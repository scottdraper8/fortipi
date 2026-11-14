import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { manifestDigest, workspaceLeaseDigest } from "fortipi-contract";
import type * as D from "../../src/boundary/dto.js";
import type { Env } from "../../src/boundary/env.js";
import type { StorageSampleInput } from "../../src/boundary/infrastructure.js";
import { harness, uuid, value } from "../control/harness.ts";

test("real CP completion settlement precedes Workspace coverage and cannot become an unused refund", {
  timeout: 90_000,
}, async () => {
  const h = await harness({
    fixturePath:
      process.env.FORTIPI_STORAGE_CONTROL_ENTRY ??
      "apps/worker/test/workspace/storage-control-worker.ts",
    workspaceClass: "TestWorkspace",
  });
  try {
    const response = await h.server.fetch("/__test/create-workspace", {
      method: "POST",
      headers: {
        "X-Fortipi-Context": JSON.stringify(await h.auth()),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ requestId: uuid(), config: { kind: "computer" } }),
    });
    const created = value(
      (await response.json()) as D.Outcome<D.OperationResponse<"createWorkspace">>,
    );
    assert.equal(created.status, 201);
    if (created.status !== 201) assert.fail("Binding creation failed");
    const binding = created.body;
    const resources: D.ResourceScope = {
      agentIds: [],
      conversationIds: [],
      workspaceIds: [binding.workspaceId],
      executorIds: [],
      backendIds: [],
      tools: [],
      actions: ["workspace.write"],
    };
    const client = await h.mint({
      requestId: uuid(),
      role: "client",
      grants: [{ grantId: "writer", version: 1, resources }],
    });
    const auth = value(
      await h.cp.authenticate({
        bearer: client.token,
        deploymentId: await h.cp.deployment(),
        requestId: "lost-settlement-ack",
        deadline: Date.now() + 30_000,
      }),
    );
    const registration = value(
      await h.cp.registerAuthorityRecipient(auth, {
        credential: {
          credentialId: auth.credentialId,
          generation: auth.generation,
          grantVersion: auth.grantVersion,
        },
        recipient: { kind: "workspace", id: binding.workspaceId },
        resources,
      }),
    );
    const ctx: D.ResourceAuthContext = { ...auth, registrationId: registration.registrationId };
    const env = await h.server.getWorker<Env>().getEnv();
    const workspace = env.WORKSPACES.getByName(binding.workspaceId);
    const deadline = Date.now() + 30_000;
    const operationId = uuid();
    const target = { kind: "backend" as const, backendId: binding.workspaceId, generation: 1 };
    const request: D.TargetRequest = {
      ownerKind: "workspace-operation",
      operationId,
      workspaceId: binding.workspaceId,
      bindingVersion: binding.bindingVersion,
      baseRevision: binding.revision,
      target,
      operationDigest: await workspaceLeaseDigest({
        deploymentId: auth.deploymentId,
        operationId,
        workspaceId: binding.workspaceId,
        bindingVersion: binding.bindingVersion,
        baseRevision: binding.revision,
        target,
        credential: {
          credentialId: auth.credentialId,
          generation: auth.generation,
          grantVersion: auth.grantVersion,
        },
        deadline,
      }),
      actions: ["workspace.write"],
      deadline,
      expiresAt: deadline,
    };
    const lease = value(
      await workspace.acquireLease(ctx, value(await h.cp.reserveTarget(ctx, request))),
    );
    const manifest: D.Manifest = { version: 1, entries: [] };
    const manifestHash = await manifestDigest(manifest);
    const begin = async (name: string) =>
      value(
        await workspace.beginUpload(ctx, {
          operationId: "beginUpload",
          path: { workspaceId: binding.workspaceId },
          query: {},
          body: {
            requestId: name,
            baseRevision: binding.revision,
            operationId,
            commitId: name,
            lease,
            manifest,
            manifestHash,
            mutations: [],
          },
        }),
      );
    const first = await begin("completed");
    assert.equal(first.status, 201);
    value(
      await workspace.validateUpload(ctx, {
        operationId: "validateUpload",
        path: { workspaceId: binding.workspaceId, uploadId: "completed" },
        query: {},
        body: undefined,
      }),
    );
    const db = await h.server
      .getWorker()
      .getDurableObjectStorage("WORKSPACES", { name: binding.workspaceId });
    const records = async <T>(key: string): Promise<T> => {
      const rows = (await db.exec("SELECT value FROM fp_ws_record WHERE key=?", key)) as {
        value: string;
      }[];
      return JSON.parse(rows[0]?.value ?? "null") as T;
    };
    const completedLocal = await records<D.CapacityReservation>("capacity:upload-completed");
    const claim = {
      operationId: "gc-unsealed",
      ownerId: binding.workspaceId,
      policyVersion: 1,
      bytes: 1_048_576,
      admissionSlots: 0,
    };
    const activeLocal = value(await workspace.reserveCapacity(ctx, claim));
    const installed = value(await h.cp.reserveCapacity(ctx, claim));
    // Low-level allocation has no install-ID argument. Link the ACTUAL CP receipt in
    // app-owned metadata as beginUpload does; initialization ACK follows the actual RPC.
    await db.exec(
      "INSERT INTO fp_ws_record(key,value) VALUES(?,?)",
      `install-capacity:${activeLocal.reservationId}`,
      JSON.stringify(installed.reservationId),
    );
    const allocation = value(
      await workspace.allocateStore(ctx, {
        authorityId: binding.workspaceId,
        workspaceId: binding.workspaceId,
        role: "revision-store",
        uploadId: "gc-unsealed",
        baseRevision: binding.revision,
        generation: lease.executorGeneration,
        operationDigest: request.operationDigest,
        capacityReservationId: activeLocal.reservationId,
        reservedBytes: activeLocal.bytes,
        deadline: Date.now() + 1000,
      }),
    );
    const initialized = value(
      await env.WORKSPACES.getByName(allocation.childId).initializeStore(ctx, allocation),
    );
    assert.equal(initialized.allocation.allocationId, allocation.allocationId);
    await db.exec(
      "INSERT INTO fp_ws_record(key,value) VALUES(?,?)",
      `storage-initialized:${allocation.allocationId}`,
      "true",
    );
    const completedId = await records<string>(`install-capacity:${completedLocal.reservationId}`);
    const activeId = await records<string>(`install-capacity:${activeLocal.reservationId}`);
    assert.deepEqual(JSON.parse((await h.cp.capacitySettlement(completedId)) ?? "null"), {
      disposition: "consumed",
    });
    assert.equal(await h.cp.capacitySettlement(activeId), undefined);
    assert.equal(
      await records(`storage-install-ack:${completedLocal.reservationId}`),
      null,
      "Lost acknowledgment was promoted to completed coverage",
    );
    assert.ok(
      !(await records<StorageSampleInput>("storage-report")).coveredReservationIds.includes(
        completedId,
      ),
    );
    assert.equal(
      (
        await h.cp.settleCapacity(ctx, {
          reservationId: completedId,
          disposition: "unused",
          observedBytes: 0,
        })
      ).ok,
      false,
    );
    assert.equal(
      (await h.cp.settleCapacity(ctx, { reservationId: activeId, disposition: "unused" })).ok,
      false,
    );
    const logicalResources = { ...resources, actions: ["backups.create"] };
    const logicalCredential = await h.mint({
      requestId: uuid(),
      role: "admin",
      grants: [{ grantId: "logical", version: 1, resources: logicalResources }],
    });
    const logicalAuth = await h.auth(logicalCredential.token);
    const logicalRegistration = value(
      await h.cp.registerAuthorityRecipient(logicalAuth, {
        credential: {
          credentialId: logicalAuth.credentialId,
          generation: logicalAuth.generation,
          grantVersion: logicalAuth.grantVersion,
        },
        recipient: { kind: "workspace", id: binding.workspaceId },
        resources: logicalResources,
      }),
    );
    const logical: D.ResourceAuthContext = {
      ...logicalAuth,
      registrationId: logicalRegistration.registrationId,
    };
    const exported = value(
      await workspace.exportData(logical, {
        exportId: "logical-pending-growth",
        action: "backups.create",
        resources: { ...logicalResources, actions: [] },
        maxBytes: 1_048_576,
        deadline: Date.now() + 30_000,
      }),
    );
    assert.equal(exported.state, "ready");
    assert.equal(
      await h.cp.capacitySettlement(activeId),
      undefined,
      "Logical-only export synthesized original write/principal authority",
    );
    assert.equal(await records(`storage-install-ack:${activeLocal.reservationId}`), null);
    assert.equal(
      await records(`storage-install-ack:${completedLocal.reservationId}`),
      null,
      "Logical export impersonated original settlement authority after lost ACK",
    );
    assert.ok(
      !(await records<StorageSampleInput>("storage-report")).coveredReservationIds.includes(
        activeId,
      ),
    );
    const observed = await workspace.fetch(
      new Request("https://workspace.internal/__fortipi/storage-sample", {
        method: "POST",
        headers: { "x-fortipi-workspace-context": JSON.stringify({ auth: ctx }) },
        body: JSON.stringify({
          kind: "authority",
          sampleId: "real-completed-barrier",
          policyVersion: 1,
        }),
      }),
    );
    assert.equal(observed.status, 200);
    const report = await records<StorageSampleInput>("storage-report");
    assert.ok(report.coveredReservationIds.includes(completedId));
    assert.ok(!report.coveredReservationIds.includes(activeId));
    assert.deepEqual(await records(`storage-install-intent:${completedLocal.reservationId}`), {
      reservationId: completedId,
      disposition: "consumed",
    });
    assert.deepEqual(await records(`storage-install-ack:${completedLocal.reservationId}`), {
      reservationId: completedId,
      disposition: "consumed",
    });
    await delay(Math.max(0, allocation.deadline + 60_000 - Date.now() + 10));
    const fresh = await h.auth(client.token);
    const freshRegistration = value(
      await h.cp.registerAuthorityRecipient(fresh, {
        credential: {
          credentialId: fresh.credentialId,
          generation: fresh.generation,
          grantVersion: fresh.grantVersion,
        },
        recipient: { kind: "workspace", id: binding.workspaceId },
        resources,
      }),
    );
    const recovery: D.ResourceAuthContext = {
      ...fresh,
      registrationId: freshRegistration.registrationId,
    };
    const lookup: D.StoreLookup = {
      allocationId: allocation.allocationId,
      childId: allocation.childId,
      authorityId: allocation.authorityId,
      workspaceId: allocation.workspaceId,
    };
    const retired = value(await workspace.retireStore(recovery, lookup));
    const removed = value(await workspace.deleteStore(recovery, retired));
    assert.equal(removed.deallocated, true);
    assert.deepEqual(JSON.parse((await h.cp.capacitySettlement(activeId)) ?? "null"), {
      disposition: "unused",
      observedBytes: 0,
    });
    assert.deepEqual(
      JSON.parse((await h.cp.capacitySettlement(completedId)) ?? "null"),
      { disposition: "consumed" },
      "Deleting a different child rewrote a retained consumed receipt",
    );
  } finally {
    await h.close();
  }
});
