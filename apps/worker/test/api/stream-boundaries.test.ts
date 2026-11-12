import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { wireLimits } from "fortipi-contract";
import type * as D from "../../src/boundary/dto.js";
import { bootstrap, eventually, harness, pause, setup } from "../agent/harness.ts";
import type { TestAgentSession } from "./stream-boundaries-worker.js";

type Harness = Awaited<ReturnType<typeof harness>>;
type Probe = DurableObjectStub<TestAgentSession>;
type Frame = Record<string, unknown>;
interface Attachment {
  __pk: { uri: string };
  __user: {
    authorityId: string;
    credentialId: string;
    generation: number;
    grantVersion: number;
    subscriptions: Record<string, number>;
  };
}
interface CloseSample {
  code: number;
  attachment: Attachment;
}
const main = resolve("apps/worker/test/api/stream-boundaries-worker.ts");
const scope = (agentId: string, conversationIds: string[]): D.ResourceScope => ({
  agentIds: [agentId],
  conversationIds,
  workspaceIds: [],
  executorIds: [],
  backendIds: [],
  tools: [],
  actions: ["events.read"],
});
async function connect(h: Harness, resources: D.ResourceScope, token = bootstrap) {
  const ticket = await h.api<D.TicketReceipt>(
    "/v1/connections/tickets",
    {
      requestId: crypto.randomUUID(),
      audience: "client-stream",
      resources,
      originMode: { kind: "native" },
    },
    "POST",
    token,
  );
  assert.equal(ticket.status, 201);
  const { url } = await h.server.listen();
  const address = new URL(url);
  address.protocol = "ws:";
  address.pathname = "/v1/stream";
  address.searchParams.set("ticket", ticket.body.ticket);
  const socket = new WebSocket(address.href);
  const frames: Frame[] = [];
  let close: { code: number; reason: string } | undefined;
  socket.addEventListener("message", (event) => frames.push(JSON.parse(String(event.data))));
  socket.addEventListener("close", (event) => {
    close = { code: event.code, reason: event.reason };
  });
  await new Promise<void>((accept, reject) => {
    const timer = setTimeout(() => reject(new Error("Native stream did not open")), 4000);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        accept();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("Native stream upgrade failed"));
      },
      { once: true },
    );
  });
  const response = async (command: Frame) => {
    socket.send(JSON.stringify(command));
    return eventually(
      async () => frames.find((frame) => frame.requestId === command.requestId),
      (value) => value !== undefined,
    ).then((value) => {
      assert.ok(value);
      return value;
    });
  };
  return {
    socket,
    frames,
    response,
    ticket: ticket.body.ticket,
    closed: () =>
      eventually(
        async () => close,
        (value) => value !== undefined,
      ),
  };
}
function subscribe(cid: string, after: number, limit = 100): Frame {
  return {
    type: "conversation.subscribe",
    requestId: crypto.randomUUID(),
    input: { operationId: "replayEvents", path: { id: cid }, query: { after, limit } },
  };
}
async function attachment(probe: Probe): Promise<Attachment> {
  const report = JSON.parse(await probe.socketReport()) as { attachment: Attachment }[];
  assert.equal(report.length, 1);
  const row = report[0];
  assert.ok(row);
  return row.attachment;
}
async function replayAll(h: Harness, cid: string, after: number, through: number) {
  const events: D.KnownDurableEvent[] = [];
  while (after < through) {
    const page = await h.api<D.ReplayPage>(
      `/v1/conversations/${cid}/events?after=${after}&through=${through}&limit=100`,
    );
    assert.equal(page.status, 200);
    assert.ok(page.body.nextAfter > after);
    events.push(...(page.body.events as D.KnownDurableEvent[]));
    after = page.body.nextAfter;
  }
  return events;
}

