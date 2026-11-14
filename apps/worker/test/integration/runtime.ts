import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { freeInfrastructurePolicy } from "fortipi-contract";
import { diagnosticPiMain, observePiOpenStages } from "../../../../scripts/source-pi-open-probe.ts";
import { observeSourceProcessCompute } from "../../../../scripts/source-test-processes.ts";
import {
  offlineWranglerEnvironment,
  verifyOfflineWranglerAuth,
} from "../../../../tests/clients/offline-wrangler.ts";
import { killRuntime } from "./runtime-child.ts";

const repository = resolve(import.meta.dirname, "../../../..");
export async function poll<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  timeout = 20000,
  observePause?: (phase: "pause.enter" | "pause.exit") => void,
): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (ready(value)) return value;
    try {
      observePause?.("pause.enter");
    } catch {
      // Diagnostic callbacks cannot replace the original polling outcome.
    }
    await new Promise<void>((accept) => setTimeout(accept, 25));
    try {
      observePause?.("pause.exit");
    } catch {
      // Diagnostic callbacks cannot replace the original polling outcome.
    }
  }
  throw new Error("Expected durable boundary did not become observable before its deadline");
}
async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((accept, reject) =>
    server.close((error) => (error ? reject(error) : accept())),
  );
  return address.port;
}
export interface RuntimeOptions {
  directory?: string;
  main?: string;
  allowedOrigin?: string;
  wranglerBin?: string;
  events?: number;
  tls?: { key: string; cert: string; ca: string };
  testBounds?: Partial<typeof freeInfrastructurePolicy.bounds>;
  traffic?: "free";
  /** Test-only real local Loader; requires an explicit source fixture main.
   * Never inferred from Free traffic or advertised as a paid account proof. */
  sourceLoader?: true;
}
/** Real TCP/workerd/SQLite, one immutable config and storage directory across kills. */
export async function start(options: RuntimeOptions = {}) {
  if (options.sourceLoader)
    assert.equal(
      options.main && resolve(options.main),
      join(repository, "apps/worker/test/integration/cloud-tool-worker.ts"),
      "Local Loader binding requires the explicit source-only cloud tool fixture; default Free composition must omit it",
    );
  const directory =
    options.directory ?? (await mkdtemp(join(tmpdir(), "fortipi-evidence-runtime-")));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const number = await port(),
    inspector = await port();
  const endpoint = `${options.tls ? "https" : "http"}://127.0.0.1:${number}`;
  const admin = `local-${randomUUID()}-${randomUUID()}`;
  const configPath = join(directory, "wrangler.json");
  const storage = join(directory, "state");
  const policy = structuredClone(freeInfrastructurePolicy);
  if (options.testBounds)
    for (const [name, value] of Object.entries(options.testBounds)) {
      const key = name as keyof typeof policy.bounds;
      assert.ok(
        Number.isSafeInteger(value) && value > 0 && value <= policy.bounds[key],
        "Fixture can only lower declared allocation bounds",
      );
      policy.bounds[key] = value;
    }
  // Isolate durable semantics from request cadence. This is explicitly NOT a
  // test of actual Free account ceilings or configured Free traffic defaults.
  if (options.traffic !== "free") {
    policy.bounds.requestsPerPrincipalMinute = 10000;
    policy.bounds.requestsPerInstallMinute = 10000;
  }
  if (options.events !== undefined) {
    assert.ok(
      Number.isSafeInteger(options.events) &&
        options.events > 0 &&
        options.events <= policy.bounds.conversationEvents,
    );
    policy.bounds.conversationEvents = options.events;
  }
  await writeFile(
    configPath,
    JSON.stringify({
      name: "fortipi-evidence-local",
      main:
        options.main ??
        diagnosticPiMain("integration") ??
        join(repository, "apps/worker/test/integration/fixture-worker.ts"),
      compatibility_date: "2026-11-10",
      compatibility_flags: ["nodejs_compat", "enable_request_signal", "request_signal_passthrough"],
      ...(options.sourceLoader ? { worker_loaders: [{ binding: "LOADER" }] } : {}),
      vars: {
        FORTIPI_EVIDENCE_SOURCE_TIME: Date.now(),
        FORTIPI_ADMIN_TOKEN: admin,
        FORTIPI_CONFIG: { version: 1, infrastructure: policy },
        ...(options.allowedOrigin ? { FORTIPI_ALLOWED_ORIGINS: [options.allowedOrigin] } : {}),
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
    { mode: 0o600, flag: "wx" },
  );
  const require = createRequire(join(repository, "apps/worker/package.json"));
  const manifestPath = require.resolve("wrangler/package.json");
  const wrangler = options.wranglerBin ?? join(dirname(manifestPath), "bin/wrangler.js");
  let child: ChildProcess | undefined;
  let childInvocation = 0;
  async function launch() {
    assert.ok(!child, "Stop the previous runtime before reopening identical storage");
    childInvocation++;
    child = spawn(
      process.execPath,
      [
        wrangler,
        "dev",
        "--local",
        "--config",
        configPath,
        "--persist-to",
        storage,
        "--port",
        String(number),
        "--inspector-port",
        String(inspector),
        ...(options.tls
          ? [
              "--local-protocol",
              "https",
              "--https-key-path",
              options.tls.key,
              "--https-cert-path",
              options.tls.cert,
            ]
          : []),
      ],
      {
        cwd: directory,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...offlineWranglerEnvironment(directory),
          ...(options.tls ? { NODE_EXTRA_CA_CERTS: options.tls.ca } : {}),
        },
      },
    );
    // Never retain raw runtime output: it may contain synthetic role values or
    // request payloads. The evidence contains only bounded public observations.
    if (child.stdout) observePiOpenStages(child.stdout, childInvocation);
    if (child.stderr) observePiOpenStages(child.stderr, childInvocation);
    child.stdout?.resume();
    child.stderr?.resume();
    let spawnError = false;
    child.once("error", () => {
      spawnError = true;
    });
    await poll(
      async () => {
        assert.ok(!spawnError && child?.exitCode === null, "Local runtime did not stay running");
        try {
          return (await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(300) })).ok;
        } catch {
          return false;
        }
      },
      Boolean,
      30000,
    );
  }
  async function stop(abrupt: boolean) {
    if (!child) return;
    const current = child;
    assert.ok(current.pid);
    const closed =
      current.exitCode === null
        ? new Promise<void>((accept) => current.once("close", () => accept()))
        : Promise.resolve();
    await killRuntime(current.pid, abrupt);
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("Runtime tree did not terminate")), 10000);
        timer.unref();
      }),
    ]);
    child = undefined;
  }
  let apiOrdinal = 0,
    clientObservations = 0;
  const observeClient = (
    ordinal: number,
    kind: "barrier" | "submission" | "other",
    phase:
      | "fetch.enter"
      | "headers"
      | "body.enter"
      | "body.exit"
      | "fetch.error"
      | "body.error"
      | "pause.enter"
      | "pause.exit",
    status: number | null = null,
  ) => {
    if (
      process.env.FORTIPI_SOURCE_PI_OPEN_DIAGNOSTICS !== "1" ||
      ordinal < 1 ||
      ordinal > 999 ||
      clientObservations >= 1024
    )
      return;
    clientObservations++;
    try {
      console.log(
        JSON.stringify({ diagnostic: "source-integration-client", ordinal, kind, phase, status }),
      );
    } catch {
      // Fixed milestones cannot replace the original response or rejection.
    }
  };
  const api = async <T>(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    token = admin,
  ) => {
    assert.ok(path.startsWith("/") && !path.startsWith("//"));
    const signal = AbortSignal.timeout(30000);
    const ordinal = ++apiOrdinal,
      kind = /^\/__test\/agents\/[A-Za-z0-9_-]+\/barrier$/.test(path)
        ? "barrier"
        : /^\/v1\/conversations\/[A-Za-z0-9_-]+\/messages$/.test(path)
          ? "submission"
          : "other";
    let status: number | null = null;
    observeClient(ordinal, kind, "fetch.enter");
    try {
      const response = await fetch(`${endpoint}${path}`, {
        method,
        redirect: "error",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
      });
      status = response.status;
      observeClient(ordinal, kind, "headers", status);
      observeClient(ordinal, kind, "body.enter", status);
      const value = (await response.json()) as T;
      observeClient(ordinal, kind, "body.exit", status);
      return { status: response.status, body: value };
    } catch (error) {
      observeClient(ordinal, kind, status === null ? "fetch.error" : "body.error", status);
      if (signal.aborted && child?.pid) observeSourceProcessCompute(child.pid, "request-deadline");
      throw error;
    }
  };
  try {
    await verifyOfflineWranglerAuth(wrangler);
    await launch();
  } catch (error) {
    await stop(false);
    if (options.directory === undefined) await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    endpoint,
    directory,
    configPath,
    storage,
    admin,
    api,
    stopAbruptly: () => stop(true),
    reopenSameStorage: launch,
    barrier: async (agentId: string, name: string) => {
      let ordinal = 0;
      return poll(
        async () => {
          ordinal = apiOrdinal + 1;
          return (await api<{ barrier: string | null }>(`/__test/agents/${agentId}/barrier`)).body;
        },
        (state) => state.barrier === name,
        20000,
        (phase) => observeClient(ordinal, "barrier", phase),
      );
    },
    dispose: async () => {
      await stop(false);
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}
export type Runtime = Awaited<ReturnType<typeof start>>;
