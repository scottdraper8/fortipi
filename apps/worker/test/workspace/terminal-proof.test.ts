import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  type CommitReceipt,
  type JobCommitted,
  manifestDigest,
  publicCommitReceipt,
} from "fortipi-contract";
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
    const wrongJob = await rpc({
      ...commitCall,
      input: { ...commitCall.input, body: { ...commit, jobId: "other-job" } },
    });
    assert.equal(wrongJob.ok, false, "Different job published the reserved write");
    const receipt = (await call<{ status: 200; body: CommitReceipt }>(commitCall)).body;
    const knownReceipt = {
      kind: "receipt",
      input: {
        workspaceId: "workspace",
        commitId: receipt.commitId,
        commitDigest: receipt.commitDigest,
      },
    };
    const factsCall = {
      kind: "facts",
      input: { recipient: { kind: "agent", id: "agent" }, limit: 100 },
    };
    const storage = await server
      .getWorker()
      .getDurableObjectStorage("WORKSPACES", { name: "workspace" });
    const retainedRows = () =>
      storage.exec(
        "SELECT key,value FROM fp_ws_record WHERE key='authority' OR key LIKE 'receipt:%' OR key LIKE 'upload:%' OR key LIKE 'reservation:%' OR key LIKE 'lease-acquire:%' ORDER BY key",
      );
    const retainedBefore = await retainedRows();
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
        kind: "public-receipt",
        input: {
          operationId: "getCommitReceipt",
          path: { workspaceId: "workspace", commitId: receipt.commitId },
          query: { commitDigest: receipt.commitDigest },
        },
      },
    ]) {
      const result = await rpc(denied);
      assert.equal(result.ok, false, "Writer gained a public read capability");
      if (!result.ok) assert.equal(result.code, "unauthorized");
    }
    await delay(Math.max(0, lease.expiresAt - Date.now() + 10));
    const recoveredReceipt = await rpc<D.CommitReceipt>(knownReceipt);
    assert.ok(recoveredReceipt.ok, "Write-only historical receipt lookup required public read");
    assert.deepEqual(publicCommitReceipt(recoveredReceipt.value), receipt);
    const expired = await rpc(knownReceipt, { ...write, "x-test-expired": "1" });
    assert.equal(expired.ok, false, "Expired current receipt authority was accepted");
    if (!expired.ok) assert.equal(expired.code, "unauthenticated");
    const recovery = { ...write, "x-test-recovery": "1" };
    const freshReceipt = await rpc<D.CommitReceipt>(knownReceipt, recovery);
    assert.ok(freshReceipt.ok, "Current recovery actor could not observe the historical receipt");
    assert.deepEqual(freshReceipt.value, recoveredReceipt.value);
    for (const flag of [
      "x-test-other-conversation",
      "x-test-other-agent",
      "x-test-other-target",
      "x-test-unregistered",
      "x-test-split-scope",
    ]) {
      const result = await rpc(knownReceipt, { ...recovery, [flag]: "1" });
      assert.equal(result.ok, false, `Wrong receipt scope was accepted: ${flag}`);
    }
    for (const input of [
      { ...knownReceipt.input, workspaceId: "other" },
      { ...knownReceipt.input, commitDigest: "f".repeat(64) },
    ])
      assert.equal((await rpc({ ...knownReceipt, input }, recovery)).ok, false);
    const page = await rpc<D.FactPage>(factsCall, recovery);
    assert.ok(page.ok, "Write-only recovery could not discover its retained receipt fact");
    assert.equal(page.value.items.length, 1);
    const fact = page.value.items[0];
    assert.ok(fact);
    assert.equal(fact.event.type, "workspace.revision.committed");
    assert.deepEqual(fact.event.payload, receipt);
    assert.equal(fact.factId, receipt.sourceFactId);
    const readPage = await rpc<D.FactPage>(factsCall, read);
    assert.ok(readPage.ok);
    assert.deepEqual(readPage.value.items, [fact]);
    const mixedPage = await rpc<D.FactPage>(factsCall, { ...recovery, "x-test-mixed-read": "1" });
    assert.ok(mixedPage.ok);
    assert.deepEqual(
      mixedPage.value.items,
      [fact],
      "Valid scoped write grant was masked by an unrelated read grant",
    );
    const publicRead = await rpc<{ status: 200; body: CommitReceipt }>(
      {
        kind: "public-receipt",
        input: {
          operationId: "getCommitReceipt",
          path: { workspaceId: "workspace", commitId: receipt.commitId },
          query: { commitDigest: receipt.commitDigest },
        },
      },
      read,
    );
    assert.ok(publicRead.ok);
    assert.deepEqual(publicRead.value.body, receipt);
    for (const headers of [
      { ...read, "x-test-other-conversation": "1" },
      { ...read, "x-test-split-scope": "1" },
      { ...recovery, "x-test-other-conversation": "1" },
      { ...recovery, "x-test-other-target": "1" },
    ]) {
      const hidden = await rpc<D.FactPage>(factsCall, headers);
      assert.ok(hidden.ok);
      assert.deepEqual(hidden.value.items, [], "Unrelated conversation received a workspace fact");
      assert.equal(
        (
          await rpc(
            {
              kind: "ack",
              input: {
                recipient: factsCall.input.recipient,
                factId: fact.factId,
                eventId: "scope-event",
                eventSeq: 1,
              },
            },
            headers,
          )
        ).ok,
        false,
      );
    }
    const unrelated: D.Fact = {
      ...fact,
      factId: "unrelated-fact",
    };
    const encoded = JSON.stringify({ fact: unrelated, acknowledgments: [] }).replaceAll("'", "''");
    await storage.exec(
      `INSERT INTO fp_ws_record(key,value) VALUES('fact:unrelated-fact','${encoded}')`,
    );
    const bounded = await rpc<D.FactPage>(factsCall, recovery);
    assert.ok(bounded.ok);
    assert.deepEqual(
      bounded.value.items,
      [fact],
      "Write-only recovery gained arbitrary fact access",
    );
    assert.equal(
      (
        await rpc(
          {
            kind: "ack",
            input: {
              recipient: factsCall.input.recipient,
              factId: unrelated.factId,
              eventId: "scope-event",
              eventSeq: 1,
            },
          },
          recovery,
        )
      ).ok,
      false,
    );
    await storage.exec("DELETE FROM fp_ws_record WHERE key='fact:unrelated-fact'");
    assert.deepEqual(
      await retainedRows(),
      retainedBefore,
      "Receipt recovery changed publication or historical authority",
    );
    const ackCall = {
      kind: "ack",
      input: {
        recipient: factsCall.input.recipient,
        factId: fact.factId,
        eventId: "scope-event",
        eventSeq: 1,
      },
    };
    const acknowledged = await rpc<D.FactAck>(ackCall, recovery);
    assert.ok(acknowledged.ok);
    assert.deepEqual(await rpc(ackCall, recovery), acknowledged);
    assert.equal(
      (await rpc({ ...ackCall, input: { ...ackCall.input, eventSeq: 2 } }, recovery)).ok,
      false,
    );
    const afterAck = await rpc<D.FactPage>(factsCall, recovery);
    assert.ok(afterAck.ok);
    assert.deepEqual(afterAck.value.items, []);
    const unchangedBytes = await server.fetch(
      `/read?revision=${receipt.revision}&path=only-write.txt`,
    );
    assert.equal(digest(new Uint8Array(await unchangedBytes.arrayBuffer())), sha256);
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
    assert.equal((await rpc(knownReceipt)).ok, false, "Revoked current actor recovered a receipt");
    const freshAfterRevocation = await rpc<D.CommitReceipt>(knownReceipt, recovery);
    assert.ok(freshAfterRevocation.ok);
    assert.deepEqual(freshAfterRevocation.value, recoveredReceipt.value);
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
    assert.equal(
      (await rpc(knownReceipt, recovery)).ok,
      false,
      "Revoked target recovered a receipt",
    );
    const fencedFacts = await rpc<D.FactPage>(factsCall, recovery);
    assert.ok(fencedFacts.ok);
    assert.deepEqual(fencedFacts.value.items, [], "Revoked target recovered a publication fact");
  } finally {
    await server.close();
  }
});
