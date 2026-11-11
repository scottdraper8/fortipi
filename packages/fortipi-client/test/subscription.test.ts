import assert from "node:assert/strict";
import { test } from "node:test";
import { AppliedCursor, cursorScopeKey, FortiPiClient } from "fortipi-client/node";
import type { ClientCommand } from "fortipi-contract";
import { Validation } from "../dist/validation.js";
import { FixtureSocket } from "./fixtures/transport.ts";
import {
  cursorScope,
  delta,
  event,
  identity,
  json,
  protocol,
  replay,
  snapshot,
  ticketReceipt,
} from "./fixtures/wire.ts";

void test("cursor advances only after ordered durable application; unknowns apply, conflicts and handler failure preserve cursor", async () => {
  const cursor = new AppliedCursor();
  const ids: string[] = [];
  await cursor.apply(delta(), (e) => {
    ids.push(e.eventId);
  });
  assert.equal(cursor.value, 0);
  await assert.rejects(
    cursor.apply(event(1), async () => {
      throw new Error("consumer failed");
    }),
  );
  assert.equal(cursor.value, 0);
  await cursor.apply(event(1), (e) => {
    ids.push(e.eventId);
  });
  assert.equal(cursor.value, 1);
  await cursor.apply(event(1), () => {
    assert.fail("duplicate applied");
  });
  await assert.rejects(
    cursor.apply({ ...event(1), eventId: "conflicting_id" }, () => {}),
    { code: "conflicting_event_identity" },
  );
  await assert.rejects(
    cursor.apply(event(3), () => {}),
    { code: "event_gap" },
  );
  assert.equal(cursor.value, 1);
  await cursor.apply(event(2), (e) => {
    ids.push(e.eventId);
  });
  assert.deepEqual(ids, ["delta_1", "event_1", "event_2"]);
});
void test("malformed known frames cannot fall through to extension handling; volatile sequence rejects", () => {
  const validation = new Validation();
  assert.equal(validation.frame(event(1)).type, "extension.future");
  assert.throws(() => validation.frame(event(1, "message.completed")), { code: "invalid_wire" });
  assert.throws(() => validation.frame({ ...delta(), eventSeq: 1 }), { code: "invalid_wire" });
});
void test("snapshot handler failure pauses without opening a socket or retrying the consumer", async () => {
  let snapshots = 0;
  const client = new FortiPiClient({
    endpoint: "https://example.test",
    credentials: async () => "synthetic",
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/protocol")) return json(protocol);
      if (path.endsWith("/tickets")) return json(ticketReceipt(), 201);
      return json(snapshot);
    },
    webSocket: () => {
      assert.fail("failed snapshot must not subscribe");
    },
  });
  const sub = client.conversations.subscribe("conv_1", {
    agentId: "agent_1",
    maxReconnects: 0,
    onSnapshot: () => {
      snapshots++;
      throw new Error("consumer could not replace projection");
    },
    onEvent: () => assert.fail("failed snapshot must not deliver events"),
  });
  await assert.rejects(sub.ready, { code: "handler_failed" });
  await assert.rejects(sub.done, { code: "handler_failed" });
  assert.equal(snapshots, 1);
  assert.equal(sub.cursor, 0);
});

void test("subscribe cannot report online before the complete high-water receipt", async () => {
  const statuses: string[] = [];
  const client = new FortiPiClient({
    endpoint: "https://example.test",
    credentials: async () => "synthetic",
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/protocol")) return json(protocol);
      if (path.endsWith("/tickets")) return json(ticketReceipt(), 201);
      if (path.endsWith("/events")) return json(replay([], 0));
      return json(snapshot);
    },
    webSocket: () => {
      const socket = new FixtureSocket();
      socket.onSend = (command) =>
        socket.frame({
          type: "ack",
          requestId: (command as { requestId: string }).requestId,
          operationId: "replayEvents",
          // Schema-valid, but event 1 is missing and no continuation is advertised.
          receipt: replay([], 0, 1),
        });
      return socket;
    },
  });
  const sub = client.conversations.subscribe("conv_1", {
    agentId: "agent_1",
    maxReconnects: 0,
    onSnapshot: () => {},
    onEvent: () => assert.fail("incomplete barrier has no events"),
    onStatus: (status) => {
      statuses.push(status);
    },
  });
  try {
    await assert.rejects(sub.ready, { code: "invalid_replay" });
    await assert.rejects(sub.done, { code: "invalid_replay" });
    assert(!statuses.includes("online"));
    assert.equal(sub.cursor, 0);
  } finally {
    sub.close();
    await sub.done.catch(() => {});
  }
});

