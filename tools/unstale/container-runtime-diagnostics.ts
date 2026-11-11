// CI-only bounded state observations while the one real transport fixture runs.
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { repository } from "../../scripts/build-workspaces.ts";

const execute = promisify(execFile);
const format =
  '{"id":{{json .Id}},"imageId":{{json .Image}},"imageRef":{{json .Config.Image}},"status":{{json .State.Status}},"exitCode":{{.State.ExitCode}},"errorPresent":{{if .State.Error}}true{{else}}false{{end}},"networkMode":{{json .HostConfig.NetworkMode}}}';

if (
  process.platform === "linux" &&
  process.argv[1] === resolve(repository, "apps/worker/test/backends/linux-image.ts")
) {
  const env = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    DOCKER_HOST: process.env.DOCKER_HOST,
    DOCKER_CONFIG: process.env.DOCKER_CONFIG,
  };
  const docker = async (args: string[]) =>
    (
      await execute("docker", args, {
        env,
        timeout: 3000,
        killSignal: "SIGKILL",
        maxBuffer: 16 * 1024,
        encoding: "utf8",
        windowsHide: true,
      })
    ).stdout;
  let polls = 0;
  let busy = false;
  let previous = "";
  async function observe() {
    if (busy) return;
    if (polls++ >= 8) return clearInterval(interval);
    busy = true;
    try {
      // The provisioner verified this job's isolated daemon, not the ambient service.
      const ids = (await docker(["ps", "--all", "--quiet", "--no-trunc"]))
        .trim()
        .split("\n")
        .filter((id) => /^[a-f0-9]{64}$/.test(id))
        .sort()
        .slice(0, 4);
      const rows = ids.length
        ? (await docker(["inspect", "--format", format, ...ids])).trim().split("\n")
        : [];
      const states = rows.map((row) => {
        const value = JSON.parse(row) as {
          id: string;
          imageId: string;
          imageRef: string;
          status: string;
          exitCode: number;
          errorPresent: boolean;
          networkMode: string;
        };
        if (
          !/^[a-f0-9]{64}$/.test(value.id) ||
          !/^sha256:[a-f0-9]{64}$/.test(value.imageId) ||
          !["created", "running", "paused", "restarting", "removing", "exited", "dead"].includes(
            value.status,
          ) ||
          !Number.isSafeInteger(value.exitCode) ||
          typeof value.errorPresent !== "boolean"
        )
          throw new Error("Invalid state projection");
        return {
          id: value.id,
          imageId: value.imageId,
          role: value.imageRef.includes("proxy-everything")
            ? "proxy-sidecar"
            : value.imageRef.includes("probehost-computerd")
              ? "computerd"
              : "other",
          status: value.status,
          exitCode: value.exitCode,
          errorPresent: value.errorPresent,
          network: ["bridge", "host", "none"].includes(value.networkMode)
            ? value.networkMode
            : value.networkMode.startsWith("container:")
              ? "container-namespace"
              : "other",
        };
      });
      const serialized = JSON.stringify(states);
      if (serialized !== previous) {
        previous = serialized;
        console.error(
          JSON.stringify({
            probe: "container-runtime-state",
            observed: new Date().toISOString(),
            states,
          }),
        );
      }
    } catch {
      console.error(JSON.stringify({ probe: "container-runtime-state", available: false }));
    } finally {
      busy = false;
    }
  }
  const first = setTimeout(() => void observe(), 1000).unref();
  const interval = setInterval(() => void observe(), 8000).unref();
  process.once("beforeExit", () => {
    clearTimeout(first);
    clearInterval(interval);
  });
}
