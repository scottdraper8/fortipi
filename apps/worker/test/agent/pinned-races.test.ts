import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import type { RaceProbe } from "./race-worker.js";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await predicate()) return;
    await pause(5);
  }
  assert.fail("Race barrier not reached");
}
test("characterize pinned Pi Node-only delayed publication rejection defect", async () => {
  // These are upstream negative controls, not Worker/service acceptance.
  // The calibrated actual Worker/task-runtime cases live in the Inspector test.
  for (const mode of ["cancel", "preaborted", "aftercall", "shutdown"]) {
    const directory = await mkdtemp(join(tmpdir(), "fortipi-node-pin-"));
    try {
      const result = await new Promise<{ code: number | null; out: string; error: string }>(
        (accept, reject) => {
          const child = spawn(
            process.execPath,
            [
              "--unhandled-rejections=strict",
              resolve("apps/worker/test/agent/pi-publication-process.ts"),
              mode,
              directory,
            ],
            { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH } },
          );
          let out = "",
            error = "";
          child.stdout.on("data", (chunk) => {
            out += String(chunk);
          });
          child.stderr.on("data", (chunk) => {
            error += String(chunk);
          });
          const timeout = setTimeout(() => child.kill("SIGKILL"), 15000);
          child.once("error", reject);
          child.once("exit", (code) => {
            clearTimeout(timeout);
            accept({ code, out, error });
          });
        },
      );
      if (mode === "cancel") {
        assert.equal(result.code, 0, result.error);
        assert.match(result.out, /"callerRejection":true/);
      } else {
        assert.equal(
          result.code,
          1,
          `${mode}: known Node diagnostic changed; reevaluate pinned compatibility`,
        );
        assert.match(result.error, mode === "shutdown" ? /Harness is closed/ : /pin-race-stop/);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
test("repaired Lifecycle same-ID replacement preserves its newer wake", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fortipi-lifecycle-race-"));
  const configPath = join(directory, "wrangler.json");
  await writeFile(
    configPath,
    JSON.stringify({
      name: "fortipi-lifecycle-race",
      main: resolve("apps/worker/test/agent/race-worker.ts"),
      compatibility_date: "2026-11-10",
      compatibility_flags: ["nodejs_compat", "enable_request_signal", "request_signal_passthrough"],
      durable_objects: { bindings: [{ name: "PROBE", class_name: "RaceProbe" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["RaceProbe"] }],
    }),
  );
  process.env.WRANGLER_SEND_METRICS = "false";
  process.env.XDG_CONFIG_HOME = join(directory, "xdg");
  process.env.XDG_CACHE_HOME = join(directory, "cache");
  const { createTestHarness } = await import("wrangler");
  const server = createTestHarness({ root: directory, workers: [{ configPath }] });
  await server.listen();
  const env = await server.getWorker<{ PROBE: DurableObjectNamespace<RaceProbe> }>().getEnv();
  const probe = env.PROBE.getByName("race");
  const drives: Promise<void>[] = [];
  try {
    await probe.arm();
    const old = probe.drive();
    drives.push(old);
    void old.catch(() => {});
    await until(async () => (await probe.state()).oldCalls === 1);
    await probe.replace();
    const newer = probe.drive();
    drives.push(newer);
    void newer.catch(() => {});
    await until(async () => (await probe.state()).newCalls === 1);
    await old;
    // A platform alarm may have won the first drive. Keep the replacement held
    // across the pinned retry's entire bounded jitter interval as well.
    await pause(1100);
    const state = await probe.state();
    console.log(JSON.stringify({ lifecycleRace: state }));
    // Revalidation prevented old effects, but a wake owned by the newer invocation must still exist.
    assert.equal(state.effects, 0, "Stale callback must not execute an effect");
    assert.equal(state.oldCalls, 1, "Superseded callbacks must not retry");
    assert.equal(state.exists, true, "The old outcome must preserve the in-flight replacement");
    assert.equal(state.fn, "new");
    assert.equal(state.newCalls, 1);
    assert.equal(state.queued, 1);
    await probe.release();
    await newer;
    await until(async () => !(await probe.state()).exists);
    const completed = await probe.state();
    assert.equal(completed.oldCalls, 1);
    assert.equal(completed.newCalls, 1);
    assert.equal(completed.effects, 0);
    assert.equal(completed.queued, 0, "The released replacement completes normally");
  } finally {
    await probe.release();
    for (const result of await Promise.allSettled(drives)) assert.equal(result.status, "fulfilled");
    await probe.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