void test("asynchronous binary frames stay ordered and queue overflow preserves the unapplied cursor", async () => {
  for (const overflow of [false, true]) {
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    class SlowBlob extends Blob {
      override async arrayBuffer(): Promise<ArrayBuffer> {
        await blocked;
        return super.arrayBuffer();
      }
    }
    const socket = new FixtureSocket();
    socket.onSend = (command) =>
      socket.frame({
        type: "ack",
        operationId: "replayEvents",
        requestId: (command as { requestId: string }).requestId,
        receipt: replay([], 0),
      });
    const applied: string[] = [];
    let caughtUp: () => void = () => {};
    const complete = new Promise<void>((resolve) => {
      caughtUp = resolve;
    });
    const client = new FortiPiClient({
      endpoint: "https://example.test",
      credentials: async () => "synthetic",
      fetch: async (url) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/protocol"))
          return json({ ...protocol, limits: { ...protocol.limits, socketBufferFrames: 2 } });
        if (path.endsWith("/tickets")) return json(ticketReceipt(), 201);
        if (path.endsWith("/events")) return json(replay([], 0));
        return json(snapshot);
      },
      webSocket: () => socket,
    });
    const sub = client.conversations.subscribe("conv_1", {
      agentId: "agent_1",
      maxReconnects: 0,
      onSnapshot: () => {},
      onEvent: (event) => {
        applied.push(event.eventId);
        if (applied.length === 2) caughtUp();
      },
    });
    try {
      await sub.ready;
      await new Promise<void>((resolve) => setImmediate(resolve));
      socket.emit("message", { data: new SlowBlob([JSON.stringify(event(1))]) });
      socket.emit("message", { data: new TextEncoder().encode(JSON.stringify(event(2))).buffer });
      if (overflow) socket.frame(event(3));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(applied, []);
      assert.equal(sub.cursor, 0);
      release();
      if (overflow) {
        await assert.rejects(sub.done, { code: "stream_overflow" });
        assert.equal(sub.cursor, 0);
        assert.deepEqual(applied, []);
      } else {
        await complete;
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(applied, ["event_1", "event_2"]);
        assert.equal(sub.cursor, 2);
      }
    } finally {
      release();
      sub.close();
      await sub.done.catch(() => {});
    }
    assert.equal(socket.readyState, 3);
    assert([...socket.listeners.values()].every((listeners) => listeners.size === 0));
  }
});
void test("live gap repairs stored history before resubscribe; each upgrade uses a fresh ticket", async () => {
  const applied: string[] = [],
    tickets: string[] = [],
    replayAfter: number[] = [];
  const sockets: FixtureSocket[] = [];
  let gap = false,
    issued = 0;
  let repaired: () => void = () => {};
  const caughtUp = new Promise<void>((r) => {
    repaired = r;
  });
  const client = new FortiPiClient({
    endpoint: "https://example.test",
    random: () => 0,
    credentials: async () => "synthetic",
    fetch: async (url, init) => {
      const path = new URL(String(url));
      if (path.pathname === "/v1/protocol") return json(protocol);
      if (path.pathname === "/v1/connections/tickets")
        return json(
          {
            audience: "client-stream",
            ticket: `ticket_${++issued}`,
            expiresAt: Date.now() + 30000,
            identity,
          },
          201,
        );
      if (path.pathname.endsWith("/events")) {
        const after = Number(path.searchParams.get("after"));
        replayAfter.push(after);
        return json(
          gap
            ? replay(
                [event(2), event(3)].filter((e) => e.eventSeq > after),
                after,
                3,
              )
            : replay([], after),
        );
      }
      assert.equal(init?.method, "GET");
      return json(snapshot);
    },
    webSocket: (url) => {
      tickets.push(new URL(url).searchParams.get("ticket") ?? "");
      const socket = new FixtureSocket();
      sockets.push(socket);
      socket.onSend = (value) => {
        const command = value as Extract<ClientCommand, { type: "conversation.subscribe" }>;
        socket.frame({
          type: "ack",
          operationId: "replayEvents",
          requestId: command.requestId,
          receipt: replay([], command.input.query.after),
        });
        if (sockets.length === 1) {
          socket.frame(delta());
          socket.frame(event(1));
          gap = true;
          socket.frame(event(3));
        }
      };
      return socket;
    },
  });
  const subscription = client.conversations.subscribe("conv_1", {
    agentId: "agent_1",
    onSnapshot: (value) => {
      assert.equal(value.lastEventSeq, 0);
    },
    onEvent: (e) => {
      if (e.durability === "durable") {
        applied.push(e.eventId);
        if (e.eventSeq === 3) repaired();
      }
    },
  });
  try {
    await subscription.ready;
    await Promise.race([
      caughtUp,
      new Promise((_, reject) => setTimeout(() => reject(new Error("gap repair timed out")), 3000)),
    ]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(applied, ["event_1", "event_2", "event_3"]);
    assert.equal(subscription.cursor, 3);
    assert(replayAfter.includes(1));
    // Wait for repaired replay to reach the new subscribe barrier.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(new Set(tickets).size, tickets.length);
    assert(tickets.length >= 2);
  } finally {
    subscription.close();
    await subscription.done;
  }
  assert(sockets.every((socket) => socket.readyState === 3));
  assert(sockets.every((socket) => [...socket.listeners.values()].every((set) => set.size === 0)));
});
void test("handler failure pauses; cursor.expired replaces snapshot, cursor.invalid never silently resets", async () => {
  let socket: FixtureSocket | undefined;
  const client = new FortiPiClient({
    endpoint: "https://example.test",
    credentials: async () => "synthetic",
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/v1/protocol") return json(protocol);
      if (path.endsWith("/tickets")) return json(ticketReceipt(), 201);
      if (path.endsWith("/events")) return json(replay([], 0));
      return json(snapshot);
    },
    webSocket: () => {
      socket = new FixtureSocket();
      socket.onSend = (value) => {
        const command = value as { requestId: string };
        socket?.frame({
          type: "ack",
          operationId: "replayEvents",
          requestId: command.requestId,
          receipt: replay([], 0),
        });
        socket?.frame(event(1));
      };
      return socket;
    },
  });
  const subscription = client.conversations.subscribe("conv_1", {
    agentId: "agent_1",
    onSnapshot: () => {},
    onEvent: async () => {
      throw new Error("do not advance");
    },
  });
  await assert.rejects(subscription.done, { code: "handler_failed" });
  assert.equal(subscription.cursor, 0);
  for (const code of ["cursor.expired", "cursor.invalid"]) {
    let snapshots = 0,
      replayed = 0;
    const expired = new FortiPiClient({
      endpoint: "https://example.test",
      random: () => 0,
      credentials: async () => "synthetic",
      fetch: async (url) => {
        const path = new URL(String(url)).pathname;
        if (path === "/v1/protocol") return json(protocol);
        if (path.endsWith("/tickets")) return json(ticketReceipt(), 201);
        if (path.endsWith("/events"))
          return ++replayed === 1
            ? json(
                { error: { code, message: "cursor", requestId: "req_1", retryable: false } },
                code === "cursor.expired" ? 410 : 400,
              )
            : json(replay([], 0));
        snapshots++;
        return json(snapshot);
      },
      webSocket: () => {
        const s = new FixtureSocket();
        s.onSend = (value) =>
          s.frame({
            type: "ack",
            operationId: "replayEvents",
            requestId: (value as { requestId: string }).requestId,
            receipt: replay([], 0),
          });
        return s;
      },
    });
    const sub = expired.conversations.subscribe("conv_1", {
      agentId: "agent_1",
      after: 0,
      scope: cursorScope,
      onSnapshot: () => {},
      onEvent: () => {},
    });
    if (code === "cursor.invalid") {
      await assert.rejects(sub.done, { code });
      assert.equal(snapshots, 0);
    } else {
      await sub.ready;
      assert.equal(snapshots, 1);
      sub.close();
      await sub.done;
    }
  }
});
void test("storage pressure pauses ticket acquisition without polling; abort interrupts long quota backoff", async () => {
  for (const storage of [true, false]) {
    let mints = 0;
    const abort = new AbortController();
    const client = new FortiPiClient({
      endpoint: "https://example.test",
      credentials: async () => "synthetic",
      fetch: async (url) => {
        if (String(url).endsWith("/v1/protocol")) return json(protocol);
        mints++;
        return json(
          {
            error: {
              code: "quota_paused",
              message: "pressure",
              requestId: "req_1",
              retryable: !storage,
              details: {
                retryAfterMs: 86400000,
                pressure: {
                  resource: storage ? "storage" : "requests",
                  scope: { kind: "account" },
                  source: "provider",
                  measurement: "unknown",
                  reason: "provider refusal",
                  action: storage ? "reclaim-storage" : "retry-later",
                },
              },
            },
          },
          503,
        );
      },
    });
    const sub = client.conversations.subscribe("conv_1", {
      agentId: "agent_1",
      signal: abort.signal,
      onSnapshot: () => {},
      onEvent: () => {},
      onStatus: (status) => {
        if (status === "reconnecting" && !storage) abort.abort();
      },
    });
    if (storage) await assert.rejects(sub.done, { code: "quota_paused" });
    else await sub.done.catch(() => {});
    assert.equal(mints, 1);
    assert.equal(sub.cursor, 0);
  }
});

