import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { ChunkInventory } from "fortipi-contract";
import { harness } from "./harness.ts";

test("range inventory hashes actual bytes independently of stream fragmentation and preserves its grid", async () => {
  const bytes = Uint8Array.from({ length: 600013 }, (_, i) => i % 239);
  const sha = (input: Uint8Array) => createHash("sha256").update(input).digest("hex");
  const grid = 17003;
  const server = harness();
  try {
    await server.listen();
    const response = await server.fetch(`/inventory?size=${bytes.length}&grid=${grid}`, {
      method: "POST",
      body: bytes,
    });
    assert.equal(response.status, 200);
    const result = (await response.json()) as { sha256: string; chunks: ChunkInventory };
    assert.equal(result.sha256, sha(bytes));
    assert.equal(result.chunks.chunkBytes, grid);
    assert.deepEqual(
      result.chunks.chunkHashes,
      Array.from({ length: Math.ceil(bytes.length / grid) }, (_, i) =>
        sha(bytes.slice(i * grid, (i + 1) * grid)),
      ),
    );
    const empty = await (
      await server.fetch(`/inventory?size=0&grid=${grid}`, {
        method: "POST",
        body: new Uint8Array(),
      })
    ).json();
    assert.deepEqual(empty, {
      sha256: sha(new Uint8Array()),
      chunks: { chunkBytes: grid, chunkHashes: [] },
    });
  } finally {
    await server.close();
  }
});
