import assert from "node:assert/strict";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { eventually, harness, setup } from "./harness.ts";
import type { TestAgentSession } from "./runtime-worker.js";

test("an admitted Pi run stops a real repeated tool-error cycle after four rounds and retains the limit on reopen", {
  timeout: 30000,
}, async () => {
  const h = await harness();
  try {
    const { agent, conversation } = await setup(h),
      probe = h.env.AGENT_SESSIONS.getByName(agent.agentId);
    await probe.queueRepeatedInvalidTools();
    const input: D.MessageSubmit = {
      clientRequestId: crypto.randomUUID(),
      content: "repeat invalid tool calls",
      busyBehavior: "followUp",
    };
    const sent = await h.api<D.AdmissionReceipt>(
      `/v1/conversations/${conversation.conversationId}/messages`,
      input,
    );
    assert.equal(sent.status, 202);
    const actual = await eventually(
      async () =>
        JSON.parse(await probe.runPolicy(conversation.conversationId)) as {
          maxTurns: number;
          calls: number;
          records: { status: string; reason?: string }[];
        },
      (value) => value.records.some((record) => record.status === "unanswered"),
    );
    assert.equal(actual.maxTurns, 4);
    assert.equal(actual.calls, 4, "The fifth model request must never start");
    assert.equal(actual.records[0]?.reason, "turn_limit");
    const entries = JSON.parse(await probe.inspectionJson(conversation.conversationId)) as Awaited<
      ReturnType<TestAgentSession["inspectConversation"]>
    >;
    assert.equal(entries.entries.filter((entry) => entry.kind === "pi.user").length, 1);
    assert.equal(entries.entries.filter((entry) => entry.kind === "pi.assistant").length, 4);
    assert.equal((await probe.toolState(conversation.conversationId)).jobs.length, 0);
    await probe.disposePi();
    const reopened = JSON.parse(await probe.runPolicy(conversation.conversationId)) as {
      maxTurns: number;
      records: unknown[];
    };
    assert.equal(reopened.maxTurns, 4);
    assert.deepEqual(reopened.records, actual.records);
    const retry = await h.api<D.AdmissionReceipt>(
      `/v1/conversations/${conversation.conversationId}/messages`,
      input,
    );
    assert.deepEqual(retry, sent);
  } finally {
    await h.close();
  }
});
