import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { type CommitReceipt, type JobCommitted, manifestDigest } from "fortipi-contract";
import type * as D from "../../src/boundary/dto.js";
import { harness } from "./harness.ts";

test("write-only publication and terminal proof retain original evidence under current least privilege", {
  timeout: 30_000,
}, async () => {
  const server = harness();
  const write = { "x-test-write-only": "1" };
  const read = { "x-test-read-only": "1" };
  const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const rpc = async <T>(
    body: unknown,
    headers: Record<string, string> = write,
  ): Promise<D.Outcome<T>> =>
    (await (
      await server.fetch("/rpc", { method: "POST", headers, body: JSON.stringify(body) })
    ).json()) as D.Outcome<T>;
  const call = async <T>(body: unknown): Promise<T> => {
    const result = await rpc<T>(body);
    if (!result.ok) assert.fail(JSON.stringify(result));
    return result.value;
  };
  const proof = (body: unknown, headers: Record<string, string> = write) =>
    server.fetch("/terminal-proof", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  try {
    await server.listen();
    const seeded = (await (await server.fetch("/seed")).json()) as D.Outcome<D.WorkspaceBinding>;
    if (!seeded.ok) assert.fail(JSON.stringify(seeded));
    const target: Extract<D.TargetRequest, { ownerKind: "job" }> = {
      ownerKind: "job",
      jobId: "proof-job",
      executionId: "proof-execution",
      operationId: "proof-operation",
      operationDigest: "a".repeat(64),
      workspaceId: "workspace",
      bindingVersion: 1,
      agentId: "agent",
      conversationId: "conversation",
      target: { kind: "executor", executorId: "executor", generation: 1 },
      actions: ["workspace.write"],
      deadline: Date.now() + 2500,
      expiresAt: Date.now() + 2500,
    };
    const lease = await call<D.Lease>({ kind: "acquire", input: target });
    const bytes = Uint8Array.from({ length: 393217 }, (_, index) => index % 251);
    const sha256 = digest(bytes);
    const manifest: D.Manifest = {
      version: 1,
      entries: [{ type: "file", path: "only-write.txt", mode: 420, size: bytes.length, sha256 }],
    };
    const manifestHash = await manifestDigest(manifest);
    const begin = await call<{ status: 201; body: D.UploadStatus }>({
      kind: "begin",
      input: {
        operationId: "beginUpload",
        path: { workspaceId: "workspace" },
        query: {},
        body: {
          requestId: "only-write-upload",
          operationId: lease.operationId,
          commitId: "only-write-commit",
          lease,
          baseRevision: lease.baseRevision,
          manifest,
          manifestHash,
          mutations: [
            { kind: "put", path: "only-write.txt", mode: 420, size: bytes.length, sha256 },
          ],
        },
      },
    });
    for (let offset = 0, index = 0; offset < bytes.length; offset += 262144, index++) {
      const chunk = bytes.slice(offset, offset + 262144);
      await call({
        kind: "chunk",
        input: {
          operationId: "putUploadChunk",
          path: {
            workspaceId: "workspace",
            uploadId: begin.body.uploadId,
            sha256,
            chunkIndex: index,
          },
          query: { length: chunk.length, sha256: digest(chunk) },
        },
        bytes: [...chunk],
      });
    }
    const stage = await call<{ status: 200; body: D.UploadValidation }>({
      kind: "validate",
      input: {
        operationId: "validateUpload",
        path: { workspaceId: "workspace", uploadId: begin.body.uploadId },
        query: {},
      },
    });
    const commit: D.UploadCommit = {
      requestId: "write-commit",
      commitId: "only-write-commit",
      uploadId: begin.body.uploadId,
      operationId: lease.operationId,
      jobId: target.jobId,
      workspaceId: "workspace",
      lease,
      baseRevision: lease.baseRevision,
      manifestHash,
      stageId: stage.body.stageId,
    };
    const commitCall = {
      kind: "commit",
      input: {
        operationId: "commitUpload",
        path: { workspaceId: "workspace", uploadId: begin.body.uploadId },
        query: {},
        body: commit,
      },
    };
    const receipt = (await call<{ status: 200; body: CommitReceipt }>(commitCall)).body;
    const data = await server.fetch(`/read?revision=${receipt.revision}&path=only-write.txt`);
    assert.equal(digest(new Uint8Array(await data.arrayBuffer())), sha256);
    assert.equal(
      (
        await server.fetch(`/read?revision=${receipt.revision}&path=only-write.txt`, {
          headers: write,
        })
      ).status,
      403,
    );
    for (const denied of [
      {
        kind: "manifest",
        input: {
          operationId: "getWorkspaceManifest",
          path: { workspaceId: "workspace" },
          query: { revision: receipt.revision },
        },
      },
      {
        kind: "stat",
        input: {
          operationId: "statWorkspaceFile",
          path: { workspaceId: "workspace" },
          query: { revision: receipt.revision, path: "only-write.txt" },
        },
      },
      {
        kind: "receipt",
        input: {
          workspaceId: "workspace",
          commitId: receipt.commitId,
          commitDigest: receipt.commitDigest,
        },
      },
    ]) {
      const result = await rpc(denied);
      assert.equal(result.ok, false, "Writer gained a public read capability");
      if (!result.ok) assert.equal(result.code, "unauthorized");
    }
    await delay(Math.max(0, lease.expiresAt - Date.now() + 10));
    assert.deepEqual(
      (await call<{ status: 200; body: CommitReceipt }>(commitCall)).body,
      receipt,
      "Lost acknowledgment retry required public read or a fresh historical lease",
    );
    const identity: D.ExecutionIdentity = {
      jobId: target.jobId,
      executionId: target.executionId,
      operationDigest: target.operationDigest,
      assignmentDigest: "b".repeat(64),
      target: target.target,
      lease,
      baseRevision: lease.baseRevision,
      deadline: target.deadline,
    };
    const committed: JobCommitted = {
      identity,
      evidence: { kind: "committed", receipt },
      terminalVersion: 2,
      eventSeq: 7,
    };
    const accepted = await proof(committed);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(await accepted.json(), committed);
    // A write-only successor must copy actual retained bytes into a complete new store.
    const nextTarget = {
      ...target,
      operationId: "copy-operation",
      executionId: "copy-execution",
      jobId: "copy-job",
      deadline: Date.now() + 30_000,
      expiresAt: Date.now() + 30_000,
    };
    const nextLease = await call<D.Lease>({ kind: "acquire", input: nextTarget });
    const emptyHash = digest(new Uint8Array());
    const nextManifest: D.Manifest = {
      version: 1,
      entries: [
        ...manifest.entries,
        { type: "file", path: "empty.txt", mode: 420, size: 0, sha256: emptyHash },
      ],
    };
    const nextHash = await manifestDigest(nextManifest);
    const nextUpload = await call<{ status: 201; body: D.UploadStatus }>({
      kind: "begin",
      input: {
        operationId: "beginUpload",
        path: { workspaceId: "workspace" },
        query: {},
        body: {
          requestId: "copy-upload",
          operationId: nextLease.operationId,
          commitId: "copy-commit",
          lease: nextLease,
          baseRevision: nextLease.baseRevision,
          manifest: nextManifest,
          manifestHash: nextHash,
          mutations: [{ kind: "put", path: "empty.txt", mode: 420, size: 0, sha256: emptyHash }],
        },
      },
    });
    const nextStage = await call<{ status: 200; body: D.UploadValidation }>({
      kind: "validate",
      input: {
        operationId: "validateUpload",
        path: { workspaceId: "workspace", uploadId: nextUpload.body.uploadId },
        query: {},
      },
    });
    const nextReceipt = (
      await call<{ status: 200; body: CommitReceipt }>({
        kind: "commit",
        input: {
          operationId: "commitUpload",
          path: { workspaceId: "workspace", uploadId: nextUpload.body.uploadId },
          query: {},
          body: {
            ...commit,
            requestId: "copy-publish",
            commitId: "copy-commit",
            uploadId: nextUpload.body.uploadId,
            operationId: nextLease.operationId,
            jobId: nextTarget.jobId,
            lease: nextLease,
            baseRevision: nextLease.baseRevision,
            manifestHash: nextHash,
            stageId: nextStage.body.stageId,
          },
        },
      })
    ).body;
    const copied = await server.fetch(`/read?revision=${nextReceipt.revision}&path=only-write.txt`);
    assert.equal(digest(new Uint8Array(await copied.arrayBuffer())), sha256);
    assert.equal(
      (await proof(committed, read)).status,
      403,
      "Committed proof did not require write",
    );
    assert.equal((await proof(committed, { ...write, "x-test-unregistered": "1" })).status, 403);
    assert.equal(
      (await proof(committed, { ...write, "x-test-other-conversation": "1" })).status,
      403,
      "Wrong conversation received a terminal proof",
    );
    for (const forged of [
      { ...committed, identity: { ...identity, executionId: "forged-execution" } },
      { ...committed, identity: { ...identity, operationDigest: "c".repeat(64) } },
      { ...committed, identity: { ...identity, lease: { ...lease, fence: "999" } } },
      {
        ...committed,
        evidence: { kind: "committed", receipt: { ...receipt, manifestHash: "0".repeat(64) } },
      },
      {
        ...committed,
        evidence: { kind: "committed", receipt: { ...receipt, revision: lease.baseRevision } },
      },
      { ...committed, terminalVersion: 0 },
    ])
      assert.equal(
        (await proof(forged)).status,
        409,
        "Forged or equivocated evidence was accepted",
      );
    const unchanged: JobCommitted = {
      ...committed,
      evidence: {
        kind: "verified-unchanged",
        workspaceId: "workspace",
        baseRevision: lease.baseRevision,
        executionId: identity.executionId,
        manifestHash: seeded.value.manifestHash,
        observedAt: Date.now(),
      },
    };
    for (const headers of [read, write]) {
      const result = await proof(unchanged, headers);
      assert.equal(result.status, 200, "Retained unchanged base required public manifest access");
      assert.deepEqual(await result.json(), unchanged);
    }
    assert.equal(
      (await proof({ ...unchanged, evidence: { ...unchanged.evidence, manifestHash } })).status,
      409,
    );
    assert.equal((await proof({ ...committed, ignored: "x".repeat(65536) })).status, 413);
    await call({
      kind: "invalidate",
      input: {
        revocationId: "old-proof-key",
        subject: { kind: "credential", credentialId: "credential", minimumGeneration: 2 },
      },
    });
    assert.equal((await proof(committed)).status, 403);
    const recovered = await proof(committed, { ...write, "x-test-recovery": "1" });
    assert.equal(
      recovered.status,
      200,
      "Current authorized recovery actor was forced to impersonate the historical credential",
    );
    assert.deepEqual(await recovered.json(), committed);
    const invalidated = await rpc(
      {
        kind: "invalidate",
        input: {
          revocationId: "executor-proof-floor",
          subject: { kind: "executor", executorId: "executor", minimumGeneration: 2 },
        },
      },
      { ...write, "x-test-recovery": "1" },
    );
    assert.equal(invalidated.ok, true);
    assert.equal((await proof(committed, { ...write, "x-test-recovery": "1" })).status, 403);
  } finally {
    await server.close();
  }
});
