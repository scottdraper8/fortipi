import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import { pause } from "./harness.ts";
import type { FixedWakeProbe } from "./pi-fixed-wake-worker.js";

test("actual PiHarness fixed wake preserves sleeping work across an older idle outcome", {
  timeout: 50000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "fortipi-fixed-wake-")),
    configPath = join(directory, "wrangler.json");
  await writeFile(
    configPath,
    JSON.stringify({
      name: "fortipi-fixed-wake",
      main: resolve("apps/worker/test/agent/pi-fixed-wake-worker.ts"),
      compatibility_date: "2026-11-10",
      compatibility_flags: ["nodejs_compat", "enable_request_signal", "request_signal_passthrough"],
      durable_objects: { bindings: [{ name: "PROBE", class_name: "FixedWakeProbe" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["FixedWakeProbe"] }],
    }),
  );
  process.env.WRANGLER_SEND_METRICS = "false";
  process.env.XDG_CONFIG_HOME = join(directory, "xdg");
  process.env.XDG_CACHE_HOME = join(directory, "cache");
  const { createTestHarness } = await import("wrangler"),
    server = createTestHarness({ root: directory, workers: [{ configPath }] });
  await server.listen();
  const env = await server.getWorker<{ PROBE: DurableObjectNamespace<FixedWakeProbe> }>().getEnv(),
    probe = env.PROBE.getByName("actual-pi");
  let drive: Promise<void> | undefined;
  const drives: Promise<void>[] = [];
  try {
    await probe.begin();
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
    await probe.sleepingSuccessor();
    for (let i = 0; i < 150; i++) {
      current = await probe.state();
      if (current.taskStatus === "sleeping" && current.row && current.row.time > Date.now()) break;
      await pause(20);
    }
    assert.equal(current.taskStatus, "sleeping");
    assert.ok(
      current.row && current.row.time > Date.now(),
      "Actual onWake must durably arm the future successor first",
    );
    const before = current;
    await probe.release();
    for (const result of await Promise.allSettled(drives)) assert.equal(result.status, "fulfilled");
    await pause(25);
    const after = await probe.state();
    console.log(JSON.stringify({ before, after }));
    assert.ok(after.row, "Older idle outcome must not erase PiHarness's newer durable wake");
    assert.ok(after.alarm !== null, "Sleeping Pi work requires an offline durable alarm");
  } finally {
    await probe.release();
    await Promise.allSettled(drives);
    await probe.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
