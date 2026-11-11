import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { freeInfrastructurePolicy } from "fortipi-contract";
import type * as D from "../../src/boundary/dto.ts";
import type { AdminStorageFixture } from "./fixtures/admin-storage.ts";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function value<T>(encoded: string): T {
  const result: D.Outcome<T> = JSON.parse(encoded);
  assert.ok(result.ok, encoded);
  return result.value;
}
function rejected(encoded: string, message: RegExp): void {
  const result: D.Outcome<unknown> = JSON.parse(encoded);
  assert.equal(result.ok, false);
  if (result.ok) assert.fail("Expected actual storage rejection");
  assert.equal(result.code, "conflict");
  assert.match(result.message, message);
}
async function storageFixture() {
  const directory = await mkdtemp(join(tmpdir(), "fortipi-admin-storage-")),
    configPath = join(directory, "wrangler.json");
  await writeFile(
    configPath,
    JSON.stringify({
      name: "admin-storage-test",
      main: resolve("apps/worker/test/control/fixtures/admin-storage.ts"),
      compatibility_date: "2026-11-10",
      compatibility_flags: ["nodejs_compat", "enable_request_signal", "request_signal_passthrough"],
      vars: { FORTIPI_CONFIG: { version: 1, infrastructure: freeInfrastructurePolicy } },
      durable_objects: {
        bindings: [{ name: "CONTROL_PLANE", class_name: "AdminStorageFixture" }],
      },
      migrations: [{ tag: "v1", new_sqlite_classes: ["AdminStorageFixture"] }],
    }),
  );
  const { createTestHarness } = await import("wrangler"),
    server = createTestHarness({ root: directory, workers: [{ configPath }] });
  await server.listen();
  const worker = server.getWorker<{
    CONTROL_PLANE: DurableObjectNamespace<AdminStorageFixture>;
  }>();
  const env = await worker.getEnv();
  return {
    cp: env.CONTROL_PLANE.getByName("control"),
    worker,
    async close() {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("admin bytes are real SQLite BLOBs, idempotent and independently hashed across chunks", async () => {
  const f = await storageFixture();
  try {
    const bytes = Uint8Array.from({ length: 393217 }, (_, i) => (i * 23 + 9) % 251);
    const baseline: { jsonRows: number } = JSON.parse(await f.cp.audit());
    for (let ordinal = 0; ordinal < 7; ordinal++)
      assert.equal(
        value(
          await f.cp.put(
            "artifact",
            ordinal,
            bytes.subarray(ordinal * 65536, (ordinal + 1) * 65536),
          ),
        ),
        true,
      );
    assert.equal(value(await f.cp.put("artifact", 0, bytes.subarray(0, 65536))), true);
    assert.equal(value(await f.cp.verify("artifact", bytes.length, sha(bytes))), sha(bytes));
    assert.deepEqual(JSON.parse(await f.cp.audit()), {
      rows: 7,
      bytes: bytes.length,
      blobRows: 7,
      jsonRows: baseline.jsonRows,
    });
    const response = await f.worker.fetch(
      `http://fixture/bytes?size=${bytes.length}&sha256=${sha(bytes)}`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
    rejected(await f.cp.put("artifact", 0, new Uint8Array([1])), /cannot change/);
  } finally {
    await f.close();
  }
});

test("retained zero/range bytes verify and truncation or same-length corruption cannot pass", async () => {
  const f = await storageFixture();
  try {
    const baseline: { jsonRows: number } = JSON.parse(await f.cp.audit());
    const bytes = Uint8Array.from({ length: 131089 }, (_, i) => (i * 13) % 239),
      digest = sha(bytes);
    value(await f.cp.put("artifact", 0, bytes.subarray(0, 65536)));
    rejected(await f.cp.verify("artifact", bytes.length, digest), /integrity mismatch/);
    value(await f.cp.put("artifact", 1, bytes.subarray(65536, 131072)));
    value(await f.cp.put("artifact", 2, bytes.subarray(131072)));
    const response = await f.worker.fetch(
      `http://fixture/bytes?size=${bytes.length}&sha256=${digest}`,
      { headers: { Range: "bytes=31-120030" } },
    );
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("Content-Range"), `bytes 31-120030/${bytes.length}`);
    const selected = new Uint8Array(await response.arrayBuffer());
    assert.deepEqual(selected, bytes.subarray(31, 120031));
    assert.equal(response.headers.get("X-Content-SHA256"), sha(selected));
    const corrupted = bytes.slice(0, 65536);
    corrupted[29] = (corrupted[29] ?? 0) ^ 1;
    await f.cp.tamper("artifact", 0, corrupted);
    rejected(await f.cp.verify("artifact", bytes.length, digest), /integrity mismatch/);
    await f.cp.remove("artifact");
    const empty = new Uint8Array();
    assert.equal(value(await f.cp.verify("empty", 0, sha(empty))), sha(empty));
    const zero = await f.worker.fetch(`http://fixture/bytes?id=empty&size=0&sha256=${sha(empty)}`);
    assert.equal((await zero.arrayBuffer()).byteLength, 0);
    assert.deepEqual(JSON.parse(await f.cp.audit()), {
      rows: 0,
      bytes: 0,
      blobRows: 0,
      jsonRows: baseline.jsonRows,
    });
  } finally {
    await f.close();
  }
});

test("near-full install retains pending claims while prepaid CP storage covers bounded BLOB growth once", async () => {
  const f = await storageFixture();
  try {
    const pending = Uint8Array.from({ length: 65536 }, (_, i) => (i * 7) % 241);
    value(await f.cp.put("pending", 0, pending));
    const before: {
      usage: { reserved: number; consumed: number; slots: number };
      physical: number;
    } = JSON.parse(await f.cp.nearFullReservation());
    const admitted: D.Outcome<unknown> = JSON.parse(
      await f.cp.put("pending", 1, new Uint8Array(65536)),
    );
    assert.equal(
      admitted.ok,
      true,
      "The CP floor already covers this physical growth; it must not be charged twice",
    );
    const after: {
      usage: { reserved: number; consumed: number; slots: number };
      physical: number;
      ready: number;
    } = JSON.parse(await f.cp.usage());
    assert.deepEqual(after.usage, before.usage);
    assert.ok(after.physical > before.physical);
    assert.equal(after.ready, 0);
    const combined = new Uint8Array(pending.length * 2);
    combined.set(pending);
    assert.equal(
      value(await f.cp.verify("pending", combined.length, sha(combined))),
      sha(combined),
    );
  } finally {
    await f.close();
  }
});

test("actual chunk stream stays pull-driven, stops after cancel and rejects a durable credential floor before the next chunk", async () => {
  const f = await storageFixture();
  try {
    value(await f.cp.put("artifact", 0, new Uint8Array(65536)));
    value(await f.cp.put("artifact", 1, new Uint8Array(65536)));
    assert.deepEqual(JSON.parse(await f.cp.streamingGuard(false)), {
      initial: 0,
      first: 65536,
      afterFirst: 2,
      idle: 2,
      afterCancel: 2,
    });
    assert.deepEqual(JSON.parse(await f.cp.streamingGuard(true)), {
      initial: 0,
      first: 65536,
      afterFirst: 2,
      idle: 2,
      code: "unauthenticated",
      afterRevoke: 3,
    });
  } finally {
    await f.close();
  }
});
