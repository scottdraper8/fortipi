import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { freeInfrastructurePolicy } from "fortipi-contract";
import type { ProcessArm, ProcessWitness } from "./runtime-worker.js";

const pause = (ms: number) => new Promise<void>((accept) => setTimeout(accept, ms));
export const processBootstrap = "synthetic-process-thread5-bootstrap-000000000000";
/** A private scheduling cue, never evidence that its transaction committed. */
export function processCueMatches(line: string, arm: ProcessArm): boolean {
  const prefix = "FORTIPI_PROCESS_CUE ";
  if (line.length > 512 || !line.startsWith(prefix)) return false;
  try {
    const raw = line.slice(prefix.length),
      value: unknown = JSON.parse(raw);
    return (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).join(",") === "runId,agentId,point,armId,generation" &&
      raw === JSON.stringify(value) &&
      Object.entries(arm).every(
        ([key, expected]) => (value as Record<string, unknown>)[key] === expected,
      )
    );
  } catch {
    return false;
  }
}
interface RequestFailure {
  operation: "state" | "barrier" | "submission" | "other";
  stage: "response" | "body";
  reason: "deadline" | "transport" | "body";
  code: string | null;
  childExitCode: number | null;
  childSignal: "SIGKILL" | "SIGTERM" | null;
}
const requestFailures = new WeakMap<object, RequestFailure>();
export function processRequestFailure(error: unknown): RequestFailure | undefined {
  return error !== null && typeof error === "object" ? requestFailures.get(error) : undefined;
}
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
  const runId = randomUUID();
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
  let childInvocation = 0;
  const origin = `http://127.0.0.1:${port}`;
  const api = async <T>(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    token = processBootstrap,
  ) => {
    const signal = AbortSignal.timeout(20000);
    let stage: RequestFailure["stage"] = "response";
    try {
      const response = await fetch(`${origin}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
      });
      stage = "body";
      return { status: response.status, body: (await response.json()) as T };
    } catch (error) {
      try {
        if (error !== null && typeof error === "object") {
          const cause = Object.getOwnPropertyDescriptor(error, "cause")?.value;
          const code = Object.getOwnPropertyDescriptor(
            cause !== null && typeof cause === "object" ? cause : error,
            "code",
          )?.value;
          requestFailures.set(error, {
            operation: /^\/__test\/agents\/[A-Za-z0-9_-]+\/state$/.test(path)
              ? "state"
              : /^\/__test\/agents\/[A-Za-z0-9_-]+\/barrier$/.test(path)
                ? "barrier"
                : /^\/v1\/conversations\/[A-Za-z0-9_-]+\/messages$/.test(path)
                  ? "submission"
                  : "other",
            stage,
            reason: signal.aborted ? "deadline" : stage === "body" ? "body" : "transport",
            code:
              typeof code === "string" &&
              [
                "ECONNRESET",
                "ECONNREFUSED",
                "ETIMEDOUT",
                "UND_ERR_SOCKET",
                "UND_ERR_CONNECT_TIMEOUT",
                "UND_ERR_HEADERS_TIMEOUT",
                "UND_ERR_BODY_TIMEOUT",
              ].includes(code)
                ? code
                : null,
            childExitCode: child?.exitCode ?? null,
            childSignal:
              child?.signalCode === "SIGKILL" || child?.signalCode === "SIGTERM"
                ? child.signalCode
                : null,
          });
        }
      } catch {
        /* Diagnostics must not replace the original request failure. */
      }
      throw error;
    }
  };
  async function start() {
    assert.ok(!child, "Previous process must be stopped");
    childInvocation++;
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
    const current = child;
    const retain = (data: Buffer) => {
      if (child === current) output = (output + String(data)).slice(-12000);
    };
    child.stdout?.on("data", retain);
    child.stderr?.on("data", retain);
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
    origin,
    api,
    async armBarrier(agentId: string, point: ProcessArm["point"], fault?: "hold" | "reject") {
      const current = child,
        invocation = childInvocation;
      assert.ok(current);
      const armId = randomUUID();
      const response = await api<ProcessArm>(`/__test/agents/${agentId}/fault`, {
        runId,
        armId,
        point,
        ...(fault ? { fault } : {}),
      });
      assert.equal(response.status, 200);
      assert.equal(child, current);
      assert.equal(
        Object.keys(response.body).sort().join(","),
        "agentId,armId,generation,point,runId",
      );
      const { generation } = response.body;
      assert.ok(typeof generation === "string" && /^[a-f0-9-]{36}$/.test(generation));
      const arm = Object.freeze({ runId, agentId, point, armId, generation });
      assert.deepEqual(response.body, arm);
      let consumed = false;
      return {
        arm,
        cue: () => {
          if (consumed || child !== current || childInvocation !== invocation) return false;
          consumed = output.split(/\r?\n/).some((line) => processCueMatches(line, arm));
          return consumed;
        },
      };
    },
    async readWitness(arm: ProcessArm): Promise<ProcessWitness> {
      const response = await api<{ generation: string; witness: ProcessWitness | null }>(
        `/__test/agents/${arm.agentId}/barrier?arm=${arm.armId}&generation=${arm.generation}`,
      );
      assert.equal(response.status, 200);
      assert.notEqual(
        response.body.generation,
        arm.generation,
        "Historical proof must be read by a replacement actor",
      );
      const witness = response.body.witness;
      assert.ok(witness, "Missing committed historical marker");
      const { admissions, ...identity } = witness;
      assert.deepEqual(
        identity,
        arm,
        "Historical marker belongs to the killed actor and exact arm",
      );
      assert.ok(Array.isArray(admissions) && admissions.length <= 100);
      return witness;
    },
    crash: () => stop("SIGKILL"),
    start,
    close: async () => {
      await stop("SIGTERM");
      await rm(directory, { recursive: true, force: true });
    },
  };
}
