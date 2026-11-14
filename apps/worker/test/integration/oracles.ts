import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type * as D from "../../src/boundary/dto.js";
import { provision } from "./fixture-state.ts";
import { poll, type Runtime, type RuntimeOptions, start } from "./runtime.ts";

interface State {
  barrier: string | null;
  admissions: {
    operationId: string;
    messageId: string;
    taskId: string;
    receipt: D.AdmissionReceipt | null;
  }[];
}
export async function admissionRecovery(supplied?: Runtime): Promise<Record<string, unknown>> {
  const runtime = supplied ?? (await start());
  try {
    const fixture = await provision(runtime);
    const probe = `/__test/agents/${fixture.agent.agentId}`;
    const canary = { seed: 1010, nonce: randomUUID() };
    assert.deepEqual((await runtime.api(`${probe}/canary`, canary, "PUT")).body, canary);
    await runtime.stopAbruptly();
    await runtime.reopenSameStorage();
    assert.deepEqual(
      (await runtime.api(`${probe}/canary`)).body,
      canary,
      "Committed canary must survive actual SIGKILL and same-storage reopen",
    );
    const cid = fixture.conversations[0]!.conversationId;
    const path = `/v1/conversations/${cid}/messages`;
    const points: string[] = [];
    for (const point of ["before-submit", "after-submit"]) {
      const input = {
        clientRequestId: randomUUID(),
        content: `seed1010-${point}`,
        busyBehavior: "followUp",
      };
      const previous = (await runtime.api<State>(`${probe}/barrier`)).body.admissions.map(
        (a) => a.operationId,
      );
      assert.equal((await runtime.api(`${probe}/fault`, point)).status, 200);
      const lost = runtime.api(path, input, "POST", fixture.client.token).catch(() => undefined);
      await runtime.barrier(fixture.agent.agentId, point);
      const before = (await runtime.api<State>(`${probe}/barrier`)).body;
      const identity = before.admissions.find((a) => !previous.includes(a.operationId));
      assert.ok(identity);
      assert.equal(identity.receipt, null);
      await runtime.stopAbruptly();
      await lost;
      await runtime.reopenSameStorage();
      const accepted = await runtime.api<D.AdmissionReceipt>(
        path,
        input,
        "POST",
        fixture.client.token,
      );
      assert.equal(accepted.status, 202);
      assert.equal(accepted.body.operationId, identity.operationId);
      assert.equal(accepted.body.messageId, identity.messageId);
      assert.equal(accepted.body.taskId, identity.taskId);
      const projection = await poll(
        async () =>
          (
            await runtime.api<D.ConversationProjection>(
              `/v1/conversations/${cid}`,
              undefined,
              "GET",
              fixture.client.token,
            )
          ).body,
        (s) => s.messages?.some((m) => m.content === `answer:${input.content}`),
      );
      assert.equal(
        projection.messages.filter((m) => m.role === "user" && m.content === input.content).length,
        1,
      );
      const actualPi = (
        await runtime.api<{ entries: { kind: string; text: string }[] }>(
          `${probe}/inspect?cid=${cid}`,
        )
      ).body;
      assert.equal(
        actualPi.entries.filter((e) => e.kind === "pi.user" && e.text === input.content).length,
        1,
        "Stable admission must leave one actual Pi input after runtime death",
      );
      const duplicates = await Promise.all([
        runtime.api(path, input, "POST", fixture.client.token),
        runtime.api(path, input, "POST", fixture.client.token),
      ]);
      for (const repeat of duplicates) assert.deepEqual(repeat, accepted);
      const changed = await runtime.api(
        path,
        { ...input, content: "changed-stable-identity" },
        "POST",
        fixture.client.token,
      );
      assert.equal(changed.status, 409, "Changed input under an accepted key must conflict");
      points.push(point);
    }
    return {
      canarySurvived: true,
      sameStorage: true,
      actualWorkerdKilled: true,
      barriers: points,
      actualPiInputsPerIntent: 1,
      identicalConcurrentReceipts: true,
      changedPayloadStatus: 409,
    };
  } finally {
    if (!supplied) await runtime.dispose();
  }
}
export async function lifecycleRecovery(): Promise<Record<string, unknown>> {
  const runtime = await start();
  try {
    const fixture = await provision(runtime);
    const cid = fixture.conversations[0]!.conversationId;
    const admitted = await runtime.api<D.AdmissionReceipt>(
      `/v1/conversations/${cid}/messages`,
      {
        clientRequestId: randomUUID(),
        content: "hold-completion",
        busyBehavior: "followUp",
      },
      "POST",
      fixture.client.token,
    );
    assert.equal(admitted.status, 202);
    const task = () =>
      runtime.api<D.Task>(
        `/v1/tasks/${admitted.body.taskId}`,
        undefined,
        "GET",
        fixture.client.token,
      );
    await poll(
      async () => (await task()).body,
      (t) => t.status.state === "running",
    );
    await runtime.stopAbruptly();
    await runtime.reopenSameStorage();
    assert.equal(
      (await runtime.api(`/__integration/release-completion/${fixture.agent.agentId}`, {})).status,
      200,
    );
    const terminal = await poll(
      async () => (await task()).body,
      (t) => t.status.state === "completed",
    );
    assert.equal(terminal.taskId, admitted.body.taskId);
    const projection = (
      await runtime.api<D.ConversationProjection>(
        `/v1/conversations/${cid}`,
        undefined,
        "GET",
        fixture.client.token,
      )
    ).body;
    assert.equal(
      projection.messages.filter((m) => m.role === "user" && m.content === "hold-completion")
        .length,
      1,
    );
    assert.ok(
      projection.messages.some(
        (m) => m.role === "assistant" && m.content === "answer:hold-completion",
      ),
    );
    return {
      realPiLifecycle: true,
      durableRunningTaskBeforeKill: true,
      sameTaskAfterReopen: true,
      actualTaskId: terminal.taskId,
      inputCount: 1,
      terminal: terminal.status.state,
      explicitResumeOrPrivateSql: false,
    };
  } finally {
    await runtime.dispose();
  }
}
export async function concurrentAdmissionBoundary(
  options: RuntimeOptions = {},
): Promise<Record<string, unknown>> {
  const runtime = await start(options);
  try {
    const fixture = await provision(runtime);
    const intents = fixture.conversations.map((conversation) => ({
      cid: conversation.conversationId,
      body: { clientRequestId: randomUUID(), content: "hold-completion", busyBehavior: "reject" },
    }));
    const send = (i: number) =>
      runtime.api<D.AdmissionReceipt | D.ErrorBody>(
        `/v1/conversations/${intents[i]!.cid}/messages`,
        intents[i]!.body,
        "POST",
        fixture.client.token,
      );
    const results = await Promise.all([send(0), send(1)]);
    assert.equal(
      results.filter((r) => r.status === 202).length,
      1,
      "Two concurrent requests competing for the final Free slot must admit exactly one",
    );
    const accepted = results.findIndex((r) => r.status === 202),
      rejected = 1 - accepted;
    assert.equal(results[rejected]!.status, 429);
    const denied = results[rejected]!.body as D.ErrorBody;
    assert.equal(denied.error.code, "quota_exceeded");
    const pressure =
      denied.error.details && "pressure" in denied.error.details
        ? denied.error.details.pressure
        : undefined;
    assert.ok(pressure);
    assert.equal(pressure.resource, "concurrency");
    assert.equal(pressure.limit, 1);
    assert.equal(pressure.remaining, 0);
    const inspect = async (i: number) =>
      (
        await runtime.api<{ entries: { kind: string }[] }>(
          `/__test/agents/${fixture.agent.agentId}/inspect?cid=${intents[i]!.cid}`,
        )
      ).body;
    assert.equal(
      (await inspect(rejected)).entries.filter((e) => e.kind === "pi.user").length,
      0,
      "Rejected final-slot contender must create no actual Pi input",
    );
    assert.deepEqual(await send(accepted), results[accepted]);
    await runtime.api(`/__integration/release-completion/${fixture.agent.agentId}`, {});
    const first = results[accepted]!.body as D.AdmissionReceipt;
    await poll(
      async () =>
        (
          await runtime.api<D.Task>(
            `/v1/tasks/${first.taskId}`,
            undefined,
            "GET",
            fixture.client.token,
          )
        ).body,
      (task) => task.status.state === "completed",
    );
    const restored = await poll(
      async () => send(rejected),
      (r) => r.status === 202,
    );
    assert.equal(
      restored.status,
      202,
      "Original refused identity must become admissible after physical work settles",
    );
    assert.equal((await inspect(rejected)).entries.filter((e) => e.kind === "pi.user").length, 1);
    return {
      contenders: 2,
      finalSlots: 1,
      acceptedBeforeRelease: 1,
      rejectedBeforeRelease: 1,
      rejectedPiInputs: 0,
      duplicatePreservedReceipt: true,
      sameRefusedKeyAdmittedAfterSettlement: true,
      pressure: {
        resource: pressure.resource,
        limit: pressure.limit,
        remaining: pressure.remaining,
      },
      syntheticTrafficHeadroom: true,
      actualFreeAccountExhaustion: false,
    };
  } finally {
    await runtime.dispose();
  }
}
