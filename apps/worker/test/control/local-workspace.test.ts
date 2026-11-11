import assert from "node:assert/strict";
import test from "node:test";
import { localStageDigest } from "fortipi-contract";
import type * as D from "../../src/boundary/dto.js";
import { connected, localBinding } from "./connection.ts";
import { harness, request, uuid, value } from "./harness.ts";

test("actual returned prepare/intent/observation/receipt route across distinct principals; lost apply response resumes observe only", async () => {
  const h = await harness();
  let socket: WebSocket | undefined;
  try {
    let channel = await connected(h);
    socket = channel.socket;
    const manifest: D.Manifest = { version: 1, entries: [] };
    const binding = await localBinding(h, channel, manifest, "retained_operator_import");
    channel = binding.channel;
    socket = channel.socket;
    const admin = await h.auth();
    const workspaceId = binding.workspaceId;
    const manifestHash = binding.manifestHash;
    const baseRevision = binding.revision;
    const deadline = Date.now() + 60000;
    const acquired = value(
      await h.cp.acquireWorkspaceLease(
        admin,
        request(
          "acquireWorkspaceLease",
          {
            requestId: uuid(),
            operationId: "local_operation",
            bindingVersion: 2,
            baseRevision,
            deadline,
          },
          { workspaceId },
        ),
      ),
    );
    if (acquired.status !== 201) assert.fail("No actual workspace lease");
    const reservation = await h.cp.reservationFor(admin.principalId, "local_operation");
    assert.ok(reservation);
    const ctx = { ...admin, registrationId: reservation.registrationIds.workspace };
    const lease = acquired.body;
    let local: D.LocalScope = {
      operationId: lease.operationId,
      operationDigest: reservation.operationDigest,
      workspaceId,
      bindingVersion: 2,
      rootBindingId: "root",
      executorId: "executor",
      executorGeneration: 1,
      credential: lease.credential,
      baseRevision,
      lease,
      deadline,
    };
    const prepare: D.LocalPrepare = {
      ...local,
      kind: "prepare",
      commitId: "local_commit",
      expectedManifestHash: manifestHash,
      mode: {
        kind: "staged-change",
        uploadId: "local_upload",
        manifest,
        mutations: [],
        postManifestHash: manifestHash,
        stagedDigest: await localStageDigest({ uploadId: "local_upload", manifest, mutations: [] }),
      },
    };
    const preparing = h.cp.requestLocalWorkspace(ctx, prepare);
    let frame = await channel.wait("workspace.request");
    if (frame.type !== "workspace.request") assert.fail("No prepare frame");
    assert.equal(frame.payload.request.credential.credentialId, ctx.credentialId);
    assert.notEqual(ctx.credentialId, channel.issued.credential.credentialId);
    const preparation: D.LocalPrepared = {
      preparationId: "actual_preparation",
      operationId: local.operationId,
      operationDigest: local.operationDigest,
      preManifestHash: manifestHash,
      stagedDigest: prepare.mode.kind === "staged-change" ? prepare.mode.stagedDigest : "",
      expiresAt: lease.expiresAt,
      state: "prepared",
    };
    channel.send({
      type: "workspace.response",
      requestId: frame.requestId,
      payload: {
        requestId: frame.payload.requestId,
        correlationId: frame.payload.correlationId,
        response: preparation,
      },
    });
    assert.equal(
      (value(await preparing) as D.LocalPrepared).preparationId,
      preparation.preparationId,
    );
    channel.frames.splice(0);
    const authority = h.env.WORKSPACES.getByName(workspaceId);
    const originalIntent = await authority.localIntent("local_commit");
    assert.ok(originalIntent);
    const intent = JSON.parse(originalIntent) as D.LocalCommitIntent;
    assert.equal(intent.preparationId, preparation.preparationId);
    const renewing = h.cp.renewWorkspaceLease(
      ctx,
      request(
        "renewWorkspaceLease",
        { requestId: uuid(), lease },
        { workspaceId, leaseId: lease.leaseId },
      ),
    );
    channel.frames.splice(0);
    frame = await channel.wait("workspace.request");
    if (frame.type !== "workspace.request" || frame.payload.request.kind !== "prepare")
      assert.fail("Renewal must use existing preparation metadata");
    const renewedScope = frame.payload.request;
    assert.deepEqual(renewedScope.mode, prepare.mode);
    assert.equal(renewedScope.lease.leaseVersion, 2);
    channel.send({
      type: "workspace.response",
      requestId: frame.requestId,
      payload: {
        requestId: frame.payload.requestId,
        correlationId: frame.payload.correlationId,
        response: { ...preparation, expiresAt: renewedScope.lease.expiresAt },
      },
    });
    const renewal = value(await renewing);
    if (renewal.status !== 200) assert.fail("No actual renewal");
    local = { ...local, lease: renewal.body };
    assert.deepEqual(
      await authority.localIntent("local_commit"),
      originalIntent,
      "renewal retains the actual original immutable intent",
    );
    channel.frames.splice(0);
    const apply: D.LocalApply = {
      ...local,
      kind: "apply",
      preparationId: preparation.preparationId,
      commitId: "local_commit",
    };
    const applying = h.cp.requestLocalWorkspace(ctx, apply);
    frame = await channel.wait("workspace.request");
    if (frame.type !== "workspace.request") assert.fail("No apply frame");
    assert.equal(frame.payload.request.kind, "apply");
    let applyFrames = 1;
    const closed = new Promise<void>((resolve) =>
      channel.socket.addEventListener("close", () => resolve(), { once: true }),
    );
    channel.socket.close();
    await closed;
    assert.equal(
      (await applying).ok,
      false,
      "disconnect after apply cannot fabricate an observation",
    );
    channel = await connected(h, { workspaceIds: [workspaceId] });
    socket = channel.socket;
    const recovering = h.cp.requestLocalWorkspace(ctx, apply);
    frame = await channel.wait("workspace.request");
    if (frame.type !== "workspace.request") assert.fail("No recovery frame");
    assert.equal(frame.payload.request.kind, "observe", "ambiguous apply must never be sent twice");
    applyFrames += channel.frames.filter(
      (f) => f.type === "workspace.request" && f.payload.request.kind === "apply",
    ).length;
    assert.equal(applyFrames, 1);
    const observation: D.LocalObservation = {
      operationId: local.operationId,
      operationDigest: local.operationDigest,
      preparationId: preparation.preparationId,
      commitId: "local_commit",
      observationSeq: 9,
      preManifestHash: manifestHash,
      postManifestHash: manifestHash,
      appliedAt: Date.now(),
      state: "applied",
    };
    channel.send({
      type: "workspace.response",
      requestId: frame.requestId,
      payload: {
        requestId: frame.payload.requestId,
        correlationId: frame.payload.correlationId,
        response: observation,
      },
    });
    const observed = value(await recovering);
    assert.equal("observationSeq" in observed ? observed.observationSeq : undefined, 9);
    channel.frames.splice(0);
    const receipt = value(await authority.commitLocal(ctx, { intent, observation, manifest }));
    const delivering = h.cp.requestLocalWorkspace(ctx, {
      ...local,
      kind: "receipt",
      preparationId: preparation.preparationId,
      receipt,
    });
    frame = await channel.wait("workspace.request");
    if (frame.type !== "workspace.request") assert.fail("No receipt frame");
    assert.equal(frame.payload.request.kind, "receipt");
    const ack: D.DeliveryAck = {
      deliveryId: "actual_local_receipt_ack",
      sequence: 9,
      persisted: true,
    };
    channel.send({
      type: "workspace.response",
      requestId: frame.requestId,
      payload: {
        requestId: frame.payload.requestId,
        correlationId: frame.payload.correlationId,
        response: ack,
      },
    });
    const delivered = value(await delivering);
    assert.equal("deliveryId" in delivered ? delivered.deliveryId : undefined, ack.deliveryId);
  } finally {
    socket?.close();
    await h.close();
  }
});
