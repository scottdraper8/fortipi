import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { eventually, harness, setup } from "./harness.ts";
import type { TestAgentSession } from "./unwritable-repair-worker.js";

test("unwritable repair markers preserve known receipts/projections and stable unadmitted recovery identity", {
  timeout: 30000,
}, async () => {
  // Synthetic traffic isolates actual SQLite/read/repair semantics; no claim
  // that these diagnostic requests fit an unchanged Free ingress minute.
  const h = await harness({ main: resolve("apps/worker/test/agent/unwritable-repair-worker.ts") });
  let cleanup: DurableObjectStub<TestAgentSession> | undefined;
  try {
    const { agent, conversation } = await setup(h);
    const cid = conversation.conversationId,
      path = `/v1/conversations/${cid}`;
    const probe = h.env.AGENT_SESSIONS.getByName(
      agent.agentId,
    ) as DurableObjectStub<TestAgentSession>;
    cleanup = probe;
    const issued = await h.api<D.CredentialReceipt>("/v1/admin/credentials", {
      requestId: crypto.randomUUID(),
      role: "client",
      grants: [
        {
          grantId: crypto.randomUUID(),
          version: 1,
          resources: {
            agentIds: [agent.agentId],
            conversationIds: [cid],
            workspaceIds: [],
            executorIds: [],
            backendIds: [],
            tools: [],
            actions: ["messages.submit", "conversations.read", "events.read"],
          },
        },
      ],
    });
    assert.equal(issued.status, 201);
    if (issued.body.state !== "issued") assert.fail("Actual scoped synthetic credential required");
    const token = issued.body.token;
    const firstInput: D.MessageSubmit = {
      clientRequestId: crypto.randomUUID(),
      content: "retained-before-refusal",
      busyBehavior: "followUp",
    };
    const first = await h.api<D.AdmissionReceipt>(`${path}/messages`, firstInput, "POST", token);
    assert.equal(first.status, 202);
    const snapshot = await eventually(
      () => h.api<D.ConversationProjection>(path, undefined, "GET", token),
      (value) =>
        value.body.messages.some((message) => message.content === "answer:retained-before-refusal"),
    );
    const replay = await h.api<D.ReplayPage>(`${path}/events?after=0`, undefined, "GET", token);
    assert.equal(replay.status, 200);
    await probe.refuseAfterNextSelection();
    const input: D.MessageSubmit = {
      clientRequestId: crypto.randomUUID(),
      content: "recover-after-refusal",
      busyBehavior: "followUp",
    };
    const blocked = await h.api<D.ErrorBody>(`${path}/messages`, input, "POST", token);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, "interrupted");
    const retained = JSON.parse(await probe.refusalState()) as {
      refusing: boolean;
      intents: { operationId: string; messageId: string; taskId: string }[];
      growth: { claims: { operationId: string }[] };
    };
    assert.equal(retained.refusing, true);
    assert.equal(retained.intents.length, 1);
    const intent = retained.intents[0];
    assert.ok(
      intent && retained.growth.claims.some((claim) => claim.operationId === intent.operationId),
    );
    assert.deepEqual(await h.api(`${path}/messages`, firstInput, "POST", token), first);
    const known = await h.api<D.ConversationProjection>(path, undefined, "GET", token);
    assert.equal(
      known.status,
      200,
      "Known snapshot must not fail because optional repair cannot write its marker",
    );
    assert.deepEqual(known.body.messages, snapshot.body.messages);
    assert.deepEqual(await h.api(`${path}/events?after=0`, undefined, "GET", token), replay);
    const stillHeld = JSON.parse(await probe.refusalState()) as typeof retained;
    assert.deepEqual(stillHeld.intents, retained.intents);
    assert.ok(
      stillHeld.growth.claims.some((claim) => claim.operationId === intent.operationId),
      "Optional reads cannot refund unacknowledged growth or replace the pending identity",
    );
    const before = JSON.parse(await probe.inspectionJson(cid)) as {
      entries: { kind: string; text: string }[];
    };
    assert.equal(before.entries.filter((entry) => entry.kind === "pi.user").length, 1);
    await probe.restoreWrites();
    const recovered = await h.api<D.AdmissionReceipt>(`${path}/messages`, input, "POST", token);
    assert.equal(recovered.status, 202, JSON.stringify(recovered.body));
    assert.deepEqual(
      [recovered.body.operationId, recovered.body.messageId, recovered.body.taskId],
      [intent.operationId, intent.messageId, intent.taskId],
    );
    await eventually(
      () => h.api<D.ConversationProjection>(path, undefined, "GET", token),
      (value) =>
        value.body.messages.some((message) => message.content === "answer:recover-after-refusal"),
    );
    const after = JSON.parse(await probe.inspectionJson(cid)) as typeof before;
    assert.equal(after.entries.filter((entry) => entry.kind === "pi.user").length, 2);
    assert.equal(
      (await h.api(`${path}/messages`, { ...input, content: "changed" }, "POST", token)).status,
      409,
    );
  } finally {
    await cleanup?.restoreWrites();
    await h.close();
  }
});
