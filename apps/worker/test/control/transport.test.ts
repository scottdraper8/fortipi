import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { assignmentDigest, manifestDigest, operationDigest } from "fortipi-contract";
import type * as D from "../../src/boundary/dto.js";
import { connected } from "./connection.ts";
import { config, harness, request, scope, uuid, value } from "./harness.ts";

test("real sockets: heartbeat writes nothing, reservation precedes lease, duplicate assign sends once, ambiguous recovery queries only", async () => {
  const h = await harness();
  let socket: WebSocket | undefined;
  try {
    const channel = await connected(h);
    socket = channel.socket;
    const admin = await h.auth();
    const count = async (): Promise<number[]> =>
      Promise.all(
        ["credential", "executor", "inbox", "audit", "recipient", "fact"].map((k) =>
          h.cp.rowCount(k),
        ),
      );
    const before = await count();
    for (let n = 0; n < 5; n++)
      channel.send({
        type: "executor.heartbeat",
        requestId: uuid(),
        payload: {
          executorId: "executor",
          generation: 1,
          connectionEpoch: channel.epoch,
          timestamp: Date.now(),
        },
      });
    await channel.wait("executor.heartbeat");
    assert.deepEqual(await count(), before, "heartbeat may update only volatile liveness");
    const operation: D.OperationDigestInput = {
      deploymentId: h.deploymentId,
      agentId: "agent",
      conversationId: "conversation",
      tool: "shell",
      arguments: { command: "synthetic" },
      workspaceId: "workspace",
      baseRevision: "base",
      target: { kind: "executor", executorId: "executor", generation: 1 },
      policyVersion: 1,
      grantVersion: admin.grantVersion,
      deadline: Date.now() + 60000,
    };
    const op = await operationDigest(operation);
    const reservation = value(
      await h.cp.reserveTarget(admin, {
        ownerKind: "job",
        jobId: "job",
        executionId: "execution",
        operationId: "operation",
        operationDigest: op,
        agentId: "agent",
        conversationId: "conversation",
        workspaceId: "workspace",
        bindingVersion: 1,
        target: operation.target,
        actions: ["jobs.dispatch"],
        deadline: operation.deadline,
        expiresAt: Date.now() + 30000,
      }),
    );
    if (reservation.ownerKind !== "job") assert.fail("Not job reservation");
    assert.equal(await h.cp.rowCount("recipient"), 2);
    const lease: D.Lease = {
      leaseId: "lease",
      operationId: "operation",
      credential: reservation.credential,
      registrationId: reservation.registrationIds.workspace,
      leaseVersion: 1,
      workspaceId: "workspace",
      executorId: "executor",
      executorGeneration: 1,
      fence: "1",
      baseRevision: "base",
      expiresAt: reservation.expiresAt,
      ownerKind: "job",
      jobId: "job",
    };
    const identity: D.ExecutionIdentity = {
      jobId: "job",
      executionId: "execution",
      operationDigest: op,
      assignmentDigest: await assignmentDigest({
        operation,
        executionId: "execution",
        reservationId: reservation.reservationId,
        leaseId: lease.leaseId,
        fence: lease.fence,
        executorGeneration: 1,
      }),
      target: operation.target,
      lease,
      baseRevision: "base",
      deadline: operation.deadline,
    };
    const emptyHash = createHash("sha256").update(new Uint8Array()).digest("hex");
    const stageManifest: D.Manifest = {
      version: 1,
      entries: [{ type: "file", path: "empty.bin", size: 0, sha256: emptyHash, mode: 420 }],
    };
    const manifestHash = await manifestDigest(stageManifest);
    const uploadId = await h.env.WORKSPACES.getByName("workspace").allocateStage({
      requestId: uuid(),
      baseRevision: "base",
      lease,
      operationId: reservation.operationId,
      commitId: uuid(),
      manifestHash,
      manifest: stageManifest,
      mutations: [{ kind: "put", path: "empty.bin", size: 0, sha256: emptyHash, mode: 420 }],
      blobs: [{ sha256: emptyHash, chunks: { chunkBytes: 262144, chunkHashes: [] } }],
    });
    const stage: Omit<D.TransferDescriptor, "transferId" | "attemptId"> = {
      deploymentId: h.deploymentId,
      direction: "to-executor",
      purpose: "local-stage",
      workspaceId: "workspace",
      bindingVersion: 1,
      operationId: reservation.operationId,
      operationDigest: reservation.operationDigest,
      jobId: reservation.jobId,
      executionId: reservation.executionId,
      executorId: "executor",
      executorGeneration: 1,
      credential: reservation.credential,
      consumer: { ...scope(), actions: ["workspace.write"] },
      baseRevision: "base",
      lease,
      content: { kind: "workspace-file", path: "empty.bin", manifestHash, uploadId },
      fileSha256: emptyHash,
      size: 0,
      chunkBytes: 262144,
      chunkHashes: [],
      expiresAt: Date.now() + 20000,
      deadline: operation.deadline,
    };
    assert.equal(
      (await h.cp.openTransfer(admin, { ...stage, executionId: "changed_execution" })).ok,
      false,
      "job stage must match the reserved execution before dispatch exists",
    );
    const staged = value(await h.cp.openTransfer(admin, stage));
    assert.equal(
      staged.executionId,
      identity.executionId,
      "reservation alone admits the legitimate pre-dispatch job stage",
    );
    const assignment: D.Assignment = {
      operationContext: {
        deploymentId: operation.deploymentId,
        agentId: operation.agentId,
        conversationId: operation.conversationId,
        policyVersion: operation.policyVersion,
      },
      identity,
      reservationId: reservation.reservationId,
      tool: operation.tool,
      arguments: operation.arguments,
      workspaceId: "workspace",
      bindingVersion: 1,
      rootBindingId: "root",
    };
    value(
      await h.cp.recordDispatchIntent(admin, { reservation, assignment, expectedJobVersion: 1 }),
    );
    const outcomes = await Promise.all([
      h.cp.assignOnce(admin, assignment),
      h.cp.assignOnce(admin, assignment),
    ]);
    outcomes.forEach(value);
    await channel.wait("job.assign");
    assert.equal(
      channel.frames.filter((f) => f.type === "job.assign").length,
      1,
      "persist-before-send allows only one attempted assign",
    );
    const querying = h.cp.queryExecution(admin, identity);
    const query = await channel.wait("job.query");
    assert.equal(channel.frames.filter((f) => f.type === "job.assign").length, 1);
    if (query.type !== "job.query") assert.fail("Not a query");
    channel.send({
      type: "job.query_result",
      requestId: query.requestId,
      payload: { identity, state: "unknown" },
    });
    assert.equal(value(await querying).state, "unknown");
    value(await h.cp.assignOnce(admin, assignment));
    assert.equal(
      channel.frames.filter((f) => f.type === "job.assign").length,
      1,
      "unknown query never authorizes a second assign",
    );
    const dispatcher = await h.mint({
      requestId: uuid(),
      role: "client",
      grants: [{ grantId: "dispatch-only", version: 1, resources: scope(["jobs.dispatch"]) }],
    });
    const dispatchAuth = await h.auth(dispatcher.token);
    assert.equal(
      (await h.cp.queryExecution(dispatchAuth, identity)).ok,
      false,
      "dispatch authority does not grant job reads",
    );
    value(await h.cp.assignOnce(dispatchAuth, assignment));
    assert.equal(
      channel.frames.filter((f) => f.type === "job.assign").length,
      1,
      "dispatch-only retry observes the original send claim without a hidden read grant",
    );
    const canceller = await h.mint({
      requestId: uuid(),
      role: "client",
      grants: [{ grantId: "cancel-only", version: 1, resources: scope(["jobs.cancel"]) }],
    });
    const cancelAuth = await h.auth(canceller.token);
    assert.equal((await h.cp.queryExecution(cancelAuth, identity)).ok, false);
    const cancelling = h.cp.cancelExecution(cancelAuth, {
      identity,
      requestId: uuid(),
      reason: "operator-request",
    });
    // A rejection must be observed before waiting for a frame the old hidden read gate prevents.
    const cancellationFrame = await Promise.race([
      channel.wait("job.cancel"),
      cancelling.then((result) => {
        value(result);
        return undefined;
      }),
    ]);
    assert.ok(
      cancellationFrame?.type === "job.cancel",
      "cancel-only authority must reach the actual executor",
    );
    channel.send({
      type: "job.cancel_ack",
      requestId: cancellationFrame.requestId,
      payload: { identity, disposition: { state: "unknown", possibleExternalEffects: true } },
    });
    assert.equal(value(await cancelling).state, "unknown");
    const recipient = h.env.AGENT_SESSIONS.getByName("agent");
    const resetAt = Date.now() + 2400;
    await recipient.setQuotaFault({
      code: "quota_paused",
      message: "Synthetic provider SQL exhaustion",
      requestId: uuid(),
      retryable: true,
      details: {
        retryAfterMs: 1000,
        pressure: {
          resource: "sql",
          scope: { kind: "account" },
          source: "provider",
          measurement: "observed",
          resetAt,
          reason: "Synthetic known reset",
          action: "retry-later",
        },
      },
    });
    const output: D.ExecutorFrame = {
      type: "job.output",
      requestId: uuid(),
      payload: { identity, sequence: 1, stream: "stdout", text: "retained transport output" },
    };
    channel.send(output);
    const outputAck = await channel.wait("job.output_ack");
    if (outputAck.type !== "job.output_ack") assert.fail("Missing durable output receipt");
    await h.cp.forceDue();
    await h.cp.drainTest();
    const held = JSON.parse(await h.cp.repairState()) as {
      holds: { kind: string; notBefore?: number; pressure: { resetAt?: number } }[];
    };
    const hold = held.holds.find((row) => row.kind === "inbox");
    assert.ok(
      hold?.notBefore && hold.notBefore >= resetAt,
      "known provider reset bounds the durable retry",
    );
    const attempts = await recipient.outputCount();
    await h.cp.forceDue();
    await h.cp.drainTest();
    assert.equal(
      await recipient.outputCount(),
      attempts,
      "a duplicate wake cannot reset a known quota deadline",
    );
    await recipient.setQuotaFault(null);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await h.cp.drainTest();
    assert.equal(
      await recipient.hasReceipt(outputAck.payload.deliveryId),
      true,
      "only the actual receiver ack releases the source inbox",
    );
    const delivered = await recipient.outputCount();
    channel.send(output);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await h.cp.forceDue();
    await h.cp.drainTest();
    assert.equal(
      await recipient.outputCount(),
      delivered,
      "duplicate acknowledged output never becomes another delivery",
    );
    await recipient.setQuotaFault({
      code: "quota_exceeded",
      message: "Synthetic storage full",
      requestId: uuid(),
      retryable: false,
      details: {
        retryAfterMs: 60000,
        pressure: {
          resource: "storage",
          scope: { kind: "object", id: "agent" },
          source: "provider",
          measurement: "observed",
          reason: "Synthetic storage refusal",
          action: "reclaim-storage",
        },
      },
    });
    channel.frames.splice(0);
    channel.send({
      type: "job.output",
      requestId: uuid(),
      payload: { identity, sequence: 2, stream: "stdout", text: "retained while storage paused" },
    });
    await channel.wait("job.output_ack");
    await h.cp.forceDue();
    await h.cp.drainTest();
    const storageState = JSON.parse(await h.cp.repairState()) as {
      holds: { kind: string; reason: string; notBefore?: number; pressure: { resetAt?: number } }[];
      due: { kind: string; due: number | null }[];
    };
    const storageHold = storageState.holds.find((row) => row.kind === "inbox");
    assert.equal(storageHold?.reason, "storage");
    assert.equal(storageHold?.notBefore, undefined);
    assert.equal(storageHold?.pressure.resetAt, undefined);
    assert.equal(
      storageState.due.some((row) => row.kind === "inbox" && row.due === null),
      true,
      "storage has no invented timed reset",
    );
    const pausedAttempts = await recipient.outputCount();
    await h.cp.forceDue();
    await h.cp.drainTest();
    assert.equal(await recipient.outputCount(), pausedAttempts);
    const api = h.cp as unknown as Pick<
      import("../../src/boundary/control-plane.js").ControlPlaneRpc,
      "handleApi"
    >;
    const patch = request("patchConfiguration", {
      requestId: uuid(),
      expectedVersion: 1,
      configuration: { ...config, version: 2 },
    });
    value(await api.handleApi(admin, patch));
    await h.cp.forceDue();
    await h.cp.drainTest();
    await h.cp.forceDue();
    await h.cp.drainTest();
    const afterConfiguration = await recipient.outputCount();
    assert.ok(
      afterConfiguration > pausedAttempts,
      "verified configuration permits a bounded repair attempt",
    );
    value(await api.handleApi(admin, patch));
    await h.cp.forceDue();
    await h.cp.drainTest();
    assert.equal(
      await recipient.outputCount(),
      afterConfiguration,
      "duplicate configuration receipt cannot reset a storage pause",
    );
    await recipient.setQuotaFault(null);
    value(
      await api.handleApi(
        admin,
        request("patchConfiguration", {
          requestId: uuid(),
          expectedVersion: 2,
          configuration: { ...config, version: 3 },
        }),
      ),
    );
    await h.cp.forceDue();
    await h.cp.drainTest();
    await h.cp.forceDue();
    await h.cp.drainTest();
    assert.equal(
      (JSON.parse(await h.cp.repairState()) as { holds: { kind: string }[] }).holds.some(
        (row) => row.kind === "inbox",
      ),
      false,
    );
    await recipient.setDrop(true);
    const closed = new Promise<void>((resolve) =>
      channel.socket.addEventListener("close", () => resolve(), { once: true }),
    );
    channel.socket.close();
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await h.cp.forceDue();
    await h.cp.drainTest();
    await h.cp.forceDue();
    await h.cp.drainTest();
    assert.equal(
      await recipient.eventCount(),
      1,
      "semantic offline transition assigns a real event coordinate",
    );
    assert.equal(
      await h.cp.rowCount("fact"),
      1,
      "lost receiver acknowledgment retains the source fact",
    );
    await recipient.setDrop(false);
    await h.cp.forceDue();
    await h.cp.drainTest();
    assert.equal(
      await recipient.eventCount(),
      1,
      "retry uses stable fact identity and cannot append another event",
    );
    assert.equal(await h.cp.rowCount("fact"), 0);
    assert.equal(await h.cp.rowCount("fact_ack"), 1);
  } finally {
    socket?.close();
    await h.close();
  }
});
