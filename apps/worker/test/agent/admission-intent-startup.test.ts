import assert from "node:assert/strict";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { eventually, harness, pause, setup } from "./harness.ts";

interface Identity {
  operationId: string;
  messageId: string;
  taskId: string;
}
interface Snapshot {
  repair: { id: string } | null;
  jobs: { id: string; fn: string }[];
  due: { kind: string; id: string }[];
  intents: (Identity & { key: string; growthBytes: number })[];
  admissions: (Identity & { receipt: D.AdmissionReceipt | null })[];
  claims: { operationId: string; bytes: number; reservationId?: string }[];
  pendingGrowth: number;
  events: (D.KnownDurableEvent & { source: string })[];
  modelCalls: number;
}

test("startup discovers a persisted input before its repair was scheduled", {
  timeout: 25000,
}, async () => {
  const h = await harness();
  let restore: (() => Promise<void>) | undefined;
  try {
    const { agent, conversation } = await setup(h);
    const probe = h.env.AGENT_SESSIONS.getByName(agent.agentId);
    restore = () => probe.setAdmissionSchedulingUnavailable(false);
    const snapshot = async () =>
      JSON.parse(await probe.admissionStartupSnapshotJson(conversation.conversationId)) as Snapshot;
    const idle = await eventually(snapshot, (s) => !s.repair && !s.jobs.length && !s.due.length);
    await probe.runAdmissionStartupDiscovery();
    const clean = await snapshot();
    assert.equal(clean.repair, null, "Idle startup must not create repair work");
    assert.deepEqual(clean.jobs, []);
    assert.deepEqual(clean.due, []);
    assert.equal(clean.modelCalls, 0);

    await probe.setAdmissionSchedulingUnavailable(true);
    const submitted = await h.api(`/v1/conversations/${conversation.conversationId}/messages`, {
      clientRequestId: crypto.randomUUID(),
      content: "persisted before scheduling",
      busyBehavior: "followUp",
    });
    assert.notEqual(submitted.status, 202, "The input was never acknowledged");
    const before = await snapshot();
    assert.equal(before.repair, null);
    assert.deepEqual(before.jobs, []);
    assert.equal(before.intents.length, 1);
    const original = before.intents[0];
    assert.ok(original);
    assert.deepEqual(before.due, [{ kind: "admission-intent", id: original.key }]);
    assert.equal(before.modelCalls, 0);
    assert.equal(before.pendingGrowth, idle.pendingGrowth + original.growthBytes);
    assert.equal(
      before.claims.filter((claim) => claim.operationId === original.operationId).length,
      1,
    );

    await restore();
    // Invoke the production startup hook. Only SQL inspection follows; no
    // client retry, projection-draining read, direct drain or manual alarm.
    await probe.runAdmissionStartupDiscovery();
    let recovered = await snapshot();
    const deadline = performance.now() + 6000;
    while (
      (!recovered.admissions[0]?.receipt ||
        !recovered.events.some(
          (event) => event.type === "task.completed" && event.taskId === original.taskId,
        )) &&
      performance.now() < deadline
    ) {
      await pause(20);
      recovered = await snapshot();
    }
    assert.equal(
      recovered.intents.length,
      0,
      "Startup left the persisted pre-arm input undiscovered",
    );
    assert.equal(recovered.admissions.length, 1);
    const admitted = recovered.admissions[0];
    assert.ok(admitted?.receipt);
    assert.deepEqual(
      {
        operationId: admitted.operationId,
        messageId: admitted.messageId,
        taskId: admitted.taskId,
      },
      {
        operationId: original.operationId,
        messageId: original.messageId,
        taskId: original.taskId,
      },
    );
    assert.equal(
      recovered.events.filter((event) => event.source === `admission:${original.operationId}`)
        .length,
      1,
    );
    assert.equal(
      recovered.events.filter(
        (event) => event.type === "task.queued" && event.taskId === original.taskId,
      ).length,
      1,
    );
    assert.equal(
      recovered.events.filter(
        (event) => event.type === "task.completed" && event.taskId === original.taskId,
      ).length,
      1,
    );
    assert.equal(recovered.modelCalls, 1);
    assert.equal(
      recovered.claims.filter((claim) => claim.operationId === original.operationId).length,
      1,
    );
  } finally {
    await restore?.();
    await h.close();
  }
});