void test("a paginated subscribe high-water barrier completes before queued live events and ready", async () => {
  let pages = 0;
  const delivered: number[] = [];
  let reached: () => void = () => {};
  const complete = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const client = new FortiPiClient({
    endpoint: "https://example.test",
    credentials: async () => "synthetic",
    fetch: async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/v1/protocol") return json(protocol);
      if (parsed.pathname.endsWith("/tickets")) return json(ticketReceipt(), 201);
      if (parsed.pathname.endsWith("/events")) {
        if (++pages === 1) return json(replay([], 0));
        assert.equal(parsed.searchParams.get("after"), "100");
        assert.equal(parsed.searchParams.get("through"), "102");
        return json(replay([event(101), event(102)], 100, 102));
      }
      return json(snapshot);
    },
    webSocket: () => {
      const socket = new FixtureSocket();
      socket.onSend = (value) => {
        socket.frame({
          type: "ack",
          operationId: "replayEvents",
          requestId: (value as { requestId: string }).requestId,
          receipt: {
            events: Array.from({ length: 100 }, (_, i) => event(i + 1)),
            after: 0,
            through: 102,
            lastEventSeq: 102,
            nextAfter: 100,
            hasMore: true,
            retainedFloor: 0,
          },
        });
        socket.frame(event(103));
      };
      return socket;
    },
  });
  const sub = client.conversations.subscribe("conv_1", {
    agentId: "agent_1",
    onSnapshot: () => {},
    onEvent: (e) => {
      if (e.durability === "durable") {
        delivered.push(e.eventSeq);
        if (e.eventSeq === 103) reached();
      }
    },
  });
  try {
    await sub.ready;
    await complete;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(
      delivered,
      Array.from({ length: 103 }, (_, i) => i + 1),
    );
    assert.equal(sub.cursor, 103);
  } finally {
    sub.close();
    await sub.done;
  }
});

