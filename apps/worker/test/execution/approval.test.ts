import assert from "node:assert/strict";
import test from "node:test";
import { resourceId } from "../../src/api/common.ts";
import type * as D from "../../src/boundary/dto.js";
import { eventually } from "../agent/harness.ts";
import { nativeService } from "./native-service.ts";

test("real Pi tool attaches one child and waits without acquiring execution before approval", {
  timeout: 25000,
}, async () => {
  const n = await nativeService({ approve: false });
  const { h, agent, conversation, probe, sent, state } = n;
  try {
    assert.equal(sent.status, 202);
    const waiting = await eventually(
      state,
      (value) => value.jobs[0]?.state === "awaiting_approval",
    ).catch(async (error) => {
      console.log(
        await probe.toolStateJson(conversation.conversationId),
        await probe.inspectionJson(conversation.conversationId),
      );
      throw error;
    });
    assert.equal(waiting.jobs.length, 1);
    assert.equal(
      waiting.jobs[0]?.hasExecution,
      false,
      "Human approval precedes target reservation/lease/execution identity",
    );
    const children = waiting.tasks.filter((task) => task.kind === "fortipi.dispatch");
    assert.equal(children.length, 1, "Actual persisted Pi child count");
    assert.ok(children[0]?.owner, "Actual child must belong to its Pi tool task");
    const task = await h.api<D.Task>(`/v1/tasks/${sent.body.taskId}`);
    assert.equal(task.status, 200);
    assert.deepEqual(task.body.status, {
      state: "waiting",
      reason: "human-approval",
      supportedContinuations: [],
    });
    const approvalId = waiting.jobs[0]?.approvalId;
    assert.ok(approvalId);
    const approval = await h.api<D.Approval>(`/v1/approvals/${approvalId}`);
    assert.equal(approval.status, 200);
    assert.equal(approval.body.operation.tool, "shell");
    const decision: D.OperationRequest<"decideApproval">["body"] = {
      requestId: crypto.randomUUID(),
      expectedVersion: approval.body.version,
      operationDigest: approval.body.operation.operationDigest,
      decision: "reject",
    };
    const rejected = await h.api<D.Approval>(`/v1/approvals/${approvalId}/decisions`, decision);
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.state, "rejected");
    const retry = await h.api<D.Approval>(`/v1/approvals/${approvalId}/decisions`, decision);
    assert.deepEqual(retry.body, rejected.body);
    const conflicting = await h.api(`/v1/approvals/${approvalId}/decisions`, {
      ...decision,
      requestId: crypto.randomUUID(),
      decision: "approve",
    });
    assert.equal(conflicting.status, 409);
    const settled = await eventually(state, (value) => value.jobs[0]?.state === "cancelled");
    assert.equal(settled.jobs[0]?.hasExecution, false);
    assert.equal(settled.tasks.filter((task) => task.kind === "fortipi.dispatch").length, 1);
    const jobId = settled.jobs[0]!.jobId;
    const prior = await h.api<D.Job>(`/v1/jobs/${jobId}`);
    assert.equal(prior.status, 200);
    const reconcile: D.ReconcileInput = {
      requestId: crypto.randomUUID(),
      expectedVersion: prior.body.version,
      reason: "Acknowledge the rejected operation",
      action: { kind: "acknowledge-failed" },
    };
    const acknowledged = await h.api<D.ReconcileReceipt>(`/v1/jobs/${jobId}/reconcile`, reconcile);
    assert.equal(acknowledged.status, 202, JSON.stringify(acknowledged.body));
    assert.equal(acknowledged.body.disposition, "failed-acknowledged");
    assert.deepEqual(
      await h.api(`/v1/jobs/${jobId}/reconcile`, reconcile),
      acknowledged,
      "Same intent survives the job version advance",
    );
    const current = await h.api<D.Job>(`/v1/jobs/${jobId}`);
    assert.equal(
      current.body.state,
      "cancelled",
      "Reconciliation preserves the original terminal disposition",
    );
    assert.equal(current.body.version, prior.body.version + 1);
    const replay = await h.api<D.ReplayPage>(
      `/v1/conversations/${conversation.conversationId}/events?after=0`,
    );
    assert.equal(replay.status, 200);
    const events = replay.body.events.filter((event) => event.type === "job.reconciled");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.jobId, jobId);
    const conflict = await h.api(`/v1/jobs/${jobId}/reconcile`, {
      ...reconcile,
      reason: "Different meaning",
    });
    assert.equal(conflict.status, 409);
    const piAfter = await state();
    assert.equal(piAfter.tasks.filter((task) => task.kind === "fortipi.dispatch").length, 1);
    assert.equal(piAfter.jobs[0]?.hasExecution, false);
    const freshCredential = await h.api<D.CredentialReceipt>("/v1/admin/credentials", {
      requestId: crypto.randomUUID(),
      role: "client",
      expiresAt: Date.now() + 180000,
      grants: [
        {
          grantId: "explicit-fresh-business-grant",
          version: 1,
          resources: {
            agentIds: [agent.agentId],
            conversationIds: [conversation.conversationId],
            workspaceIds: [n.workspaceId],
            executorIds: [n.f.profile.executorId],
            backendIds: [],
            tools: ["shell"],
            actions: [
              "jobs.reconcile",
              "jobs.dispatch",
              "workspace.write",
              "jobs.read",
              "approvals.read",
              "approvals.decide",
              "tasks.cancel",
            ],
          },
        },
      ],
    });
    assert.equal(freshCredential.body.state, "issued");
    if (freshCredential.body.state !== "issued")
      assert.fail("Actual scoped fresh authorization required");
    const freshInput: D.ReconcileInput = {
      requestId: crypto.randomUUID(),
      expectedVersion: current.body.version,
      reason: "Explicitly request a different operation after rejection",
      action: {
        kind: "new-job",
        authorizationId: crypto.randomUUID(),
      },
    };
    const fresh = await h.api<D.ReconcileReceipt>(
      `/v1/jobs/${jobId}/reconcile`,
      freshInput,
      "POST",
      freshCredential.body.token,
    );
    assert.equal(fresh.status, 202, JSON.stringify(fresh.body));
    assert.equal(fresh.body.disposition, "new-job-requested");
    assert.equal(
      typeof fresh.body.newJobId,
      "string",
      "Server durably allocates the omitted opaque ID",
    );
    assert.notEqual(fresh.body.newJobId, jobId);
    const allocated = await eventually(state, (view) =>
      view.jobs.some(
        (job) => job.jobId === fresh.body.newJobId && job.state === "awaiting_approval",
      ),
    );
    assert.equal(
      allocated.tasks.filter((task) => task.kind === "fortipi.dispatch").length,
      2,
      "One fresh Pi child alongside the original child",
    );
    assert.deepEqual(
      await h.api(`/v1/jobs/${jobId}/reconcile`, freshInput, "POST", freshCredential.body.token),
      fresh,
    );
    assert.equal(
      (await state()).tasks.filter((task) => task.kind === "fortipi.dispatch").length,
      2,
    );
    const newJob = await h.api<D.Job>(
      `/v1/jobs/${fresh.body.newJobId}`,
      undefined,
      "GET",
      freshCredential.body.token,
    );
    assert.equal(newJob.status, 200);
    assert.notEqual(newJob.body.operationDigest, prior.body.operationDigest);
    assert.notEqual(newJob.body.taskId, prior.body.taskId);
    assert.equal(
      newJob.body.execution,
      undefined,
      "Fresh authorization does not reuse an old execution or skip approval",
    );
    const oldAgain = await h.api<D.Job>(`/v1/jobs/${jobId}`);
    assert.equal(oldAgain.body.state, "cancelled");
    const changed = await h.api(
      `/v1/jobs/${jobId}/reconcile`,
      { ...freshInput, reason: "Changed business payload" },
      "POST",
      freshCredential.body.token,
    );
    assert.equal(changed.status, 409);
    const newApprovalId = allocated.jobs.find(
      (job) => job.jobId === fresh.body.newJobId,
    )?.approvalId;
    assert.ok(newApprovalId);
    assert.notEqual(newApprovalId, approvalId);
    const newApproval = await h.api<D.Approval>(
      `/v1/approvals/${newApprovalId}`,
      undefined,
      "GET",
      freshCredential.body.token,
    );
    assert.equal(newApproval.status, 200);
    assert.notEqual(newApproval.body.operation.operationId, approval.body.operation.operationId);
    const deniedFresh = await h.api(
      `/v1/approvals/${newApprovalId}/decisions`,
      {
        requestId: crypto.randomUUID(),
        expectedVersion: newApproval.body.version,
        operationDigest: newApproval.body.operation.operationDigest,
        decision: "reject",
      },
      "POST",
      freshCredential.body.token,
    );
    assert.equal(deniedFresh.status, 200);
    await eventually(state, (view) =>
      view.jobs.some((job) => job.jobId === fresh.body.newJobId && job.state === "cancelled"),
    );
    const freshTask = await h.api<D.Task>(`/v1/tasks/${newJob.body.taskId}`);
    assert.equal(freshTask.status, 200);
    assert.equal(
      freshTask.body.status.state,
      "cancelled",
      "Fresh task projects its own terminal disposition",
    );
    const limited = await h.api<D.CredentialReceipt>("/v1/admin/credentials", {
      requestId: crypto.randomUUID(),
      role: "client",
      grants: [
        {
          grantId: crypto.randomUUID(),
          version: 1,
          resources: {
            agentIds: [agent.agentId],
            conversationIds: [conversation.conversationId],
            workspaceIds: [n.workspaceId],
            executorIds: [n.f.profile.executorId],
            backendIds: [],
            tools: ["shell"],
            actions: ["jobs.reconcile"],
          },
        },
      ],
    });
    if (limited.body.state !== "issued") assert.fail("Actual narrow credential required");
    const noFreshAuthority = await h.api(
      `/v1/jobs/${jobId}/reconcile`,
      {
        ...freshInput,
        requestId: crypto.randomUUID(),
        expectedVersion: oldAgain.body.version,
        action: {
          kind: "new-job",
          authorizationId: crypto.randomUUID(),
          newJobId: resourceId("j", agent.agentId),
        },
      },
      "POST",
      limited.body.token,
    );
    assert.equal(
      noFreshAuthority.status,
      403,
      "Reconciliation alone grants no new dispatch/write authority",
    );
    assert.equal((await h.api<D.Job>(`/v1/jobs/${jobId}`)).body.version, oldAgain.body.version);
    assert.equal(
      (await state()).tasks.filter((task) => task.kind === "fortipi.dispatch").length,
      2,
    );
    const reusedId = await h.api(
      `/v1/jobs/${jobId}/reconcile`,
      {
        ...freshInput,
        requestId: crypto.randomUUID(),
        expectedVersion: oldAgain.body.version,
        action: {
          kind: "new-job",
          authorizationId: crypto.randomUUID(),
          newJobId: fresh.body.newJobId,
        },
      },
      "POST",
      freshCredential.body.token,
    );
    assert.equal(
      reusedId.status,
      409,
      "An explicit existing job ID cannot acquire another authorization",
    );
    const originalId = await h.api(
      `/v1/jobs/${jobId}/reconcile`,
      {
        ...freshInput,
        requestId: crypto.randomUUID(),
        expectedVersion: oldAgain.body.version,
        action: { kind: "new-job", authorizationId: crypto.randomUUID(), newJobId: jobId },
      },
      "POST",
      freshCredential.body.token,
    );
    assert.equal(originalId.status, 400, "Explicit ID cannot identify the old operation");
    const cancellable = await h.api<D.ReconcileReceipt>(
      `/v1/jobs/${jobId}/reconcile`,
      {
        requestId: crypto.randomUUID(),
        expectedVersion: oldAgain.body.version,
        reason: "Independently cancel a fresh standalone task",
        action: { kind: "new-job", authorizationId: crypto.randomUUID() },
      },
      "POST",
      freshCredential.body.token,
    );
    assert.equal(cancellable.status, 202);
    const cancelJob = await h.api<D.Job>(
      `/v1/jobs/${cancellable.body.newJobId}`,
      undefined,
      "GET",
      freshCredential.body.token,
    );
    assert.equal(cancelJob.status, 200);
    const cancelInput: D.TaskControl = {
      requestId: crypto.randomUUID(),
      reason: "Cancel before approval and any execution",
    };
    const cancelReceipt = await h.api<D.ControlReceipt>(
      `/v1/tasks/${cancelJob.body.taskId}/cancel`,
      cancelInput,
      "POST",
      freshCredential.body.token,
    );
    assert.equal(cancelReceipt.status, 202, JSON.stringify(cancelReceipt.body));
    assert.equal(cancelReceipt.body.disposition.possibleExternalEffects, false);
    assert.deepEqual(
      await h.api(
        `/v1/tasks/${cancelJob.body.taskId}/cancel`,
        cancelInput,
        "POST",
        freshCredential.body.token,
      ),
      cancelReceipt,
    );
    const cancelledTask = await eventually(
      () => h.api<D.Task>(`/v1/tasks/${cancelJob.body.taskId}`),
      (value) => value.body.status.state === "cancelled",
    );
    assert.equal(cancelledTask.body.taskId, cancelJob.body.taskId);
    const noExecution = await h.api<D.Job>(
      `/v1/jobs/${cancellable.body.newJobId}`,
      undefined,
      "GET",
      freshCredential.body.token,
    );
    assert.equal(noExecution.body.state, "cancelled");
    assert.equal(noExecution.body.execution, undefined);
  } finally {
    await n.close();
  }
});
