import assert from "node:assert/strict";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { harness, setup } from "../agent/harness.ts";

test("registered Agent export storage growth uses its exact logical administrator grant without hidden capacity actions", async () => {
  const h = await harness();
  try {
    const { agent } = await setup(h),
      control = h.env.CONTROL_PLANE.getByName("control");
    const resources: D.ResourceScope = {
      agentIds: [agent.agentId],
      conversationIds: [],
      workspaceIds: [],
      executorIds: [],
      backendIds: [],
      tools: [],
      actions: ["exports.create"],
    };
    const issued = await h.api<D.CredentialReceipt>("/v1/admin/credentials", {
      requestId: crypto.randomUUID(),
      role: "admin",
      grants: [{ grantId: crypto.randomUUID(), version: 1, resources }],
    });
    assert.equal(issued.status, 201);
    if (issued.body.state !== "issued") assert.fail("Actual scoped synthetic credential required");
    const authenticated = await control.authenticate({
      bearer: issued.body.token,
      deploymentId: h.env.CONTROL_PLANE.idFromName("control").toString(),
      requestId: crypto.randomUUID(),
      deadline: Date.now() + 30000,
    });
    if (!authenticated.ok) assert.fail("Actual export authentication required");
    const auth = authenticated.value;
    const registered = await control.registerAuthorityRecipient(auth, {
      credential: {
        credentialId: auth.credentialId,
        generation: auth.generation,
        grantVersion: auth.grantVersion,
      },
      recipient: { kind: "agent", id: agent.agentId },
      resources,
    });
    if (!registered.ok) assert.fail("Actual Agent registration required");
    auth.registrationId = registered.value.registrationId;
    await h.env.AGENT_SESSIONS.getByName(agent.agentId).physicalSample(
      auth,
      undefined,
      "exports.create",
    );
    const result = await control.reserveCapacity(auth, {
      operationId: crypto.randomUUID(),
      ownerId: agent.agentId,
      policyVersion: 1,
      bytes: 65536,
      admissionSlots: 0,
    });
    assert.equal(
      result.ok,
      true,
      result.ok
        ? ""
        : JSON.stringify({
            code: result.code,
            message: result.message,
            resources,
            ownerId: agent.agentId,
            admissionSlots: 0,
          }),
    );
  } finally {
    await h.close();
  }
});
