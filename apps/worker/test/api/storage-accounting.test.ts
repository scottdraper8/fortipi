import assert from "node:assert/strict";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import type {
  StorageSampleInput,
  StorageSampleReceipt,
} from "../../src/boundary/infrastructure.js";
import { eventually, harness, pause, setup } from "../agent/harness.ts";
import type { TestAgentSession } from "../agent/runtime-worker.js";

test("install storage charge covers actual Agent baseline and small-input/large-answer persistence", {
  timeout: 45000,
}, async () => {
  const h = await harness({ traffic: "free" });
  try {
    const { agent, conversation } = await setup(h);
    const probe = h.env.AGENT_SESSIONS.getByName(agent.agentId);
    const before = JSON.parse(await probe.storageReport()) as { bytes: number };
    const resources: D.ResourceScope = {
      agentIds: [agent.agentId],
      conversationIds: [conversation.conversationId],
      workspaceIds: [],
      executorIds: [],
      backendIds: [],
      tools: [],
      actions: ["messages.submit"],
    };
    const minted = await h.api<D.CredentialReceipt>("/v1/admin/credentials", {
      requestId: crypto.randomUUID(),
      role: "client",
      grants: [{ grantId: crypto.randomUUID(), version: 1, resources }],
    });
    assert.equal(minted.status, 201);
    if (minted.body.state !== "issued") assert.fail("Synthetic scoped client required");
    const token = minted.body.token;
    const input: D.MessageSubmit = {
      clientRequestId: crypto.randomUUID(),
      content: "large-answer",
      busyBehavior: "followUp",
    };
    const sent = await h.api<D.AdmissionReceipt>(
      `/v1/conversations/${conversation.conversationId}/messages`,
      input,
      "POST",
      token,
    );
    assert.equal(sent.status, 202);
    let actual: Awaited<ReturnType<TestAgentSession["inspectConversation"]>> | undefined;
    for (let i = 0; i < 400; i++) {
      actual = JSON.parse(await probe.inspectionJson(conversation.conversationId)) as typeof actual;
      if (
        actual?.entries.some(
          (entry) => entry.kind === "pi.assistant" && entry.text.length === 102400,
        )
      )
        break;
      await pause(75);
    }
    assert.ok(
      actual?.entries.some(
        (entry) => entry.kind === "pi.assistant" && entry.text.length === 102400,
      ),
      "Actual100KiB final answer must commit before measuring",
    );
    assert.ok(actual);
    assert.equal(actual.entries.filter((entry) => entry.kind === "pi.user").length, 1);
    await eventually(
      async () => {
        await probe.runRepair();
        return (await probe.admissionStatus())[0];
      },
      (value) => value?.state === "settled",
    );
    const after = JSON.parse(await probe.storageReport()) as { bytes: number };
    const cp = h.env.CONTROL_PLANE.getByName("control");
    // A genuine next public admission must sample the completed large answer
    // BEFORE its new capacity reservation; no test-only sampling call here.
    const followUp = await h.api<D.AdmissionReceipt>(
      `/v1/conversations/${conversation.conversationId}/messages`,
      { clientRequestId: crypto.randomUUID(), content: "next", busyBehavior: "followUp" },
      "POST",
      token,
    );
    assert.equal(followUp.status, 202, JSON.stringify(followUp.body));
    const sampled = JSON.parse(await probe.lastPhysicalSample()) as {
      input: StorageSampleInput;
      receipt: StorageSampleReceipt;
    };
    assert.ok(sampled.input.coverage.bytes >= after.bytes);
    assert.equal(sampled.receipt.sampleSeq, sampled.input.sampleSeq);
    const allocation = await cp.physicalAllocation("agent", agent.agentId);
    assert.equal(allocation.allocation?.measured, sampled.input.coverage.bytes);
    assert.equal(allocation.allocation?.sequence, sampled.input.sampleSeq);
    const admission = (await probe.admissionStatus()).find(
      (row) => row.receipt?.operationId === sent.body.operationId,
    );
    assert.ok(admission);
    assert.ok(sampled.input.coveredReservationIds.includes(admission.reservationId));
    assert.equal(await cp.reservationState(admission.reservationId), "settled");
    const usage = await h.api<D.Usage>("/v1/admin/usage");
    assert.equal(usage.status, 200);
    console.log(
      JSON.stringify({
        inputBytes: new TextEncoder().encode("large-answer").length,
        actualAnswerBytes: 102400,
        baselineSqlBytes: before.bytes,
        currentTotalSqlBytes: after.bytes,
        reservedInstallBytes: usage.body.reservedBytes,
        observedInstallBytes: usage.body.observedBytes,
        sampledAgentBytes: sampled.input.coverage.bytes,
        actualControlBytes: allocation.controlBytes,
        retainedEstimatedAgentFloor: allocation.allocation?.estimate,
      }),
    );
    assert.ok(
      usage.body.reservedBytes + usage.body.observedBytes >= after.bytes,
      "An install-wide bound must cover actual total Agent SQLite storage, not only input/metadata estimates",
    );
    assert.ok(usage.body.observedBytes >= sampled.input.coverage.bytes + allocation.controlBytes);
    const retry = await h.api<D.AdmissionReceipt>(
      `/v1/conversations/${conversation.conversationId}/messages`,
      input,
      "POST",
      token,
    );
    assert.deepEqual(retry, sent);
  } finally {
    await h.close();
  }
});
