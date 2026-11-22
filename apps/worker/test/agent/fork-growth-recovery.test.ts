import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { eventually } from "./harness.ts";
import { processHarness } from "./process-harness.ts";

interface State {
  barrier: string | null;
  creations: {
    conversationId: string;
    operationId: string;
    growthBytes: number;
    hasModel: boolean;
  }[];
  piIds: string[];
  growth: { claims: { operationId: string; bytes: number }[] };
}
test("real SIGKILL preserves creation-before-model and fork-after-capacity identities, claims and one Pi copy", {
  timeout: 60000,
}, async () => {
  const h = await processHarness(resolve("apps/worker/test/agent/fork-growth-worker.ts"));
  try {
    const agent = await h.api<D.Agent>("/v1/agents", {
      requestId: crypto.randomUUID(),
      name: "fork-recovery",
      model: { providerId: "cloudflare", modelId: "@cf/zai-org/glm-5.3-flash" },
    });
    assert.equal(agent.status, 201);
    const probe = `/__test/agents/${agent.body.agentId}`;
    const status = async () =>
      (await h.api<State>(`/__fork-growth/status?agent=${agent.body.agentId}`)).body;
    const canary = { nonce: crypto.randomUUID() };
    await h.api(`${probe}/canary`, canary, "PUT");
    let parent: D.Conversation | undefined;
    for (const point of ["creation-before-model", "creation-after-capacity"] as const) {
      const before = await status();
      const input = {
        requestId: crypto.randomUUID(),
        title: point,
        ...(parent
          ? {
              through: (
                await h.api<D.ConversationProjection>(`/v1/conversations/${parent.conversationId}`)
              ).body.lastEventSeq,
            }
          : {}),
      };
      const path = parent
        ? `/v1/conversations/${parent.conversationId}/fork`
        : `/v1/agents/${agent.body.agentId}/conversations`;
      await h.api(`${probe}/fault`, point);
      const lost = h.api(path, input).catch(() => undefined);
      const held = await eventually(status, (value) => value.barrier === point);
      const intent = held.creations.find(
        (row) => !before.creations.some((old) => old.operationId === row.operationId),
      );
      assert.ok(intent, "Stable creation identity must exist before the asynchronous phase");
      assert.ok(intent.growthBytes > 0);
      assert.equal(
        held.growth.claims.find((row) => row.operationId === intent.operationId)?.bytes,
        intent.growthBytes,
      );
      assert.equal(intent.hasModel, point !== "creation-before-model");
      assert.deepEqual(
        held.piIds,
        before.piIds,
        "No new Pi conversation before the actual capacity reply",
      );
      await h.crash();
      await lost;
      await h.start();
      assert.deepEqual((await h.api(`${probe}/canary`)).body, canary);
      const recovered = await h.api<D.Conversation>(path, input);
      assert.equal(recovered.status, 201, JSON.stringify(recovered.body));
      assert.equal(recovered.body.conversationId, intent.conversationId);
      const after = await status();
      assert.equal(after.piIds.length, before.piIds.length + 1);
      assert.equal(
        after.creations.find((row) => row.conversationId === intent.conversationId)?.operationId,
        intent.operationId,
      );
      assert.deepEqual(await h.api(path, input), recovered);
      assert.equal((await h.api(path, { ...input, title: "changed" })).status, 409);
      if (!parent) {
        parent = recovered.body;
        const currentParent = parent;
        const sent = await h.api(`/v1/conversations/${parent.conversationId}/messages`, {
          clientRequestId: crypto.randomUUID(),
          content: "single copied prefix",
          busyBehavior: "followUp",
        });
        assert.equal(sent.status, 202);
        await eventually(
          () =>
            h.api<D.ConversationProjection>(`/v1/conversations/${currentParent.conversationId}`),
          (value) => value.body.conversation.taskState.state === "completed",
        );
      } else {
        const copied = await h.api<{ users: number }>(
          `/__fork-growth/history?agent=${agent.body.agentId}&cid=${recovered.body.conversationId}`,
        );
        assert.equal(copied.body.users, 1);
      }
    }
  } finally {
    await h.close();
  }
});
