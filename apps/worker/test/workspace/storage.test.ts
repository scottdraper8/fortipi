import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { assignmentDigest, operationDigest } from "fortipi-contract";
import type * as D from "../../src/boundary/dto.js";
import type {
  StorageSampleInput,
  WorkspaceStorageSample,
} from "../../src/boundary/infrastructure.js";
import { harness } from "./harness.ts";
import { workspaceTarget } from "./target.ts";

function value<T>(result: D.Outcome<T>): T {
  if (!result.ok) assert.fail(JSON.stringify(result));
  return result.value;
}
type Server = ReturnType<typeof harness>;
async function rpc<T>(server: Server, kind: string, input: unknown, headers = {}): Promise<T> {
  return value(
    (await (
      await server.fetch("/rpc", { method: "POST", headers, body: JSON.stringify({ kind, input }) })
    ).json()) as D.Outcome<T>,
  );
}
async function sample(server: Server, sampleId: string, headers = {}) {
  return server.fetch("/storage-sample", {
    method: "POST",
    headers,
    body: JSON.stringify({ kind: "authority", sampleId, policyVersion: 1 }),
  });
}
async function facts(server: Server) {
  return (await (await server.fetch("/storage-facts")).json()) as {
    bytes: number;
    charge: { observed: number; unspent: number; bytes: number };
    census: { version: number; bytes: number; children: Record<string, number> };
    report: StorageSampleInput;
  };
}
async function storage(server: Server) {
  return server.getWorker().getDurableObjectStorage("WORKSPACES", { name: "workspace" });
}
async function records<T>(server: Server, prefix: string): Promise<T[]> {
  const rows = (await (
    await storage(server)
  ).exec(
    "SELECT value FROM fp_ws_record WHERE key>=? AND key<? ORDER BY key",
    prefix,
    `${prefix}\uffff`,
  )) as { value: string }[];
  return rows.map((row) => JSON.parse(row.value) as T);
}
async function job(server: Server, revision: string, number: number, source?: string) {
  const deadline = Date.now() + 30_000;
  const operationContext: D.OperationContext = {
    deploymentId: "test-deployment",
    agentId: "agent",
    conversationId: "conversation",
    policyVersion: 1,
  };
  const operation: D.OperationDigestInput = {
    ...operationContext,
    workspaceId: "workspace",
    baseRevision: revision,
    tool: "javascript",
    arguments: {
      source: source ?? `export default async function(){console.log('${number}'.repeat(40000));}`,
    },
    target: { kind: "backend", backendId: "backend", generation: 1 },
    grantVersion: 1,
    deadline,
  };
  const executionId = `pool-execution-${number}`;
  const target: D.TargetRequest = {
    ownerKind: "job",
    operationId: `pool-operation-${number}`,
    operationDigest: await operationDigest(operation),
    workspaceId: "workspace",
    bindingVersion: 1,
    target: operation.target,
    actions: ["workspace.write"],
    jobId: `pool-job-${number}`,
    executionId,
    agentId: "agent",
    conversationId: "conversation",
    deadline,
    expiresAt: deadline,
  };
  const headers = { "x-test-write-only": "1" };
  const reservation = await rpc<D.TargetReservation>(server, "reservation", target, headers);
  assert.equal(reservation.ownerKind, "job");
  if (reservation.ownerKind !== "job") throw new Error("Job reservation required");
  const lease = await rpc<D.Lease>(server, "acquire", target, headers);
  const identity: D.ExecutionIdentity = {
    jobId: `pool-job-${number}`,
    executionId,
    operationDigest: target.operationDigest,
    assignmentDigest: await assignmentDigest({
      operation,
      executionId,
      reservationId: reservation.reservationId,
      leaseId: lease.leaseId,
      fence: lease.fence,
      executorGeneration: lease.executorGeneration,
    }),
    target: operation.target,
    lease,
    baseRevision: revision,
    deadline,
  };
  const request: D.ExecutionRequest = {
    reservation,
    operationContext,
    identity,
    tool: operation.tool,
    arguments: operation.arguments,
    workspaceId: "workspace",
    bindingVersion: 1,
    capabilities: ["javascript", "workspace.write"],
  };
  return {
    prepared: await rpc<D.PreparedExecution>(server, "prepare-execution", request, headers),
    identity,
    headers,
  };
}

