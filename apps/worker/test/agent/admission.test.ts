import assert from "node:assert/strict";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { eventually, harness, setup } from "./harness.ts";

test("actual Pi admission identity survives reply retry and shared-store reopen", async () => {
  const h = await harness();
  try {
    const { agent, conversation } = await setup(h);
    const path = `/v1/conversations/${conversation.conversationId}`;
    const input: D.MessageSubmit = {
      clientRequestId: crypto.randomUUID(),
      content: "independent-oracle",
      busyBehavior: "followUp",
      expectedConversationRevision: conversation.revision,
    };
    const first = await h.api<D.AdmissionReceipt>(`${path}/messages`, input);
    assert.equal(first.status, 202, JSON.stringify(first.body));
    const snapshot = await eventually(
      () => h.api<D.ConversationProjection>(path),
      (value) =>
        value.status === 200 && value.body.messages.some((message) => message.role === "assistant"),
    );
    assert.equal(
      snapshot.body.messages.filter((m) => m.role === "user").length,
      1,
      "One admitted identity must place one user input",
    );
    assert.equal(
      snapshot.body.messages.find((m) => m.role === "assistant")?.content,
      "answer:independent-oracle",
    );
    const retry = await h.api<D.AdmissionReceipt>(`${path}/messages`, input);
    assert.equal(retry.status, 202);
    assert.deepEqual(retry.body, first.body, "Accepted retry must precede stale revision check");
    const changed = await h.api(`${path}/messages`, { ...input, content: "different" });
    assert.equal(changed.status, 409);
    const probe = h.env.AGENT_SESSIONS.getByName(agent.agentId);
    const before = await probe.inspectConversation(conversation.conversationId);
    await probe.disposePi();
    const after = await probe.inspectConversation(conversation.conversationId);
    assert.deepEqual(
      after.entries,
      before.entries,
      "Supported close/reopen must preserve committed Pi entries",
    );
    assert.equal(after.entries.filter((e) => e.kind === "pi.user").length, 1);
  } finally {
    await h.close();
  }
});

test("retained replay window rolls over while canonical committed messages remain usable", async () => {
  const h = await harness({ events: 6 });
  try {
    const { conversation } = await setup(h);
    const path = `/v1/conversations/${conversation.conversationId}`;
    for (let i = 0; i < 4; i++) {
      const sent = await h.api(`${path}/messages`, {
        clientRequestId: `turn-${i}`,
        content: `message-${i}`,
        busyBehavior: "followUp",
      });
      assert.equal(sent.status, 202);
      await eventually(
        () => h.api<D.ConversationProjection>(path),
        (value) =>
          value.status === 200 &&
          value.body.messages.filter((m) => m.role === "assistant").length === i + 1,
      );
    }
    const snapshot = await h.api<D.ConversationProjection>(path);
    assert.equal(snapshot.body.messages.length, 8);
    assert.ok(snapshot.body.retainedFloor > 0);
    const expired = await h.api(`${path}/events?after=0`);
    assert.equal(expired.status, 410);
    const retained = await h.api<D.ReplayPage>(
      `${path}/events?after=${snapshot.body.retainedFloor}`,
    );
    assert.equal(retained.status, 200);
    assert.ok(retained.body.events.length <= 6);
    const ids = retained.body.events.map((e) => e.eventId);
    const again = await h.api<D.ReplayPage>(
      `${path}/events?after=${snapshot.body.retainedFloor}&through=${retained.body.through}`,
    );
    assert.deepEqual(
      again.body.events.map((e) => e.eventId),
      ids,
      "Replay must preserve original event IDs",
    );
  } finally {
    await h.close();
  }
});
