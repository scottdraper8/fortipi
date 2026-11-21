import assert from "node:assert/strict";
import { test } from "node:test";
import type { Approval } from "fortipi-contract";
import { Controller } from "fortipi-tui";
import { FixtureService } from "./fixtures/service.ts";

export const approval: Approval = {
  approvalId: "approval_1",
  jobId: "job_1",
  agentId: "agent_1",
  conversationId: "conv_1",
  requestingPrincipalId: "requester_1",
  version: 1,
  state: "pending",
  operation: {
    operationId: "op_1",
    operationDigest: "a".repeat(64),
    tool: "shell.exec",
    arguments: { command: "touch example" },
    workspaceId: "ws_1",
    baseRevision: "r_1",
    target: { kind: "executor", executorId: "exec_1", generation: 2 },
    trust: "host",
    capabilities: ["shell"],
    policyVersion: 3,
    grantVersion: 4,
    expiresAt: Date.now() + 60000,
  },
};
void test("busy preserves composer and never steers; uncertain send reuses the original identity", async () => {
  const service = new FixtureService();
  await service.start();
  const controller = new Controller(service.client());
  try {
    await controller.open("conv_1", "agent_1");
    controller.composer = "keep this";
    service.busy = true;
    await assert.rejects(controller.send(), { code: "conflict" });
    assert.equal(controller.composer, "keep this");
    assert(!service.requests.some((request) => request.endsWith("/steer")));
    service.busy = false;
    const realSend = controller.client.conversations.send;
    let first = true;
    controller.client.conversations.send = async (...args) => {
      const value = await realSend(...args);
      if (first) {
        first = false;
        throw new Error("lost response");
      }
      return value;
    };
    await assert.rejects(controller.send());
    assert.equal(controller.composer, "keep this");
    const receipt = await controller.send();
    assert.equal(receipt.taskId, "task_1");
    assert.equal(service.admissions.size, 1);
    assert.equal(controller.composer, "");
    await controller.disconnect();
    assert.equal(controller.connection, "offline");
    assert.equal(controller.projection.snapshot?.conversation.taskState.state, "completed");
  } finally {
    controller.close();
    await service.close();
  }
});
void test("approval displays exact context, re-fetches it before action, and refuses stale or late profile results", async () => {
  const service = new FixtureService();
  await service.start();
  service.approvals.set(approval.approvalId, approval);
  const controller = new Controller(service.client());
  try {
    await controller.approval(approval.approvalId);
    for (const field of [
      "requester_1",
      "touch example",
      "host",
      "exec_1",
      "baseRevision",
      "policyVersion",
      "grantVersion",
      "expiresAt",
    ])
      assert(controller.detail.includes(field));
    service.approvals.set(approval.approvalId, { ...approval, version: 2 });
    await assert.rejects(controller.decide("approve"), { code: "stale_approval_context" });
    assert.equal(service.decisions.length, 0);
    await controller.decide("reject");
    assert.deepEqual(service.decisions[0], {
      requestId: (service.decisions[0] as { requestId: string }).requestId,
      expectedVersion: 2,
      operationDigest: approval.operation.operationDigest,
      decision: "reject",
    });
    service.approvals.set(approval.approvalId, approval);
    service.approvals.set("approval_2", { ...approval, approvalId: "approval_2" });
    await controller.approval(approval.approvalId);
    const get = controller.client.approvals.get;
    const entered = Promise.withResolvers<void>();
    const delayed = Promise.withResolvers<void>();
    let first = true;
    controller.client.approvals.get = async (...args) => {
      const hold = first;
      first = false;
      const value = await get(...args);
      if (hold) {
        entered.resolve();
        await delayed.promise;
      }
      return value;
    };
    const decision = controller.decide("approve");
    await entered.promise;
    await controller.approval("approval_2");
    delayed.resolve();
    await assert.rejects(decision, { code: "stale_approval_context" });
    assert.equal(service.decisions.length, 1);
    assert.equal(controller.selectedApproval?.approvalId, "approval_2");
    let release: () => void = () => {};
    service.delayApproval = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = controller.approval(approval.approvalId);
    controller.changeClient(service.client());
    release();
    await pending.catch(() => {});
    assert.equal(controller.selectedApproval, undefined);
    assert.equal(controller.detail, "");
  } finally {
    controller.close();
    await service.close();
  }
});