async function finish(server: Server, next: Awaited<ReturnType<typeof job>>) {
  await rpc(server, "start-execution", next.prepared, next.headers);
  for (let attempt = 0; attempt < 300; attempt++) {
    const observation = await rpc<D.ExecutionObservation>(
      server,
      "query-execution",
      next.identity,
      next.headers,
    );
    if (observation.state === "terminal")
      return rpc<D.PreparedResult>(server, "collect-execution", next.identity, next.headers);
    await delay(10);
  }
  assert.fail("Actual Loader did not finish");
}

test("independent retained copies count physically and changed surveys or unwritable census markers cannot release credit", {
  timeout: 30_000,
}, async () => {
  const server = harness(true);
  try {
    await server.listen();
    const binding = value(
      (await (await server.fetch("/seed")).json()) as D.Outcome<D.WorkspaceBinding>,
    );
    const next = await job(
      server,
      binding.revision,
      1,
      "import {writeFile} from 'node:fs/promises';export default async function(){await writeFile('/workspace/copy.txt','same'.repeat(1024));}",
    );
    const result = await finish(server, next);
    assert.ok(result.uploadId && result.commitId);
    const staged = await rpc<{ body: D.UploadValidation }>(server, "validate", {
      operationId: "validateUpload",
      path: { workspaceId: "workspace", uploadId: result.uploadId },
      query: {},
    });
    const committed = await rpc<{ body: D.CommitReceipt }>(server, "commit", {
      operationId: "commitUpload",
      path: { workspaceId: "workspace", uploadId: result.uploadId },
      query: {},
      body: {
        requestId: "pool-commit",
        stageId: staged.body.stageId,
        commitId: result.commitId,
        uploadId: result.uploadId,
        operationId: next.identity.lease.operationId,
        jobId: next.identity.jobId,
        workspaceId: "workspace",
        lease: next.identity.lease,
        manifestHash: result.manifestHash,
        baseRevision: binding.revision,
      },
    });
    await rpc(server, "release", { requestId: "release-first", lease: next.identity.lease });
    const manifest = await rpc<{ body: D.ManifestResponse }>(server, "manifest", {
      operationId: "getWorkspaceManifest",
      path: { workspaceId: "workspace" },
      query: { revision: committed.body.revision },
    });
    const target = await workspaceTarget("copy-again", committed.body.revision);
    const lease = await rpc<D.Lease>(server, "acquire", target);
    const upload = await rpc<{ body: D.UploadStatus }>(server, "begin", {
      operationId: "beginUpload",
      path: { workspaceId: "workspace" },
      query: {},
      body: {
        requestId: "copy-again",
        baseRevision: committed.body.revision,
        operationId: lease.operationId,
        commitId: "copy-again",
        lease,
        manifest: manifest.body.manifest,
        manifestHash: manifest.body.manifestHash,
        mutations: [],
      },
    });
    await rpc(server, "validate", {
      operationId: "validateUpload",
      path: { workspaceId: "workspace", uploadId: upload.body.uploadId },
      query: {},
    });
    const measured = await sample(server, "copied");
    assert.equal(measured.status, 200);
    const observation = (await measured.json()) as WorkspaceStorageSample;
    const census = await facts(server);
    assert.equal(Object.keys(census.census.children).length, 3);
    assert.equal(
      census.report.coverage.bytes,
      observation.bytes +
        Object.values(census.census.children).reduce((sum, bytes) => sum + bytes, 0),
    );
    assert.equal(
      census.charge.observed,
      census.bytes + Object.values(census.census.children).reduce((sum, bytes) => sum + bytes, 0),
      "Workspace pool omitted independently observed child copies",
    );
    const allocations = await records<{ state: D.StoreState }>(server, "allocation:");
    const copies = allocations.filter((row) => row.state.allocation.role === "revision-store");
    assert.equal(copies.length, 2);
    assert.notEqual(copies[0]?.state.allocation.childId, copies[1]?.state.allocation.childId);
    const unique = (await records<{ unique: Record<string, number> }>(server, "retained"))[0];
    assert.equal(
      Object.values(unique?.unique ?? {}).reduce((sum, size) => sum + size, 0),
      4096,
    );
    assert.ok(Object.values(census.census.children).every((bytes) => bytes > 4096));
    assert.notEqual(
      (await sample(server, "changed-survey", { "x-test-request-id": "storage-change" })).status,
      200,
    );
    assert.deepEqual(await records(server, "test-storage-midawait"), ["/__test/storage-change"]);
    assert.equal(
      (await facts(server)).census.version,
      census.census.version,
      "Changed full authority survey published a census",
    );
    const beforeCredits = await records(server, "storage-credit:");
    const db = await storage(server);
    await db.exec(
      "CREATE TRIGGER test_census_full BEFORE UPDATE ON fp_ws_record WHEN NEW.key='storage-census' BEGIN SELECT RAISE(FAIL,'SQLITE_FULL'); END",
    );
    assert.notEqual((await sample(server, "unwritable")).status, 200);
    assert.deepEqual(await records(server, "storage-credit:"), beforeCredits);
    assert.equal((await facts(server)).census.version, census.census.version);
    assert.deepEqual(
      await (await sample(server, "copied")).json(),
      observation,
      "Unwritable new marker erased a durable receipt",
    );
    await db.exec("DROP TRIGGER test_census_full");
    assert.equal((await sample(server, "recovered")).status, 200);
    assert.notEqual(
      (await sample(server, "revoked-await", { "x-test-request-id": "storage-revoke" })).status,
      200,
    );
    assert.deepEqual(await records(server, "test-storage-midawait"), ["/__test/storage-revoke"]);
    assert.notEqual(
      (await sample(server, "copied")).status,
      200,
      "Cached sample bypassed current floors",
    );
  } finally {
    await server.close();
  }
});

