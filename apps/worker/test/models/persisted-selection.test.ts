import assert from "node:assert/strict";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { eventually, harness } from "../agent/harness.ts";

test("actual Pi generation follows each persisted Agent selection rather than an installation default", async () => {
  const h = await harness();
  try {
    const created = await h.api<D.Agent>("/v1/agents", {
      requestId: crypto.randomUUID(),
      name: "selected",
      model: { providerId: "cloudflare", modelId: "fixture-alternate" },
    });
    assert.equal(created.status, 201);
    const agent = created.body,
      conversation = await h.api<D.Conversation>(`/v1/agents/${agent.agentId}/conversations`, {
        requestId: crypto.randomUUID(),
      });
    assert.equal(conversation.status, 201);
    const probe = h.env.AGENT_SESSIONS.getByName(agent.agentId),
      cid = conversation.body.conversationId;
    const answer = async (content: string, modelId: string) => {
      const sent = await h.api(`/v1/conversations/${cid}/messages`, {
        clientRequestId: crypto.randomUUID(),
        content,
        busyBehavior: "followUp",
      });
      assert.equal(sent.status, 202, JSON.stringify(sent.body));
      const actual = await eventually(
        async () =>
          JSON.parse(await probe.inspectionJson(cid)) as {
            entries: { kind: string; text: string; models: string[] }[];
          },
        (value) =>
          value.entries.some(
            (entry) => entry.kind === "pi.assistant" && entry.text === `answer:${content}`,
          ),
      );
      assert.deepEqual(actual.entries.find((entry) => entry.text === `answer:${content}`)?.models, [
        modelId,
      ]);
      await eventually(
        () => h.api<D.ConversationProjection>(`/v1/conversations/${cid}`),
        (response) =>
          response.status === 200 && response.body.conversation.taskState.state === "completed",
      );
    };
    await answer("alternate-selection", "fixture-alternate");
    const selected = { providerId: "cloudflare" as const, modelId: "@cf/zai-org/glm-5.3-flash" };
    const configured = await h.api<D.Agent>(
      `/v1/agents/${agent.agentId}`,
      { requestId: crypto.randomUUID(), expectedVersion: 1, model: selected },
      "PATCH",
    );
    assert.equal(configured.status, 200);
    await probe.disposePi();
    await answer("changed-selection", selected.modelId);
  } finally {
    await h.close();
  }
});
