// CI-only bounded state observations while the one real transport fixture runs.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isIPv4 } from "node:net";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { repository } from "../../scripts/build-workspaces.ts";
import { isStepSecuritySinkhole } from "./verify-container-egress.ts";

const execute = promisify(execFile);
const format =
  '{"id":{{json .Id}},"imageId":{{json .Image}},"imageRef":{{json .Config.Image}},"status":{{json .State.Status}},"exitCode":{{.State.ExitCode}},"errorPresent":{{if .State.Error}}true{{else}}false{{end}},"networkMode":{{json .HostConfig.NetworkMode}}}';
export const healthCommand = `set -eu
exec 3<>/dev/tcp/127.0.0.1/8080
printf 'HEAD /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n' >&3
IFS=' ' read -r protocol status remainder <&3
[[ "$protocol" = HTTP/1.1 || "$protocol" = HTTP/1.0 ]] || exit 1
[[ "$status" =~ ^[1-5][0-9]{2}$ ]] || exit 1
printf '%s' "$status"`;

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
  let dnsAttempted = false;
  let busy = false;
  let previous = "";
  async function observeHealth(id: string) {
    let httpStatus: number | null = null;
    try {
      const { stdout } = await execute(
        "docker",
        ["exec", id, "/usr/bin/timeout", "--signal=KILL", "1", "/bin/bash", "-c", healthCommand],
        { env, timeout: 2000, killSignal: "SIGKILL", maxBuffer: 1024, encoding: "utf8" },
      );
      if (stdout.length === 3 && /^[1-5][0-9]{2}$/.test(stdout)) httpStatus = Number(stdout);
    } catch {}
    console.error(
      JSON.stringify({
        role: "computerd",
        httpStatus,
        success: httpStatus === 200,
        unknown: httpStatus === null,
      }),
    );
    return httpStatus === 200;
  }
  async function observeDns(id: string, imageId: string): Promise<void> {
    const targets = [
      ["internal-callback", "computer.internal"],
      ["allowed-registry", "registry.npmjs.org"],
      ["denied-example", "example.com"],
    ] as const;
    const signal = AbortSignal.timeout(6000);
    const identityFormat =
      '{"id":{{json .Id}},"imageId":{{json .Image}},"imageRef":{{json .Config.Image}},"pid":{{.State.Pid}},"startedAt":{{json .State.StartedAt}},"running":{{.State.Running}},"network":{{json .HostConfig.NetworkMode}}}';
    interface Identity {
      id: string;
      imageId: string;
      imageRef: string;
      pid: number;
      startedAt: string;
      running: boolean;
      network: string;
    }
    const inspect = async (ids: string[]): Promise<Identity[]> => {
      const result = await execute("docker", ["inspect", "--format", identityFormat, ...ids], {
        env,
        signal,
        timeout: 1000,
        killSignal: "SIGKILL",
        maxBuffer: 4096,
        encoding: "utf8",
      });
      return result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Identity);
    };
    let results: { target: string; exit: string; classification: string }[];
    try {
      // Resolve only a public network reference; never inspect Env, Cmd or credentials.
      const app = (await inspect([id]))[0];
      assert.ok(app && app.id === id && app.imageId === imageId);
      assert.ok(app.network.startsWith("container:"));
      const sidecarRef = app.network.slice("container:".length);
      assert.match(sidecarRef, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/);
      const before = await inspect([id, sidecarRef]);
      assert.equal(before.length, 2);
      assert.deepEqual(before[0], app);
      assert.equal(before[0]?.id, id);
      assert.equal(before[0]?.imageId, imageId);
      assert.equal(before[0]?.network, app.network);
      assert.equal(
        before[1]?.imageRef,
        "cloudflare/proxy-everything:3cb1195@sha256:0ef6716c52430096900b150d84a3302057d6cd2319dae7987128c85d0733e3c8",
      );
      assert.equal(before[1]?.network, "bridge");
      for (const row of before) {
        assert.match(row.id, /^[a-f0-9]{64}$/);
        assert.match(row.imageId, /^sha256:[a-f0-9]{64}$/);
        assert.ok(row.running === true && Number.isSafeInteger(row.pid) && row.pid > 1);
        assert.match(row.startedAt, /^\d{4}-\d\d-\d\dT[0-9:.]+Z$/);
      }
      results = await Promise.all(
        targets.map(async ([target, hostname]) => {
          try {
            const { stdout } = await execute(
              "docker",
              [
                "exec",
                id,
                "/usr/bin/timeout",
                "--signal=KILL",
                "1",
                "/usr/bin/getent",
                "ahostsv4",
                hostname,
              ],
              {
                env,
                signal,
                timeout: 2000,
                killSignal: "SIGKILL",
                maxBuffer: 4096,
                encoding: "utf8",
              },
            );
            const addresses = [
              ...new Set(
                stdout
                  .split("\n")
                  .map((line) => line.split(/\s+/)[0] ?? "")
                  .filter(isIPv4),
              ),
            ];
            const classification = isStepSecuritySinkhole(addresses)
              ? "provider-sinkhole"
              : addresses.length === 1 && addresses[0] === "11.0.0.1"
                ? "synthetic-allow"
                : addresses.length > 0
                  ? "resolved"
                  : "unknown";
            return { target, exit: "zero", classification };
          } catch (error) {
            const code = (error as { code?: unknown }).code;
            return {
              target,
              exit:
                code === 124 || code === 137
                  ? "timeout"
                  : code === 125 || code === 126 || code === 127
                    ? "setup-failure"
                    : typeof code === "number"
                      ? "nonzero"
                      : "unknown",
              classification: "unknown",
            };
          }
        }),
      );
      const after = await inspect(before.map((row) => row.id));
      assert.deepEqual(after, before);
    } catch {
      results = targets.map(([target]) => ({ target, exit: "unknown", classification: "unknown" }));
    }
    for (const result of results)
      console.error(JSON.stringify({ probe: "application-dns", ...result }));
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
          const healthy = await observeHealth(computerd.id);
          if (healthy && !dnsAttempted) {
            dnsAttempted = true;
            await observeDns(computerd.id, metadata.imageId);
          }
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
