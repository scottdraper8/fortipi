import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { FortiPiClient } from "../../../../packages/fortipi-client/dist/node.js";
import type * as D from "../../src/boundary/dto.js";
import { bootstrap, eventually, harness, setup } from "../agent/harness.ts";
import type { TestAgentSession } from "./stream-boundaries-worker.js";

test("the unmodified SDK resnapshots and reconnects after the actual socket lifetime allowance", {
  timeout: 30000,
}, async () => {
  // Synthetic principal traffic isolates supported reconnect semantics. The
  // original actual Free cases remain unchanged and separately qualified.
  const h = await harness({ main: resolve("apps/worker/test/api/stream-boundaries-worker.ts") });
  let close: (() => void) | undefined;
  let done: Promise<void> | undefined;
  try {
    const { agent, conversation } = await setup(h);
    const cid = conversation.conversationId;
    const probe = h.env.AGENT_SESSIONS.getByName(
      agent.agentId,
    ) as DurableObjectStub<TestAgentSession>;
    const { url } = await h.server.listen();
    const client = new FortiPiClient({
      endpoint: url.toString(),
      allowLoopbackHttp: true,
      credentials: async () => bootstrap,
    });
    const snapshots: D.ConversationProjection[] = [];
    const events: D.ClientEvent[] = [];
    const statuses: string[] = [];
    const subscription = client.conversations.subscribe(cid, {
      agentId: agent.agentId,
      onSnapshot: (snapshot) => {
        snapshots.push(snapshot);
      },
      onEvent: (event) => {
        events.push(event);
      },
      onStatus: (status) => {
        statuses.push(status);
      },
    });
    close = () => subscription.close();
    done = subscription.done;
    // Keep a rejection observed even if a test assertion fails first; the same
    // promise is awaited in cleanup, so an unexpected SDK failure still fails.
    void done.catch(() => {});
    await subscription.ready;
    await probe.appendStreamMessages(cid, 8, 65536);
    await probe.notifyStream(cid);
    await eventually(
      async () => events.length,
      (count) => count === 8,
    );
    await probe.appendStreamMessages(cid, 8, 65536);
    await probe.notifyStream(cid);
    await eventually(
      async () => statuses.filter((status) => status === "online").length,
      (count) => count >= 2,
    );
    assert.ok(statuses.includes("resyncing"));
    assert.equal(snapshots.length, 2);
    const restored = snapshots.at(-1);
    assert.ok(restored);
    assert.equal(restored.lastEventSeq, 17);
    assert.equal(subscription.cursor, 17);
    const last = await client.conversations.events(cid, { after: 16, through: 17 });
    const final = last.events[0];
    assert.equal(final?.type, "message.completed");
    if (final?.type !== "message.completed") assert.fail("Final immutable message required");
    const payload = final.payload;
    assert.ok(payload && typeof payload === "object" && "messageId" in payload);
    assert.equal(restored.messages.at(-1)?.messageId, payload.messageId);
    const durable = events.filter((event) => event.durability === "durable");
    assert.equal(new Set(durable.map((event) => event.eventId)).size, durable.length);
    const budgets: { id: string; value: { closed: boolean } }[] = JSON.parse(
      await probe.socketBudgetJson(),
    );
    assert.equal(budgets.length, 2, "A new one-use ticket creates a distinct allowance");
    assert.equal(new Set(budgets.map((row) => row.id)).size, 2);
    assert.equal(budgets.filter((row) => row.value.closed).length, 1);
  } finally {
    close?.();
    try {
      await done;
    } finally {
      await h.close();
    }
  }
});
