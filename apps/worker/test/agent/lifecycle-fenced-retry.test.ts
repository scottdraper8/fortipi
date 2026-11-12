import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import { eventually, pause } from "./harness.ts";
import type { RaceProbe } from "./race-worker.js";

for (const mode of ["cancel", "replace"] as const) {
  test(`official Lifecycle fence suppresses the old retry after ${mode}`, {
    timeout: 15000,
  }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "fortipi-lifecycle-fenced-"));
    const configPath = join(directory, "wrangler.json");
    await writeFile(
      configPath,
      JSON.stringify({
        name: "fortipi-lifecycle-fenced",
        main: resolve("apps/worker/test/agent/race-worker.ts"),
        compatibility_date: "2026-11-10",
        compatibility_flags: [
          "nodejs_compat",
          "enable_request_signal",
          "request_signal_passthrough",
        ],
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
    const probe = env.PROBE.getByName(`actual-${mode}`);
    const drives: Promise<void>[] = [];
    try {
      await probe.arm();
      const old = probe.drive();
      drives.push(old);
      void old.catch(() => {});
      await eventually(
        () => probe.state(),
        (state) => state.oldCalls === 1,
      );
      if (mode === "cancel") await probe.cancel();
      else {
        await probe.replace();
        const newer = probe.drive();
        drives.push(newer);
        void newer.catch(() => {});
        await eventually(
          () => probe.state(),
          (state) => state.newCalls === 1,
        );
      }
      await old;
      // Keep the replacement held across the existing fixture's complete
      // one-second retry interval, even if a platform alarm won the drive.
      await pause(1100);
      const held = await probe.state();
      t.diagnostic(JSON.stringify({ mode, held }));
      assert.equal(held.oldCalls, 1, "Superseded callbacks must not retry");
      assert.equal(held.effects, 0, "No obsolete application effect");
      if (mode === "cancel") {
        assert.equal(held.exists, false);
        assert.equal(held.queued, 0);
      } else {
        assert.equal(held.exists, true, "The old outcome cannot erase the in-flight replacement");
        assert.equal(held.fn, "new");
        assert.equal(held.newCalls, 1);
        assert.equal(held.queued, 1);
      }
    } finally {
      await probe.release();
      for (const result of await Promise.allSettled(drives))
        assert.equal(result.status, "fulfilled");
      await probe.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
