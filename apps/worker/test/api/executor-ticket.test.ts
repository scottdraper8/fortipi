import assert from "node:assert/strict";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { harness } from "../agent/harness.ts";

test("public ticket union permits scoped executor session and rejects client-stream/application authority", async () => {
  const h = await harness();
  try {
    const resources: D.ResourceScope = {
      agentIds: ["agent"],
      conversationIds: [],
      workspaceIds: [],
      executorIds: ["executor"],
      backendIds: [],
      tools: [],
      actions: ["tickets.mint", "executors.register", "events.read"],
    };
    const issued = await h.api<D.CredentialReceipt>("/v1/admin/credentials", {
      requestId: crypto.randomUUID(),
      role: "executor",
      executorId: "executor",
      grants: [{ grantId: "executor", version: 1, resources }],
    });
    assert.equal(issued.status, 201);
    if (issued.body.state !== "issued") assert.fail("Expected synthetic executor issuance");
    // Fresh issuance's initial generation is server-validated here. Existing
    // execution targets use the actual registered/keyed generation instead.
    const ticket = await h.api<D.TicketReceipt>(
      "/v1/connections/tickets",
      {
        requestId: crypto.randomUUID(),
        audience: "executor-session",
        resources,
        originMode: { kind: "native" },
        executor: {
          executorId: "executor",
          generation: 1,
          ledgerId: "fixture_ledger",
          ledgerInstanceId: "fixture_instance",
        },
      },
      "POST",
      issued.body.token,
    );
    assert.equal(ticket.status, 201, JSON.stringify(ticket.body));
    const application = await h.api("/v1/agents", undefined, "GET", issued.body.token);
    assert.equal(application.status, 403);
    const wrong = await h.api(
      "/v1/connections/tickets",
      {
        requestId: crypto.randomUUID(),
        audience: "client-stream",
        resources: { ...resources, agentIds: ["agent"] },
        originMode: { kind: "native" },
      },
      "POST",
      issued.body.token,
    );
    assert.equal(wrong.status, 403);
  } finally {
    await h.close();
  }
});
