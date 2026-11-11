import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { manifestDigest } from "fortipi-contract";
import type * as D from "../../src/boundary/dto.js";
import { harness } from "./harness.ts";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
test("Computer snapshots preserve independently hashed old bytes across CAS loss, revocation and receipt retry", {
  timeout: 120_000,
}, async () => {
  const server = harness();
  async function call<T>(body: unknown): Promise<T> {
    const response = await server.fetch("/rpc", { method: "POST", body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    const result = (await response.json()) as D.Outcome<T>;
    if (!result.ok) assert.fail(JSON.stringify(result));
    return result.value;
  }
  async function lease(operationId: string, generation = 1): Promise<D.Lease> {
    return call({
      kind: "acquire",
      input: {
        ownerKind: "job",
        operationId,
        operationDigest: "a".repeat(64),
        workspaceId: "workspace",
        bindingVersion: 1,
        target: { kind: "executor", executorId: "executor", generation },
        actions: ["workspace.write"],
        agentId: "agent",
        conversationId: "conversation",
        jobId: operationId,
        executionId: `${operationId}-execution`,
        deadline: Date.now() + 30_000,
        expiresAt: Date.now() + 30_000,
      },
    });
  }
  async function stage(bytes: Uint8Array, lease: D.Lease, name: string): Promise<D.UploadCommit> {
    const hash = sha(bytes);
    const manifest: D.Manifest = {
      version: 1,
      entries: [{ path: "canary.txt", type: "file", mode: 420, size: bytes.length, sha256: hash }],
    };
    const manifestHash = await manifestDigest(manifest);
    const begun = await call<{ status: 201; body: D.UploadStatus }>({
      kind: "begin",
      input: {
        operationId: "beginUpload",
        path: { workspaceId: "workspace" },
        query: {},
        body: {
          requestId: name,
          baseRevision: lease.baseRevision,
          lease,
          operationId: lease.operationId,
          commitId: `commit-${name}`,
          manifest,
          manifestHash,
          mutations: [
            {
              kind: "put",
              path: "canary.txt",

              mode: 420,
              size: bytes.length,
              sha256: hash,
            },
          ],
        },
      },
    });
    for (
      let offset = 0, index = 0;
      offset < bytes.length || (bytes.length === 0 && index === 0);
      offset += 262144, index++
    ) {
      const chunk = bytes.slice(offset, offset + 262144);
      await call({
        kind: "chunk",
        input: {
          operationId: "putUploadChunk",
          path: {
            workspaceId: "workspace",
            uploadId: begun.body.uploadId,
            sha256: hash,
            chunkIndex: index,
          },
          query: { length: chunk.length, sha256: sha(chunk) },
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
    return {
      requestId: `commit-request-${name}`,
      stageId: validated.body.stageId,
      commitId: `commit-${name}`,
      uploadId: begun.body.uploadId,
      operationId: lease.operationId,
      jobId: lease.ownerKind === "job" ? lease.jobId : undefined,
      workspaceId: "workspace",
      lease,
      manifestHash,
      baseRevision: lease.baseRevision,
    } as D.UploadCommit;
  }
  const commitCall = (commit: D.UploadCommit) => ({
    kind: "commit",
    input: {
      operationId: "commitUpload",
      path: { workspaceId: "workspace", uploadId: commit.uploadId },
      query: {},
      body: commit,
    },
  });
  async function read(revision: string): Promise<Uint8Array> {
    const response = await server.fetch(`/read?revision=${revision}&path=canary.txt`);
    assert.equal(response.status, 200);
    return new Uint8Array(await response.arrayBuffer());
  }
  try {
    await server.listen();
    assert.equal((await server.fetch("/seed")).status, 200);
    await call({
      kind: "describe",
      input: { operationId: "describeWorkspace", path: { workspaceId: "workspace" }, query: {} },
    });
    const firstLease = await lease("first");
    const old = Uint8Array.from({ length: 1_100_013 }, (_, index) => index % 251);
    const first = await stage(old, firstLease, "first-upload");
    const receipt = (await call<{ status: 200; body: D.CommitReceipt }>(commitCall(first))).body;
    assert.equal(sha(await read(receipt.revision)), sha(old));
    assert.equal("childId" in receipt, false);
    assert.equal(receipt.providerKind, "computer");
    assert.deepEqual(
      Object.keys(receipt.providerKind === "computer" ? receipt.storeRef : {}).sort(),
      ["stageId"],
    );
    assert.deepEqual(
      (
        await call<{ status: 200; body: D.CommitReceipt }>(
          commitCall({ ...first, lease: { ...first.lease, expiresAt: 0, leaseVersion: 999 } }),
        )
      ).body,
      receipt,
      "Receipt retry must ignore expired mutable lease observations",
    );
    const facts = await call<D.FactPage>({
      kind: "facts",
      input: { recipient: { kind: "agent", id: "agent" }, limit: 100 },
    });
    assert.equal(facts.items[0]?.factId, receipt.sourceFactId);
    assert.deepEqual(
      (
        await call<D.FactPage>({
          kind: "facts",
          input: { recipient: { kind: "agent", id: "agent" }, limit: 100 },
        })
      ).items,
      facts.items,
      "Lost ack must replay the identical fact",
    );
    const coordinates = {
      kind: "ack",
      input: {
        factId: receipt.sourceFactId,
        recipient: { kind: "agent", id: "agent" },
        eventId: "actual-recipient-event",
        eventSeq: 37,
      },
    };
    await call(coordinates);
    assert.deepEqual(await call(coordinates), { ...coordinates.input, persisted: true });
    await call({
      kind: "release",
      input: { requestId: "release-first", lease: firstLease, reason: "completed" },
    });
    const raceLease = await lease("race");
    const left = await stage(new TextEncoder().encode("left"), raceLease, "left-upload");
    const right = await stage(new TextEncoder().encode("right"), raceLease, "right-upload");
    const race = await Promise.all(
      [left, right].map(async (input) => {
        const response = await server.fetch("/rpc", {
          method: "POST",
          body: JSON.stringify(commitCall(input)),
        });
        return (await response.json()) as D.Outcome<unknown>;
      }),
    );
    assert.equal(race.filter((result) => result.ok).length, 1);
    assert.equal(sha(await read(receipt.revision)), sha(old));
    await call({
      kind: "release",
      input: { requestId: "release-race", lease: raceLease, reason: "completed" },
    });
    const revoked = await lease("revoked");
    const pending = await stage(
      new TextEncoder().encode("must-not-publish"),
      revoked,
      "revoked-upload",
    );
    await call({
      kind: "invalidate",
      input: {
        revocationId: "revocation",
        subject: { kind: "executor", executorId: "executor", minimumGeneration: 2 },
      },
    });
    const denied = await server.fetch("/rpc", {
      method: "POST",
      body: JSON.stringify(commitCall(pending)),
    });
    const rejected = (await denied.json()) as D.Outcome<unknown>;
    assert.equal(rejected.ok, false, "Revoked generation published a revision");
    if (!rejected.ok) assert.equal(rejected.details?.reason, "stale_generation");
    assert.equal(sha(await read(receipt.revision)), sha(old));
  } finally {
    await server.close();
  }
});