// Oracle fixed before implementation: <=100 is a complete delivery page;
// >100 must explicitly resync/1013, retain the pre-overflow attachment cursor,
// and let a client recover every stored ID from its last applied event.
test("actual stream 100/101 stored-event boundary resyncs without advancing the overflow attachment", {
  timeout: 30000,
}, async (t) => {
  let overflowCursor: number | undefined;
  let overflowStart = 0;
  for (const count of [100, 101]) {
    // Fresh CP keeps each case within ordinary, unraised Free request cadence.
    // These are separate connections, never a simulated restart.
    const h = await harness({ main, traffic: "free" });
    let socket: WebSocket | undefined;
    let cleanupProbe: Probe | undefined;
    try {
      const { agent, conversation } = await setup(h);
      const cid = conversation.conversationId;
      const probe = h.env.AGENT_SESSIONS.getByName(agent.agentId) as Probe;
      cleanupProbe = probe;
      const before = await probe.streamSnapshot(cid);
      const client = await connect(h, scope(agent.agentId, [cid]));
      socket = client.socket;
      assert.deepEqual(
        await probe.observeSocketClose(),
        [{ bufferedAmountPresent: false }],
        "Pinned workerd has no backlog counter; this fixture does not manufacture one",
      );
      await probe.holdReplay(cid);
      const pending = client.response(subscribe(cid, before.lastEventSeq));
      await eventually(() => probe.replayHeld(), Boolean);
      const seeded = await probe.appendStreamEvents(cid, count);
      await probe.releaseReplay();
      const ack = await pending;
      t.diagnostic(`seed=${count}, response=${ack.type}, frames=${client.frames.length}`);
      assert.equal(ack.type, "ack");
      const receipt = ack.receipt as D.ReplayPage;
      assert.equal(receipt.through, before.lastEventSeq);
      assert.deepEqual(receipt.events, []);
      await eventually(
        async () => client.frames.filter((frame) => typeof frame.eventSeq === "number").length,
        (length) =>
          length === 100 ||
          client.frames.some((frame) => frame.type === "error" || frame.type === "resync_required"),
      );
      t.diagnostic(
        JSON.stringify(
          client.frames.filter(
            (frame) => frame.type === "error" || frame.type === "resync_required",
          ),
        ),
      );
      const live = client.frames.filter(
        (frame) => typeof frame.eventSeq === "number",
      ) as unknown as D.KnownDurableEvent[];
      assert.deepEqual(
        live.map((event) => event.eventSeq),
        Array.from({ length: 100 }, (_, i) => before.lastEventSeq + i + 1),
      );
      assert.deepEqual(
        live.map((event) => event.eventId),
        seeded.slice(0, 100).map((event) => event.eventId),
      );
      if (count === 100) {
        assert.equal(
          (await attachment(probe)).__user.subscriptions[cid],
          before.lastEventSeq + 100,
        );
        assert.equal(
          (await client.response({ type: "ping", requestId: crypto.randomUUID() })).type,
          "ack",
        );
        assert.ok(!client.frames.some((frame) => frame.type === "resync_required"));
      } else {
        const closed = await client.closed();
        assert.equal(closed?.code, 1013);
        assert.equal(
          client.frames.filter(
            (frame) => frame.type === "resync_required" && frame.reason === "overflow",
          ).length,
          1,
        );
        assert.ok(client.frames.length <= wireLimits.socketFrames);
        assert.ok(
          client.frames.reduce(
            (bytes, frame) => bytes + new TextEncoder().encode(JSON.stringify(frame)).length,
            0,
          ) < wireLimits.socketBytes,
        );
        const samples: CloseSample[] = JSON.parse(await probe.closeSamplesJson());
        const sample: CloseSample | undefined = samples.find((entry) => entry.code === 1013);
        assert.ok(sample);
        overflowCursor = sample.attachment.__user.subscriptions[cid];
        overflowStart = before.lastEventSeq;
        const last = live.at(-1);
        assert.ok(last);
        const lastApplied = last.eventSeq;
        const rest = await replayAll(h, cid, lastApplied, before.lastEventSeq + count);
        assert.equal(rest.length, 1);
        const authority = [
          ...(
            JSON.parse(
              await probe.streamReplayJson(cid, before.lastEventSeq, before.lastEventSeq + count),
            ) as D.ReplayPage
          ).events,
          ...(
            JSON.parse(
              await probe.streamReplayJson(cid, lastApplied, before.lastEventSeq + count),
            ) as D.ReplayPage
          ).events,
        ];
        assert.deepEqual(
          [...live, ...rest].map((event) => event.eventId),
          authority.map((event) => event.eventId),
        );
        t.diagnostic(
          `101 stored: 100 contiguous native frames, resync/1013, final ID recoverable; attachment ${overflowStart}->${overflowCursor}`,
        );
      }
    } finally {
      await cleanupProbe?.releaseReplay();
      socket?.close();
      await h.close();
    }
  }
  assert.equal(
    overflowCursor,
    overflowStart,
    "Overflow must not advance the retained attachment cursor",
  );
});