void test("reconciliation requires current evidence/version and explicit separately authorized new job; never retries uncertain work", async () => {
  const service = new FixtureService();
  await service.start();
  const job = {
    jobId: "job_1",
    agentId: "agent_1",
    conversationId: "conv_1",
    taskId: "task_1",
    operationDigest: "a".repeat(64),
    workspaceId: "ws_1",
    baseRevision: "r_1",
    state: "requires_reconciliation" as const,
    version: 1,
  };
  service.jobs.set(job.jobId, job);
  const controller = new Controller(service.client());
  try {
    await controller.job(job.jobId);
    assert(controller.detail.includes("requires_reconciliation"));
    assert.equal(service.reconciliations.length, 0);
    service.jobs.set(job.jobId, { ...job, version: 2 });
    await assert.rejects(
      controller.reconcile({ kind: "acknowledge-unknown" }, "unverifiable external effects"),
      { code: "stale_job_context" },
    );
    assert.equal(service.reconciliations.length, 0);
    await controller.reconcile({ kind: "acknowledge-unknown" }, "unverifiable external effects");
    assert.equal(service.reconciliations[0]?.expectedVersion, 2);
    assert.deepEqual(service.reconciliations[0]?.action, { kind: "acknowledge-unknown" });
    await controller.reconcile(
      { kind: "new-job", newJobId: "fresh_job", authorizationId: "explicit_authority" },
      "separately authorized retry",
    );
    assert.deepEqual(service.reconciliations[1]?.action, {
      kind: "new-job",
      newJobId: "fresh_job",
      authorizationId: "explicit_authority",
    });
    assert.equal(service.admissions.size, 0);
    service.jobs.set("job_2", { ...job, jobId: "job_2" });
    const get = controller.client.jobs.get;
    const entered = Promise.withResolvers<void>();
    const delayed = Promise.withResolvers<void>();
    let first = true;
    controller.client.jobs.get = async (...args) => {
      const hold = first;
      first = false;
      const value = await get(...args);
      if (hold) {
        entered.resolve();
        await delayed.promise;
      }
      return value;
    };
    const reconcile = controller.reconcile({ kind: "acknowledge-unknown" }, "old context");
    await entered.promise;
    await controller.job("job_2");
    delayed.resolve();
    await assert.rejects(reconcile, { code: "stale_job_context" });
    assert.equal(service.reconciliations.length, 2);
    assert.equal(controller.selectedJob?.jobId, "job_2");
  } finally {
    controller.close();
    await service.close();
  }
});

void test("reopen restores actionable metadata through the snapshot cursor without replaying historical UI events", async () => {
  const service = new FixtureService();
  await service.start();
  const base = {
    protocolVersion: "1.0" as const,
    schemaVersion: "1.0.0" as const,
    deploymentId: "deploy_test",
    conversationId: "conv_1",
    timestamp: 1,
    durability: "durable" as const,
  };
  const job = {
    jobId: "job_1",
    agentId: "agent_1",
    conversationId: "conv_1",
    taskId: "task_1",
    operationDigest: "a".repeat(64),
    workspaceId: "ws_1",
    baseRevision: "r_1",
    state: "requires_reconciliation" as const,
    version: 1,
  };
  const task = {
    taskId: "task_1",
    conversationId: "conv_1",
    version: 1,
    status: {
      state: "waiting" as const,
      reason: "human-approval" as const,
      supportedContinuations: [],
    },
  };
  service.events.push(
    { ...base, eventId: "event_1", eventSeq: 1, type: "approval.requested", payload: approval },
    { ...base, eventId: "event_2", eventSeq: 2, type: "job.state.changed", payload: job },
    { ...base, eventId: "event_3", eventSeq: 3, type: "task.waiting", payload: task },
  );
  service.snapshot.lastEventSeq = 3;
  service.snapshot.conversation.taskState = task.status;
  service.jobs.set(job.jobId, job);
  service.tasks.set(task.taskId, task);
  const controller = new Controller(service.client());
  try {
    await controller.open("conv_1", "agent_1");
    assert.equal(controller.projection.approvals.get("approval_1")?.operation.trust, "host");
    assert.equal(controller.projection.jobs.get("job_1")?.state, "requires_reconciliation");
    assert.equal(controller.projection.tasks.get("task_1")?.status.state, "waiting");
    assert.equal(controller.projection.cursor, 3);
    assert.deepEqual(controller.projection.appliedIds, []);
    assert.deepEqual(controller.projection.snapshot?.messages, []);
    controller.listApprovals();
    assert.equal(controller.choices[0]?.id, "approval_1");
    await controller.job();
    assert.equal(controller.selectedJob?.jobId, "job_1");
  } finally {
    controller.close();
    await service.close();
  }
});

void test("TUI displays authenticated redacted client identity and rejects operator/executor credentials before snapshot access", async () => {
  for (const role of ["client", "admin", "executor"] as const) {
    const service = new FixtureService();
    await service.start();
    service.identity = { ...service.identity, role };
    const controller = new Controller(service.client());
    try {
      await assert.rejects(controller.open("conv_1"), { code: "select_agent" });
      assert.equal(service.requests.length, 0);
      if (role === "client") {
        await controller.open("conv_1", "agent_1");
        assert.equal(controller.ticketIdentity?.principalId, "principal_test");
        assert(controller.ids().includes("principal_test"));
        assert(controller.ticketIdentity && !("ticket" in controller.ticketIdentity));
      } else {
        await assert.rejects(controller.open("conv_1", "agent_1"), {
          code: "application_credential_required",
        });
        assert(!service.requests.includes("GET /v1/conversations/conv_1"));
        assert.equal(controller.ticketIdentity, undefined);
      }
    } finally {
      controller.close();
      await service.close();
    }
  }
});
