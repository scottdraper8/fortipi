import assert from "node:assert/strict";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { eventually, harness, setup } from "./harness.ts";

test("fork through a terminal event uses its committed Pi prefix and excludes later parent history", async () => {
  const h = await harness();
  try {
    const { agent, conversation } = await setup(h),
      path = `/v1/conversations/${conversation.conversationId}`;
    const turn = async (content: string) => {
      const sent = await h.api(`${path}/messages`, {
        clientRequestId: crypto.randomUUID(),
        content,
        busyBehavior: "followUp",
      });
      assert.equal(sent.status, 202);
      return eventually(
        () => h.api<D.ConversationProjection>(path),
        (value) =>
          value.body.messages.some((message) => message.content === `answer:${content}`) &&
          value.body.conversation.taskState.state === "completed",
      );
    };
    const first = await turn("fork-prefix");
    await turn("excluded-later-parent");
    const input: D.ForkInput = {
      requestId: crypto.randomUUID(),
      through: first.body.lastEventSeq,
      title: "exact prefix",
    };
    const forked = await h.api<D.Conversation>(`${path}/fork`, input);
    assert.equal(forked.status, 201, JSON.stringify(forked.body));
    const snapshot = await h.api<D.ConversationProjection>(
      `/v1/conversations/${forked.body.conversationId}`,
    );
    assert.equal(snapshot.status, 200);
    assert.deepEqual(
      snapshot.body.messages.map((message) => message.content),
      ["fork-prefix", "answer:fork-prefix"],
    );
    const repeated = await h.api<D.Conversation>(`${path}/fork`, input);
    assert.deepEqual(repeated, forked);
    const actual = JSON.parse(
      await h.env.AGENT_SESSIONS.getByName(agent.agentId).inspectionJson(
        forked.body.conversationId,
      ),
    ) as { entries: { kind: string; text: string }[] };
    assert.equal(actual.entries.filter((entry) => entry.kind === "pi.user").length, 1);
    assert.equal(
      actual.entries.some((entry) => entry.text.includes("excluded-later-parent")),
      false,
    );
  } finally {
    await h.close();
  }
});
