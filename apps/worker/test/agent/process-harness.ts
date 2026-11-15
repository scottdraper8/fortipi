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
import { observeOwnedRuntimeRoles } from "../../../../scripts/owned-runtime-roles.ts";
import {
  sourceRecoveryPath,
  sourceTestDiagnostic,
} from "../../../../scripts/source-test-processes.ts";
import {
  armProcessBarrier,
  type ProcessArm,
  type ProcessWitness,
  processCueMatches,
  readProcessWitness,
} from "./process-observation.ts";
import { processProfile, processProfileLines } from "./process-profile.ts";

const pause = (ms: number) => new Promise<void>((accept) => setTimeout(accept, ms));
export const processBootstrap = "synthetic-process-thread5-bootstrap-000000000000";
export { processCueMatches } from "./process-observation.ts";

let harnessOrdinal = 0;

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
  const sourcePath = sourceRecoveryPath();
  const currentHarness = ++harnessOrdinal;
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
    const invocation = childInvocation;
    let announcedPort: number | undefined;
    const announcementMatches = () => (announcedPort === undefined ? null : announcedPort === port);
    const retain = (data: Buffer) => {
      if (child !== current) return;
      output = (output + String(data)).slice(-12000);
      if (announcedPort === undefined) {
        const announced =
          /\bReady on\s+http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})(?=\s)/.exec(output);
        if (announced) announcedPort = Number(announced[1]);
      }
    };
    child.stdout?.on("data", retain);
    child.stderr?.on("data", retain);
    const began = performance.now();
    let attempts = 0,
      deadlines = 0,
      transports = 0,
      status: number | null = null,
      ready = false;
    const observe = (event: "spawned" | "probe" | "ready" | "end") => {
      try {
        const code = child?.exitCode,
          signal = child?.signalCode;
        const line = JSON.stringify({
          diagnostic: "source-recovery-start",
          event,
          invocation: childInvocation,
          elapsedMs: Math.round(performance.now() - began),
          attempts,
          deadlines,
          transports,
          status,
          exitCode:
            typeof code === "number" && Number.isInteger(code) && Math.abs(code) <= 255
              ? code
              : null,
          signal:
            signal === null || signal === undefined
              ? null
              : /^SIG[A-Z0-9]{1,8}$/.test(signal)
                ? signal
                : "other",
          logStage: output.includes("Ready on")
            ? "ready-log"
            : output.includes("Starting local server")
              ? "starting-log"
              : "unobserved",
          sourcePath,
          harnessOrdinal: currentHarness,
          announcedPortMatches: announcementMatches(),
        });
        if (sourceTestDiagnostic(`# ${line}`)) console.log(line);
      } catch {
        /* Never replace the original readiness result. */
      }
    };
    observe("spawned");
    try {
      for (let i = 0; i < 300; i++) {
        assert.equal(child.exitCode, null, "Wrangler exited before readiness");
        assert.equal(child.signalCode, null, "Wrangler terminated by signal");
        assert.notEqual(
          announcementMatches(),
          false,
          "Owned Wrangler announced a different readiness endpoint",
        );
        const signal = AbortSignal.timeout(300);
        attempts++;
        try {
          const response = await fetch(`${origin}/__test/ping`, { signal });
          status = response.status;
          if (response.ok && announcementMatches() === true) {
            ready = true;
            return;
          }
        } catch {
          status = null;
          if (signal.aborted) deadlines++;
          else transports++;
        }
        if (attempts % 25 === 0) observe("probe");
        await pause(50);
      }
      assert.fail("Wrangler not ready");
    } finally {
      observe(ready ? "ready" : "end");
      if (!ready) {
        // Observe only after the original readiness decision. Never print process
        // arguments, identifiers, environment, paths or captured child output.
        let runtimeCount: number | null = null,
          runnableCount: number | null = null,
          rssKiB: number | null = null,
          cpuMs: number | null = null;
        try {
          assert.ok(current.pid);
          const table = await promisify(execFile)("ps", ["-eo", "pgid=,stat=,time=,rss=,comm="], {
            timeout: 1000,
            maxBuffer: 262144,
          });
          const runtimes = table.stdout
            .split("\n")
            .map((row) => row.trim().split(/\s+/))
            .filter(
              (row) => Number(row[0]) === current.pid && row.slice(4).join(" ").includes("workerd"),
            );
          runtimeCount = runtimes.length;
          runnableCount = runtimes.filter((row) => row[1]?.startsWith("R")).length;
          const resident = runtimes.map((row) => Number(row[3]));
          if (resident.every((value) => Number.isSafeInteger(value) && value >= 0))
            rssKiB = resident.reduce((sum, value) => sum + value, 0);
          const times = runtimes.map((row) => {
            const match = /^(?:(\d{1,4})-)?(\d{1,4}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?$/.exec(
              row[2] ?? "",
            );
            if (!match) return null;
            const hours = match[4] === undefined ? 0 : Number(match[2]);
            const minutes = Number(match[4] === undefined ? match[2] : match[3]);
            const seconds = Number(match[4] === undefined ? match[3] : match[4]);
            return (
              ((Number(match[1] ?? 0) * 24 + hours) * 3600 + minutes * 60 + seconds) * 1000 +
              Number((match[5] ?? "0").padEnd(3, "0"))
            );
          });
          if (times.every((value) => value !== null))
            cpuMs = times.reduce<number>((sum, value) => sum + (value ?? 0), 0);
        } catch {
          // Unavailable observation is not a runtime or readiness conclusion.
        }
        try {
          const line = JSON.stringify({
            diagnostic: "source-recovery-process",
            sourcePath,
            harnessOrdinal: currentHarness,
            invocation: childInvocation,
            runtimeCount,
            runnableCount,
            rssKiB,
            cpuMs,
          });
          if (sourceTestDiagnostic(`# ${line}`)) console.log(line);
        } catch {
          /* Preserve the original failure. */
        }
        if (
          announcementMatches() === true &&
          child === current &&
          current.exitCode === null &&
          current.signalCode === null
        ) {
          try {
            const role = await observeOwnedRuntimeRoles(current, port, "baseline");
            const line = JSON.stringify({
              diagnostic: "source-recovery-role",
              sourcePath: sourcePath !== null && sourcePath.length <= 64 ? sourcePath : null,
              harnessOrdinal: currentHarness,
              invocation,
              status: role.status,
              stage: role.stage,
              elapsedMs: role.elapsedMs,
              roles: role.roles,
            });
            if (sourceTestDiagnostic(`# ${line}`)) console.log(line);
          } catch {
            /* Never replace the already-decided startup error. */
          }
          try {
            const profile = await processProfile(inspector);
            for (const line of processProfileLines(
              profile,
              sourcePath,
              currentHarness,
              childInvocation,
            )) {
              if (sourceTestDiagnostic(`# ${line}`)) console.log(line);
            }
          } catch {
            /* Never replace the already-decided startup error. */
          }
        }
      }
    }
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
      current.exitCode !== null || current.signalCode !== null
        ? Promise.resolve()
        : new Promise<void>((accept) => current.once("exit", () => accept()));
    try {
      process.kill(-current.pid, signal);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ESRCH" ||
        (current.exitCode === null && current.signalCode === null)
      )
        throw error;
    }
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
    inspectorPort: inspector,
    api,
    async armBarrier(agentId: string, point: ProcessArm["point"], fault?: "hold" | "reject") {
      const current = child,
        invocation = childInvocation;
      assert.ok(current);
      const arm = await armProcessBarrier(api, runId, agentId, point, fault);
      assert.equal(child, current);
      assert.equal(childInvocation, invocation);
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
      return readProcessWitness(api, arm);
    },
    crash: () => stop("SIGKILL"),
    start,
    close: async () => {
      await stop("SIGTERM");
      await rm(directory, { recursive: true, force: true });
    },
  };
}
