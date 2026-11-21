import assert from "node:assert/strict";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { eventually, harness, setup } from "./harness.ts";

test("actual idle rejections reclaim only CP-unused acknowledged and physically sampled growth before another admission", async () => {
  const h = await harness();
  try {
    const { agent, conversation } = await setup(h),
      probe = h.env.AGENT_SESSIONS.getByName(agent.agentId),
      path = `/v1/conversations/${conversation.conversationId}`;
    for (let i = 0; i < 4; i++) {
      const input: D.SteerInput = { clientRequestId: `idle-${i}`, content: "unadmitted steering" };
      const rejected = await h.api<D.ErrorBody>(`${path}/steer`, input);
      assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
      assert.equal(rejected.body.error.message, "Conversation is idle");
      const growth = await probe.growthReport();
      assert.equal(growth.pending, 0);
      assert.equal(growth.claims.length, 0);
      assert.ok(growth.rejections.every((row) => row.acknowledged && row.reclaimed));
      const changed = await h.api(`${path}/steer`, { ...input, content: "changed" });
      assert.equal(changed.status, 409);
    }
    const sent = await h.api<D.AdmissionReceipt>(`${path}/messages`, {
      clientRequestId: "after-idle-rejections",
      content: "hold-completion",
      busyBehavior: "followUp",
    });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    const held = await probe.growthReport();
    assert.equal(held.claims.length, 1);
    assert.ok(held.pending >= 33554432);
    assert.equal(held.claims[0]?.operationId, sent.body.operationId);
    assert.ok(held.claims[0]?.reservationId);
    await probe.releaseCompletion();
    await eventually(
      async () => {
        await probe.runRepair();
        return (await probe.admissionStatus()).find(
          (row) => row.receipt?.operationId === sent.body.operationId,
        );
      },
      (row) => row?.state === "settled",
    );
    assert.ok(
      (await probe.growthReport()).pending >= 33554432,
      "A consumed ACK alone cannot clear prospective growth before measurement",
    );
    const next = await h.api(`${path}/messages`, {
      clientRequestId: "new-measured-admission",
      content: "next",
      busyBehavior: "followUp",
    });
    assert.equal(next.status, 202, JSON.stringify(next.body));
    const after = await probe.growthReport();
    assert.equal(after.claims.length, 1);
    assert.notEqual(after.claims[0]?.operationId, sent.body.operationId);
  } finally {
    await h.close();
  }
});
