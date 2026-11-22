import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import type { StorageSampleInput } from "../../src/boundary/infrastructure.js";
import { bootstrap, harness } from "./harness.ts";

test("Agent sampling orders real shared Pi/app writes, retains lost observations and rejects post-await floors", {
  timeout: 30000,
}, async () => {
  const main = process.env.FORTIPI_SAMPLE_ORACLE_WORKER;
  const h = await harness(main ? { main } : {});
  try {
    const created = await h.api<D.Agent>("/v1/agents", {
      requestId: crypto.randomUUID(),
      name: "physical-sample",
      model: { providerId: "cloudflare", modelId: "@cf/zai-org/glm-5.3-flash" },
    });
    assert.equal(created.status, 201);
    const agentId = created.body.agentId,
      control = h.env.CONTROL_PLANE.getByName("control");
    const authenticated = await control.authenticate({
      bearer: bootstrap,
      deploymentId: h.env.CONTROL_PLANE.idFromName("control").toString(),
      requestId: crypto.randomUUID(),
      deadline: Date.now() + 30000,
    });
    assert.equal(authenticated.ok, true);
    if (!authenticated.ok) assert.fail("Actual CP authentication failed");
    const auth = authenticated.value;
    const registered = await control.registerAuthorityRecipient(auth, {
      credential: {
        credentialId: auth.credentialId,
        generation: auth.generation,
        grantVersion: auth.grantVersion,
      },
      recipient: { kind: "agent", id: agentId },
      resources: {
        agentIds: [agentId],
        conversationIds: [],
        workspaceIds: [],
        executorIds: [],
        backendIds: [],
        tools: [],
        actions: ["conversations.create"],
      },
    });
    assert.equal(registered.ok, true);
    if (!registered.ok) assert.fail("Actual CP registration failed");
    auth.registrationId = registered.value.registrationId;
    await h.env.AGENT_SESSIONS.getByName(agentId).physicalSample(auth);
    const capacity = await control.reserveCapacity(auth, {
      ownerId: agentId,
      operationId: crypto.randomUUID(),
      policyVersion: 1,
      bytes: 4096,
      admissionSlots: 0,
    });
    assert.equal(capacity.ok, true);
    if (!capacity.ok) assert.fail("Actual CP capacity failed");
    const settled = await control.settleCapacity(auth, {
      reservationId: capacity.value.reservationId,
      disposition: "consumed",
    });
    assert.equal(settled.ok, true);
    if (!settled.ok) assert.fail("Actual CP settlement failed");
    assert.equal(settled.value.state, "settled");
    const probe = h.env.AGENT_SESSIONS.getByName(agentId);
    const result = JSON.parse(await probe.sampleOracle(auth, capacity.value.reservationId)) as {
      disposition: string;
      lostRetainsClaim: boolean;
      replayed: boolean;
      covered: boolean;
      beforeReport: number;
      first: StorageSampleInput;
      newer: StorageSampleInput;
      malformed: boolean;
      malformedRetainsUnacknowledged: boolean;
      revoked: boolean;
      revokedRetainsUnacknowledged: boolean;
    };
    assert.equal(result.disposition, "lost-response");
    assert.equal(result.lostRetainsClaim, true);
    assert.equal(result.replayed, true, "Lost-response retry must retain ID/sequence/bytes/time");
    assert.equal(result.first.coverage.kind, "agent");
    assert.ok(result.first.coverage.bytes >= result.beforeReport);
    assert.deepEqual(result.first.coveredReservationIds, [capacity.value.reservationId]);
    assert.equal(result.covered, true);
    assert.notEqual(result.newer.sampleId, result.first.sampleId);
    assert.equal(result.newer.sampleSeq, result.first.sampleSeq + 1);
    assert.ok(result.newer.coverage.bytes > result.first.coverage.bytes);
    assert.deepEqual(result.newer.coveredReservationIds, []);
    assert.equal(result.malformed, true);
    assert.equal(result.malformedRetainsUnacknowledged, true);
    assert.equal(result.revoked, true);
    assert.equal(result.revokedRetainsUnacknowledged, true);
  } finally {
    await h.close();
  }
});
