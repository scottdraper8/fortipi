import assert from "node:assert/strict";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { harness, pause, setup } from "../agent/harness.ts";
import type { TestAgentSession } from "../agent/runtime-worker.js";

test("install storage charge covers actual Agent baseline and small-input/large-answer persistence", {
  timeout: 45000,
}, async () => {
  const h = await harness({ traffic: "free" });
  try {
    const { agent, conversation } = await setup(h);
    const probe = h.env.AGENT_SESSIONS.getByName(agent.agentId);
    const before = JSON.parse(await probe.storageReport()) as { bytes: number };
    const sent = await h.api<D.AdmissionReceipt>(
      `/v1/conversations/${conversation.conversationId}/messages`,
      { clientRequestId: crypto.randomUUID(), content: "large-answer", busyBehavior: "followUp" },
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
    const after = JSON.parse(await probe.storageReport()) as { bytes: number };
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
      }),
    );
    assert.ok(
      usage.body.reservedBytes + usage.body.observedBytes >= after.bytes,
      "An install-wide bound must cover actual total Agent SQLite storage, not only input/metadata estimates",
    );
  } finally {
    await h.close();
  }
});
