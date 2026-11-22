import assert from "node:assert/strict";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { harness } from "../agent/harness.ts";

const auth: D.AuthContext = {
  credentialId: "credential",
  generation: 2,
  grantVersion: 3,
  principalId: "principal",
  role: "client",
  deploymentId: "deployment",
  requestId: "request",
  authenticatedAt: Date.now() - 1000,
  credentialExpiresAt: Date.now() + 60000,
  deadline: Date.now() + 30000,
  registrationId: "registration",
  grants: [
    {
      grantId: "create-only",
      version: 3,
      resources: {
        agentIds: ["agent"],
        conversationIds: [],
        workspaceIds: [],
        executorIds: [],
        backendIds: [],
        tools: [],
        actions: ["conversations.create"],
      },
    },
  ],
};
test("selected-model consumer preserves canonical authority and complete actual config", async () => {
  const selection: D.ModelConfig = {
    providerId: "openai",
    modelId: "gpt-6",
    endpoint: "https://api.openai.com/v1",
    auth: { kind: "oauth", providerId: "openai" },
  };
  const h = await harness();
  try {
    const probe = h.env.AGENT_SESSIONS.getByName("selection-probe");
    const result = JSON.parse(
      await probe.modelSelectionProbeJson(
        JSON.stringify({ auth, body: JSON.stringify(selection), status: 200 }),
      ),
    ) as { model: D.ModelConfig; calls: number; canonical: boolean };
    assert.deepEqual(result, { model: selection, calls: 1, canonical: true });
  } finally {
    await h.close();
  }
});
test("selected-model consumer fails closed for denied, invalid and oversized authority responses", async () => {
  const h = await harness();
  try {
    const probe = h.env.AGENT_SESSIONS.getByName("selection-negative");
    for (const response of [
      { status: 403, body: "denied" },
      {
        status: 200,
        body: JSON.stringify({
          providerId: "cloudflare",
          modelId: "model",
          apiKey: "unadvertised-field",
        }),
      },
      { status: 200, body: JSON.stringify({ padding: "x".repeat(65536) }) },
    ])
      await assert.rejects(probe.modelSelectionProbeJson(JSON.stringify({ auth, ...response })));
  } finally {
    await h.close();
  }
});
