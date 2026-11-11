import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { manifestDigest } from "fortipi-contract";
import type * as D from "../../src/boundary/dto.js";
import { harness } from "./harness.ts";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
test("ordered superseded puts, same-upload equal hashes and empty files retain exact authority", {
  timeout: 30_000,
}, async () => {
  const server = harness();
  async function call<T>(input: unknown): Promise<T> {
    const response = await server.fetch("/rpc", { method: "POST", body: JSON.stringify(input) });
    const result = (await response.json()) as D.Outcome<T>;
    if (!result.ok) assert.fail(JSON.stringify(result));
    return result.value;
  }
  try {
    await server.listen();
    await server.fetch("/seed");
    const lease = await call<D.Lease>({
      kind: "acquire",
      input: {
        ownerKind: "workspace-operation",
        operationId: "ordered-operation",
        operationDigest: "a".repeat(64),
        workspaceId: "workspace",
        bindingVersion: 1,
        target: { kind: "executor", executorId: "executor", generation: 1 },
        actions: ["workspace.write"],
        deadline: Date.now() + 30_000,
        expiresAt: Date.now() + 30_000,
      },
    });
    const old = new TextEncoder().encode("superseded bytes still require verification");
    const bytes = Uint8Array.from({ length: 300013 }, (_, index) => index % 239);
    const emptyHash = hash(new Uint8Array());
    const sha256 = hash(bytes);
    const manifest: D.Manifest = {
      version: 1,
      entries: [
        { type: "directory", path: "tree", mode: 493 },
        { type: "file", path: "tree/new", mode: 420, size: bytes.length, sha256 },
        { type: "file", path: "tree/copy", mode: 420, size: bytes.length, sha256 },
        { type: "file", path: "empty", mode: 420, size: 0, sha256: emptyHash },
      ],
    };
    const mutations: D.Mutation[] = [
      { kind: "put", path: "tree/old", mode: 420, size: old.length, sha256: hash(old) },
      { kind: "delete", path: "tree" },
      { kind: "mkdir", path: "tree", mode: 493 },
      { kind: "put", path: "tree/new", mode: 420, size: bytes.length, sha256 },
      { kind: "put", path: "tree/copy", mode: 420, size: bytes.length, sha256 },
      { kind: "put", path: "empty", mode: 420, size: 0, sha256: emptyHash },
    ];
    const manifestHash = await manifestDigest(manifest);
    const begun = await call<{ status: 201; body: D.UploadStatus }>({
      kind: "begin",
      input: {
        operationId: "beginUpload",
        path: { workspaceId: "workspace" },
        query: {},
        body: {
          requestId: "ordered-upload",
          operationId: lease.operationId,
          commitId: "ordered-commit",
          lease,
          baseRevision: lease.baseRevision,
          manifest,
          manifestHash,
          mutations,
        },
      },
    });
    for (const file of [old, bytes])
      for (let offset = 0, index = 0; offset < file.length; offset += 262144, index++) {
        const chunk = file.slice(offset, offset + 262144);
        await call({
          kind: "chunk",
          input: {
            operationId: "putUploadChunk",
            path: {
              workspaceId: "workspace",
              uploadId: begun.body.uploadId,
              sha256: hash(file),
              chunkIndex: index,
            },
            query: { length: chunk.length, sha256: hash(chunk) },
          },
          bytes: [...chunk],
        });
      }
    const validated = await call<{ status: 200; body: D.UploadValidation }>({
      kind: "validate",
      input: {
        operationId: "validateUpload",
        path: { workspaceId: "workspace", uploadId: begun.body.uploadId },
        query: {},
      },
    });
    const receipt = await call<{ status: 200; body: D.CommitReceipt }>({
      kind: "commit",
      input: {
        operationId: "commitUpload",
        path: { workspaceId: "workspace", uploadId: begun.body.uploadId },
        query: {},
        body: {
          requestId: "ordered-commit-request",
          stageId: validated.body.stageId,
          uploadId: begun.body.uploadId,
          commitId: "ordered-commit",
          operationId: lease.operationId,
          workspaceId: "workspace",
          lease,
          baseRevision: lease.baseRevision,
          manifestHash,
        },
      },
    });
    for (const path of ["tree/new", "tree/copy"]) {
      const response = await server.fetch(`/read?revision=${receipt.body.revision}&path=${path}`);
      assert.equal(response.status, 200);
      assert.equal(hash(new Uint8Array(await response.arrayBuffer())), sha256);
    }
    const empty = await server.fetch(`/read?revision=${receipt.body.revision}&path=empty`);
    assert.equal(empty.status, 200);
    assert.equal((await empty.arrayBuffer()).byteLength, 0);
    assert.equal(
      (
        await server.fetch(
          `/v1/workspaces/workspace/blobs/${hash(old)}?revision=${receipt.body.revision}`,
        )
      ).status,
      404,
      "Superseded staged blob leaked",
    );
    assert.equal(
      (await server.fetch(`/v1/workspaces/other/blobs/${sha256}?revision=${receipt.body.revision}`))
        .status,
      403,
      "Cross-workspace routing leaked committed bytes",
    );
    const ranged = await server.fetch(`/read?revision=${receipt.body.revision}&path=tree/new`, {
      headers: { Range: "bytes=262130-262160" },
    });
    assert.equal(ranged.status, 206);
    const part = new Uint8Array(await ranged.arrayBuffer());
    assert.equal(hash(part), hash(bytes.slice(262130, 262161)));
    assert.equal(ranged.headers.get("X-Content-SHA256"), hash(part));
  } finally {
    await server.close();
  }
});
