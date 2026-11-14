import assert from "node:assert/strict";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { harness, request, uuid, value } from "./harness.ts";

const resources = (agentId = "agent"): D.ResourceScope => ({
  agentIds: [agentId],
  conversationIds: ["conversation"],
  workspaceIds: [],
  executorIds: [],
  backendIds: [],
  tools: [],
  actions: ["events.read"],
});
async function mint(
  h: Awaited<ReturnType<typeof harness>>,
  ctx: D.AuthContext,
  input: Partial<Extract<D.TicketInput, { audience: "client-stream" }>> = {},
) {
  const result = value(
    await h.cp.mintTicket(
      ctx,
      request("mintConnectionTicket", {
        requestId: uuid(),
        audience: "client-stream",
        resources: resources(),
        originMode: { kind: "native" },
        ...input,
      }),
    ),
  );
  if (result.status !== 201) assert.fail("No actual stream ticket");
  return result.body;
}
async function websocket(url: string): Promise<{ socket: WebSocket; packet: string } | null> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url);
    let settled = false;
    const finish = (packet: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (packet === null) {
        socket.close();
        resolve(null);
      } else resolve({ socket, packet });
    };
    const timer = setTimeout(() => finish(null), 5000);
    socket.addEventListener("message", (event) => finish(String(event.data)), { once: true });
    socket.addEventListener("error", () => finish(null), { once: true });
    socket.addEventListener("close", () => finish(null), { once: true });
  });
}

