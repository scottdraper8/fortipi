import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { manifestDigest } from "fortipi-contract";
import type * as D from "../../src/boundary/dto.js";
import { harness } from "./harness.ts";

test("local admission checks every declared blob, final path, mutation count and the announced grid", async () => {
  const server = harness();
  const bytes = Uint8Array.from({ length: 700013 }, (_, i) => i % 239);
  const hash = (input: Uint8Array) => createHash("sha256").update(input).digest("hex");
  const sha256 = hash(bytes);
  const grid = 65536;
  const chunks = (input: Uint8Array, grid: number): D.ChunkInventory => ({
    chunkBytes: grid,
    chunkHashes: Array.from({ length: Math.ceil(input.length / grid) }, (_, i) =>
      hash(input.slice(i * grid, (i + 1) * grid)),
    ),
  });
  const limits: D.ExecutorTransferLimits = {
    chunkBytes: grid,
    fileBytes: 4 * 1024 * 1024,
    snapshotBytes: 2 * 1024 * 1024,
    artifactBytes: 1024 * 1024,
    manifestEntries: 512,
  };
  const lease: D.Lease = {
    ownerKind: "workspace-operation",
    leaseId: "lease",
    operationId: "operation",
    credential: { credentialId: "application", generation: 1, grantVersion: 1 },
    registrationId: "registration",
    workspaceId: "workspace",
    baseRevision: "base",
    executorId: "executor",
    executorGeneration: 1,
    fence: "1",
    leaseVersion: 1,
    expiresAt: Date.now() + 30000,
  };
  const upload: D.UploadBegin = {
    requestId: "request",
    operationId: "operation",
    commitId: "commit",
    baseRevision: "base",
    lease,
    manifestHash: "a".repeat(64),
    manifest: {
      version: 1,
      entries: ["one", "two"].map((path) => ({
        type: "file",
        path,
        mode: 420,
        size: bytes.length,
        sha256,
      })),
    },
    mutations: ["one", "two"].map((path) => ({
      kind: "put",
      path,
      mode: 420,
      size: bytes.length,
      sha256,
    })),
    blobs: [{ sha256, chunks: chunks(bytes, grid) }],
  };
  upload.manifestHash = await manifestDigest(upload.manifest);
  const admit = async (
    input: D.UploadBegin,
    caps: D.ExecutorTransferLimits | null = limits,
  ): Promise<boolean> => {
    const result = (await (
      await server.fetch("/admit", {
        method: "POST",
        body: JSON.stringify({ upload: input, limits: caps }),
      })
    ).json()) as D.Outcome<unknown>;
    return result.ok;
  };
  try {
    await server.listen();
    assert.equal(await admit(upload), true, "Valid >256KiB same-SHA paths were excluded");
    assert.equal(await admit(upload, null), false, "Missing observation guessed a default");
    assert.equal(
      await admit({ ...upload, blobs: [{ sha256, chunks: chunks(bytes, 262144) }] }),
      false,
      "Announced grid silently renegotiated",
    );
    assert.equal(await admit(upload, { ...limits, fileBytes: 600000 }), false);
    assert.equal(
      await admit(upload, { ...limits, snapshotBytes: 1000000 }),
      false,
      "Final duplicate paths were undercounted",
    );
    assert.equal(await admit(upload, { ...limits, manifestEntries: 1 }), false);
    const second = Uint8Array.from(bytes, (b) => b ^ 255);
    const secondHash = hash(second);
    const superseded: D.UploadBegin = {
      ...upload,
      manifest: {
        version: 1,
        entries: [
          { type: "file", path: "final", mode: 420, size: second.length, sha256: secondHash },
        ],
      },
      mutations: [
        { kind: "put", path: "old", mode: 420, size: bytes.length, sha256 },
        { kind: "delete", path: "old" },
        { kind: "put", path: "final", mode: 420, size: second.length, sha256: secondHash },
      ],
      blobs: [
        { sha256, chunks: chunks(bytes, grid) },
        { sha256: secondHash, chunks: chunks(second, grid) },
      ],
    };
    superseded.manifestHash = await manifestDigest(superseded.manifest);
    assert.equal(
      await admit(superseded, { ...limits, snapshotBytes: 1000000 }),
      false,
      "Superseded staged bytes were not admitted",
    );
    assert.equal(
      await admit(superseded, { ...limits, manifestEntries: 1 }),
      false,
      "Ordered mutations escaped entry capacity",
    );
    const emptyHash = hash(new Uint8Array());
    const empty: D.UploadBegin = {
      ...upload,
      manifest: {
        version: 1,
        entries: [{ type: "file", path: "empty", mode: 420, size: 0, sha256: emptyHash }],
      },
      mutations: [{ kind: "put", path: "empty", mode: 420, size: 0, sha256: emptyHash }],
      blobs: [{ sha256: emptyHash, chunks: { chunkBytes: grid, chunkHashes: [] } }],
    };
    empty.manifestHash = await manifestDigest(empty.manifest);
    assert.equal(await admit(empty), true);
  } finally {
    await server.close();
  }
});
