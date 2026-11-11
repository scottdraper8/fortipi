import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";

test("actual local Loader isolate reads and writes rooted Computer scratch with complete sync", {
  timeout: 60_000,
}, async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
  const server = createTestHarness({
    root,
    workers: [
      {
        config: {
          name: "fortipi-codemode-probe",
          main: resolve(root, "apps/worker/test/backends/runtime-worker.ts"),
          compatibility_date: "2026-11-10",
          compatibility_flags: ["nodejs_compat"],
          worker_loaders: [{ binding: "LOADER" }],
          durable_objects: { bindings: [{ name: "WORKSPACES", class_name: "BackendProbe" }] },
          migrations: [{ tag: "v1", new_sqlite_classes: ["BackendProbe"] }],
        },
      },
    ],
  });
  try {
    await server.listen();
    const response = await server.fetch("/run?backend=js");
    assert.equal(response.status, 200);
    const result = (await response.json()) as {
      status: string;
      content: string;
      canary: boolean;
      sync: string;
      skipped: number;
    };
    assert.equal(result.status, "completed");
    assert.equal(result.content, "fortipi-result");
    assert.equal(result.canary, true);
    assert.equal(result.sync, "complete");
    assert.equal(result.skipped, 0);
  } finally {
    await server.close();
  }
});