void test("authenticated identity and agent scope retained cursors; changed authority resnapshots, ticket TTL does not", async () => {
  const changed = [
    identity,
    { ...identity, principalId: "different_principal" },
    { ...identity, credential: { ...identity.credential, generation: 2 } },
    { ...identity, credential: { ...identity.credential, grantVersion: 2 } },
    { ...identity, credential: { ...identity.credential, credentialId: "different_credential" } },
    { ...identity, role: "admin" as const },
    identity,
  ];
  for (const [index, current] of changed.entries()) {
    const agentId = index === changed.length - 1 ? "agent_2" : "agent_1";
    assert.equal(
      cursorScopeKey({ ...cursorScope, agentId, identity: current }) ===
        cursorScopeKey(cursorScope),
      index === 0,
    );
    let snapshots = 0;
    const after = index === 0 ? 5 : 0;
    const client = new FortiPiClient({
      endpoint: "https://example.test",
      credentials: async () => "synthetic",
      fetch: async (url) => {
        const parsed = new URL(String(url));
        if (parsed.pathname === "/v1/protocol") return json(protocol);
        if (parsed.pathname.endsWith("/tickets"))
          return json(ticketReceipt("fresh_ticket", current, Date.now() + 20000), 201);
        if (parsed.pathname.endsWith("/events")) {
          assert.equal(Number(parsed.searchParams.get("after")), after);
          return json(replay([], after));
        }
        snapshots++;
        return json({ ...snapshot, conversation: { ...snapshot.conversation, agentId } });
      },
      webSocket: () => {
        const socket = new FixtureSocket();
        socket.onSend = (command) =>
          socket.frame({
            type: "ack",
            requestId: (command as { requestId: string }).requestId,
            operationId: "replayEvents",
            receipt: replay([], after),
          });
        return socket;
      },
    });
    const sub = client.conversations.subscribe("conv_1", {
      agentId,
      after: 5,
      scope: cursorScope,
      onSnapshot: () => {},
      onEvent: () => {},
      onIdentity: (authenticated) => {
        assert(!("ticket" in authenticated));
        assert.deepEqual(authenticated, current);
      },
    });
    try {
      await sub.ready;
      assert.equal(snapshots, index === 0 ? 0 : 1);
      assert.equal(sub.cursor, after);
      assert.deepEqual(sub.scope?.identity, current);
    } finally {
      sub.close();
      await sub.done;
    }
  }
});

