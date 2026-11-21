import assert from "node:assert/strict";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { eventually, harness } from "../agent/harness.ts";
import type { TestAgentSession } from "../agent/runtime-worker.js";

test("ordinary explicit application grants admit and settle without private capacity actions", async () => {
  const h = await harness({ traffic: "free" });
  try {
    const agent = await h.api<D.Agent>("/v1/agents", {
      requestId: crypto.randomUUID(),
      name: "least-privilege",
      model: { providerId: "cloudflare", modelId: "@cf/zai-org/glm-5.3-flash" },
    });
    assert.equal(agent.status, 201);
    const mint = async (conversationIds: string[], actions: string[]) => {
      const grant: D.Grant = {
        grantId: crypto.randomUUID(),
        version: 1,
        resources: {
          agentIds: [agent.body.agentId],
          conversationIds,
          workspaceIds: [],
          executorIds: [],
          backendIds: [],
          tools: [],
          actions,
        },
      };
      const result = await h.api<D.CredentialReceipt>("/v1/admin/credentials", {
        requestId: crypto.randomUUID(),
        role: "client",
        grants: [grant],
      });
      assert.equal(result.status, 201);
      assert.equal(result.body.state, "issued");
      if (result.body.state !== "issued") assert.fail("Expected new synthetic credential");
      return result.body.token;
    };
    // Creation needs no wildcard conversation grant. A later submit credential
    // names the returned conversation explicitly, without broadening either actor.
    const creator = await mint([], ["conversations.create"]);
    const created = await h.api<D.Conversation>(
      `/v1/agents/${agent.body.agentId}/conversations`,
      { requestId: crypto.randomUUID(), title: "explicit" },
      "POST",
      creator,
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const sender = await mint(
      [created.body.conversationId],
      ["messages.submit", "conversations.read"],
    );
    const submitted = await h.api<D.AdmissionReceipt>(
      `/v1/conversations/${created.body.conversationId}/messages`,
      { clientRequestId: crypto.randomUUID(), content: "ordinary-grant", busyBehavior: "followUp" },
      "POST",
      sender,
    );
    assert.equal(submitted.status, 202, JSON.stringify(submitted.body));
    const probe = h.env.AGENT_SESSIONS.getByName(agent.body.agentId);
    await eventually(
      async () =>
        JSON.parse(await probe.inspectionJson(created.body.conversationId)) as Awaited<
          ReturnType<TestAgentSession["inspectConversation"]>
        >,
      (value) =>
        value.entries.some(
          (entry) => entry.kind === "pi.assistant" && entry.text === "answer:ordinary-grant",
        ),
    );
    await probe.runRepair();
    const admission = (await probe.admissionStatus())[0];
    assert.ok(admission);
    assert.deepEqual(admission.receipt, submitted.body);
    const state = await h.env.CONTROL_PLANE.getByName("control").reservationState(
      admission.reservationId,
    );
    assert.equal(
      state,
      "settled",
      "Original ordinary app identity must be allowed to settle its registered reservation",
    );
  } finally {
    await h.close();
  }
});
