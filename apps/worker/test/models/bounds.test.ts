import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { BoundsProbe } from "./bounds-worker.js";

test("public provider bound preserves100KiB Pi answers and refuses encoded text/reasoning/arguments/errors/progress pressure", {
  timeout: 45000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "fortipi-model-bounds-")),
    configPath = join(directory, "wrangler.json");
  await writeFile(
    configPath,
    JSON.stringify({
      name: "fortipi-model-bounds",
      main:
        process.env.FORTIPI_T5_BOUNDS_WORKER ?? resolve("apps/worker/test/models/bounds-worker.ts"),
      compatibility_date: "2026-11-10",
      compatibility_flags: ["nodejs_compat", "enable_request_signal", "request_signal_passthrough"],
      durable_objects: { bindings: [{ name: "PROBE", class_name: "BoundsProbe" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["BoundsProbe"] }],
    }),
  );
  process.env.WRANGLER_SEND_METRICS = "false";
  process.env.XDG_CONFIG_HOME = join(directory, "xdg");
  process.env.XDG_CACHE_HOME = join(directory, "cache");
  const { createTestHarness } = await import("wrangler"),
    server = createTestHarness({ root: directory, workers: [{ configPath }] });
  await server.listen();
  try {
    const env = await server.getWorker<{ PROBE: DurableObjectNamespace<BoundsProbe> }>().getEnv();
    const accepted = await env.PROBE.getByName("hundred-KiB").run("text", 102400);
    assert.equal(accepted.status, "done");
    assert.equal(accepted.textBytes, 102400);
    assert.ok(accepted.physicalAfter > accepted.physicalBefore, "Measure real persisted Pi state");
    assert.ok(accepted.retainedBytes >= 102400, "Reopen must retain actual Pi assistant entries");
    const chunked = await env.PROBE.getByName("chunked-hundred-KiB").run("chunked", 102400);
    console.log(JSON.stringify({ kind: "chunked", ...chunked }));
    assert.equal(chunked.status, "done");
    assert.equal(chunked.textBytes, 102400);
    assert.equal(chunked.chunkBytes, 256);
    assert.ok(chunked.retainedBytes >= 102400);
    assert.ok(
      chunked.physicalAfter - chunked.physicalBefore <= 8 * 1024 * 1024,
      "Bound this actual fixture's persisted growth; no aggregate Agent claim",
    );
    const churn = await env.PROBE.getByName("high-churn").run("high-churn", 102400);
    console.log(JSON.stringify({ kind: "high-churn", ...churn }));
    assert.equal(churn.status, "done", "Contiguous small deltas share bounded snapshot work");
    assert.equal(churn.chunkBytes, 32);
    assert.equal(churn.textBytes, 102400);
    assert.ok(churn.retainedBytes >= 102400);
    assert.ok(churn.physicalAfter - churn.physicalBefore <= 8 * 1024 * 1024);
    for (const [kind, size] of [
      ["text", 524288],
      ["unicode", 100000],
      ["thinking", 524288],
      ["thinking-unicode", 70000],
      ["tool", 70000],
      ["tool-unicode", 18000],
      ["error", 524288],
      ["progress", 1],
    ] as const) {
      const rejected = await env.PROBE.getByName(kind).run(kind, size);
      console.log(JSON.stringify({ kind, ...rejected }));
      assert.equal(rejected.status, "unanswered", kind);
      assert.ok(
        rejected.maxAssistantBytes < 65536,
        `${kind}: oversized data must not become a committed assistant entry`,
      );
      assert.equal(rejected.containsLargeData, false, kind);
      assert.equal(rejected.providerCancelled, true, kind);
    }
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