// No local hibernation claim: inspect the real retained attachment, then drive
// production commands after actual retention and actual grant expiry. The SDK's
// restoration/cache-reset predicate still needs live Cloudflare eviction.
test("actual retained attachment enforces ticket scope, replay floor and expiring current grants", {
  timeout: 30000,
}, async (t) => {
  const h = await harness({ main, traffic: "free", events: 4 });
  const sockets: WebSocket[] = [];
  try {
    const { agent, conversation } = await setup(h);
    const cid = conversation.conversationId;
    const other = await h.api<D.Conversation>(`/v1/agents/${agent.agentId}/conversations`, {
      requestId: crypto.randomUUID(),
      title: "outside ticket",
    });
    assert.equal(other.status, 201);
    const probe = h.env.AGENT_SESSIONS.getByName(agent.agentId) as Probe;
    const resources = scope(agent.agentId, [cid, other.body.conversationId]);
    const expiresAt = Date.now() + 5000;
    const minted = await h.api<D.CredentialReceipt>("/v1/admin/credentials", {
      requestId: crypto.randomUUID(),
      role: "client",
      expiresAt: Date.now() + 60000,
      grants: [
        {
          grantId: "bounded-stream",
          version: 1,
          expiresAt,
          resources: { ...resources, actions: ["events.read", "tickets.mint"] },
        },
      ],
    });
    assert.equal(minted.status, 201);
    assert.equal(minted.body.state, "issued");
    if (minted.body.state !== "issued") assert.fail("Synthetic credential required");
    const token = minted.body.token;
    const denied = await connect(h, scope(agent.agentId, [cid]), token);
    sockets.push(denied.socket);
    const scopeError = await denied.response(subscribe(other.body.conversationId, 0));
    assert.equal(scopeError.type, "error");
    assert.equal((scopeError.error as { code: string }).code, "unauthorized");
    assert.equal((await denied.closed())?.code, 1008);
    assert.ok(!denied.frames.some((frame) => frame.receipt || frame.eventSeq !== undefined));
    await eventually(
      async () => JSON.parse(await probe.socketReport()).length as number,
      (length) => length === 0,
    );

    const client = await connect(h, scope(agent.agentId, [cid]), token);
    sockets.push(client.socket);
    const first = await client.response(subscribe(cid, 0));
    assert.equal(first.type, "ack");
    const cursor = (first.receipt as D.ReplayPage).through;
    const saved = await attachment(probe);
    const encoded = JSON.stringify(saved);
    assert.ok(new TextEncoder().encode(encoded).length <= 2048);
    assert.equal(new URL(saved.__pk.uri).search, "");
    for (const forbidden of [
      client.ticket,
      token,
      bootstrap,
      '"grants"',
      '"accessToken"',
      '"refreshToken"',
    ])
      assert.ok(!encoded.includes(forbidden), "Attachment must exclude raw authority material");
    assert.deepEqual(
      Object.keys(saved.__user)
        .filter((key) => !key.startsWith("_cf_"))
        .sort(),
      ["authorityId", "credentialId", "generation", "grantVersion", "subscriptions"],
    );
    assert.deepEqual(saved.__user.subscriptions, { [cid]: cursor });
    await probe.appendStreamEvents(cid, 8);
    const retained = await probe.retainStreamEvents(cid);
    assert.ok(retained.retainedFloor > cursor);
    const expired = await client.response(subscribe(cid, cursor));
    assert.equal(expired.type, "error");
    assert.equal((expired.error as { code: string }).code, "cursor.expired");
    assert.deepEqual((await attachment(probe)).__user.subscriptions, { [cid]: cursor });
    const future = await client.response(subscribe(cid, retained.lastEventSeq + 1));
    assert.equal((future.error as { code: string }).code, "cursor.invalid");
    const resumed = await client.response(subscribe(cid, retained.retainedFloor));
    assert.equal(resumed.type, "ack");
    const page = resumed.receipt as D.ReplayPage;
    const stored = JSON.parse(
      await probe.streamReplayJson(cid, retained.retainedFloor, retained.lastEventSeq),
    ) as D.ReplayPage;
    assert.deepEqual(
      page.events.map((event) => event.eventId),
      stored.events.map((event) => event.eventId),
    );
    assert.deepEqual(
      page.events.map((event) => event.eventSeq),
      Array.from({ length: 4 }, (_, i) => retained.retainedFloor + i + 1),
    );
    assert.equal((await attachment(probe)).__user.subscriptions[cid], retained.lastEventSeq);
    await pause(Math.max(0, expiresAt - Date.now() + 25));
    const noLongerGranted = await client.response(subscribe(cid, retained.lastEventSeq));
    assert.equal(noLongerGranted.type, "error");
    assert.ok(
      ["unauthorized", "unauthenticated"].includes(
        (noLongerGranted.error as { code: string }).code,
      ),
    );
    assert.equal((await client.closed())?.code, 1008);
    assert.ok(!client.frames.some((frame) => frame.conversationId === other.body.conversationId));
    t.diagnostic(
      `Ticket scope denied; real retained floor ${retained.retainedFloor} rejected old cursor; four stored IDs restored; expired grant denied on same connection. No eviction performed.`,
    );
  } finally {
    for (const socket of sockets) socket.close();
    await h.close();
  }
});

