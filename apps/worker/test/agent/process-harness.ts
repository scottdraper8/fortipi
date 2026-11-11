import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { freeInfrastructurePolicy } from "fortipi-contract";

const pause = (ms: number) => new Promise<void>((accept) => setTimeout(accept, ms));
export const processBootstrap = "synthetic-process-thread5-bootstrap-000000000000";
async function freePort() {
  const server = createServer();
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((accept, reject) =>
    server.close((error) => (error ? reject(error) : accept())),
  );
  return address.port;
}
/** A real standalone Wrangler/workerd process. createTestHarness cannot persist. */
export async function processHarness(main = resolve("apps/worker/test/agent/runtime-worker.ts")) {
  const directory = await mkdtemp(join(tmpdir(), "fortipi-process-"));
  const port = await freePort(),
    inspector = await freePort();
  const configPath = join(directory, "wrangler.json");
  const policy = structuredClone(freeInfrastructurePolicy);
  // This isolates storage/recovery semantics. The separate Free tests retain30.
  policy.bounds.requestsPerPrincipalMinute = 10000;
  policy.bounds.requestsPerInstallMinute = 10000;
  await writeFile(
    configPath,
    JSON.stringify({
      name: "fortipi-process",
      main,
      compatibility_date: "2026-11-10",
      compatibility_flags: ["nodejs_compat", "enable_request_signal", "request_signal_passthrough"],
      vars: {
        FORTIPI_ADMIN_TOKEN: processBootstrap,
        FORTIPI_CONFIG: { version: 1, infrastructure: policy },
      },
      durable_objects: {
        bindings: [
          { name: "CONTROL_PLANE", class_name: "ControlPlane" },
          { name: "AGENT_SESSIONS", class_name: "TestAgentSession" },
          { name: "WORKSPACES", class_name: "WorkspaceObject" },
        ],
      },
      migrations: [
        { tag: "v1", new_sqlite_classes: ["ControlPlane", "TestAgentSession", "WorkspaceObject"] },
      ],
    }),
  );
  const wrangler = join(
    dirname(fileURLToPath(import.meta.resolve("wrangler"))),
    "../bin/wrangler.js",
  );
  let child: ChildProcess | undefined,
    output = "";
  const origin = `http://127.0.0.1:${port}`;
  const api = async <T>(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: { Authorization: `Bearer ${processBootstrap}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20000),
    });
    return { status: response.status, body: (await response.json()) as T };
  };
  async function start() {
    assert.ok(!child, "Previous process must be stopped");
    output = "";
    child = spawn(
      process.execPath,
      [
        wrangler,
        "dev",
        "--local",
        "--config",
        configPath,
        "--persist-to",
        join(directory, "state"),
        "--port",
        String(port),
        "--inspector-port",
        String(inspector),
      ],
      {
        cwd: directory,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH,
          WRANGLER_SEND_METRICS: "false",
          XDG_CONFIG_HOME: join(directory, "xdg"),
          XDG_CACHE_HOME: join(directory, "cache"),
        },
      },
    );
    child.stdout?.on("data", (data) => {
      output = (output + String(data)).slice(-12000);
    });
    child.stderr?.on("data", (data) => {
      output = (output + String(data)).slice(-12000);
    });
    for (let i = 0; i < 300; i++) {
      assert.equal(child.exitCode, null, output);
      try {
        if ((await fetch(`${origin}/__test/ping`, { signal: AbortSignal.timeout(300) })).ok) return;
      } catch {}
      await pause(50);
    }
    assert.fail(`Wrangler not ready: ${output}`);
  }
  async function stop(signal: "SIGKILL" | "SIGTERM") {
    if (!child) return;
    const current = child;
    assert.ok(current.pid);
    if (signal === "SIGKILL") {
      // comm only: never inspect process arguments, environment or credentials.
      const table = await promisify(execFile)("ps", ["-eo", "pid=,ppid=,pgid=,comm="]);
      const group = table.stdout
        .split("\n")
        .map((row) => row.trim().split(/\s+/))
        .filter((row) => Number(row[2]) === current.pid);
      assert.ok(
        group.some((row) => row.slice(3).join(" ").includes("workerd")),
        "Must kill the actual workerd process, not only a wrapper",
      );
    }
    const exited =
      current.exitCode !== null
        ? Promise.resolve()
        : new Promise<void>((accept) => current.once("exit", () => accept()));
    process.kill(-current.pid, signal);
    await exited;
    if (signal === "SIGKILL") assert.equal(current.signalCode, signal);
    child = undefined;
  }
  try {
    await start();
  } catch (error) {
    await stop("SIGTERM");
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    api,
    crash: () => stop("SIGKILL"),
    start,
    close: async () => {
      await stop("SIGTERM");
      await rm(directory, { recursive: true, force: true });
    },
  };
}
