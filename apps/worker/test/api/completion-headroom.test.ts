import assert from "node:assert/strict";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { eventually, harness, setup } from "../agent/harness.ts";

test("Free principal pressure preserves admitted completion, receipt and reserved settlement headroom", async () => {
  const h = await harness({ traffic: "free" });
  let agentId = "";
  try {
    const { agent, conversation } = await setup(h);
    agentId = agent.agentId;
    const input: D.MessageSubmit = {
      clientRequestId: crypto.randomUUID(),
      content: "hold-completion",
      busyBehavior: "followUp",
    };
    const first = await h.api<D.AdmissionReceipt>(
      `/v1/conversations/${conversation.conversationId}/messages`,
      input,
    );
    assert.equal(first.status, 202);
    const probe = h.env.AGENT_SESSIONS.getByName(agent.agentId);
    const before = await probe.inspectConversation(conversation.conversationId);
    assert.equal(
      before.entries.some((entry) => entry.kind === "pi.assistant"),
      false,
      "Model completion must still be held",
    );
    let pressure: D.ErrorBody | undefined,
      publicRequests = 3;
    for (let i = 0; i < 31; i++) {
      const response = await h.api<D.ErrorBody>("/v1/admin/health");
      publicRequests++;
      if (response.status === 429) {
        pressure = response.body;
        break;
      }
      assert.equal(response.status, 200);
    }
    assert.ok(pressure);
    assert.equal(pressure.error.code, "rate_limited");
    await probe.releaseCompletion();
    const completed = await eventually(
      () => probe.inspectConversation(conversation.conversationId),
      (value) =>
        value.entries.some(
          (entry) => entry.kind === "pi.assistant" && entry.text === "answer:hold-completion",
        ),
    );
    assert.equal(completed.entries.filter((entry) => entry.kind === "pi.user").length, 1);
    const progress = await probe.runRepair();
    const admission = (await probe.admissionStatus())[0];
    assert.ok(admission);
    assert.deepEqual(
      admission.receipt,
      first.body,
      "Pressure must preserve the original durable admission receipt",
    );
    const reservationState = await h.env.CONTROL_PLANE.getByName("control").reservationState(
      admission.reservationId,
    );
    console.log(
      JSON.stringify({
        publicRequests,
        pressure: pressure.error.code,
        admissionState: admission.state,
        reservationState,
        repair: progress,
        actualControlCalls: await h.env.CONTROL_PLANE.getByName("control").ingressCounts(),
      }),
    );
    assert.equal(
      reservationState,
      "settled",
      "An already reserved completion must not be stranded by new-ingress metering",
    );
  } finally {
    if (agentId) await h.env.AGENT_SESSIONS.getByName(agentId).releaseCompletion();
    await h.close();
  }
});
