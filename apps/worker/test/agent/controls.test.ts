import assert from "node:assert/strict";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { routingPeer } from "../execution/routing-peer.ts";
import { eventually, harness, setup } from "./harness.ts";
import type { TestAgentSession } from "./runtime-worker.js";

test("cancelling a completed actual Pi task retains an already-terminal receipt and uncertain external effects", {
  timeout: 25000,
}, async () => {
  const h = await harness();
  try {
    const { agent, conversation } = await setup(h);
    const sent = await h.api<D.AdmissionReceipt>(
      `/v1/conversations/${conversation.conversationId}/messages`,
      {
        clientRequestId: crypto.randomUUID(),
        content: "completed-before-cancel",
        busyBehavior: "followUp",
      },
    );
    assert.equal(sent.status, 202);
    const path = `/v1/tasks/${sent.body.taskId}`;
    const completed = await eventually(
      () => h.api<D.Task>(path),
      (value) => value.status === 200 && value.body.status?.state === "completed",
    );
    const probe = h.env.AGENT_SESSIONS.getByName(agent.agentId);
    const before = JSON.parse(await probe.inspectionJson(conversation.conversationId)) as Awaited<
      ReturnType<TestAgentSession["inspectConversation"]>
    >;
    assert.equal(before.entries.filter((entry) => entry.kind === "pi.user").length, 1);
    assert.ok(before.entries.some((entry) => entry.text === "answer:completed-before-cancel"));
    const input: D.TaskControl = { requestId: crypto.randomUUID(), reason: "already finished" };
    const cancelled = await h.api<D.ControlReceipt>(`${path}/cancel`, input);
    assert.equal(cancelled.status, 202);
    assert.equal(
      cancelled.body.disposition.state,
      "already-terminal",
      "The public receipt must report the task's committed terminal disposition",
    );
    assert.equal(cancelled.body.durableIntent, true);
    assert.equal(
      cancelled.body.disposition.possibleExternalEffects,
      true,
      "Task completion alone cannot prove that external effects are absent",
    );
    await probe.disposePi();
    assert.deepEqual(await h.api(`${path}/cancel`, input), cancelled);
    assert.equal(
      (await h.api(`${path}/cancel`, { ...input, reason: "changed identity" })).status,
      409,
    );
    assert.deepEqual(await h.api(path), completed, "Cancellation must preserve the completed task");
    const after = JSON.parse(await probe.inspectionJson(conversation.conversationId)) as Awaited<
      ReturnType<TestAgentSession["inspectConversation"]>
    >;
    assert.deepEqual(after.entries, before.entries, "Cancellation must preserve the Pi transcript");
  } finally {
    await h.close();
  }
});

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
  let native: Awaited<ReturnType<typeof routingPeer>> | undefined;
  try {
    const { agent, conversation } = await setup(h);
    const probe = h.env.AGENT_SESSIONS.getByName(agent.agentId);
    const binding = await h.api<D.WorkspaceBinding>("/v1/workspaces", {
      requestId: crypto.randomUUID(),
      config: { kind: "computer" },
    });
    assert.equal(binding.status, 201);
    native = await routingPeer(h, binding.body, agent.agentId, conversation.conversationId);
    await probe.queueTool(
      JSON.stringify({
        tool: "shell",
        arguments: { command: "echo awaiting-approval" },
        workspaceId: binding.body.workspaceId,
        baseRevision: binding.body.revision,
        target: { kind: "executor", executorId: native.executorId, generation: 1 },
        capabilities: ["shell"],
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
    assert.deepEqual(cancelled.body.disposition, {
      state: "unknown",
      possibleExternalEffects: true,
    });
    assert.deepEqual(await h.api(`/v1/tasks/${sent.body.taskId}/cancel`, input), cancelled);
    const settled = await eventually(state, (s) => s.jobs[0]?.state === "cancelled");
    assert.equal(settled.jobs[0]?.hasExecution, false);
    const children = settled.tasks.filter((task) => task.kind === "fortipi.dispatch");
    assert.equal(children.length, 1);
    assert.equal(children[0]?.status, "terminal");
    assert.deepEqual(
      await h.api(`/v1/tasks/${sent.body.taskId}/cancel`, input),
      cancelled,
      "A later terminal observation cannot rewrite the original uncertain receipt",
    );
  } finally {
    await native?.close();
    await h.close();
  }
});