test("opaque client stream routes once with atomic registration and sanitized canonical authority", async () => {
  const h = await harness();
  const sockets: WebSocket[] = [];
  try {
    const issued = await h.mint({
      requestId: uuid(),
      role: "client",
      expiresAt: Date.now() + 120000,
      grants: [
        {
          grantId: "stream",
          version: 1,
          resources: { ...resources(), actions: ["events.read", "tickets.mint"] },
        },
        { grantId: "other", version: 1, resources: resources("other") },
      ],
    });
    const ctx = await h.auth(issued.token);
    const ticket = await mint(h, ctx);
    const { url: listenUrl } = await h.server.listen();
    const url = new URL(listenUrl);
    url.protocol = "ws:";
    url.pathname = "/v1/stream";
    url.searchParams.set("ticket", ticket.ticket);
    const races = await Promise.all([websocket(url.href), websocket(url.href)]);
    const opened = races.filter((result) => result !== null);
    for (const result of opened) sockets.push(result.socket);
    const agent = h.env.AGENT_SESSIONS.getByName("agent");
    const other = h.env.AGENT_SESSIONS.getByName("other");
    const audit = JSON.parse(await agent.streamAudit());
    assert.equal(
      opened.length,
      1,
      `opaque client stream must forward exactly once under a real upgrade race; calls=${audit.calls}; recipientError=${audit.error}`,
    );
    assert.equal(audit.calls, 1);
    assert.equal(JSON.parse(await other.streamAudit()).calls, 0);
    assert.equal(await h.cp.rowCount("recipient"), 1);
    const seen = JSON.parse(opened[0]?.packet ?? "null");
    assert.equal(seen.actorId, agent.id.toString());
    assert.equal(seen.query, "", "ticket query must never reach the Agent recipient");
    assert.equal(seen.path, "/v1/stream");
    assert.equal(seen.method, "GET");
    const identity = JSON.parse(seen.socket);
    const canonical = JSON.parse(seen.context);
    assert.deepEqual(identity.resources, resources());
    assert.equal(
      identity.registrationId,
      seen.registration.registrationId,
      "actual recipient registration must exist before downstream upgrade",
    );
    assert.deepEqual(seen.registration.recipient, { kind: "agent", id: "agent" });
    assert.deepEqual(
      canonical.grants,
      ctx.grants,
      "canonical grants must stay unchanged, including unrelated grants",
    );
    assert.equal(canonical.credentialExpiresAt, ctx.credentialExpiresAt);
    assert.equal(canonical.registrationId, identity.registrationId);
    assert.equal(canonical.principalId, identity.principalId);
    assert.equal(canonical.deploymentId, identity.deploymentId);
    assert.equal(canonical.role, identity.role);
    assert.equal(canonical.credentialId, identity.credentialId);
    assert.equal(canonical.generation, identity.generation);
    assert.equal(canonical.grantVersion, identity.grantVersion);
    assert.ok(canonical.authenticatedAt <= Date.now());
    assert.ok(canonical.deadline <= identity.expiresAt && canonical.deadline <= Date.now() + 30000);
    assert.equal(canonical.resources, undefined);
    assert.equal(await websocket(url.href), null, "spent ticket cannot forward a second upgrade");

    const otherTicket = await mint(h, ctx, { resources: resources("other") });
    url.searchParams.set("ticket", otherTicket.ticket);
    const otherStream = await websocket(url.href);
    assert.ok(otherStream, "another exact agent ticket must route to its own recipient");
    sockets.push(otherStream.socket);
    assert.equal(JSON.parse(otherStream.packet).actorId, other.id.toString());
    assert.equal(await h.cp.rowCount("recipient"), 2);

    await agent.streamFailure("status");
    const failed = await mint(h, ctx);
    const path = `https://fixture.invalid/v1/stream?ticket=${failed.ticket}`;
    const response = await h.server.fetch(path, {
      headers: {
        Upgrade: "websocket",
        Authorization: "Bearer synthetic-spoof",
        Cookie: "synthetic=spoof",
        "X-Fortipi-Socket": '{"resources":{"agentIds":["other"]}}',
        "X-Fortipi-Context": '{"principalId":"spoof"}',
        "X-Fortipi-Connection-Id": "spoof",
      },
    });
    assert.equal(response.status, 503);
    const failedAudit = JSON.parse(await agent.streamAudit()).last;
    assert.equal(failedAudit.query, "");
    assert.equal(
      failedAudit.hasBearer ||
        failedAudit.hasCookie ||
        failedAudit.hasProtocol ||
        failedAudit.hasConnectionId,
      false,
    );
    assert.equal(JSON.parse(failedAudit.socket).principalId, ctx.principalId);
    assert.deepEqual(JSON.parse(failedAudit.socket).resources.agentIds, ["agent"]);
    assert.equal(
      JSON.parse(failedAudit.context).principalId,
      ctx.principalId,
      "caller authority headers must be replaced by current canonical server context",
    );
    assert.equal(
      (await h.server.fetch(path)).status,
      401,
      "failed target upgrade spends the ticket once",
    );
    await agent.streamFailure("throw");
    const thrown = await mint(h, ctx);
    const thrownPath = `https://fixture.invalid/v1/stream?ticket=${thrown.ticket}`;
    assert.equal(
      (await h.server.fetch(thrownPath, { headers: { Upgrade: "websocket" } })).status,
      500,
    );
    assert.equal((await h.server.fetch(thrownPath)).status, 401);
  } finally {
    for (const socket of sockets) socket.close();
    await h.close();
  }
});

