import assert from "node:assert/strict";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { eventually, harness, pause, setup } from "../agent/harness.ts";

test("actual Agent replay/live handoff retains commits made after H capture and before attachment", {
  timeout: 30000,
}, async () => {
  const h = await harness();
  let socket: WebSocket | undefined,
    agentId = "";
  try {
    const { agent, conversation } = await setup(h);
    agentId = agent.agentId;
    const cid = conversation.conversationId,
      path = `/v1/conversations/${cid}`,
      probe = h.env.AGENT_SESSIONS.getByName(agentId);
    const before = await h.api(`${path}/messages`, {
      clientRequestId: crypto.randomUUID(),
      content: "before-handoff",
      busyBehavior: "followUp",
    });
    assert.equal(before.status, 202);
    await eventually(
      () => h.api<D.ConversationProjection>(path),
      (value) =>
        value.body.messages.some((message) => message.content === "answer:before-handoff") &&
        value.body.conversation.taskState.state === "completed",
    );
    const ticket = await h.api<D.TicketReceipt>("/v1/connections/tickets", {
      requestId: crypto.randomUUID(),
      audience: "client-stream",
      resources: {
        agentIds: [agentId],
        conversationIds: [cid],
        workspaceIds: [],
        executorIds: [],
        backendIds: [],
        tools: [],
        actions: ["events.read"],
      },
      originMode: { kind: "native" },
    });
    assert.equal(ticket.status, 201);
    const { url } = await h.server.listen(),
      address = new URL(url);
    address.protocol = "ws:";
    address.pathname = "/v1/stream";
    address.searchParams.set("ticket", ticket.body.ticket);
    socket = new WebSocket(address.href);
    const frames: Record<string, unknown>[] = [];
    socket.addEventListener("message", (event) =>
      frames.push(JSON.parse(String(event.data)) as Record<string, unknown>),
    );
    await new Promise<void>((accept, reject) => {
      socket!.addEventListener("open", () => accept(), { once: true });
      socket!.addEventListener("error", () => reject(new Error("Actual Agent upgrade failed")), {
        once: true,
      });
    });
    await probe.holdReplay(cid);
    const requestId = crypto.randomUUID();
    socket.send(
      JSON.stringify({
        type: "conversation.subscribe",
        requestId,
        input: { operationId: "replayEvents", path: { id: cid }, query: { after: 0, limit: 2 } },
      }),
    );
    await eventually(
      () => probe.replayHeld(),
      (value) => value,
    );
    const concurrent = h.api(`${path}/messages`, {
      clientRequestId: crypto.randomUUID(),
      content: "during-handoff",
      busyBehavior: "followUp",
    });
    await eventually(
      async () =>
        JSON.parse(await probe.inspectionJson(cid)) as {
          entries: { kind: string; text: string }[];
        },
      (value) =>
        value.entries.some(
          (entry) => entry.kind === "pi.assistant" && entry.text === "answer:during-handoff",
        ),
    );
    await probe.releaseReplay();
    assert.equal((await concurrent).status, 202);
    const ack = await eventually(
      async () => frames.find((frame) => frame.type === "ack" && frame.requestId === requestId),
      (value) => !!value,
    );
    assert.ok(ack);
    const first = ack.receipt as D.ReplayPage;
    assert.equal(first.events.length, 2);
    assert.equal(first.hasMore, true);
    const historical: D.KnownDurableEvent[] = [...(first.events as D.KnownDurableEvent[])];
    let after = first.nextAfter;
    while (after < first.through) {
      const page = await h.api<D.ReplayPage>(
        `${path}/events?after=${after}&through=${first.through}&limit=2`,
      );
      assert.equal(page.status, 200);
      assert.ok(page.body.nextAfter > after);
      historical.push(...(page.body.events as D.KnownDurableEvent[]));
      after = page.body.nextAfter;
    }
    const snapshot = await eventually(
      () => h.api<D.ConversationProjection>(path),
      (value) =>
        value.body.conversation.taskState.state === "completed" &&
        value.body.messages.some((message) => message.content === "answer:during-handoff"),
    );
    for (
      let i = 0;
      i < 200 && !frames.some((frame) => frame.eventSeq === snapshot.body.lastEventSeq);
      i++
    )
      await pause(5);
    const live = frames.filter(
      (frame) => typeof frame.eventSeq === "number",
    ) as unknown as D.KnownDurableEvent[];
    assert.ok(live.length > 0);
    assert.ok(live.every((event) => event.eventSeq > first.through));
    const all = [...historical, ...live].sort((a, b) => a.eventSeq - b.eventSeq);
    assert.equal(
      new Set(all.map((event) => event.eventId)).size,
      all.length,
      "Replay/live must not duplicate source events",
    );
    assert.deepEqual(
      all.map((event) => event.eventSeq),
      Array.from({ length: snapshot.body.lastEventSeq }, (_, index) => index + 1),
      "Handoff must contain every committed event without gaps",
    );
    const authority = await h.api<D.ReplayPage>(
      `${path}/events?after=0&through=${snapshot.body.lastEventSeq}`,
    );
    assert.deepEqual(
      all.map((event) => event.eventId),
      authority.body.events.map((event) => event.eventId),
    );
  } finally {
    if (agentId) await h.env.AGENT_SESSIONS.getByName(agentId).releaseReplay();
    socket?.close();
    await h.close();
  }
});