test("expiry during a captured replay cannot publish its receipt or stored events", {
  timeout: 20000,
}, async () => {
  const h = await harness({ main, traffic: "free" });
  let socket: WebSocket | undefined;
  let probe: Probe | undefined;
  try {
    const { agent, conversation } = await setup(h);
    const cid = conversation.conversationId;
    probe = h.env.AGENT_SESSIONS.getByName(agent.agentId) as Probe;
    await probe.appendStreamEvents(cid, 1);
    const expiresAt = Date.now() + 5000;
    const resources = scope(agent.agentId, [cid]);
    const minted = await h.api<D.CredentialReceipt>("/v1/admin/credentials", {
      requestId: crypto.randomUUID(),
      role: "client",
      expiresAt: Date.now() + 60000,
      grants: [
        {
          grantId: "replay-expiry",
          version: 1,
          expiresAt,
          resources: { ...resources, actions: ["events.read", "tickets.mint"] },
        },
      ],
    });
    assert.equal(minted.status, 201);
    if (minted.body.state !== "issued") assert.fail("Scoped synthetic credential required");
    const client = await connect(h, resources, minted.body.token);
    socket = client.socket;
    await probe.holdReplay(cid);
    const pending = client.response(subscribe(cid, 0));
    await eventually(() => probe!.replayHeld(), Boolean);
    await pause(Math.max(0, expiresAt - Date.now() + 25));
    await probe.releaseReplay();
    const result = await pending;
    assert.equal(
      result.type,
      "error",
      "Authority expiring during replay must be checked before publication",
    );
    assert.ok(
      ["unauthorized", "unauthenticated"].includes((result.error as { code: string }).code),
    );
    assert.ok(
      !client.frames.some((frame) => frame.receipt || frame.eventSeq !== undefined),
      "No captured private replay data may follow expiry",
    );
    assert.equal((await client.closed())?.code, 1008);
  } finally {
    await probe?.releaseReplay();
    socket?.close();
    await h.close();
  }
});
