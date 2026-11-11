// CI-only bounded state observations while the one real transport fixture runs.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { repository } from "../../scripts/build-workspaces.ts";

const execute = promisify(execFile);
const format =
  '{"id":{{json .Id}},"imageId":{{json .Image}},"imageRef":{{json .Config.Image}},"status":{{json .State.Status}},"exitCode":{{.State.ExitCode}},"errorPresent":{{if .State.Error}}true{{else}}false{{end}},"networkMode":{{json .HostConfig.NetworkMode}}}';
// The pinned SEA supports NODE_OPTIONS preloads. Exit before its daemon entry point.
export const healthPreload = `--import=data:text/javascript;base64,${Buffer.from(`
let httpStatus = null;
try {
  const response = await fetch("http://127.0.0.1:8080/health", {
    method: "HEAD", redirect: "error", signal: AbortSignal.timeout(1000)
  });
  httpStatus = response.status;
  await response.body?.cancel();
} catch {} finally {
  process.stdout.write(JSON.stringify({ httpStatus }));
  process.exit(0);
}
`).toString("base64")}`;

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
  let healthAttempts = 0;
  let busy = false;
  let previous = "";
  async function observeHealth(id: string) {
    let httpStatus: number | null = null;
    try {
      const { stdout } = await execute(
        "docker",
        [
          "exec",
          "--env",
          `NODE_OPTIONS=${healthPreload}`,
          id,
          "/usr/bin/timeout",
          "--signal=KILL",
          "1.5",
          "/usr/local/bin/computerd",
        ],
        { env, timeout: 2000, killSignal: "SIGKILL", maxBuffer: 1024, encoding: "utf8" },
      );
      const result = JSON.parse(stdout) as { httpStatus: unknown };
      if (
        Object.keys(result).length === 1 &&
        Number.isInteger(result.httpStatus) &&
        Number(result.httpStatus) >= 100 &&
        Number(result.httpStatus) <= 599
      )
        httpStatus = Number(result.httpStatus);
    } catch {}
    console.error(
      JSON.stringify({
        role: "computerd",
        httpStatus,
        success: httpStatus === 200,
        unknown: httpStatus === null,
      }),
    );
  }
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
      if (healthAttempts < 2) {
        const metadata = JSON.parse(
          await readFile(
            resolve(repository, "apps/worker/dist/container/image-metadata.json"),
            "utf8",
          ),
        ) as { imageId: string };
        if (!/^sha256:[a-f0-9]{64}$/.test(metadata.imageId)) throw new Error("Invalid image ID");
        const computerd = states.find(
          (state) =>
            state.role === "computerd" &&
            state.status === "running" &&
            state.imageId === metadata.imageId,
        );
        if (computerd) {
          healthAttempts++;
          await observeHealth(computerd.id);
        }
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
