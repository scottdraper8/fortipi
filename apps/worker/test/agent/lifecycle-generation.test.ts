import assert from "node:assert/strict";
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
  assert.fail("Actual callback barrier not reached");
}
test("candidate immutable Lifecycle generation ID preserves newer wake and bounds work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fortipi-generation-"));
  const configPath = join(directory, "wrangler.json");
  await writeFile(
    configPath,
    JSON.stringify({
      name: "fortipi-generation",
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
  const probe = env.PROBE.getByName("candidate");
  try {
    await probe.arm(true);
    const old = probe.drive();
    await until(async () => (await probe.state()).oldCalls === 1);
    await probe.replace(true);
    const newer = probe.drive();
    await until(async () => (await probe.state()).newCalls === 1);
    await probe.releaseOldFailure();
    await old;
    await pause(1100);
    const held = await probe.state();
    assert.equal(held.effects, 0, "App CAS must suppress old effects");
    // replace(true) cancels the predecessor; its queued retry must be fenced:
    // https://github.com/cloudflare/agents/commit/5071d3cda939972fb532c93e9b46942b36d8f5d7
    assert.equal(held.oldCalls, 1, "A cancelled Lifecycle dispatch must not retry");
    assert.equal(held.exists, true, "Old outcome must not erase the distinct new row");
    assert.equal(held.fn, "new");
    assert.ok(held.queued <= 2, "Generation strategy must not accumulate queued rows");
    await probe.release();
    await newer;
    await until(async () => ((await probe.state()).time ?? 0) > Date.now());
    const resumed = await probe.state();
    assert.equal(resumed.exists, true);
    assert.ok(
      resumed.time! > Date.now(),
      "Supported returned rescheduleAt must preserve the next wake",
    );
    assert.equal(resumed.newCalls, 1);
    assert.equal(resumed.queued, 1, "Completed obsolete work must drain");
    console.log(JSON.stringify({ held, resumed }));
  } finally {
    await probe.releaseOldFailure();
    await probe.release();
    await probe.close();
    await server.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});