void test("deployment changes refresh discovery before resnapshot; unscoped cursor and missing identity reject", async () => {
  let deployment = "deploy_test",
    protocols = 0,
    snapshots = 0;
  const client = new FortiPiClient({
    endpoint: "https://example.test",
    credentials: async () => "synthetic",
    fetch: async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/v1/protocol") {
        protocols++;
        return json({ ...protocol, deploymentId: deployment });
      }
      if (parsed.pathname.endsWith("/tickets")) {
        deployment = "deployment_replaced";
        return json(
          ticketReceipt("ticket_replaced", { ...identity, deploymentId: deployment }),
          201,
        );
      }
      if (parsed.pathname.endsWith("/events")) {
        assert.equal(parsed.searchParams.get("after"), "0");
        return json(replay([], 0));
      }
      snapshots++;
      return json(snapshot);
    },
    webSocket: () => {
      const socket = new FixtureSocket();
      socket.onSend = (command) =>
        socket.frame({
          type: "ack",
          operationId: "replayEvents",
          requestId: (command as { requestId: string }).requestId,
          receipt: replay([], 0),
        });
      return socket;
    },
  });
  assert.throws(
    () =>
      client.conversations.subscribe("conv_1", {
        agentId: "agent_1",
        after: 4,
        onSnapshot: () => {},
        onEvent: () => {},
      }),
    { code: "cursor_scope_required" },
  );
  const sub = client.conversations.subscribe("conv_1", {
    agentId: "agent_1",
    after: 4,
    scope: cursorScope,
    onSnapshot: () => {},
    onEvent: () => {},
  });
  try {
    await sub.ready;
    assert.equal(protocols, 2);
    assert.equal(snapshots, 1);
    assert.equal(sub.scope?.identity.deploymentId, "deployment_replaced");
  } finally {
    sub.close();
    await sub.done;
  }
  const validator = new Validation();
  assert.throws(
    () =>
      validator.assert("TicketReceipt", {
        ticket: "legacy",
        audience: "client-stream",
        expiresAt: Date.now() + 30000,
      }),
    { code: "invalid_wire" },
  );
});

void test("duplicates older than the bounded recent window are checked against stored identities, never blindly discarded", async () => {
  for (const conflicting of [false, true]) {
    let checked: () => void = () => {};
    const verified = new Promise<void>((resolve) => {
      checked = resolve;
    });
    let applications = 0,
      lookups = 0;
    const client = new FortiPiClient({
      endpoint: "https://example.test",
      credentials: async () => "synthetic",
      fetch: async (url) => {
        const parsed = new URL(String(url));
        if (parsed.pathname === "/v1/protocol") return json(protocol);
        if (parsed.pathname.endsWith("/tickets")) return json(ticketReceipt(), 201);
        assert(parsed.pathname.endsWith("/events"));
        const after = Number(parsed.searchParams.get("after"));
        if (after === 5) return json(replay([], 5));
        assert.equal(after, 0);
        lookups++;
        checked();
        return json(
          replay(
            Array.from({ length: 5 }, (_, i) => event(i + 1)),
            0,
            5,
          ),
        );
      },
      webSocket: () => {
        const socket = new FixtureSocket();
        socket.onSend = (command) => {
          socket.frame({
            type: "ack",
            operationId: "replayEvents",
            requestId: (command as { requestId: string }).requestId,
            receipt: replay([], 5),
          });
          socket.frame(conflicting ? { ...event(1), eventId: "conflicting_identity" } : event(1));
        };
        return socket;
      },
    });
    const sub = client.conversations.subscribe("conv_1", {
      agentId: "agent_1",
      after: 5,
      scope: cursorScope,
      onSnapshot: () => assert.fail("unneeded snapshot"),
      onEvent: () => {
        applications++;
      },
    });
    try {
      await sub.ready;
      if (conflicting) await assert.rejects(sub.done, { code: "conflicting_event_identity" });
      else {
        await verified;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      assert.equal(lookups, 1);
      assert.equal(applications, 0);
      assert.equal(sub.cursor, 5);
    } finally {
      sub.close();
      await sub.done.catch(() => {});
    }
  }
});
