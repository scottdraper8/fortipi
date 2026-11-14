import assert from "node:assert/strict";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { eventually, harness, setup } from "../agent/harness.ts";
import type { TestAgentSession } from "../agent/runtime-worker.js";

interface StorageReport {
  bytes: number;
  objectBytes: number;
  headroomFraction: number;
}
test("observed total SQLite storage stops new admission while existing completion retains physical headroom", {
  timeout: 45000,
}, async () => {
  const h = await harness({ traffic: "free", events: 6 });
  try {
    const { agent, conversation } = await setup(h);
    const probe = h.env.AGENT_SESSIONS.getByName(agent.agentId);
    const path = `/v1/conversations/${conversation.conversationId}`;
    const input: D.MessageSubmit = {
      clientRequestId: crypto.randomUUID(),
      content: "hold-completion",
      busyBehavior: "followUp",
    };
    const accepted = await h.api<D.AdmissionReceipt>(`${path}/messages`, input);
    assert.equal(accepted.status, 202);
    let report = JSON.parse(await probe.storageReport()) as StorageReport;
    const initial = report.bytes;
    const ordinaryLimit = Math.floor(report.objectBytes * (1 - report.headroomFraction));
    // Test-only owned application rows create real physical SQLite pressure.
    // No private Pi SQL, per-job attribution, synthetic object bound or clock.
    for (let i = 0; i < 20 && report.bytes < ordinaryLimit; i++)
      report = JSON.parse(await probe.fillStorageHeadroom()) as StorageReport;
    assert.ok(report.bytes >= ordinaryLimit);
    assert.ok(report.bytes < report.objectBytes);
    const blocked = await h.api(`${path}/messages`, {
      ...input,
      clientRequestId: crypto.randomUUID(),
      content: "new-work",
    });
    assert.equal(blocked.status, 503, JSON.stringify(blocked.body));
    await probe.releaseCompletion();
    const inspection = await eventually(
      async () =>
        JSON.parse(await probe.inspectionJson(conversation.conversationId)) as Awaited<
          ReturnType<TestAgentSession["inspectConversation"]>
        >,
      (state) =>
        state.entries.some(
          (entry) => entry.kind === "pi.assistant" && entry.text === "answer:hold-completion",
        ),
    );
    assert.equal(inspection.entries.filter((entry) => entry.kind === "pi.user").length, 1);
    const retry = await h.api<D.AdmissionReceipt>(`${path}/messages`, input);
    assert.deepEqual(retry, accepted, "Pressure must retain the accepted receipt");
    const after = JSON.parse(await probe.storageReport()) as StorageReport;
    assert.ok(
      after.bytes < after.objectBytes,
      "Admitted completion must fit inside the real reserved storage headroom",
    );
    console.log(
      JSON.stringify({
        initialSqlBytes: initial,
        pressuredSqlBytes: report.bytes,
        completedSqlBytes: after.bytes,
        objectBytes: after.objectBytes,
        headroomFraction: after.headroomFraction,
      }),
    );
  } finally {
    await h.close();
  }
});
