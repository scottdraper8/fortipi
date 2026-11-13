import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createObserverServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { freeInfrastructurePolicy } from "fortipi-contract";
import type { ProcessBarrierSnapshot } from "./runtime-worker.js";

const pause = (ms: number) => new Promise<void>((accept) => setTimeout(accept, ms));
export const processBootstrap = "synthetic-process-thread5-bootstrap-000000000000";
const requestTimeout = 20000;
export interface ProcessBarrierArm {
  readonly observationId: string;
  readonly agentId: string;
  readonly point: "before-submit" | "after-submit";
}
/** Disposable loopback receiver; these notifications coordinate a kill, not recovery storage. */
export async function createProcessBarrierObserver() {
  const token = `${randomUUID()}-${randomUUID()}`;
  const records = new Map<
    string,
    {
      arm: ProcessBarrierArm;
      receiving?: boolean;
      snapshot?: ProcessBarrierSnapshot;
      failed?: boolean;
    }
  >();
  let closed = false;
  const keys = (value: unknown, expected: string): value is Record<string, unknown> =>
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === expected;
  const id = (value: unknown): value is string =>
    typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  const server = createObserverServer(async (request, response) => {
    try {
      if (
        closed ||
        request.method !== "POST" ||
        request.url !== "/barriers" ||
        request.headers["content-type"] !== "application/json" ||
        request.headers.authorization !== `Bearer ${token}`
      ) {
        response.writeHead(403, { Connection: "close" }).end();
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        size += chunk.length;
        assert.ok(size <= 65536);
        chunks.push(Buffer.from(chunk));
      }
      const raw = Buffer.concat(chunks).toString("utf8"),
        value: unknown = JSON.parse(raw);
      assert.ok(keys(value, "admissions,agentId,barrier,observationId"));
      assert.equal(raw, JSON.stringify(value), "Noncanonical fixture notification");
      assert.equal(typeof value.observationId, "string");
      const record = records.get(value.observationId as string);
      if (
        !record ||
        record.receiving ||
        record.failed ||
        value.agentId !== record.arm.agentId ||
        value.barrier !== record.arm.point
      ) {
        response.writeHead(409).end();
        return;
      }
      assert.ok(Array.isArray(value.admissions) && value.admissions.length <= 100);
      for (const row of value.admissions) {
        assert.ok(keys(row, "messageId,operationId,receipt,taskId"));
        assert.ok(id(row.operationId) && id(row.messageId) && id(row.taskId));
        if (row.receipt !== null) {
          assert.ok(keys(row.receipt, "eventSeq,messageId,operationId,revision,taskId"));
          assert.ok(
            id(row.receipt.operationId) && id(row.receipt.messageId) && id(row.receipt.taskId),
          );
          assert.equal(row.receipt.operationId, row.operationId);
          assert.equal(row.receipt.messageId, row.messageId);
          assert.equal(row.receipt.taskId, row.taskId);
          assert.ok(
            id(row.receipt.revision) &&
              Number.isSafeInteger(row.receipt.eventSeq) &&
              Number(row.receipt.eventSeq) >= 0,
          );
        }
      }
      record.receiving = true;
      const snapshot = {
        barrier: value.barrier,
        admissions: value.admissions,
      } as ProcessBarrierSnapshot;
      response.once("finish", () => {
        if (response.statusCode === 204) record.snapshot = snapshot;
        else record.failed = true;
      });
      response.once("close", () => {
        if (!response.writableFinished) record.failed = true;
      });
      response.writeHead(204).end();
    } catch {
      // Neither rejected payloads nor errors can disclose credentials/body data.
      if (!response.destroyed && !response.writableEnded)
        response.writeHead(400, { Connection: "close" }).end();
    }
  });
  server.requestTimeout = requestTimeout;
  server.headersTimeout = requestTimeout;
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}/barriers`,
    token,
    arm(agentId: string, point: ProcessBarrierArm["point"]): ProcessBarrierArm {
      assert.ok(!closed && id(agentId));
      assert.ok(point === "before-submit" || point === "after-submit");
      for (const [key, record] of records) if (record.arm.agentId === agentId) records.delete(key);
      const arm = Object.freeze({ observationId: randomUUID(), agentId, point });
      records.set(arm.observationId, { arm });
      return arm;
    },
    snapshot(arm: ProcessBarrierArm): ProcessBarrierSnapshot {
      assert.ok(!closed);
      const record = records.get(arm.observationId);
      assert.ok(record && !record.failed);
      assert.deepEqual(record.arm, arm);
      return structuredClone(record.snapshot ?? { barrier: null, admissions: [] });
    },
    invalidate() {
      records.clear();
    },
    async close() {
      if (closed) return;
      closed = true;
      records.clear();
      const done = new Promise<void>((accept) => server.close(() => accept()));
      server.closeAllConnections();
      await done;
    },
  };
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
  const directory = await mkdtemp(join(tmpdir(), "fortipi-process-"));
  const port = await freePort(),
    inspector = await freePort();
  const configPath = join(directory, "wrangler.json");
  const policy = structuredClone(freeInfrastructurePolicy);
  // This isolates storage/recovery semantics. The separate Free tests retain30.
  policy.bounds.requestsPerPrincipalMinute = 10000;
  policy.bounds.requestsPerInstallMinute = 10000;
  const observer = await createProcessBarrierObserver().catch(async (error) => {
    await rm(directory, { recursive: true, force: true });
    throw error;
  });
  const writeConfig = () =>
    writeFile(
      configPath,
      JSON.stringify({
        name: "fortipi-process",
        main,
        compatibility_date: "2026-11-10",
        compatibility_flags: [
          "nodejs_compat",
          "enable_request_signal",
          "request_signal_passthrough",
        ],
        vars: {
          FORTIPI_ADMIN_TOKEN: processBootstrap,
          FORTIPI_CONFIG: { version: 1, infrastructure: policy },
          FORTIPI_TEST_PROCESS_OBSERVER: { url: observer.url, token: observer.token },
        },
        durable_objects: {
          bindings: [
            { name: "CONTROL_PLANE", class_name: "ControlPlane" },
            { name: "AGENT_SESSIONS", class_name: "TestAgentSession" },
            { name: "WORKSPACES", class_name: "WorkspaceObject" },
          ],
        },
        migrations: [
          {
            tag: "v1",
            new_sqlite_classes: ["ControlPlane", "TestAgentSession", "WorkspaceObject"],
          },
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
    token = processBootstrap,
  ) => {
    const signal = AbortSignal.timeout(requestTimeout);
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
    observer.invalidate();
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
    const retain = (data: Buffer) => {
      output = (output + String(data))
        .replaceAll(observer.token, "[redacted observer]")
        .slice(-12000);
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
    await writeConfig();
    await start();
  } catch (error) {
    try {
      await stop("SIGTERM");
    } finally {
      await observer.close();
      await rm(directory, { recursive: true, force: true });
    }
    throw error;
  }
  return {
    origin,
    api,
    async armBarrier(agentId: string, point: ProcessBarrierArm["point"]) {
      const arm = observer.arm(agentId, point);
      const armed = await api(`/__test/agents/${agentId}/fault`, {
        point,
        observationId: arm.observationId,
      });
      assert.equal(armed.status, 200);
      return { snapshot: () => observer.snapshot(arm) };
    },
    crash: () => stop("SIGKILL"),
    start,
    close: async () => {
      try {
        await stop("SIGTERM");
      } finally {
        await observer.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
