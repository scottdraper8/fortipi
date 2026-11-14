import assert from "node:assert/strict";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { eventually, harness, setup } from "./harness.ts";
import type { TestAgentSession } from "./runtime-worker.js";

test("a Free admitted four-round near-envelope response retains completion and receipt headroom under real SQLite pressure", {
  timeout: 60000,
}, async () => {
  // An explicitly ample faux context isolates infrastructure growth from
  // compaction/summarizer behavior; all byte/event/time/turn/Free caps stay fixed.
  const h = await harness({ traffic: "free", modelChunkBytes: 256, largeModelContext: true });
  try {
    const { agent, conversation } = await setup(h),
      probe = h.env.AGENT_SESSIONS.getByName(agent.agentId),
      path = `/v1/conversations/${conversation.conversationId}`;
    await probe.queueNearLimitRounds();
    const input: D.MessageSubmit = {
      clientRequestId: crypto.randomUUID(),
      content: "hold-completion",
      busyBehavior: "followUp",
    };
    const accepted = await h.api<D.AdmissionReceipt>(`${path}/messages`, input);
    assert.equal(accepted.status, 202);
    let physical = JSON.parse(await probe.storageReport()) as {
      bytes: number;
      objectBytes: number;
      headroomFraction: number;
    };
    const admissionLine = Math.floor(physical.objectBytes * (1 - physical.headroomFraction));
    for (let i = 0; i < 20 && physical.bytes < admissionLine; i++)
      physical = JSON.parse(await probe.fillStorageHeadroom()) as typeof physical;
    assert.ok(physical.bytes >= admissionLine);
    assert.ok(physical.bytes < physical.objectBytes);
    await probe.releaseCompletion();
    const completed = await eventually(
      async () =>
        JSON.parse(await probe.runPolicy(conversation.conversationId)) as {
          calls: number;
          records: { status: string; reason?: string }[];
        },
      (value) => value.records.some((record) => record.status === "unanswered"),
    );
    assert.equal(completed.calls, 4, JSON.stringify(completed));
    assert.equal(completed.records[0]?.reason, "turn_limit");
    const actual = JSON.parse(await probe.inspectionJson(conversation.conversationId)) as Awaited<
      ReturnType<TestAgentSession["inspectConversation"]>
    >;
    const answers = actual.entries.filter((entry) => entry.kind === "pi.assistant");
    assert.equal(answers.length, 4);
    assert.ok(
      answers.every((entry) => entry.assistantBytes > 195000 && entry.assistantBytes <= 262144),
    );
    assert.ok(
      answers.every(
        (entry) => entry.toolArgumentBytes >= 65000 && entry.toolArgumentBytes <= 65536,
      ),
    );
    assert.ok(
      answers.every(
        (entry) =>
          entry.assistantBytes + entry.toolArgumentBytes > 260000 &&
          entry.assistantBytes + entry.toolArgumentBytes <= 262144,
      ),
    );
    assert.equal(actual.entries.filter((entry) => entry.kind === "pi.user").length, 1);
    assert.equal((await probe.toolState(conversation.conversationId)).jobs.length, 0);
    await probe.runRepair();
    const blocked = await h.api<D.ErrorBody>(`${path}/messages`, {
      ...input,
      clientRequestId: crypto.randomUUID(),
      content: "new growth",
    });
    assert.equal(blocked.status, 503, JSON.stringify(blocked.body));
    assert.equal(blocked.body.error.code, "quota_paused");
    assert.deepEqual(await h.api(`${path}/messages`, input), accepted);
    const after = JSON.parse(await probe.storageReport()) as typeof physical;
    assert.ok(after.bytes < after.objectBytes);
    console.log(
      JSON.stringify({
        pressuredSqlBytes: physical.bytes,
        completedSqlBytes: after.bytes,
        admittedRounds: 4,
        maximumAssistantBytes: Math.max(...answers.map((entry) => entry.assistantBytes)),
        maximumArgumentBytes: Math.max(...answers.map((entry) => entry.toolArgumentBytes)),
        actualProcessStarts: 0,
        originalReceiptRetained: true,
      }),
    );
  } finally {
    await h.close();
  }
});
