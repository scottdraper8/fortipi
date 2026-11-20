import assert from "node:assert/strict";
import test from "node:test";
import { resourceId } from "../../src/api/common.ts";
import type * as D from "../../src/boundary/dto.js";
import { eventually } from "../agent/harness.ts";
import { nativeService } from "./native-service.ts";

test("real Pi tool attaches one child and waits without acquiring execution before approval", {
  timeout: 25000,
}, async (t) => {
  type ApprovalPhase =
    | "fixture"
    | "original-approval-wait"
    | "original-approval-snapshot"
    | "original-approval-read"
    | "original-reject"
    | "original-cancel-wait"
    | "acknowledge-rejection"
    | "fresh-authority"
    | "fresh-request"
    | "fresh-approval-wait"
    | "fresh-identity"
    | "fresh-reject"
    | "fresh-cancel-wait"
    | "narrow-authority"
    | "identity-conflicts"
    | "standalone-new-job"
    | "standalone-job-read"
    | "standalone-cancel"
    | "standalone-cancel-retry"
    | "standalone-cancel-wait"
    | "final-job-read"
    | "close";
  const began = performance.now();
  let phase: ApprovalPhase = "fixture";
  const enter = (next: ApprovalPhase) => {
    phase = next;
  };
  const aborted = () => {
    try {
      const elapsed = performance.now() - began;
      const elapsedMs = Number.isFinite(elapsed)
        ? Math.min(60_000, Math.max(0, Math.round(elapsed)))
        : 0;
      t.diagnostic(
        JSON.stringify({ diagnostic: "approval-phase", phase, event: "aborted", elapsedMs }),
      );
    } catch {
      // Diagnostics must never change the test result.
    }
  };
  t.signal.addEventListener("abort", aborted, { once: true });
  t.after(() => t.signal.removeEventListener("abort", aborted));
  enter("fixture");
  const n = await nativeService({ approve: false });
  const { h, agent, conversation, probe, sent, state } = n;
  try {
    assert.equal(sent.status, 202);
    enter("original-approval-wait");
    const waiting = await eventually(
      state,
      (value) => value.jobs[0]?.state === "awaiting_approval",
    ).catch(async (error) => {
      enter("original-approval-snapshot");
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
    enter("original-approval-read");
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
    enter("original-reject");
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
    enter("original-cancel-wait");
    const settled = await eventually(state, (value) => value.jobs[0]?.state === "cancelled");
    assert.equal(settled.jobs[0]?.hasExecution, false);
    assert.equal(settled.tasks.filter((task) => task.kind === "fortipi.dispatch").length, 1);
    const jobId = settled.jobs[0]!.jobId;
    enter("acknowledge-rejection");
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
    enter("fresh-authority");
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
    enter("fresh-request");
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
    enter("fresh-approval-wait");
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
    enter("fresh-identity");
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
    enter("fresh-reject");
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
    enter("fresh-cancel-wait");
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
    enter("narrow-authority");
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
    enter("identity-conflicts");
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
    enter("standalone-new-job");
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
    enter("standalone-job-read");
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
    enter("standalone-cancel");
    const cancelReceipt = await h.api<D.ControlReceipt>(
      `/v1/tasks/${cancelJob.body.taskId}/cancel`,
      cancelInput,
      "POST",
      freshCredential.body.token,
    );
    assert.equal(cancelReceipt.status, 202, JSON.stringify(cancelReceipt.body));
    assert.equal(cancelReceipt.body.disposition.possibleExternalEffects, false);
    enter("standalone-cancel-retry");
    assert.deepEqual(
      await h.api(
        `/v1/tasks/${cancelJob.body.taskId}/cancel`,
        cancelInput,
        "POST",
        freshCredential.body.token,
      ),
      cancelReceipt,
    );
    enter("standalone-cancel-wait");
    const cancelledTask = await eventually(
      () => h.api<D.Task>(`/v1/tasks/${cancelJob.body.taskId}`),
      (value) => value.body.status.state === "cancelled",
    );
    assert.equal(cancelledTask.body.taskId, cancelJob.body.taskId);
    enter("final-job-read");
    const noExecution = await h.api<D.Job>(
      `/v1/jobs/${cancellable.body.newJobId}`,
      undefined,
      "GET",
      freshCredential.body.token,
    );
    assert.equal(noExecution.body.state, "cancelled");
    assert.equal(noExecution.body.execution, undefined);
  } finally {
    enter("close");
    await n.close();
  }
});
