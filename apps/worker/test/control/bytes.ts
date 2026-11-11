import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { validateChunkInventory } from "fortipi-contract";
import type * as D from "../../src/boundary/dto.js";
export async function chunk(
  path: string,
  index: number,
  chunkBytes: number,
  size: number,
): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const bytes = new Uint8Array(Math.min(chunkBytes, size - index * chunkBytes));
    const read = await handle.read(bytes, 0, bytes.length, index * chunkBytes);
    assert.equal(read.bytesRead, bytes.length);
    return bytes;
  } finally {
    await handle.close();
  }
}
export async function inventory(
  path: string,
  size: number,
  chunkBytes: number,
): Promise<{ sha256: string; chunks: D.ChunkInventory }> {
  const owner = await open(path, "r");
  try {
    const stat = await owner.stat();
    assert.ok(stat.isFile());
    assert.equal(stat.size, size, "inventory requires the actual retained owner file");
  } finally {
    await owner.close();
  }
  const full = createHash("sha256");
  const chunkHashes: string[] = [];
  for (let index = 0; index < Math.ceil(size / chunkBytes); index++) {
    const bytes = await chunk(path, index, chunkBytes, size);
    full.update(bytes);
    chunkHashes.push(createHash("sha256").update(bytes).digest("hex"));
  }
  const chunks = { chunkBytes, chunkHashes };
  validateChunkInventory(chunks, size);
  return { sha256: full.digest("hex"), chunks };
}
