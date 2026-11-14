import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { eventually } from "./harness.ts";
import { processHarness } from "./process-harness.ts";

interface Trace {
  local: {
    barrier: string | null;
    retainedMetadata: { exportId: string; sha256: string; size: number; createdAt: number }[];
    works: { operationId: string; capacity?: D.CapacityReservation }[];
    growth: { claims: { operationId: string; reservationId?: string }[] };
  };
  control: { reservation: D.CapacityReservation; disposition?: string; covered: boolean }[];
}
test("SIGKILL after immutable Agent export bytes and lost consumed ACK recovers the same public export and measured claim", {
  timeout: 60000,
}, async () => {
  const h = await processHarness(resolve("apps/worker/test/agent/export-growth-worker.ts"));
  try {
    const agent = await h.api<D.Agent>("/v1/agents", {
      requestId: crypto.randomUUID(),
      name: "export-recovery",
      model: { providerId: "cloudflare", modelId: "@cf/zai-org/glm-5.3-flash" },
    });
    assert.equal(agent.status, 201);
    const created = await h.api<D.Conversation>(`/v1/agents/${agent.body.agentId}/conversations`, {
      requestId: crypto.randomUUID(),
    });
    assert.equal(created.status, 201);
    const cid = created.body.conversationId;
    assert.equal(
      (
        await h.api(`/v1/conversations/${cid}/messages`, {
          clientRequestId: crypto.randomUUID(),
          content: "before-export-cut",
          busyBehavior: "followUp",
        })
      ).status,
      202,
    );
    await eventually(
      () => h.api<D.ConversationProjection>(`/v1/conversations/${cid}`),
      (value) =>
        value.body.messages.some((message) => message.content === "answer:before-export-cut"),
    );
    const resources: D.ResourceScope = {
      agentIds: [agent.body.agentId],
      conversationIds: [cid],
      workspaceIds: [],
      executorIds: [],
      backendIds: [],
      tools: [],
      actions: [],
    };
    const issue = async (actions: string[]) => {
      const receipt = await h.api<D.CredentialReceipt>("/v1/admin/credentials", {
        requestId: crypto.randomUUID(),
        role: "admin",
        grants: [
          { grantId: crypto.randomUUID(), version: 1, resources: { ...resources, actions } },
        ],
      });
      assert.equal(receipt.status, 201);
      if (receipt.body.state !== "issued")
        assert.fail("Actual scoped synthetic credential required");
      return receipt.body.token;
    };
    const creator = await issue(["exports.create"]),
      reader = await issue(["operations.read", "artifacts.read"]);
    const probe = `/__test/agents/${agent.body.agentId}`;
    const canary = { nonce: crypto.randomUUID() };
    await h.api(`${probe}/canary`, canary, "PUT");
    await h.api(`${probe}/fault`, "export-after-ready");
    await h.api("/__export-growth/mode?mode=settlement");
    const input: D.ExportInput = { requestId: crypto.randomUUID(), resources, maxBytes: 1048576 };
    const accepted = await h.api<D.AdminOperation>("/v1/admin/exports", input, "POST", creator);
    assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
    let operationId = "";
    const trace = async () =>
      (
        await h.api<Trace>(
          `/__export-growth/trace?agent=${agent.body.agentId}&cid=${cid}${operationId ? `&operation=${operationId}` : ""}`,
        )
      ).body;
    const held = await eventually(
      trace,
      (value) =>
        value.local.barrier === "export-after-ready" &&
        value.control[0]?.disposition === "consumed",
    );
    const work = held.local.works[0],
      retained = held.local.retainedMetadata[0];
    assert.ok(work?.capacity);
    assert.ok(retained && retained.size > 0);
    operationId = work.operationId;
    assert.equal(held.control[0]?.reservation.reservationId, work.capacity.reservationId);
    assert.equal(work.capacity.admissionSlots, 0);
    assert.equal(held.control[0]?.covered, false);
    assert.ok(held.local.growth.claims.some((claim) => claim.operationId === operationId));
    await h.crash();
    await h.start();
    assert.deepEqual((await h.api(`${probe}/canary`)).body, canary);
    const view = await eventually(
      () =>
        h.api<D.AdminOperation>(
          `/v1/admin/operations/${accepted.body.operationId}`,
          undefined,
          "GET",
          reader,
        ),
      (value) => ["completed", "failed", "unavailable"].includes(value.body.state),
    );
    assert.equal(view.body.state, "completed", JSON.stringify(view.body));
    assert.equal(view.body.artifacts.length, 1);
    const artifact = view.body.artifacts[0];
    assert.ok(artifact);
    assert.equal(artifact.scope.kind, "agent");
    assert.equal(artifact.sha256, retained.sha256);
    assert.equal(artifact.size, retained.size);
    const repaired = await eventually(trace, (value) => value.local.works.length === 0);
    assert.deepEqual(repaired.local.retainedMetadata, held.local.retainedMetadata);
    assert.equal(repaired.control[0]?.covered, false);
    assert.ok(
      repaired.local.growth.claims.some((claim) => claim.operationId === operationId),
      "Actual consumed ACK alone cannot retire export P",
    );
    assert.equal(
      (
        await h.api(`/v1/conversations/${cid}/messages`, {
          clientRequestId: crypto.randomUUID(),
          content: "after-export-cut",
          busyBehavior: "followUp",
        })
      ).status,
      202,
    );
    const sampled = await trace();
    assert.equal(
      sampled.local.growth.claims.some((claim) => claim.operationId === operationId),
      false,
    );
    assert.equal(sampled.control[0]?.covered, true);
    const downloaded = await fetch(`${h.origin}${artifact.endpoint}`, {
      headers: { Authorization: `Bearer ${reader}` },
    });
    assert.equal(downloaded.status, 200);
    const bytes = new Uint8Array(await downloaded.arrayBuffer());
    assert.equal(bytes.byteLength, retained.size);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), retained.sha256);
    const text = new TextDecoder().decode(bytes);
    assert.ok(text.includes("before-export-cut"));
    assert.equal(text.includes("after-export-cut"), false);
  } finally {
    await h.close();
  }
});
