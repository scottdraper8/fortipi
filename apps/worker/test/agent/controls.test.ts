import assert from "node:assert/strict";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { eventually, harness, setup } from "./harness.ts";
import type { TestAgentSession } from "./runtime-worker.js";

test("kept input resumes its actual Pi transcript and public task without another user message", {
  timeout: 25000,
}, async () => {
  const h = await harness();
  try {
    const { agent, conversation } = await setup(h);
    const probe = h.env.AGENT_SESSIONS.getByName(agent.agentId);
    await probe.failNextModel();
    const sent = await h.api<D.AdmissionReceipt>(
      `/v1/conversations/${conversation.conversationId}/messages`,
      { clientRequestId: crypto.randomUUID(), content: "kept", busyBehavior: "followUp" },
    );
    assert.equal(sent.status, 202);
    await eventually(
      () => h.api<D.ConversationProjection>(`/v1/conversations/${conversation.conversationId}`),
      (value) => value.body.conversation?.taskState.state === "waiting",
    );
    const input: D.TaskResume = { requestId: crypto.randomUUID(), continuation: "resume" };
    const resumed = await h.api<D.ControlReceipt>(`/v1/tasks/${sent.body.taskId}/resume`, input);
    assert.equal(resumed.status, 202, JSON.stringify(resumed.body));
    const completed = await eventually(
      () => h.api<D.ConversationProjection>(`/v1/conversations/${conversation.conversationId}`),
      (value) =>
        value.body.messages?.some((message) => message.content === "resumed-without-input"),
    );
    assert.equal(completed.body.messages.filter((message) => message.role === "user").length, 1);
    const inspection = JSON.parse(
      await probe.inspectionJson(conversation.conversationId),
    ) as Awaited<ReturnType<TestAgentSession["inspectConversation"]>>;
    assert.equal(inspection.entries.filter((entry) => entry.kind === "pi.user").length, 1);
    const retry = await h.api<D.ControlReceipt>(`/v1/tasks/${sent.body.taskId}/resume`, input);
    assert.deepEqual(retry, resumed);
    const task = await eventually(
      () => h.api<D.Task>(`/v1/tasks/${sent.body.taskId}`),
      (value) => value.body.status?.state === "completed",
    );
    assert.equal(task.body.taskId, sent.body.taskId);
  } finally {
    await h.close();
  }
});

test("cancellation durably stops an unapproved actual Pi child and retains one control receipt", {
  timeout: 25000,
}, async () => {
  const h = await harness();
  try {
    const { agent, conversation } = await setup(h);
    const probe = h.env.AGENT_SESSIONS.getByName(agent.agentId);
    const binding = await h.api<D.WorkspaceBinding>("/v1/workspaces", {
      requestId: crypto.randomUUID(),
      config: { kind: "computer" },
    });
    assert.equal(binding.status, 201);
    await probe.queueTool(
      JSON.stringify({
        tool: "javascript",
        arguments: { code: "return 42" },
        workspaceId: binding.body.workspaceId,
        baseRevision: binding.body.revision,
        target: { kind: "backend", backendId: "cloud", generation: 1 },
        capabilities: ["javascript"],
      }),
    );
    const sent = await h.api<D.AdmissionReceipt>(
      `/v1/conversations/${conversation.conversationId}/messages`,
      {
        clientRequestId: crypto.randomUUID(),
        content: "cancel-before-approval",
        busyBehavior: "followUp",
      },
    );
    assert.equal(sent.status, 202);
    const state = async () =>
      JSON.parse(await probe.toolStateJson(conversation.conversationId)) as Awaited<
        ReturnType<TestAgentSession["toolState"]>
      >;
    await eventually(state, (s) => s.jobs[0]?.state === "awaiting_approval");
    const input: D.TaskControl = { requestId: crypto.randomUUID(), reason: "stop" };
    const cancelled = await h.api<D.ControlReceipt>(`/v1/tasks/${sent.body.taskId}/cancel`, input);
    assert.equal(cancelled.status, 202);
    assert.deepEqual(await h.api(`/v1/tasks/${sent.body.taskId}/cancel`, input), cancelled);
    const settled = await eventually(state, (s) => s.jobs[0]?.state === "cancelled");
    assert.equal(settled.jobs[0]?.hasExecution, false);
    const children = settled.tasks.filter((task) => task.kind === "fortipi.dispatch");
    assert.equal(children.length, 1);
    assert.equal(children[0]?.status, "terminal");
  } finally {
    await h.close();
  }
});
