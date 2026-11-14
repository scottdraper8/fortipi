import assert from "node:assert/strict";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { harness, pause } from "../agent/harness.ts";

async function open(url: string): Promise<WebSocket | null> {
  return new Promise((accept) => {
    const socket = new WebSocket(url);
    let settled = false;
    const done = (value: WebSocket | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!value) socket.close();
      accept(value);
    };
    const timer = setTimeout(() => done(null), 4000);
    socket.addEventListener("open", () => done(socket), { once: true });
    socket.addEventListener("error", () => done(null), { once: true });
    socket.addEventListener("close", () => done(null), { once: true });
  });
}
async function packet(socket: WebSocket, command: unknown) {
  return new Promise<Record<string, unknown>>((accept, reject) => {
    const listener = (event: MessageEvent) => {
      clearTimeout(timer);
      socket.removeEventListener("message", listener);
      accept(JSON.parse(String(event.data)) as Record<string, unknown>);
    };
    const timer = setTimeout(() => {
      socket.removeEventListener("message", listener);
      reject(new Error("Expected JSON stream response"));
    }, 4000);
    socket.addEventListener("message", listener);
    socket.send(JSON.stringify(command));
  });
}
test("real Agent stream consumes once, rejects capability frames and keeps bounded query-free attachment past handshake deadline", {
  timeout: 45000,
}, async () => {
  const h = await harness();
  const sockets: WebSocket[] = [];
  try {
    const agent = await h.api<D.Agent>("/v1/agents", {
      requestId: crypto.randomUUID(),
      name: "stream",
      model: { providerId: "cloudflare", modelId: "@cf/zai-org/glm-5.3-flash" },
    });
    assert.equal(agent.status, 201);
    const resources: D.ResourceScope = {
      agentIds: [agent.body.agentId],
      conversationIds: [],
      workspaceIds: [],
      executorIds: [],
      backendIds: [],
      tools: [],
      actions: ["events.read", "tickets.mint"],
    };
    const minted = await h.api<D.CredentialReceipt>("/v1/admin/credentials", {
      requestId: crypto.randomUUID(),
      role: "client",
      expiresAt: Date.now() + 120000,
      grants: [{ grantId: "stream", version: 1, resources }],
    });
    assert.equal(minted.status, 201);
    if (minted.body.state !== "issued") assert.fail("Expected synthetic client issuance");
    const credential = minted.body;
    const ticket = await h.api<D.TicketReceipt>(
      "/v1/connections/tickets",
      {
        requestId: crypto.randomUUID(),
        audience: "client-stream",
        resources: { ...resources, actions: ["events.read"] },
        originMode: { kind: "native" },
      },
      "POST",
      credential.token,
    );
    assert.equal(ticket.status, 201, JSON.stringify(ticket.body));
    const { url: listenUrl } = await h.server.listen();
    const url = new URL(listenUrl);
    url.protocol = "ws:";
    url.pathname = "/v1/stream";
    url.searchParams.set("ticket", ticket.body.ticket);
    const raced = await Promise.all([open(url.href), open(url.href)]);
    for (const socket of raced) if (socket) sockets.push(socket);
    if (sockets.length === 0) {
      const diagnostic = await h.api<D.TicketReceipt>(
        "/v1/connections/tickets",
        {
          requestId: crypto.randomUUID(),
          audience: "client-stream",
          resources: { ...resources, actions: ["events.read"] },
          originMode: { kind: "native" },
        },
        "POST",
        credential.token,
      );
      const response = await h.server.fetch(
        `http://fortipi.local/v1/stream?ticket=${diagnostic.body.ticket}`,
        { headers: { Upgrade: "websocket" } },
      );
      assert.fail(
        `Agent upgrade diagnostic ${response.status}: ${response.status === 101 ? "accepted by in-process fetch" : await response.text()}`,
      );
    }
    assert.equal(sockets.length, 1, "One retained ticket permits one actual Agent upgrade");
    const socket = sockets[0];
    assert.ok(socket);
    const first = await packet(socket, { type: "ping", requestId: crypto.randomUUID() });
    assert.equal(first.type, "ack");
    assert.equal(first.operationId, "ping");
    for (const invalid of [
      { type: "rpc", method: "handleApi", args: [] },
      { type: "setState", state: { admin: true } },
    ]) {
      const denied = await packet(socket, invalid);
      assert.equal(denied.type, "error");
    }
    const report = JSON.parse(
      await h.env.AGENT_SESSIONS.getByName(agent.body.agentId).socketReport(),
    ) as { bytes: number; containsGrants: boolean; containsTicket: boolean }[];
    assert.equal(report.length, 1);
    assert.ok(report[0]!.bytes <= 2048);
    assert.equal(report[0]!.containsGrants, false);
    assert.equal(report[0]!.containsTicket, false);
    await pause(31000);
    const later = await packet(socket, { type: "ping", requestId: crypto.randomUUID() });
    assert.equal(
      later.type,
      "ack",
      "A30s handshake request deadline must not forge or shorten credential/socket lifetime",
    );
    const closed = new Promise<void>((accept) =>
      socket.addEventListener("close", () => accept(), { once: true }),
    );
    const revoke = await h.api(
      `/v1/admin/credentials/${credential.credential.credentialId}/revoke`,
      { requestId: crypto.randomUUID(), expectedGeneration: credential.credential.generation },
    );
    assert.ok([200, 202].includes(revoke.status));
    await Promise.race([
      closed,
      pause(4000).then(() => assert.fail("Durable revocation must close the actual Agent stream")),
    ]);
  } finally {
    for (const socket of sockets) socket.close();
    await h.close();
  }
});
