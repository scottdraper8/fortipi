import { ChildProcess } from "node:child_process";
import { subscribe } from "node:diagnostics_channel";
import { writeSync } from "node:fs";
import { dirname, relative, resolve, win32 } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const tests = new Set([
  "packages/fortipi-executor/test/executor-job.test.ts",
  "packages/fortipi-executor/test/ledger.test.ts",
  "packages/fortipi-executor/test/platform.test.ts",
  "packages/fortipi-executor/test/policy.test.ts",
  "packages/fortipi-executor/test/preclaim.test.ts",
  "packages/fortipi-executor/test/provision.test.ts",
  "packages/fortipi-executor/test/transport.test.ts",
  "packages/fortipi-executor/test/workspace.test.ts",
]);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const candidate =
  process.argv.length === 2 && process.argv[1]
    ? relative(root, resolve(process.argv[1])).replaceAll("\\", "/")
    : null;
const source = candidate !== null && tests.has(candidate) ? candidate : null;
const systemRoot = process.env.SystemRoot;
if (
  process.platform === "win32" &&
  process.env.GITHUB_ACTIONS === "true" &&
  source !== null &&
  systemRoot &&
  /^[a-z]:\\windows$/i.test(systemRoot)
) {
  const trusted = win32
    .join(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe")
    .toLowerCase();
  const active = new Map<ChildProcess, number>();
  const began = performance.now();
  let started = 0,
    completed = 0,
    maxActive = 0,
    totalMs = 0,
    maxMs = 0,
    records = 0;
  const emit = (event: "interval" | "exit") => {
    try {
      if (records >= (event === "exit" ? 20 : 19)) return;
      const now = performance.now();
      let total = totalMs,
        max = maxMs;
      for (const since of active.values()) {
        const elapsed = now - since;
        total += elapsed;
        max = Math.max(max, elapsed);
      }
      const numbers = {
        elapsedMs: Math.round(now - began),
        started,
        completed,
        active: active.size,
        maxActive,
        totalElapsedMs: Math.round(total),
        maxElapsedMs: Math.round(max),
      };
      if (!Object.values(numbers).every((n) => Number.isSafeInteger(n) && n >= 0)) return;
      // Synchronous bounded stderr also permits a final record during normal exit.
      writeSync(
        2,
        `${JSON.stringify({ diagnostic: "windows-executor-metrics", source, event, ...numbers })}\n`,
      );
      records++;
    } catch {
      /* Metrics must never change a product verdict or expose a write error. */
    }
  };
  subscribe("child_process", (message: unknown) => {
    try {
      if (message === null || typeof message !== "object") return;
      const child = Object.getOwnPropertyDescriptor(message, "process")?.value;
      if (!(child instanceof ChildProcess)) return;
      child.once("spawn", () => {
        try {
          if (child.spawnfile.toLowerCase() !== trusted || active.has(child)) return;
          child.once("exit", () => {
            try {
              const since = active.get(child);
              if (since === undefined) return;
              const elapsed = performance.now() - since;
              completed++;
              totalMs += elapsed;
              maxMs = Math.max(maxMs, elapsed);
            } catch {
              /* Ignore unavailable timing without changing event delivery. */
            } finally {
              try {
                active.delete(child);
              } catch {
                /* Cleanup observations must not escape the callback. */
              }
            }
          });
          const since = performance.now();
          active.set(child, since);
          started++;
          maxActive = Math.max(maxActive, active.size);
        } catch {
          /* Deferred observations must not affect a test verdict. */
        }
      });
    } catch {
      /* Ignore unavailable observations without inspecting arbitrary errors. */
    }
  });
  const interval = setInterval(() => emit("interval"), 60_000);
  interval.unref();
  process.once("exit", () => {
    try {
      clearInterval(interval);
    } catch {
      /* A diagnostic cleanup failure must not change process exit. */
    }
    emit("exit");
  });
}
