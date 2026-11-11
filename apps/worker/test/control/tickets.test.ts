import assert from "node:assert/strict";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { harness, request, scope, uuid, value } from "./harness.ts";

test("ticket-only consume is atomic and binds audience, destination, Origin and expiry", async () => {
  const h = await harness();
  try {
    const admin = await h.auth();
    const input: D.TicketInput = {
      requestId: uuid(),
      audience: "client-stream",
      resources: scope(),
      originMode: { kind: "native" },
    };
    const mint = async (body = input, ctx = admin): Promise<D.TicketReceipt> => {
      const response = value(await h.cp.mintTicket(ctx, request("mintConnectionTicket", body)));
      if (response.status !== 201) assert.fail("No ticket");
      return response.body;
    };
    const ticket = await mint();
    assert.deepEqual(ticket.identity, {
      deploymentId: admin.deploymentId,
      principalId: admin.principalId,
      role: admin.role,
      credential: {
        credentialId: admin.credentialId,
        generation: admin.generation,
        grantVersion: admin.grantVersion,
      },
      credentialExpiresAt: admin.credentialExpiresAt,
    });
    const redemption: D.TicketRedemption = {
      ticket: ticket.ticket,
      deploymentId: h.deploymentId,
      audience: "client-stream",
      origin: { kind: "native" },
      destination: { kind: "agent", id: "agent" },
    };
    const races = await Promise.all([
      h.cp.consumeTicket(redemption),
      h.cp.consumeTicket(redemption),
    ]);
    assert.equal(races.filter((r) => r.ok).length, 1, "one ticket admits exactly one identity");
    assert.equal(
      await h.cp.rowCount("recipient"),
      1,
      "consume must register before returning identity",
    );
    const wrong = await mint();
    assert.equal(
      (
        await h.cp.consumeTicket({
          ...redemption,
          ticket: wrong.ticket,
          audience: "executor-session",
        })
      ).ok,
      false,
    );
    assert.equal(
      (
        await h.cp.consumeTicket({
          ...redemption,
          ticket: wrong.ticket,
          destination: { kind: "agent", id: "other" },
        })
      ).ok,
      false,
    );
    const browser = await mint(
      { ...input, requestId: uuid(), originMode: { kind: "browser", value: "https://ui.example" } },
      await h.auth(undefined, "https://ui.example"),
    );
    assert.equal(
      (
        await h.cp.consumeTicket({
          ...redemption,
          ticket: browser.ticket,
          origin: { kind: "browser", value: "https://evil.example" },
        })
      ).ok,
      false,
    );
    const expiring = await mint({ ...input, requestId: uuid(), ttlMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await h.cp.consumeTicket({ ...redemption, ticket: expiring.ticket })).ok, false);
    const fresh = await mint();
    value(await h.cp.consumeTicket({ ...redemption, ticket: fresh.ticket }));
    assert.equal(
      (await h.cp.consumeTicket({ ...redemption, ticket: fresh.ticket })).ok,
      false,
      "failed upgrade cannot restore ticket",
    );
  } finally {
    await h.close();
  }
});

test("actual failed HTTP upgrade spends a ticket; CORS admits only exact configured HTTPS origins", async () => {
  const h = await harness({ allowedOrigins: ["https://ui.example"] });
  try {
    const issued = await h.mint({
      requestId: uuid(),
      role: "executor",
      executorId: "executor",
      grants: [{ grantId: "executor", version: 1, resources: scope() }],
    });
    const auth = await h.auth(issued.token);
    const response = value(
      await h.cp.mintTicket(
        auth,
        request("mintConnectionTicket", {
          requestId: uuid(),
          audience: "executor-session",
          resources: scope(),
          originMode: { kind: "native" },
          executor: { executorId: "executor", generation: 1 },
        }),
      ),
    );
    if (response.status !== 201) assert.fail("No ticket");
    assert.equal(response.body.identity.credentialExpiresAt, null);
    assert.ok(response.body.expiresAt < Date.now() + 60000);
    const url = `https://fixture.invalid/v1/executor/session?ticket=${response.body.ticket}`;
    assert.equal((await h.server.fetch(url)).status, 400);
    assert.equal(
      (await h.server.fetch(url)).status,
      401,
      "failed upgrade cannot unspend the ticket",
    );
    const preflight = (origin: string) =>
      h.server.fetch("https://fixture.invalid/v1/executor/session", {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "authorization",
        },
      });
    const allowed = await preflight("https://ui.example");
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), "https://ui.example");
    for (const origin of [
      "null",
      "https://evil.example",
      "https://ui.example/path",
      "http://ui.example",
    ]) {
      const denied = await preflight(origin);
      assert.equal(denied.status, 403);
      assert.equal(denied.headers.has("Access-Control-Allow-Origin"), false);
    }
  } finally {
    await h.close();
  }
});
