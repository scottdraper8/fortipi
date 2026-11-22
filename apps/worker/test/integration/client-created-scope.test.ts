import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { FortiPiClient } from "../../../../packages/fortipi-client/dist/node.js";
import type * as D from "../../src/boundary/dto.js";
import { poll, start } from "./runtime.ts";

test("an explicitly agent-scoped client creates and uses a conversation with the same credential", {
  timeout: 120000,
}, async () => {
  const runtime = await start();
  let subscription: ReturnType<FortiPiClient["conversations"]["subscribe"]> | undefined;
  try {
    const model = await runtime.api<D.ModelConfig>("/__integration/model");
    assert.equal(model.status, 200);
    const makeAgent = async () => {
      const result = await runtime.api<D.Agent>("/v1/agents", {
        requestId: randomUUID(),
        name: "Scoped creation",
        model: model.body,
      });
      assert.equal(result.status, 201);
      return result.body.agentId;
    };
    const agentId = await makeAgent(),
      otherAgent = await makeAgent();
    const resources: D.AgentConversationGrantScope = {
      agentIds: [agentId],
      conversationIds: ["*"],
      workspaceIds: [],
      executorIds: [],
      backendIds: [],
      tools: [],
      actions: [
        "conversations.list",
        "conversations.create",
        "conversations.read",
        "messages.submit",
        "events.read",
        "tasks.read",
        "tickets.mint",
      ],
    };
    const issued = await runtime.api<D.CredentialReceipt>("/v1/admin/credentials", {
      requestId: randomUUID(),
      role: "client",
      grants: [{ grantId: randomUUID(), version: 1, resources }],
    });
    assert.equal(issued.status, 201);
    assert.equal(issued.body.state, "issued");
    if (issued.body.state !== "issued") assert.fail("Initial scoped credential required");
    const credential = issued.body;
    const client = new FortiPiClient({
      endpoint: runtime.endpoint,
      credentials: async () => credential.token,
      allowLoopbackHttp: true,
    });
    const conversation = await client.conversations.create(agentId, {
      requestId: randomUUID(),
      title: "First client conversation",
    });
    assert.equal(
      (await client.conversations.get(conversation.conversationId)).conversation.conversationId,
      conversation.conversationId,
    );
    const ticket = await client.tickets.mint(agentId, conversation.conversationId);
    assert.deepEqual(ticket.identity.credential, credential.credential);
    const seen: D.DurableEvent[] = [];
    subscription = client.conversations.subscribe(conversation.conversationId, {
      agentId,
      maxReconnects: 0,
      onSnapshot() {},
      onEvent(event) {
        if (event.durability === "durable") seen.push(event);
      },
    });
    await subscription.ready;
    const intent = client.messageIntent(
      conversation.conversationId,
      "seed1010-first-scoped-client",
      "followUp",
    );
    const receipt = await intent.send();
    await poll(
      async () =>
        seen.some((event) => event.type === "task.completed" && event.taskId === receipt.taskId),
      Boolean,
    );
    assert.equal((await client.tasks.get(receipt.taskId)).status.state, "completed");
    assert.ok(
      seen.some((event) => event.type === "message.completed" && event.taskId === receipt.taskId),
    );
    assert.deepEqual(
      await intent.send(),
      receipt,
      "Retry keeps the original committed input identity",
    );

    const otherConversation = await runtime.api<D.Conversation>(
      `/v1/agents/${otherAgent}/conversations`,
      {
        requestId: randomUUID(),
        title: "Outside selected agent",
      },
    );
    assert.equal(otherConversation.status, 201);
    const denied = await runtime.api(
      `/v1/conversations/${otherConversation.body.conversationId}`,
      undefined,
      "GET",
      credential.token,
    );
    assert.equal(denied.status, 403, "Conversation scope cannot cross its concrete agent boundary");

    const exact = await runtime.api<D.CredentialReceipt>("/v1/admin/credentials", {
      requestId: randomUUID(),
      role: "client",
      grants: [
        { grantId: randomUUID(), version: 1, resources: { ...resources, conversationIds: [] } },
      ],
    });
    assert.equal(exact.status, 201);
    if (exact.body.state !== "issued") assert.fail("Exact-scope credential required");
    assert.equal(
      (
        await runtime.api(
          `/v1/conversations/${conversation.conversationId}`,
          undefined,
          "GET",
          exact.body.token,
        )
      ).status,
      403,
      "Empty exact scope still grants no conversation access",
    );
  } finally {
    subscription?.close();
    await runtime.dispose();
  }
});
