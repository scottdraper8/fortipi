import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import { pause } from "./harness.ts";
import type { FixedWakeProbe } from "./pi-fixed-wake-worker.js";

type Phase =
  | "prepare"
  | "listen"
  | "environment"
  | "begin"
  | "hold-idle"
  | "sleep-successor"
  | "observe-successor"
  | "release-old"
  | "settle-old"
  | "final-read"
  | "final-assertions"
  | "cleanup-release"
  | "cleanup-drives"
  | "cleanup-pi"
  | "cleanup-server"
  | "cleanup-directory";

function diagnostic(record: object) {
  try {
    process.stderr.write(`# ${JSON.stringify(record)}\n`);
  } catch {
    // Diagnostics cannot change the test's control flow or rejection.
  }
}
function observeState(
  phase: "before-release" | "after-join",
  state: Awaited<ReturnType<FixedWakeProbe["state"]>>,
  until: number,
) {
  try {
    const remaining = until - Date.now();
    const bound = (value: number, min: number, max: number) =>
      Number.isFinite(value) ? Math.max(min, Math.min(max, Math.trunc(value))) : 0;
    const taskState = state.taskStatus;
    diagnostic({
      diagnostic: "source-fixed-wake-state",
      phase,
      taskState:
        taskState === undefined
          ? "missing"
          : ["pending", "running", "waiting", "sleeping", "completing", "terminal"].some(
                (known) => known === taskState,
              )
            ? taskState
            : "unknown",
      wakeActive: state.wake.active === true,
      wakeAtPresent: typeof state.wake.at === "number" && Number.isFinite(state.wake.at),
      wakeAtMatches: state.wake.at === until,
      rowPresent: state.row !== null,
      rowIdMatches: state.row?.id === "pi-wake",
      rowFnMatches: state.row?.fn === "wake",
      rowTimeMatches: state.row?.time === until,
      alarmPresent: typeof state.alarm === "number" && Number.isFinite(state.alarm),
      alarmTimeMatches: state.alarm === until,
      deadlineFuture: remaining > 0,
      remainingMs: bound(remaining, -60000, 60000),
      alarmsEntered: bound(state.alarms.entered, 0, 1000),
      alarmsSettled: bound(state.alarms.settled, 0, 1000),
      alarmsInFlight: bound(state.alarms.inFlight, 0, 1000),
    });
  } catch {
    // A failed projection cannot replace a body or cleanup failure.
  }
}

test("actual PiHarness fixed wake preserves sleeping work across an older idle outcome", {
  timeout: 50000,
}, async () => {
  let lastPhase: Phase = "prepare",
    bodyFailed = false,
    cleanupActive = false;
  const failure = (scope: "setup" | "body" | "cleanup") => {
    diagnostic({ diagnostic: "source-fixed-wake-failure", scope, lastPhase, bodyFailed });
  };
  try {
    const directory = await mkdtemp(join(tmpdir(), "fortipi-fixed-wake-")),
      configPath = join(directory, "wrangler.json");
    await writeFile(
      configPath,
      JSON.stringify({
        name: "fortipi-fixed-wake",
        main: resolve("apps/worker/test/agent/pi-fixed-wake-worker.ts"),
        compatibility_date: "2026-11-10",
        compatibility_flags: [
          "nodejs_compat",
          "enable_request_signal",
          "request_signal_passthrough",
        ],
        durable_objects: { bindings: [{ name: "PROBE", class_name: "FixedWakeProbe" }] },
        migrations: [{ tag: "v1", new_sqlite_classes: ["FixedWakeProbe"] }],
      }),
    );
    process.env.WRANGLER_SEND_METRICS = "false";
    process.env.XDG_CONFIG_HOME = join(directory, "xdg");
    process.env.XDG_CACHE_HOME = join(directory, "cache");
    const { createTestHarness } = await import("wrangler"),
      server = createTestHarness({ root: directory, workers: [{ configPath }] });
    lastPhase = "listen";
    await server.listen();
    lastPhase = "environment";
    const env = await server
        .getWorker<{ PROBE: DurableObjectNamespace<FixedWakeProbe> }>()
        .getEnv(),
      probe = env.PROBE.getByName("actual-pi");
    let drive: Promise<void> | undefined;
    const drives: Promise<void>[] = [];
    try {
      lastPhase = "begin";
      await probe.begin();
      lastPhase = "hold-idle";
      drive = probe.drive();
      drives.push(drive);
      let current = await probe.state();
      for (let i = 0; i < 150 && !current.held; i++) {
        await pause(20);
        current = await probe.state();
        if (i % 20 === 19 && !current.held) {
          await probe.prepareDrive();
          drives.push(probe.drive());
        }
      }
      assert.equal(
        current.held,
        true,
        "Real PiHarness must have produced an idle completion before interleaving",
      );
      lastPhase = "sleep-successor";
      const until = await probe.sleepingSuccessor();
      lastPhase = "observe-successor";
      for (let i = 0; i < 150; i++) {
        current = await probe.state();
        if (
          current.taskStatus === "sleeping" &&
          current.wake.active === false &&
          current.wake.at === until &&
          current.row?.time === until &&
          current.alarm === until &&
          until > Date.now()
        )
          break;
        await pause(20);
      }
      assert.equal(current.taskStatus, "sleeping");
      assert.equal(current.wake.active, false);
      assert.equal(current.wake.at, until);
      assert.equal(current.row?.id, "pi-wake");
      assert.equal(current.row?.fn, "wake");
      assert.equal(current.row?.time, until);
      assert.equal(current.alarm, until);
      assert.ok(
        current.row && current.row.time > Date.now(),
        "Actual onWake must durably arm the future successor first",
      );
      observeState("before-release", current, until);
      lastPhase = "release-old";
      const joined = await probe.releaseAndJoin();
      assert.ok(joined >= 1, "Join the entered dispatch through outcome application and rearming");
      lastPhase = "settle-old";
      for (const result of await Promise.allSettled(drives))
        assert.equal(result.status, "fulfilled");
      lastPhase = "final-read";
      const after = await probe.state();
      observeState("after-join", after, until);
      lastPhase = "final-assertions";
      assert.ok(after.row, "Older idle outcome must not erase PiHarness's newer durable wake");
      assert.ok(after.alarm !== null, "Sleeping Pi work requires an offline durable alarm");
      assert.equal(after.taskStatus, "sleeping");
      assert.equal(after.wake.active, false);
      assert.equal(after.wake.at, until);
      assert.equal(after.row.id, "pi-wake");
      assert.equal(after.row.fn, "wake");
      assert.equal(after.row.time, until);
      assert.equal(after.alarm, until);
    } catch (error) {
      bodyFailed = true;
      failure("body");
      throw error;
    } finally {
      cleanupActive = true;
      lastPhase = "cleanup-release";
      await probe.release();
      lastPhase = "cleanup-drives";
      await Promise.allSettled(drives);
      lastPhase = "cleanup-pi";
      await probe.close();
      lastPhase = "cleanup-server";
      await server.close();
      lastPhase = "cleanup-directory";
      await rm(directory, { recursive: true, force: true });
      cleanupActive = false;
    }
  } catch (error) {
    if (cleanupActive) failure("cleanup");
    else if (!bodyFailed) failure("setup");
    throw error;
  }
});
