import assert from "node:assert/strict";
import { manifestDigest } from "fortipi-contract";
import { hash } from "../../../../packages/fortipi-executor/dist/index.js";
import type * as D from "../../src/boundary/dto.js";
import type { harness } from "../agent/harness.ts";

/** Public non-job lease/upload/commit only; actual Computer child bytes, no seeded rows. */
export async function computerBase(
  h: Awaited<ReturnType<typeof harness>>,
  binding: D.WorkspaceBinding,
  token: string,
  files: number,
): Promise<D.WorkspaceBinding> {
  const bytes = new TextEncoder().encode("actual snapshot input\n"),
    sha256 = hash(bytes),
    manifest: D.Manifest = {
      version: 1,
      entries: Array.from({ length: files }, (_, i) => ({
        path: `file-${String(i).padStart(3, "0")}.txt`,
        type: "file",
        mode: 420,
        size: bytes.byteLength,
        sha256,
      })),
    },
    manifestHash = await manifestDigest(manifest),
    workspaceId = binding.workspaceId,
    base = `/v1/workspaces/${workspaceId}`,
    operationId = crypto.randomUUID(),
    commitId = crypto.randomUUID();
  const acquired = await h.api<D.WorkspaceOperationLease>(
    `${base}/leases`,
    {
      requestId: crypto.randomUUID(),
      operationId,
      bindingVersion: binding.bindingVersion,
      baseRevision: binding.revision,
      deadline: Date.now() + 120000,
    },
    "POST",
    token,
  );
  assert.equal(acquired.status, 201, JSON.stringify(acquired.body));
  const lease = acquired.body;
  const opened = await h.api<D.UploadStatus>(
    `${base}/uploads`,
    {
      requestId: crypto.randomUUID(),
      baseRevision: binding.revision,
      lease,
      operationId,
      commitId,
      manifest,
      manifestHash,
      mutations: manifest.entries.map((entry) => ({
        kind: "put",
        path: entry.path,
        mode: 420,
        size: bytes.byteLength,
        sha256,
      })),
    },
    "POST",
    token,
  );
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  const chunk = await h.server.fetch(
    `http://fortipi.local${base}/uploads/${opened.body.uploadId}/blobs/${sha256}/chunks/0?length=${bytes.byteLength}&sha256=${sha256}`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
      body: bytes,
    },
  );
  assert.equal(chunk.status, 204, chunk.status === 204 ? "" : await chunk.text());
  const validated = await h.api<D.UploadValidation>(
    `${base}/uploads/${opened.body.uploadId}/validate`,
    undefined,
    "POST",
    token,
  );
  assert.equal(validated.status, 200, JSON.stringify(validated.body));
  const committed = await h.api<D.CommitReceipt>(
    `${base}/uploads/${opened.body.uploadId}/commit`,
    {
      requestId: crypto.randomUUID(),
      stageId: validated.body.stageId,
      commitId,
      uploadId: opened.body.uploadId,
      operationId,
      workspaceId,
      lease,
      manifestHash,
      baseRevision: binding.revision,
    },
    "POST",
    token,
  );
  assert.equal(committed.status, 200, JSON.stringify(committed.body));
  const released = await h.api(
    `${base}/leases/${lease.leaseId}/release`,
    { requestId: crypto.randomUUID(), lease, reason: "completed" },
    "POST",
    token,
  );
  assert.equal(released.status, 200, JSON.stringify(released.body));
  assert.equal(committed.body.manifestHash, manifestHash);
  return { ...binding, revision: committed.body.revision, manifestHash };
}
