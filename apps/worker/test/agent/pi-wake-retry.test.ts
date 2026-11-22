import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import type { TestHarness } from "wrangler";
import { eventually } from "./harness.ts";
import type { WakeRetryProbe } from "./pi-wake-retry-worker.js";

interface RetryState {
  failed: boolean;
  failedCapturedTime?: number;
  calls: { attempt: number; capturedTime: number; calledAt: number; finishedAt: number | null }[];
  row: { time: number; retry?: { maxAttempts?: number } } | null;
  opens: number;
}
interface TaskState {
  status: string;
  outcome?: { status: string; result?: number };
}

test("actual PiHarness retry rereads replacement delayed work after a failed reopen", {
  timeout: 20000,
}, async (t) => {
  let phase = "setup";
  const mark = (next: string) => {
    phase = next;
    // Fixed phase names only; write before awaiting so TAP ordering cannot hide
    // the last entered boundary if startup or teardown does not settle.
    process.stderr.write(`# ${JSON.stringify({ diagnostic: "source-pi-wake-phase", phase })}\n`);
  };
  let directory: string | undefined;
  let server: TestHarness | undefined;
  let cleanupProbe: DurableObjectStub<WakeRetryProbe> | undefined;
  let drive: Promise<void> | undefined;
  try {
    mark("setup");
    directory = await mkdtemp(join(tmpdir(), "fortipi-pi-wake-retry-"));
    const configPath = join(directory, "wrangler.json");
    await writeFile(
      configPath,
      JSON.stringify({
        name: "fortipi-pi-wake-retry",
        main: resolve("apps/worker/test/agent/pi-wake-retry-worker.ts"),
        compatibility_date: "2026-11-10",
        compatibility_flags: [
          "nodejs_compat",
          "enable_request_signal",
          "request_signal_passthrough",
        ],
        durable_objects: { bindings: [{ name: "PROBE", class_name: "WakeRetryProbe" }] },
        migrations: [{ tag: "v1", new_sqlite_classes: ["WakeRetryProbe"] }],
      }),
    );
    process.env.WRANGLER_SEND_METRICS = "false";
    process.env.XDG_CONFIG_HOME = join(directory, "xdg");
    process.env.XDG_CACHE_HOME = join(directory, "cache");
    const { createTestHarness } = await import("wrangler");
    server = createTestHarness({ root: directory, workers: [{ configPath }] });
    mark("listen");
    await server.listen();
    mark("bind");
    const env = await server
      .getWorker<{ PROBE: DurableObjectNamespace<WakeRetryProbe> }>()
      .getEnv();
    const probe = env.PROBE.getByName("actual-pi-wake-retry");
    cleanupProbe = probe;
    const state = async () => JSON.parse(await probe.stateJson()) as RetryState;
    const task = async () => JSON.parse(await probe.taskJson()) as TaskState;
    mark("prepare");
    const prepared = await probe.prepare();
    mark("drive");
    drive = probe.drive();
    void drive.catch(() => {});
    mark("observe-failure");
    await eventually(state, (state) => state.failed);
    mark("recover");
    await probe.recover();
    mark("replacement");
    const replacement = await eventually(state, (state) => state.row?.time === prepared.until);
    assert.equal(replacement.row?.retry, undefined, "Use the real inherited retry policy");
    assert.equal((await task()).status, "sleeping");
    mark("release");
    await probe.releaseFailure();
    mark("wait-drive");
    await drive;
    mark("interim");
    const interim = await state();
    assert.equal(
      interim.row?.time,
      prepared.until,
      "The older result must preserve the newer wake",
    );
    assert.equal((await task()).status, "sleeping", "No early task execution");
    assert.ok((await probe.alarmTime()) !== null, "Delayed work retains an actual physical alarm");
    mark("terminal");
    const terminal = await eventually(task, (state) => state?.status === "terminal");
    assert.equal(terminal?.status, "terminal");
    if (terminal?.status !== "terminal") assert.fail("Actual Pi task did not finish");
    assert.equal(terminal.outcome?.status, "completed");
    assert.ok(
      terminal.outcome?.status === "completed" && typeof terminal.outcome.result === "number",
    );
    assert.ok(
      terminal.outcome.result >= prepared.until,
      "The natural wake obeys the stored deadline",
    );
    const after = await state();
    mark("attempts");
    assert.equal(typeof replacement.failedCapturedTime, "number");
    const attempts = after.calls.filter(
      (call) => call.capturedTime === replacement.failedCapturedTime,
    );
    assert.ok(attempts.length >= 1 && attempts.length <= 3, "One default bounded retry dispatch");
    t.diagnostic(JSON.stringify({ prepared, replacement, interim, after, terminal }));
    assert.equal(
      attempts.length,
      1,
      "A replaced Pi wake must not invoke the obsolete callback again",
    );
  } catch (error) {
    try {
      t.diagnostic(JSON.stringify({ diagnostic: "source-pi-wake-failure", phase }));
    } catch {
      // Diagnostic failure must not replace the original runtime error.
    }
    throw error;
  } finally {
    mark("cleanup");
    try {
      if (cleanupProbe) {
        try {
          await cleanupProbe.releaseFailure();
          await drive?.catch(() => {});
        } finally {
          await cleanupProbe.close();
        }
      }
    } finally {
      try {
        await server?.close();
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    }
  }
});
