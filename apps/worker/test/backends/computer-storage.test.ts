import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import { createTestHarness } from "wrangler";

test("Computer lazy reads survive overwrite; failed staged writes preserve committed bytes after owner reopen", {
  timeout: 30_000,
}, async (t) => {
  const root = resolve(import.meta.dirname, "../../../..");
  const harness = createTestHarness({
    root,
    workers: [
      {
        config: {
          name: "computer-storage",
          main: resolve(root, "apps/worker/test/backends/computer-storage-worker.ts"),
          compatibility_date: "2026-11-10",
          compatibility_flags: ["nodejs_compat"],
          durable_objects: { bindings: [{ name: "PROBES", class_name: "ComputerStorageProbe" }] },
          migrations: [{ tag: "v1", new_sqlite_classes: ["ComputerStorageProbe"] }],
        },
      },
    ],
  });
  const original = Uint8Array.from({ length: 1_100_013 }, (_, i) => (i * 17 + 3) % 251);
  const replacement = Uint8Array.from(original, (b) => (b + 1) % 251);
  const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  try {
    await harness.listen();
    const response = await harness.fetch("/");
    assert.equal(response.status, 200);
    const observed = (await response.json()) as {
      firstChunkBytes: number;
      originalBytes: number;
      oldDigest: string;
      writeRejected: boolean;
      sourcePulls: number;
      afterFailure: string;
      reopened: string;
      emptyBytes: number;
      physicalBytes: number;
    };
    assert.ok(
      observed.firstChunkBytes > 0 && observed.firstChunkBytes < original.length,
      "The overwrite must occur with independently unread canary bytes",
    );
    assert.equal(observed.originalBytes, original.length);
    assert.equal(observed.oldDigest, sha(original), "An active read lost its pre-overwrite bytes");
    assert.equal(observed.writeRejected, true, "A failed input stream was accepted");
    assert.equal(observed.sourcePulls, 2);
    assert.equal(
      observed.afterFailure,
      sha(replacement),
      "Partial staging replaced committed bytes",
    );
    assert.equal(observed.reopened, sha(replacement), "Owner close/reopen lost committed bytes");
    assert.equal(observed.emptyBytes, 0);
    assert.ok(Number.isSafeInteger(observed.physicalBytes) && observed.physicalBytes > 0);
    t.diagnostic(
      `Actual SQLite physical bytes after staging/cancel/reopen: ${observed.physicalBytes}; no logical deletion credit inferred`,
    );
  } finally {
    await harness.close();
  }
});