test("client stream ticket scope, audience, origin and current authority fail closed", async () => {
  const h = await harness({ allowedOrigins: ["https://ui.example", "https://other.example"] });
  try {
    const admin = await h.auth();
    const url = (ticket: string) => `https://fixture.invalid/v1/stream?ticket=${ticket}`;
    for (const agents of [[], ["agent", "other"], ["agent", "agent"], ["*"]]) {
      const result = await h.cp.mintTicket(
        admin,
        request("mintConnectionTicket", {
          requestId: uuid(),
          audience: "client-stream",
          resources: { ...resources(), agentIds: agents },
          originMode: { kind: "native" },
        }),
      );
      assert.equal(result.ok, false, "client stream mint must require exactly one concrete agent");
      const legacy = await mint(h, admin);
      await h.cp.replaceTicketAgents(legacy.ticket, agents);
      assert.equal(
        (await h.server.fetch(url(legacy.ticket))).status,
        400,
        "legacy ambiguous ticket scope must fail before recipient registration or forwarding",
      );
    }
    assert.equal(await h.cp.rowCount("recipient"), 0);
    const scoped = await mint(h, admin);
    assert.equal(
      (
        await h.cp.consumeTicket({
          ticket: scoped.ticket,
          deploymentId: h.deploymentId,
          audience: "client-stream",
          origin: { kind: "native" },
          destination: { kind: "agent", id: "other" },
        })
      ).ok,
      false,
      "an explicit cross-agent redemption must fail",
    );
    const browser = await mint(h, await h.auth(undefined, "https://ui.example"), {
      originMode: { kind: "browser", value: "https://ui.example" },
    });
    assert.equal(
      (await h.server.fetch(url(browser.ticket), { headers: { Origin: "https://other.example" } }))
        .status,
      403,
    );
    assert.equal(
      (await h.server.fetch(url(browser.ticket), { headers: { Origin: "https://ui.example" } }))
        .status,
      400,
    );
    assert.equal(
      (await h.server.fetch(url(browser.ticket), { headers: { Origin: "https://ui.example" } }))
        .status,
      401,
    );
    const expired = await mint(h, admin, { ttlMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await h.server.fetch(url(expired.ticket))).status, 401);
    const executor = await h.mint({
      requestId: uuid(),
      role: "executor",
      executorId: "executor",
      grants: [
        {
          grantId: "executor",
          version: 1,
          resources: {
            ...resources(),
            executorIds: ["executor"],
            actions: ["*"],
          },
        },
      ],
    });
    const executorCtx = await h.auth(executor.token);
    const executorTicket = value(
      await h.cp.mintTicket(
        executorCtx,
        request("mintConnectionTicket", {
          requestId: uuid(),
          audience: "executor-session",
          originMode: { kind: "native" },
          resources: { ...resources(), executorIds: ["executor"] },
          executor: { executorId: "executor", generation: 1 },
        }),
      ),
    );
    if (executorTicket.status !== 201) assert.fail("No executor audience ticket");
    assert.equal(
      (await h.server.fetch(url(executorTicket.body.ticket))).status,
      403,
      "executor audience cannot enter the client stream",
    );
    assert.equal(
      (
        await h.cp.mintTicket(
          executorCtx,
          request("mintConnectionTicket", {
            requestId: uuid(),
            audience: "client-stream",
            resources: resources(),
            originMode: { kind: "native" },
          }),
        )
      ).ok,
      false,
    );
    const authorityExpiry = Date.now() + 1500;
    const expiringTickets: D.TicketReceipt[] = [];
    for (const expiresCredential of [true, false]) {
      const authority = await h.mint({
        requestId: uuid(),
        role: "client",
        ...(expiresCredential ? { expiresAt: authorityExpiry } : {}),
        grants: [
          {
            grantId: "bounded",
            version: 1,
            ...(expiresCredential ? {} : { expiresAt: authorityExpiry }),
            resources: { ...resources(), actions: ["tickets.mint", "events.read"] },
          },
        ],
      });
      const ticket = await mint(h, await h.auth(authority.token));
      assert.ok(
        ticket.expiresAt <= authorityExpiry,
        "ticket lifetime cannot outlive current credential or covering grant",
      );
      expiringTickets.push(ticket);
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(1, authorityExpiry - Date.now() + 5)),
    );
    for (const ticket of expiringTickets)
      assert.equal((await h.server.fetch(url(ticket.ticket))).status, 401);
    const selector = await mint(h, admin);
    assert.equal((await h.server.fetch(`${url(selector.ticket)}&agentId=other`)).status, 400);
    assert.equal(
      (await h.server.fetch(`${url(selector.ticket)}&ticket=${selector.ticket}`)).status,
      400,
    );
    for (const init of [
      { method: "POST" },
      { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": "capnweb" } },
    ]) {
      const ticket = await mint(h, admin);
      assert.equal((await h.server.fetch(url(ticket.ticket), init)).status, 400);
      assert.equal((await h.server.fetch(url(ticket.ticket))).status, 401);
    }
    const client = await h.mint({
      requestId: uuid(),
      role: "client",
      grants: [
        {
          grantId: "read",
          version: 1,
          resources: { ...resources(), actions: ["tickets.mint", "events.read"] },
        },
      ],
    });
    const revoked = await mint(h, await h.auth(client.token));
    value(
      await h.cp.revokeCredential(
        admin,
        request(
          "revokeCredential",
          {
            requestId: uuid(),
            expectedGeneration: client.credential.generation,
          },
          { id: client.credential.credentialId },
        ),
      ),
    );
    assert.equal((await h.server.fetch(url(revoked.ticket))).status, 401);
    assert.equal(JSON.parse(await h.env.AGENT_SESSIONS.getByName("agent").streamAudit()).calls, 0);
  } finally {
    await h.close();
  }
});

