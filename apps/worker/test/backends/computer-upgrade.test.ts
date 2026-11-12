import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { createTestHarness } from "wrangler";

test("actual Computer reconnect waits for closing Loader handle and preserves complete synchronized writes", {
  timeout: 30000,
}, async (t) => {
  const root = resolve(import.meta.dirname, "../../../..");
  const harness = createTestHarness({
    root,
    workers: [
      {
        config: {
          name: "computer-upgrade",
          main: resolve(root, "apps/worker/test/backends/computer-upgrade-worker.ts"),
          compatibility_date: "2026-11-10",
          compatibility_flags: ["nodejs_compat"],
          worker_loaders: [{ binding: "LOADER" }],
          durable_objects: { bindings: [{ name: "PROBES", class_name: "UpgradeProbe" }] },
          migrations: [{ tag: "v1", new_sqlite_classes: ["UpgradeProbe"] }],
        },
      },
    ],
  });
  try {
    await harness.listen();
    const response = await harness.fetch("/");
    assert.equal(response.status, 200);
    const result = (await response.json()) as {
      first: string;
      firstSync: string;
      firstSkipped: number;
      second: string;
      secondSync: string;
      secondSkipped: number;
      content: string;
      overlapped: boolean;
      physicalBytes: number;
      tables: string[];
    };
    assert.equal(result.first, "completed");
    assert.equal(result.firstSync, "complete");
    assert.equal(result.firstSkipped, 0);
    assert.equal(result.second, "completed");
    assert.equal(result.secondSync, "complete");
    assert.equal(result.secondSkipped, 0);
    assert.equal(result.content, "second");
    assert.equal(
      result.overlapped,
      false,
      "A new actual module connection overlapped old-handle drain",
    );
    t.diagnostic(
      JSON.stringify({ physicalBytes: result.physicalBytes, actualTables: result.tables }),
    );
  } finally {
    await harness.close();
  }
});