test("unknown actual Loader dispatch retains active role and unspent collection growth", {
  timeout: 30_000,
}, async () => {
  const server = harness(true);
  try {
    await server.listen();
    const binding = value(
      (await (await server.fetch("/seed")).json()) as D.Outcome<D.WorkspaceBinding>,
    );
    const next = await job(
      server,
      binding.revision,
      1,
      "import value from 'fortipi-host-secret'; export default async function(){return value;}",
    );
    await rpc(server, "start-execution", next.prepared, next.headers);
    assert.equal(
      (await rpc<D.ExecutionObservation>(server, "query-execution", next.identity, next.headers))
        .state,
      "unknown",
    );
    assert.equal(
      ((await (await server.fetch("/storage-role")).json()) as D.Outcome<boolean>).ok,
      false,
    );
    assert.equal((await sample(server, "unknown")).status, 200);
    const held = await facts(server);
    assert.ok(held.charge.unspent >= 34 * 1024 * 1024);
    assert.equal((await records(server, "storage-credit:")).length, 0);
    await rpc(server, "release", { requestId: "release-unknown", lease: next.identity.lease });
    await assert.rejects(job(server, binding.revision, 2), /quota_exceeded/);
    assert.equal(
      ((await (await server.fetch("/storage-role")).json()) as D.Outcome<boolean>).ok,
      false,
    );
  } finally {
    await server.close();
  }
});

test("one pool permits consecutive actual Loader jobs while earlier output remains pinned, then enforces retained capacity", {
  timeout: 60_000,
}, async () => {
  const server = harness(true);
  try {
    await server.listen();
    const binding = value(
      (await (await server.fetch("/seed")).json()) as D.Outcome<D.WorkspaceBinding>,
    );
    const artifacts: D.ByteReference[] = [];
    for (let number = 1; number <= 8; number++) {
      const next = await job(server, binding.revision, number);
      assert.equal(
        ((await (await server.fetch("/storage-role")).json()) as D.Outcome<boolean>).ok,
        false,
        "PENDING scratch bypassed the active role cap",
      );
      await rpc(server, "start-execution", next.prepared, next.headers);
      let terminal = false;
      for (let attempt = 0; attempt < 300; attempt++) {
        const observed = await rpc<D.ExecutionObservation>(
          server,
          "query-execution",
          next.identity,
          next.headers,
        );
        if (observed.state === "terminal") {
          terminal = true;
          break;
        }
        await delay(10);
      }
      assert.ok(terminal);
      const result = await rpc<D.PreparedResult>(
        server,
        "collect-execution",
        next.identity,
        next.headers,
      );
      assert.equal(result.state, "succeeded");
      assert.ok(result.output.artifacts.length > 0);
      artifacts.push(...result.output.artifacts);
      const execution = (
        await records<{ storageQuiescent: boolean }>(
          server,
          `execution:${next.identity.executionId}`,
        )
      )[0];
      assert.equal(
        execution?.storageQuiescent,
        true,
        "Terminal/full sync did not establish the cloud-JS writer barrier",
      );
      await rpc(
        server,
        "release",
        { requestId: `release-${number}`, lease: next.identity.lease },
        next.headers,
      );
      const rows = await records<{ pins: number }>(server, "allocation:");
      assert.ok(
        rows.every((row) => row.pins > 0),
        "Required output was evicted to admit another job",
      );
    }
    await assert.rejects(job(server, binding.revision, 9), /quota_exceeded/);
    for (const [index, artifact] of artifacts.entries()) {
      const response = await server.fetch(artifact.endpoint);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), `${String(index + 1).repeat(40000)}\n`);
    }
    const measured = await facts(server);
    assert.equal(Object.keys(measured.census.children).length, 8);
    assert.equal(measured.report.coverage.bytes, measured.census.bytes);
    assert.ok(measured.charge.bytes <= 48 * 1024 * 1024);
  } finally {
    await server.close();
  }
});

