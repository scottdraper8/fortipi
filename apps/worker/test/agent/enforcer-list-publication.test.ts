import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import type { TestAgentSession } from "./enforcer-list-publication-worker.js";
import { eventually, harness, pause } from "./harness.ts";

// Each returned item needs its own current grant. Another conversation's grant
// can keep this credential authorized to list without authorizing the old item.
test("aggregate conversation publication excludes a grant that expires before its final guard", {
  timeout: 20000,
}, async () => {
  const h = await harness({
    main: resolve("apps/worker/test/agent/enforcer-list-publication-worker.ts"),
    traffic: "free",
  });
  let probe: DurableObjectStub<TestAgentSession> | undefined;
  let pending: Promise<{ status: number; body: D.ConversationPage | D.ErrorBody }> | undefined;
  try {
    const agent = await h.api<D.Agent>("/v1/agents", {
      requestId: crypto.randomUUID(),
      name: "aggregate-list-authority",
      model: { providerId: "cloudflare", modelId: "@cf/zai-org/glm-5.3-flash" },
    });
    assert.equal(agent.status, 201);
    const aTitle = "enforcer-expiring-A-private-title";
    const conversations: D.Conversation[] = [];
    for (const title of [aTitle, "enforcer-permanent-B-title"]) {
      const created = await h.api<D.Conversation>(
        `/v1/agents/${agent.body.agentId}/conversations`,
        { requestId: crypto.randomUUID(), title },
      );
      assert.equal(created.status, 201);
      conversations.push(created.body);
    }
    const [a, b] = conversations;
    assert.ok(a && b);
    const expiresAt = Date.now() + 5000;
    const issued = await h.api<D.CredentialReceipt>("/v1/admin/credentials", {
      requestId: crypto.randomUUID(),
      role: "client",
      // The credential and G2 remain valid; only G1 has an expiry.
      grants: [a, b].map((conversation, n) => ({
        grantId: n === 0 ? "G1-expiring-A" : "G2-permanent-B",
        version: 1,
        ...(n === 0 ? { expiresAt } : {}),
        resources: {
          agentIds: [agent.body.agentId],
          conversationIds: [conversation.conversationId],
          workspaceIds: [],
          executorIds: [],
          backendIds: [],
          tools: [],
          actions: ["conversations.list"],
        },
      })),
    });
    assert.equal(issued.status, 201);
    assert.equal(issued.body.state, "issued");
    if (issued.body.state !== "issued")
      assert.fail("Actual two-grant synthetic credential required");
    const path = `/v1/agents/${agent.body.agentId}/conversations?limit=2`;
    const positive = await h.api<D.ConversationPage>(path, undefined, "GET", issued.body.token);
    assert.equal(positive.status, 200);
    assert.deepEqual(
      positive.body.items.map((item) => item.conversationId).sort(),
      [a.conversationId, b.conversationId].sort(),
    );
    assert.ok(positive.body.items.some((item) => item.title === aTitle));
    assert.ok(positive.body.nextPageToken, "A full real page must persist its continuation token");
    probe = h.env.AGENT_SESSIONS.getByName(
      agent.body.agentId,
    ) as unknown as DurableObjectStub<TestAgentSession>;
    await probe.armList(issued.body.credential.credentialId);
    pending = h.api<D.ConversationPage | D.ErrorBody>(path, undefined, "GET", issued.body.token);
    const observer = probe;
    const held = await eventually(
      () => observer.listGate(),
      (gate) => gate.enteredAt !== null,
    );
    assert.ok(held.authorizedAt !== null && held.pageWrittenAt !== null && held.enteredAt !== null);
    assert.ok(held.authorizedAt <= held.pageWrittenAt && held.pageWrittenAt <= held.enteredAt);
    assert.ok(held.enteredAt < expiresAt, "G1 must still authorize A when its payload is selected");
    assert.equal(held.delegatedAt, null, "The barrier must precede the actual final guard");
    assert.deepEqual(
      (await probe.queuedConversations()).sort(),
      [a.conversationId, b.conversationId].sort(),
      "The actual SQL queue remains available while the final guard is held",
    );
    await pause(Math.max(0, expiresAt - Date.now() + 30));
    assert.ok(Date.now() > expiresAt);
    const fresh = await h.api<D.ConversationPage>(path, undefined, "GET", issued.body.token);
    assert.equal(fresh.status, 200, "G2 must keep this same credential authorized");
    assert.deepEqual(
      fresh.body.items.map((item) => item.conversationId),
      [b.conversationId],
      "Fresh listing must establish that conversation scope is actually enforced after G1 expiry",
    );
    assert.equal(JSON.stringify(fresh.body).includes(aTitle), false);
    await probe.releaseList();
    const response = await pending;
    const final = await probe.listGate();
    assert.ok(final.delegatedAt !== null && final.delegatedAt > expiresAt);
    assert.equal(final.finalPassed, true, "Actual final agent/action guard must run successfully");
    const body = JSON.stringify(response.body);
    console.log({
      positiveItems: positive.body.items.length,
      selectionBeforeExpiry: held.enteredAt < expiresAt,
      heldBeforeFinalGuard: held.delegatedAt === null,
      queueAvailableWhileHeld: true,
      finalGuardAfterExpiryMs: final.delegatedAt - expiresAt,
      finalGuardPassed: final.finalPassed,
      freshStatus: fresh.status,
      freshContainsA: fresh.body.items.some((item) => item.conversationId === a.conversationId),
      heldStatus: response.status,
      heldContainsA: body.includes(a.conversationId),
      heldLeaksATitle: body.includes(aTitle),
    });
    assert.ok([200, 401, 403].includes(response.status));
    assert.equal(
      body.includes(a.conversationId) || body.includes(aTitle),
      false,
      "Aggregate list published conversation A after its sole item grant expired despite passing the final agent/action guard",
    );
  } finally {
    await probe?.releaseList();
    await pending?.catch(() => {});
    await h.close();
  }
});
