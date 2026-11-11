import assert from "node:assert/strict";
import test from "node:test";
import { assignmentDigest, operationDigest } from "fortipi-contract";
import type * as D from "../../src/boundary/dto.js";
import { connected } from "./connection.ts";
import { harness, request, scope, uuid, value } from "./harness.ts";

test("dispatch intent requires dispatch authority and retained resources without job read access", async () => {
  const h = await harness();
  let socket: WebSocket | undefined;
  try {
    const channel = await connected(h);
    socket = channel.socket;
    const admission = async (actions: string[]) => {
      const issued = await h.mint({
        requestId: uuid(),
        role: "client",
        grants: [{ grantId: "scoped", version: 1, resources: scope(actions) }],
      });
      const actor = await h.auth(issued.token);
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
        grantVersion: actor.grantVersion,
        deadline: Date.now() + 60000,
      };
      const reservation = value(
        await h.cp.reserveTarget(actor, {
          ownerKind: "job",
          jobId: uuid(),
          executionId: uuid(),
          operationId: uuid(),
          operationDigest: await operationDigest(operation),
          agentId: "agent",
          conversationId: "conversation",
          workspaceId: "workspace",
          bindingVersion: 1,
          target: operation.target,
          actions,
          deadline: operation.deadline,
          expiresAt: Date.now() + 30000,
        }),
      );
      assert.equal(reservation.ownerKind, "job");
      const lease: D.Lease = {
        ownerKind: "job",
        jobId: reservation.jobId,
        leaseId: uuid(),
        operationId: reservation.operationId,
        credential: reservation.credential,
        registrationId: reservation.registrationIds.workspace,
        leaseVersion: 1,
        workspaceId: "workspace",
        executorId: "executor",
        executorGeneration: 1,
        fence: "1",
        baseRevision: "base",
        expiresAt: reservation.expiresAt,
      };
      const assignment: D.Assignment = {
        operationContext: {
          deploymentId: h.deploymentId,
          agentId: "agent",
          conversationId: "conversation",
          policyVersion: 1,
        },
        identity: {
          jobId: reservation.jobId,
          executionId: reservation.executionId,
          operationDigest: reservation.operationDigest,
          assignmentDigest: await assignmentDigest({
            operation,
            executionId: reservation.executionId,
            reservationId: reservation.reservationId,
            leaseId: lease.leaseId,
            fence: lease.fence,
            executorGeneration: 1,
          }),
          target: operation.target,
          lease,
          baseRevision: "base",
          deadline: operation.deadline,
        },
        reservationId: reservation.reservationId,
        tool: "shell",
        arguments: operation.arguments,
        workspaceId: "workspace",
        bindingVersion: 1,
        rootBindingId: "root",
      };
      return {
        issued,
        actor,
        assignment,
        intent: { reservation, assignment, expectedJobVersion: 1 },
      };
    };
    // A reservation for observing a job cannot authorize dispatch admission.
    const reader = await admission(["jobs.read"]);
    assert.equal(
      (await h.cp.recordDispatchIntent(reader.actor, reader.intent)).ok,
      false,
      "a read-only reservation cannot admit dispatch intent",
    );
    const writer = await admission(["jobs.dispatch"]);
    value(await h.cp.recordDispatchIntent(writer.actor, writer.intent));
    assert.equal((await h.cp.queryExecution(writer.actor, writer.assignment.identity)).ok, false);
    value(await h.cp.assignOnce(writer.actor, writer.assignment));
    await channel.wait("job.assign");
    const readCredential = await h.mint({
      requestId: uuid(),
      role: "client",
      grants: [{ grantId: "read-only", version: 1, resources: scope(["jobs.read"]) }],
    });
    const reading = h.cp.queryExecution(
      await h.auth(readCredential.token),
      writer.assignment.identity,
    );
    const query = await channel.wait("job.query");
    assert.equal(query.type, "job.query");
    channel.send({
      type: "job.query_result",
      requestId: query.requestId,
      payload: { identity: writer.assignment.identity, state: "unknown" },
    });
    assert.equal(
      value(await reading).state,
      "unknown",
      "job-read authority alone can query the retained execution",
    );
    const wrongTarget = await h.mint({
      requestId: uuid(),
      role: "client",
      grants: [
        {
          grantId: "other-target",
          version: 1,
          resources: { ...scope(["jobs.read"]), executorIds: ["other-executor"] },
        },
      ],
    });
    assert.equal(
      (await h.cp.queryExecution(await h.auth(wrongTarget.token), writer.assignment.identity)).ok,
      false,
      "query authority must cover the retained tool and target as well as job resources",
    );
    const wrongScope = await h.mint({
      requestId: uuid(),
      role: "client",
      grants: [
        {
          grantId: "wrong-agent",
          version: 1,
          resources: { ...scope(["jobs.dispatch", "jobs.cancel"]), agentIds: ["other"] },
        },
      ],
    });
    const other = await h.auth(wrongScope.token);
    assert.equal((await h.cp.assignOnce(other, writer.assignment)).ok, false);
    assert.equal(
      (
        await h.cp.cancelExecution(other, {
          identity: writer.assignment.identity,
          requestId: uuid(),
          reason: "unauthorized",
        })
      ).ok,
      false,
    );
    value(
      await h.cp.revokeCredential(
        await h.auth(),
        request(
          "revokeCredential",
          { requestId: uuid(), expectedGeneration: writer.actor.generation },
          { id: writer.actor.credentialId },
        ),
      ),
    );
    assert.equal(
      (await h.cp.assignOnce(writer.actor, writer.assignment)).ok,
      false,
      "retained dispatch permission cannot bypass a current credential floor",
    );
    assert.equal(
      (await h.cp.assignOnce(await h.auth(), writer.assignment)).ok,
      false,
      "another current dispatcher cannot restore the revoked execution owner",
    );
    assert.equal(channel.frames.filter((frame) => frame.type === "job.assign").length, 1);
    channel.frames.splice(0);
    const current = await admission(["jobs.dispatch"]);
    value(await h.cp.recordDispatchIntent(current.actor, current.intent));
    value(await h.cp.assignOnce(current.actor, current.assignment));
    await channel.wait("job.assign");
    value(
      await h.cp.revokeExecutor(
        await h.auth(),
        request("revokeExecutor", { requestId: uuid(), expectedGeneration: 1 }, { id: "executor" }),
      ),
    );
    assert.equal(
      (await h.cp.assignOnce(current.actor, current.assignment)).ok,
      false,
      "duplicate send claims cannot bypass the current executor floor",
    );
    assert.equal(
      (await h.cp.recordDispatchIntent(current.actor, current.intent)).ok,
      false,
      "retained intent receipts cannot bypass the current executor floor",
    );
    assert.equal(channel.frames.filter((frame) => frame.type === "job.assign").length, 1);
  } finally {
    socket?.close();
    await h.close();
  }
});
