import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { manifestDigest } from "fortipi-contract";
import type * as D from "../../src/boundary/dto.js";
import { nativeService } from "../execution/native-service.ts";

test("same scoped public client can begin a local upload under its actual acquired workspace-operation lease", {
  timeout: 45000,
}, async () => {
  const n = await nativeService({ approve: false, reconciliation: true });
  try {
    const binding = await n.h.api<D.WorkspaceBinding>(`/v1/workspaces/${n.workspaceId}`);
    assert.equal(binding.status, 200);
    const operationId = randomUUID();
    const acquired = await n.h.api<D.WorkspaceOperationLease>(
      `/v1/workspaces/${n.workspaceId}/leases`,
      {
        requestId: randomUUID(),
        operationId,
        bindingVersion: binding.body.bindingVersion,
        baseRevision: binding.body.revision,
        deadline: Date.now() + 120000,
      },
      "POST",
      n.actor.token,
    );
    assert.equal(acquired.status, 201);
    const bytes = Buffer.from("seed1010-local-public-stage\n");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const manifest: D.Manifest = {
      version: 1,
      entries: [{ path: "notes.txt", type: "file", mode: 420, size: bytes.byteLength, sha256 }],
    };
    const opened = await n.h.api<D.UploadStatus>(
      `/v1/workspaces/${n.workspaceId}/uploads`,
      {
        requestId: randomUUID(),
        operationId,
        commitId: randomUUID(),
        lease: acquired.body,
        baseRevision: binding.body.revision,
        manifest,
        manifestHash: await manifestDigest(manifest),
        mutations: [{ kind: "put", path: "notes.txt", mode: 420, size: bytes.byteLength, sha256 }],
        blobs: [{ sha256, chunks: { chunkBytes: 262144, chunkHashes: [sha256] } }],
      },
      "POST",
      n.actor.token,
    );
    assert.equal(
      opened.status,
      201,
      "A current exact lease and unchanged scoped client must permit public local staging",
    );
  } finally {
    await n.close();
  }
});
