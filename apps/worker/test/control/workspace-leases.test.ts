import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { ControlPlaneRpc } from "../../src/boundary/control-plane.js";
import { harness, request, scope, uuid, value } from "./harness.ts";

test("public non-job leases bind the literal preimage, recover lost acks and never revive closing authority", async () => {
  const h = await harness();
  try {
    const admin = await h.auth();
    const api = h.cp as unknown as Pick<ControlPlaneRpc, "handleApi">;
    const created = value(
      await api.handleApi(
        admin,
        request("createWorkspace", { requestId: uuid(), config: { kind: "computer" } }),
      ),
    );
    if (created.status !== 201) assert.fail("No actual authority binding");
    const binding = created.body;
    const resources = {
      ...scope(["workspace.write"]),
      agentIds: [],
      conversationIds: [],
      workspaceIds: [binding.workspaceId],
      executorIds: [],
      backendIds: [],
      tools: [],
    };
    const issued = await h.mint({
      requestId: uuid(),
      role: "client",
      grants: [{ grantId: "write", version: 1, resources }],
    });
    const writer = await h.auth(issued.token);
    const body = {
      requestId: uuid(),
      operationId: uuid(),
      bindingVersion: binding.bindingVersion,
      baseRevision: binding.revision,
      deadline: Date.now() + 120000,
    };
    const acquire = request("acquireWorkspaceLease", body, { workspaceId: binding.workspaceId });
    const authority = h.env.WORKSPACES.getByName(binding.workspaceId);
    await authority.setLeaseDrop("acquire");
    assert.equal(
      (await h.cp.acquireWorkspaceLease(writer, acquire)).ok,
      false,
      "lost acquire ack cannot fabricate a lease",
    );
    const reservation = await h.cp.reservationFor(writer.principalId, body.operationId);
    assert.ok(reservation);
    assert.equal(reservation.ownerKind, "workspace-operation");
    assert.deepEqual(reservation.target, {
      kind: "backend",
      backendId: binding.workspaceId,
      generation: binding.bindingVersion,
    });
    const literal = JSON.stringify({
      baseRevision: body.baseRevision,
      bindingVersion: binding.bindingVersion,
      credential: {
        credentialId: writer.credentialId,
        generation: writer.generation,
        grantVersion: writer.grantVersion,
      },
      deadline: body.deadline,
      deploymentId: h.deploymentId,
      operationId: body.operationId,
      target: {
        backendId: binding.workspaceId,
        generation: binding.bindingVersion,
        kind: "backend",
      },
      workspaceId: binding.workspaceId,
    });
    assert.equal(
      reservation.operationDigest,
      createHash("sha256").update(`fortipi:workspace-lease:v1\n${literal}`).digest("hex"),
    );
    const firstPrivate = await authority.leaseInput("acquire", reservation.reservationId);
    await authority.setLeaseDrop(null);
    const acquired = value(await h.cp.acquireWorkspaceLease(await h.auth(issued.token), acquire));
    if (acquired.status !== 201) assert.fail("No recovered actual lease");
    assert.equal(acquired.body.ownerKind, "workspace-operation");
    assert.equal("jobId" in acquired.body, false);
    assert.equal(acquired.body.fence, "1");
    assert.deepEqual(
      await authority.leaseInput("acquire", reservation.reservationId),
      firstPrivate,
      "retry cannot change expiry or allocate another fence",
    );
    const changed = await h.cp.acquireWorkspaceLease(
      writer,
      request(
        "acquireWorkspaceLease",
        { ...body, deadline: body.deadline + 1 },
        { workspaceId: binding.workspaceId },
      ),
    );
    assert.equal(changed.ok, false);
    const scoped = { ...writer, registrationId: reservation.registrationIds.workspace };
    await authority.reportStorage(scoped, "workspace");
    assert.equal(
      (
        await h.cp.reserveCapacity(writer, {
          ownerId: binding.workspaceId,
          operationId: uuid(),
          policyVersion: 1,
          bytes: 4096,
          admissionSlots: 0,
        })
      ).ok,
      false,
      "workspace capacity needs actual current registration",
    );
    const capacity = value(
      await h.cp.reserveCapacity(scoped, {
        ownerId: binding.workspaceId,
        operationId: uuid(),
        policyVersion: 1,
        bytes: 4096,
        admissionSlots: 0,
      }),
    );
    value(
      await h.cp.settleCapacity(scoped, {
        reservationId: capacity.reservationId,
        disposition: "unused",
        observedBytes: 0,
      }),
    );
    assert.equal(
      (
        await h.cp.reserveCapacity(scoped, {
          ownerId: binding.workspaceId,
          operationId: uuid(),
          policyVersion: 1,
          bytes: 4096,
          admissionSlots: 1,
        })
      ).ok,
      false,
      "workspace.write does not confer install/job admission authority",
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const renew = request(
      "renewWorkspaceLease",
      { requestId: uuid(), lease: acquired.body },
      { workspaceId: binding.workspaceId, leaseId: acquired.body.leaseId },
    );
    await authority.setLeaseDrop("renew");
    assert.equal((await h.cp.renewWorkspaceLease(writer, renew)).ok, false);
    const renewalPrivate = await authority.leaseInput("renew", renew.body.requestId);
    await authority.setLeaseDrop(null);
    const renewed = value(await h.cp.renewWorkspaceLease(await h.auth(issued.token), renew));
    if (renewed.status !== 200) assert.fail("No recovered renewal");
    assert.equal(renewed.body.leaseVersion, 2);
    assert.equal(renewed.body.fence, acquired.body.fence);
    assert.ok(
      renewed.body.expiresAt > reservation.expiresAt,
      "renewal ceiling is the operation deadline, not first admission cutoff",
    );
    assert.deepEqual(
      await authority.leaseInput("renew", renew.body.requestId),
      renewalPrivate,
      "business retry retains chosen expiry and expected version",
    );
    assert.equal(
      (
        await h.cp.renewWorkspaceLease(writer, {
          ...renew,
          path: { ...renew.path, leaseId: "wrong" },
        })
      ).ok,
      false,
    );
    const releasing = request(
      "releaseWorkspaceLease",
      { requestId: uuid(), lease: renewed.body, reason: "completed" },
      { workspaceId: binding.workspaceId, leaseId: renewed.body.leaseId },
    );
    await authority.setLeaseDrop("release");
    assert.equal((await h.cp.releaseWorkspaceLease(writer, releasing)).ok, false);
    assert.equal(
      (await h.cp.acquireWorkspaceLease(writer, acquire)).ok,
      false,
      "a pending release cannot be revived by an old acquisition receipt",
    );
    assert.equal(
      (await h.cp.renewWorkspaceLease(writer, renew)).ok,
      false,
      "lost release ack cannot revive a renewal receipt",
    );
    const releaseProof = await authority.leaseInput("release", releasing.body.requestId);
    await authority.setLeaseDrop(null);
    const released = value(await h.cp.releaseWorkspaceLease(await h.auth(issued.token), releasing));
    if (released.status !== 200) assert.fail("No actual release");
    assert.deepEqual(Object.keys(released.body).sort(), ["leaseId", "released"]);
    assert.equal(released.body.released, true);
    assert.deepEqual(await authority.leaseInput("release", releasing.body.requestId), releaseProof);
    assert.deepEqual(value(await h.cp.releaseWorkspaceLease(writer, releasing)), released);
  } finally {
    await h.close();
  }
});
