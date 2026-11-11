import assert from "node:assert/strict";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { eventually, harness, setup } from "../agent/harness.ts";
import type { TestAgentSession } from "../agent/runtime-worker.js";

test("completed fresh-job handoffs do not exhaust the bounded Pi child-reference window", {
  timeout: 45000,
}, async () => {
  const h = await harness();
  try {
    const { agent, conversation } = await setup(h),
      probe = h.env.AGENT_SESSIONS.getByName(agent.agentId),
      state = async () =>
        JSON.parse(await probe.toolStateJson(conversation.conversationId)) as Awaited<
          ReturnType<TestAgentSession["toolState"]>
        >;
    const workspace = await h.api<D.WorkspaceBinding>("/v1/workspaces", {
      requestId: crypto.randomUUID(),
      config: { kind: "computer" },
    });
    assert.equal(workspace.status, 201);
    await probe.queueTool(
      JSON.stringify({
        tool: "javascript",
        arguments: { code: "return 42" },
        workspaceId: workspace.body.workspaceId,
        baseRevision: workspace.body.revision,
        target: { kind: "backend", backendId: "cloud", generation: 1 },
        capabilities: ["javascript"],
      }),
    );
    assert.equal(
      (
        await h.api(`/v1/conversations/${conversation.conversationId}/messages`, {
          clientRequestId: crypto.randomUUID(),
          content: "bounded references",
          busyBehavior: "followUp",
        })
      ).status,
      202,
    );
    const original = (
      await eventually(state, (value) => value.jobs[0]?.state === "awaiting_approval")
    ).jobs[0]!;
    const reject = async (jobId: string) => {
      const current = (
        await eventually(state, (value) =>
          value.jobs.some((job) => job.jobId === jobId && job.state === "awaiting_approval"),
        )
      ).jobs.find((job) => job.jobId === jobId)!;
      assert.ok(current.approvalId);
      const approval = await h.api<D.Approval>(`/v1/approvals/${current.approvalId}`);
      assert.equal(approval.status, 200);
      assert.equal(
        (
          await h.api(`/v1/approvals/${current.approvalId}/decisions`, {
            requestId: crypto.randomUUID(),
            expectedVersion: approval.body.version,
            operationDigest: approval.body.operation.operationDigest,
            decision: "reject",
          })
        ).status,
        200,
      );
      await eventually(state, (value) =>
        value.jobs.some((job) => job.jobId === jobId && job.state === "cancelled"),
      );
    };
    await reject(original.jobId);
    const ids = new Set<string>(),
      receipts: { input: D.ReconcileInput; receipt: D.ReconcileReceipt }[] = [];
    for (let i = 0; i < 6; i++) {
      const old = await h.api<D.Job>(`/v1/jobs/${original.jobId}`);
      assert.equal(old.status, 200);
      const input: D.ReconcileInput = {
        requestId: crypto.randomUUID(),
        expectedVersion: old.body.version,
        reason: "A different explicit business attempt",
        action: { kind: "new-job", authorizationId: crypto.randomUUID() },
      };
      const fresh = await h.api<D.ReconcileReceipt>(`/v1/jobs/${original.jobId}/reconcile`, input);
      console.log(JSON.stringify({ businessAttempt: i + 1, status: fresh.status }));
      assert.equal(
        fresh.status,
        202,
        "Completed handoff references must not impose a lifetime four-attempt limit",
      );
      assert.ok(fresh.body.newJobId);
      assert.equal(ids.has(fresh.body.newJobId), false);
      ids.add(fresh.body.newJobId);
      receipts.push({ input, receipt: fresh.body });
      assert.ok(
        (await probe.freshReferenceCount(conversation.conversationId)) <= 4,
        "The actual public Pi document remains bounded; removing the capacity guard alone is insufficient",
      );
      await reject(fresh.body.newJobId);
    }
    for (const { input, receipt } of receipts) {
      const retry = await h.api<D.ReconcileReceipt>(`/v1/jobs/${original.jobId}/reconcile`, input);
      assert.equal(retry.status, 202);
      assert.deepEqual(
        retry.body,
        receipt,
        "Pruning a reference cannot erase its durable business receipt",
      );
    }
    const actual = await state();
    assert.equal(
      actual.tasks.filter((task) => task.kind === "fortipi.dispatch").length,
      7,
      "One Pi child per explicit new authorization, no replay duplicate",
    );
    assert.ok(
      actual.jobs.every((job) => !job.hasExecution),
      "Rejections never acquire execution authority",
    );
  } finally {
    await h.close();
  }
});