test("physical census preserves immutable samples, current authority, orphan holds and actual overruns", {
  timeout: 30_000,
}, async () => {
  const server = harness();
  try {
    await server.listen();
    const binding = value(
      (await (await server.fetch("/seed")).json()) as D.Outcome<D.WorkspaceBinding>,
    );
    const first = await sample(server, "initial");
    assert.equal(first.status, 200);
    const original = (await first.json()) as WorkspaceStorageSample;
    assert.equal(original.kind, "authority");
    const initial = await facts(server);
    assert.ok(original.bytes > 0);
    assert.equal(
      initial.census.bytes,
      original.bytes,
      "Authority observation included prospective credits",
    );
    assert.ok(initial.charge.bytes > initial.census.bytes);
    for (const headers of [
      { "x-test-unregistered": "1" },
      { "x-test-expired": "1" },
      { "x-test-no-grants": "1" },
    ])
      assert.notEqual((await sample(server, "denied", headers)).status, 200);
    const invalid = await server.fetch("/storage-sample", {
      method: "POST",
      body: JSON.stringify({
        kind: "authority",
        sampleId: "initial",
        policyVersion: 1,
        registryVersion: 1,
      }),
    });
    assert.notEqual(invalid.status, 200);
    const target = await workspaceTarget("orphan", binding.revision);
    const lease = await rpc<D.Lease>(server, "acquire", target);
    const capacity = await rpc<D.CapacityReservation>(server, "capacity", {
      operationId: "orphan-capacity",
      ownerId: "workspace",
      policyVersion: 1,
      bytes: 2 * 1024 * 1024,
      admissionSlots: 0,
    });
    const allocation = await rpc<D.StoreAllocation>(server, "allocate", {
      authorityId: "workspace",
      workspaceId: "workspace",
      role: "revision-store",
      uploadId: "orphan",
      baseRevision: binding.revision,
      generation: lease.executorGeneration,
      operationDigest: target.operationDigest,
      capacityReservationId: capacity.reservationId,
      reservedBytes: capacity.bytes,
      deadline: Date.now() + 30_000,
    });
    assert.ok(allocation.childId);
    const held = await facts(server);
    const version = held.census.version;
    await (await storage(server)).exec(
      "INSERT INTO fp_ws_record(key,value) VALUES('test-storage-track','true')",
    );
    assert.notEqual((await sample(server, "orphan-observation")).status, 200);
    assert.deepEqual(
      await records(server, "test-storage-activation:"),
      [],
      "Survey activated an allocated child without actual initialization acknowledgment",
    );
    assert.equal((await facts(server)).census.version, version);
    assert.equal((await records(server, "storage-credit:")).length, 0);
    assert.deepEqual(
      await (await sample(server, "initial")).json(),
      original,
      "Retry sampled a different physical cut",
    );
    // Public SQLite allocation, not a file-size estimate or a fake databaseSize getter.
    await (await storage(server)).exec(
      "CREATE TABLE test_pool_pressure (payload BLOB); WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<48) INSERT INTO test_pool_pressure SELECT zeroblob(1048576) FROM n",
    );
    const pressure = await facts(server);
    assert.ok(pressure.bytes > 48 * 1024 * 1024);
    assert.ok(pressure.charge.bytes >= pressure.bytes + capacity.bytes);
    await assert.rejects(
      rpc(server, "capacity", {
        operationId: "must-hold",
        ownerId: "workspace",
        policyVersion: 1,
        bytes: 1,
        admissionSlots: 0,
      }),
    );
    assert.deepEqual(
      await rpc(server, "capacity", {
        operationId: "orphan-capacity",
        ownerId: "workspace",
        policyVersion: 1,
        bytes: capacity.bytes,
        admissionSlots: 0,
      }),
      capacity,
      "Physical pressure lost the original reservation receipt",
    );
  } finally {
    await server.close();
  }
});
