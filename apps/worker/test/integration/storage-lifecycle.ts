import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { RoleContext } from "../../../../tests/clients/roles.ts";
import type * as D from "../../src/boundary/dto.js";
import { harness } from "../agent/harness.ts";
import { bytes } from "./fixture-state.ts";
import type { WorkspaceObject } from "./fixture-worker.ts";
import { readWorkspace, stageWorkspace } from "./workspace-portability.ts";

function value<T>(result: D.Outcome<T>): T {
  if (!result.ok) throw new Error(`Actual storage operation failed: ${result.code}`);
  return result.value;
}
/** Real Computer/SQLite retirement; real elapsed authority grace, no fake clock
 * or direct mutation of allocation/usage records. Published bytes remain live. */
export async function storeRetirement() {
  const h = await harness({ main: resolve(import.meta.dirname, "fixture-worker.ts") });
  const { url } = await h.server.listen();
  const roles = new RoleContext(
    new URL(url).origin,
    (await import("../agent/harness.ts")).bootstrap,
  );
  try {
    const created = await roles.call({
      operationId: "createWorkspace",
      path: {},
      query: {},
      body: { requestId: randomUUID(), config: { kind: "computer" } },
    });
    const role = await roles.issue({
      requestId: randomUUID(),
      role: "client",
      expiresAt: Date.now() + 240000,
      grants: [
        {
          grantId: randomUUID(),
          version: 1,
          resources: {
            agentIds: [],
            conversationIds: [],
            workspaceIds: [created.workspaceId],
            executorIds: [],
            backendIds: [],
            tools: [],
            actions: ["workspace.read", "workspace.write"],
          },
        },
      ],
    });
    const port = { endpoint: roles.endpoint, api: h.api };
    const base = await stageWorkspace(port, created, role.token, bytes);
    const published = await base.commit();
    assert.equal(published.status, 200);
    await base.release();
    const retained = {
      ...created,
      revision: published.body.revision,
      manifestHash: published.body.manifestHash,
    };
    const operationId = randomUUID();
    const acquired = await h.api<D.WorkspaceOperationLease>(
      `/v1/workspaces/${created.workspaceId}/leases`,
      {
        requestId: randomUUID(),
        operationId,
        bindingVersion: retained.bindingVersion,
        baseRevision: retained.revision,
        deadline: Date.now() + 120000,
      },
      "POST",
      role.token,
    );
    assert.equal(acquired.status, 201);
    const env = await h.server
      .getWorker<{ WORKSPACES: DurableObjectNamespace<WorkspaceObject> }>()
      .getEnv();
    const owner = env.WORKSPACES.getByName(created.workspaceId);
    const cp = h.env.CONTROL_PLANE.getByName("control");
    // Use discovery's deployment identity, not a workspace/object name.
    const protocol = await h.api<D.Protocol>("/v1/protocol");
    assert.equal(protocol.status, 200);
    const auth = async () => ({
      ...value(
        await cp.authenticate({
          bearer: role.token,
          deploymentId: protocol.body.deploymentId,
          requestId: randomUUID(),
          deadline: Date.now() + 30000,
        }),
      ),
      registrationId: acquired.body.registrationId,
    });
    const context = await auth();
    const details = await owner.storeFixtureLease(acquired.body.leaseId);
    const capacity = value(
      await owner.reserveCapacity(context, {
        operationId: randomUUID(),
        ownerId: created.workspaceId,
        policyVersion: details.policyVersion,
        bytes: 2 * 1024 * 1024,
        admissionSlots: 0,
      }),
    );
    const allocation = value(
      await owner.allocateStore(context, {
        authorityId: created.workspaceId,
        workspaceId: created.workspaceId,
        role: "revision-store",
        uploadId: randomUUID(),
        baseRevision: retained.revision,
        generation: details.generation,
        operationDigest: details.operationDigest,
        capacityReservationId: capacity.reservationId,
        reservedBytes: capacity.bytes,
        deadline: Date.now() + 3000,
      }),
    );
    const child = env.WORKSPACES.getByName(allocation.childId);
    value(await child.initializeStore(context, allocation));
    const disposable = Buffer.alloc(128 * 1024, 0x6b);
    const entry: D.ManifestEntry = {
      path: "unreferenced.bin",
      type: "file",
      mode: 420,
      size: disposable.byteLength,
      sha256: createHash("sha256").update(disposable).digest("hex"),
    };
    assert.equal(await owner.storeFixtureWriteBlob(context, allocation, entry, disposable), 204);
    const lookup: D.StoreLookup = {
      allocationId: allocation.allocationId,
      authorityId: allocation.authorityId,
      workspaceId: allocation.workspaceId,
      childId: allocation.childId,
    };
    const before = value(await child.describeStore(context, lookup));
    assert.ok((before.measuredBytes ?? 0) >= disposable.byteLength);
    const early = await owner.retireStore(context, lookup);
    assert.equal(early.ok, false, "Actual cleanup grace must protect a live disposable allocation");
    if (early.ok) assert.fail("Premature retirement accepted");
    assert.equal(early.code, "conflict");
    assert.equal(early.message, "Allocation is referenced, pinned or within cleanup grace");
    const absent = await fetch(
      `${roles.endpoint}/v1/workspaces/${created.workspaceId}/read?${new URLSearchParams({ revision: retained.revision, path: entry.path })}`,
      {
        headers: { Authorization: `Bearer ${role.token}` },
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      },
    );
    assert.equal(
      absent.status,
      404,
      "Unreferenced child bytes cannot appear through a published revision",
    );
    const graceEnds = allocation.deadline + 60000;
    while (Date.now() <= graceEnds)
      await new Promise<void>((accept) =>
        setTimeout(accept, Math.min(500, graceEnds - Date.now() + 1)),
      );
    const fresh = await auth();
    const retirement = value(await owner.retireStore(fresh, lookup));
    const deleted = value(await owner.deleteStore(fresh, retirement));
    assert.equal(deleted.deallocated, true);
    const after = value(await child.describeStore(await auth(), lookup));
    assert.equal(after.state, "deleted");
    assert.ok(
      (after.measuredBytes ?? Infinity) < (before.measuredBytes ?? 0),
      "A metadata counter is not physical Computer/SQLite storage relief",
    );
    assert.equal(
      (await child.initializeStore(await auth(), allocation)).ok,
      false,
      "A deleted permanent child identity cannot resurrect",
    );
    await readWorkspace(port, retained, role.token, bytes);
    return {
      actualComputerAndSqlite: true,
      realGraceMs: 60000,
      graceProtected: true,
      disposableMeasuredBytesBefore: before.measuredBytes,
      disposableMeasuredBytesAfter: after.measuredBytes,
      actualDeallocation: true,
      tombstonePreserved: true,
      unreferencedPublicReadStatus: 404,
      publishedIndependentHashesPreserved: true,
      limitations: [
        "Local real workerd/Computer storage; no live image, account capacity or cloud eviction proof",
      ],
    };
  } finally {
    const cleanup = await roles.cleanup();
    await h.close();
    assert.ok(
      cleanup.every((role) => role.state === "complete"),
      "Storage fixture role revocation is pending/unknown",
    );
  }
}
