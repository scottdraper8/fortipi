import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { manifestDigest } from "fortipi-contract";
import type * as D from "../../src/boundary/dto.js";
import { harness } from "./harness.ts";
import { workspaceTarget } from "./target.ts";

test("sealed children reject mutation and authority-clock expiry rejects publication", {
  timeout: 60_000,
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
    const seeded = (await (await server.fetch("/seed")).json()) as D.Outcome<D.WorkspaceBinding>;
    if (!seeded.ok) assert.fail(JSON.stringify(seeded));
    const initialRevision = seeded.value.revision;
    const lease = await call<D.Lease>({
      kind: "acquire",
      input: await workspaceTarget("expiry", initialRevision, { expiresAt: Date.now() + 2000 }),
    });
    const bytes = new TextEncoder().encode("immutable");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const entry: D.ManifestEntry = {
      type: "file",
      path: "immutable.txt",
      mode: 420,
      sha256,
      size: bytes.length,
    };
    const manifest: D.Manifest = { version: 1, entries: [entry] };
    const manifestHash = await manifestDigest(manifest);
    await call({
      kind: "begin",
      input: {
        operationId: "beginUpload",
        path: { workspaceId: "workspace" },
        query: {},
        body: {
          requestId: "expiry-upload",
          operationId: lease.operationId,
          commitId: "expiry-commit",
          baseRevision: lease.baseRevision,
          lease,
          manifest,
          manifestHash,
          mutations: [
            {
              kind: "put",
              path: entry.path,
              sha256,
              size: bytes.length,
              mode: 420,
            },
          ],
        },
      },
    });
    await call({
      kind: "chunk",
      input: {
        operationId: "putUploadChunk",
        path: { workspaceId: "workspace", uploadId: "expiry-upload", sha256, chunkIndex: 0 },
        query: { length: bytes.length, sha256 },
      },
      bytes: [...bytes],
    });
    const validated = await call<{ status: 200; body: D.UploadValidation }>({
      kind: "validate",
      input: {
        operationId: "validateUpload",
        path: { workspaceId: "workspace", uploadId: "expiry-upload" },
        query: {},
      },
    });
    const storage = await server
      .getWorker()
      .getDurableObjectStorage("WORKSPACES", { name: "workspace" });
    const rows = (await storage.exec(
      "SELECT value FROM fp_ws_record WHERE key LIKE 'allocation:%'",
    )) as { value: string }[];
    const allocation = (JSON.parse(rows[0]?.value ?? "null") as { state: D.StoreState }).state
      .allocation;
    const mutation = await server.fetch("/rpc", {
      method: "POST",
      body: JSON.stringify({
        kind: "child-mutate",
        input: allocation,
        entry,
        bytes: [...new TextEncoder().encode("corrupted")],
      }),
    });
    assert.equal(mutation.status, 409, "Sealed-store mutation was accepted");
    await delay(Math.max(0, lease.expiresAt - Date.now() + 20));
    const rejected = await server.fetch("/rpc", {
      method: "POST",
      body: JSON.stringify({
        kind: "commit",
        input: {
          operationId: "commitUpload",
          path: { workspaceId: "workspace", uploadId: "expiry-upload" },
          query: {},
          body: {
            requestId: "commit-expired",
            stageId: validated.body.stageId,
            commitId: "expiry-commit",
            uploadId: "expiry-upload",
            operationId: lease.operationId,
            workspaceId: "workspace",
            lease,
            baseRevision: lease.baseRevision,
            manifestHash,
          },
        },
      }),
    });
    const result = (await rejected.json()) as D.Outcome<unknown>;
    assert.equal(result.ok, false, "Expired lease published a revision");
    if (!result.ok) assert.equal(result.details?.reason, "expired_lease");
    const described = await call<{ status: 200; body: D.WorkspaceBinding }>({
      kind: "describe",
      input: { operationId: "describeWorkspace", path: { workspaceId: "workspace" }, query: {} },
    });
    assert.equal(described.body.revision, initialRevision);
  } finally {
    await server.close();
  }
});

test("supported child deleteAll reduces observed storage and permanent registry denies resurrection", {
  timeout: 90_000,
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
    const seeded = (await (await server.fetch("/seed")).json()) as D.Outcome<D.WorkspaceBinding>;
    if (!seeded.ok) assert.fail(JSON.stringify(seeded));
    const initialRevision = seeded.value.revision;
    const capacity = await call<D.CapacityReservation>({
      kind: "capacity",
      input: {
        operationId: "gc-capacity",
        ownerId: "workspace",
        policyVersion: 1,
        bytes: 2_000_000,
        admissionSlots: 0,
      },
    });
    await call<D.Lease>({
      kind: "acquire",
      input: {
        ownerKind: "job",
        operationId: "gc-operation",
        jobId: "gc-job",
        executionId: "gc-execution",
        agentId: "agent",
        conversationId: "conversation",
        operationDigest: "b".repeat(64),
        workspaceId: "workspace",
        bindingVersion: 1,
        target: { kind: "executor", executorId: "executor", generation: 1 },
        actions: ["workspace.write"],
        deadline: Date.now() + 30_000,
        expiresAt: Date.now() + 30_000,
      },
    });
    const allocation = await call<D.StoreAllocation>({
      kind: "allocate",
      input: {
        authorityId: "workspace",
        workspaceId: "workspace",
        role: "scratch",
        jobId: "gc-job",
        executionId: "gc-execution",
        baseRevision: initialRevision,
        generation: 1,
        operationDigest: "b".repeat(64),
        capacityReservationId: capacity.reservationId,
        reservedBytes: capacity.bytes,
        deadline: Date.now() + 100,
      },
    });
    await call({ kind: "initialize", input: allocation });
    const input: D.StoreLookup = {
      allocationId: allocation.allocationId,
      authorityId: allocation.authorityId,
      childId: allocation.childId,
      workspaceId: allocation.workspaceId,
    };
    const before = await call<D.StoreState>({ kind: "child-state", input });
    assert.ok((before.measuredBytes ?? 0) > 0);
    await delay(Math.max(0, allocation.deadline + 60_000 - Date.now() + 10));
    const retirement = await call<D.StoreRetirement>({ kind: "retire", input });
    const deleted = await call<D.CleanupReceipt>({ kind: "delete", input: retirement });
    assert.equal(deleted.deallocated, true);
    const after = await call<D.StoreState>({ kind: "child-state", input });
    assert.equal(after.state, "deleted");
    assert.ok(
      (after.measuredBytes ?? Infinity) < (before.measuredBytes ?? 0),
      "Metadata counter alone is not storage relief",
    );
    const resurrect = await server.fetch("/rpc", {
      method: "POST",
      body: JSON.stringify({ kind: "initialize", input: allocation }),
    });
    const denied = (await resurrect.json()) as D.Outcome<unknown>;
    assert.equal(denied.ok, false);
    assert.equal((await call<D.StoreState>({ kind: "store", input })).state, "deleted");
  } finally {
    await server.close();
  }
});
