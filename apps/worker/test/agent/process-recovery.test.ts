import assert from "node:assert/strict";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { eventually } from "./harness.ts";
import { processHarness } from "./process-harness.ts";

interface ProbeState {
  barrier: string | null;
  admissions: {
    operationId: string;
    messageId: string;
    taskId: string;
    receipt: D.AdmissionReceipt | null;
  }[];
  creations: { conversationId: string }[];
  piIds: string[];
}
test("SIGKILL/reopen preserves canary, allocation provenance and stable accepted input", {
  timeout: 90000,
}, async () => {
  const h = await processHarness();
  try {
    const agent = await h.api<D.Agent>("/v1/agents", {
      requestId: crypto.randomUUID(),
      name: "process",
      model: { providerId: "cloudflare", modelId: "@cf/zai-org/glm-5.3-flash" },
    });
    assert.equal(agent.status, 201, JSON.stringify(agent.body));
    const probe = `/__test/agents/${agent.body.agentId}`;
    const canary = { nonce: crypto.randomUUID() };
    assert.deepEqual((await h.api(`${probe}/canary`, canary, "PUT")).body, canary);
    await h.crash();
    await h.start();
    assert.deepEqual(
      (await h.api(`${probe}/canary`)).body,
      canary,
      "Committed data must survive a real ungraceful process death before recovery claims",
    );
    const initialPiIds = (await h.api<ProbeState>(`${probe}/state`)).body.piIds;
    const creation = { requestId: crypto.randomUUID(), title: "killed allocation" };
    await h.api(`${probe}/fault`, "after-create");
    const lostCreate = h
      .api(`/v1/agents/${agent.body.agentId}/conversations`, creation)
      .catch(() => undefined);
    const allocated = await eventually(
      async () => (await h.api<ProbeState>(`${probe}/state`)).body,
      (s) => s.barrier === "after-create",
    );
    assert.equal(allocated.piIds.length, initialPiIds.length + 1);
    assert.equal(allocated.creations.length, 1);
    await h.crash();
    await lostCreate;
    await h.start();
    const conversation = await h.api<D.Conversation>(
      `/v1/agents/${agent.body.agentId}/conversations`,
      creation,
    );
    assert.equal(conversation.status, 201, JSON.stringify(conversation.body));
    assert.equal(conversation.body.conversationId, allocated.creations[0]!.conversationId);
    assert.deepEqual(
      (await h.api<ProbeState>(`${probe}/state`)).body.piIds,
      allocated.piIds,
      "Lost allocation response must not allocate a second Pi conversation",
    );
    for (const point of ["before-submit", "after-submit"]) {
      const input = {
        clientRequestId: crypto.randomUUID(),
        content: point,
        busyBehavior: "followUp",
      };
      const previous = (await h.api<ProbeState>(`${probe}/state`)).body.admissions.map(
        (a) => a.operationId,
      );
      await h.api(`${probe}/fault`, point);
      const lost = h
        .api(`/v1/conversations/${conversation.body.conversationId}/messages`, input)
        .catch(() => undefined);
      const before = await eventually(
        async () => (await h.api<ProbeState>(`${probe}/state`)).body,
        (s) => s.barrier === point,
      );
      const identity = before.admissions.find((a) => !previous.includes(a.operationId));
      assert.ok(identity);
      assert.equal(identity.receipt, null);
      await h.crash();
      await lost;
      await h.start();
      const accepted = await h.api<D.AdmissionReceipt>(
        `/v1/conversations/${conversation.body.conversationId}/messages`,
        input,
      );
      assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
      assert.equal(accepted.body.operationId, identity.operationId);
      assert.equal(accepted.body.messageId, identity.messageId);
      assert.equal(accepted.body.taskId, identity.taskId);
      const completed = await eventually(
        async () =>
          (
            await h.api<D.ConversationProjection>(
              `/v1/conversations/${conversation.body.conversationId}`,
            )
          ).body,
        (s) => s.messages?.some((m) => m.content === `answer:${point}`),
      );
      assert.equal(
        completed.messages.filter((m) => m.role === "user" && m.content === point).length,
        1,
      );
      const entries = (
        await h.api<{ entries: { kind: string; text: string }[] }>(
          `${probe}/inspect?cid=${conversation.body.conversationId}`,
        )
      ).body.entries;
      assert.equal(
        entries.filter((e) => e.kind === "pi.user" && e.text === point).length,
        1,
        "Count actual Pi input entries, not only deduplicated public projections",
      );
      const repeat = await h.api<D.AdmissionReceipt>(
        `/v1/conversations/${conversation.body.conversationId}/messages`,
        input,
      );
      assert.deepEqual(repeat, accepted);
    }
  } finally {
    await h.close();
  }
});
