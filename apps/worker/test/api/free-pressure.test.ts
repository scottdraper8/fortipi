import assert from "node:assert/strict";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { harness, setup } from "../agent/harness.ts";

test("unchanged Free ingress bound permits a six-request one-message flow", async () => {
  const h = await harness({ traffic: "free" });
  try {
    const { conversation } = await setup(h);
    const path = `/v1/conversations/${conversation.conversationId}`;
    const input: D.MessageSubmit = {
      clientRequestId: crypto.randomUUID(),
      content: "free-policy-oracle",
      busyBehavior: "followUp",
    };
    const first = await h.api<D.AdmissionReceipt>(`${path}/messages`, input);
    const snapshot = await h.api<D.ConversationProjection>(path);
    const retry = await h.api<D.AdmissionReceipt>(`${path}/messages`, input);
    const changed = await h.api(`${path}/messages`, { ...input, content: "changed" });
    const counts = await h.env.CONTROL_PLANE.getByName("control").ingressCounts();
    console.log(
      JSON.stringify({
        publicRequests: 6,
        statuses: [201, 201, first.status, snapshot.status, retry.status, changed.status],
        actualControlCalls: counts,
      }),
    );
    assert.equal(first.status, 202);
    assert.equal(snapshot.status, 200);
    assert.equal(retry.status, 202);
    assert.deepEqual(retry.body, first.body);
    assert.equal(
      changed.status,
      409,
      "A logical request below the ingress bound must reach the idempotency conflict oracle",
    );
  } finally {
    await h.close();
  }
});