test("stream authority headers are bounded without narrowing canonical grants or restoring the spent ticket", async () => {
  const h = await harness();
  try {
    const large: D.Grant[] = Array.from({ length: 8 }, (_, index) => ({
      grantId: `other_${index}`,
      version: 1,
      resources: {
        ...resources("other"),
        conversationIds: Array.from({ length: 100 }, (_, n) => `c_${n}_${"x".repeat(110)}`),
      },
    }));
    const client = await h.mint({
      requestId: uuid(),
      role: "client",
      grants: [
        {
          grantId: "stream",
          version: 1,
          resources: { ...resources(), actions: ["tickets.mint", "events.read"] },
        },
        ...large,
      ],
    });
    const ctx = await h.auth(client.token);
    const ticket = await mint(h, ctx);
    const url = `https://fixture.invalid/v1/stream?ticket=${ticket.ticket}`;
    const denied = await h.server.fetch(url, { headers: { Upgrade: "websocket" } });
    assert.equal(
      denied.status,
      400,
      "oversized canonical authority must fail instead of truncating grants",
    );
    assert.equal((await h.server.fetch(url)).status, 401);
    assert.equal(JSON.parse(await h.env.AGENT_SESSIONS.getByName("agent").streamAudit()).calls, 0);
    assert.equal(
      await h.cp.rowCount("recipient"),
      1,
      "header rejection follows atomic consume/registration",
    );
  } finally {
    await h.close();
  }
});

test("failed ticket persistence rolls back its actual stream recipient registration", async () => {
  const h = await harness();
  try {
    const ticket = await mint(h, await h.auth(), { resources: resources("rollback") });
    const target = h.env.AGENT_SESSIONS.getByName("rollback");
    await target.streamFailure("status");
    const url = `https://fixture.invalid/v1/stream?ticket=${ticket.ticket}`;
    await h.cp.refuseWrites("ticket");
    assert.equal((await h.server.fetch(url, { headers: { Upgrade: "websocket" } })).status, 500);
    assert.equal(
      await h.cp.rowCount("recipient"),
      0,
      "recipient registration must roll back when atomic ticket consumption cannot persist",
    );
    assert.equal(await h.cp.rowCount("registration_key"), 0);
    assert.equal(JSON.parse(await target.streamAudit()).calls, 0);
    await h.cp.refuseWrites(null);
    assert.equal(
      (await h.server.fetch(url, { headers: { Upgrade: "websocket" } })).status,
      503,
      "the uncommitted ticket remains usable after the storage fault is removed",
    );
    assert.equal(await h.cp.rowCount("recipient"), 1);
    assert.equal((await h.server.fetch(url)).status, 401);
  } finally {
    await h.close();
  }
});
