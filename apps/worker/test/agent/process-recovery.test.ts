import assert from "node:assert/strict";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { eventually } from "./harness.ts";
import { processCueMatches, processHarness, processRequestFailure } from "./process-harness.ts";

interface ProbeState {
  barrier: string | null;
  admissions: {
    operationId: string;
    messageId: string;
    taskId: string;
    receipt: D.AdmissionReceipt | null;
  }[];
  creations: { conversationId: string }[];
  piIds: string[];
}
test("SIGKILL/reopen preserves canary, allocation provenance and stable accepted input", {
  timeout: 90000,
}, async (t) => {
  let phase = "initial.start";
  const failure = (error: unknown): never => {
    const diagnostic: {
      phase: string;
      kind: string;
      code: string | null;
      location: string | null;
    } = {
      phase,
      kind: "unknown",
      code: null,
      location: null,
    };
    try {
      diagnostic.kind =
        error instanceof assert.AssertionError
          ? "assertion"
          : error instanceof Error
            ? "error"
            : "non-error";
      if (error !== null && typeof error === "object") {
        const code = Object.getOwnPropertyDescriptor(error, "code")?.value;
        if (
          typeof code === "string" &&
          [
            "ERR_ASSERTION",
            "ECONNRESET",
            "ECONNREFUSED",
            "ETIMEDOUT",
            "ABORT_ERR",
            "ERR_TEST_FAILURE",
          ].includes(code)
        )
          diagnostic.code = code;
        const stack = Object.getOwnPropertyDescriptor(error, "stack")?.value;
        const frame =
          typeof stack === "string"
            ? /[\\/]((?:process-(?:recovery\.test|harness)|harness)\.ts):(\d{1,6}):(\d{1,6})/.exec(
                stack.slice(0, 4096),
              )
            : null;
        if (frame) diagnostic.location = `${frame[1]}:${frame[2]}:${frame[3]}`;
      }
      t.diagnostic(
        JSON.stringify({ ...diagnostic, request: processRequestFailure(error) ?? null }),
      );
    } catch {
      /* Diagnostics must not replace the original thrown value. */
    }
    throw error;
  };
  const h = await processHarness().catch(failure);
  try {
    phase = "agent.create";
    const agent = await h.api<D.Agent>("/v1/agents", {
      requestId: crypto.randomUUID(),
      name: "process",
      model: { providerId: "cloudflare", modelId: "@cf/zai-org/glm-5.3-flash" },
    });
    assert.equal(agent.status, 201, JSON.stringify(agent.body));
    const probe = `/__test/agents/${agent.body.agentId}`;
    const canary = { nonce: crypto.randomUUID() };
    phase = "canary.write";
    assert.deepEqual((await h.api(`${probe}/canary`, canary, "PUT")).body, canary);
    phase = "canary.crash";
    await h.crash();
    phase = "canary.restart";
    await h.start();
    phase = "canary.read";
    assert.deepEqual(
      (await h.api(`${probe}/canary`)).body,
      canary,
      "Committed data must survive a real ungraceful process death before recovery claims",
    );
    phase = "allocation.initial";
    const initialPiIds = (await h.api<ProbeState>(`${probe}/state`)).body.piIds;
    const creation = { requestId: crypto.randomUUID(), title: "killed allocation" };
    phase = "allocation.arm";
    await h.api(`${probe}/fault`, "after-create");
    const lostCreate = h
      .api(`/v1/agents/${agent.body.agentId}/conversations`, creation)
      .catch(() => undefined);
    phase = "allocation.wait";
    const allocated = await eventually(
      async () => (await h.api<ProbeState>(`${probe}/state`)).body,
      (s) => s.barrier === "after-create",
    );
    assert.equal(allocated.piIds.length, initialPiIds.length + 1);
    assert.equal(allocated.creations.length, 1);
    phase = "allocation.crash";
    await h.crash();
    await lostCreate;
    phase = "allocation.restart";
    await h.start();
    phase = "allocation.retry";
    const conversation = await h.api<D.Conversation>(
      `/v1/agents/${agent.body.agentId}/conversations`,
      creation,
    );
    assert.equal(conversation.status, 201, JSON.stringify(conversation.body));
    assert.equal(conversation.body.conversationId, allocated.creations[0]!.conversationId);
    assert.deepEqual(
      (await h.api<ProbeState>(`${probe}/state`)).body.piIds,
      allocated.piIds,
      "Lost allocation response must not allocate a second Pi conversation",
    );
    for (const point of ["before-submit", "after-submit"] as const) {
      phase = `${point}.arm`;
      const input = {
        clientRequestId: crypto.randomUUID(),
        content: point,
        busyBehavior: "followUp",
      };
      const previous = (await h.api<ProbeState>(`${probe}/state`)).body.admissions.map(
        (a) => a.operationId,
      );
      const observation = await h.armBarrier(agent.body.agentId, point);
      const lost = h
        .api(`/v1/conversations/${conversation.body.conversationId}/messages`, input)
        .catch(() => undefined);
      phase = `${point}.wait`;
      await eventually(async () => observation.cue(), Boolean);
      phase = `${point}.crash`;
      await h.crash();
      await lost;
      phase = `${point}.restart`;
      await h.start();
      const before = await h.readWitness(observation.arm);
      const identity = before.admissions.find((a) => !previous.includes(a.operationId));
      assert.ok(identity);
      assert.equal(identity.receipt, null);
      phase = `${point}.retry`;
      const accepted = await h.api<D.AdmissionReceipt>(
        `/v1/conversations/${conversation.body.conversationId}/messages`,
        input,
      );
      assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
      assert.equal(accepted.body.operationId, identity.operationId);
      assert.equal(accepted.body.messageId, identity.messageId);
      assert.equal(accepted.body.taskId, identity.taskId);
      phase = `${point}.complete`;
      const completed = await eventually(
        async () =>
          (
            await h.api<D.ConversationProjection>(
              `/v1/conversations/${conversation.body.conversationId}`,
            )
          ).body,
        (s) => s.messages?.some((m) => m.content === `answer:${point}`),
      );
      assert.equal(
        completed.messages.filter((m) => m.role === "user" && m.content === point).length,
        1,
      );
      phase = `${point}.inspect`;
      const entries = (
        await h.api<{ entries: { kind: string; text: string }[] }>(
          `${probe}/inspect?cid=${conversation.body.conversationId}`,
        )
      ).body.entries;
      assert.equal(
        entries.filter((e) => e.kind === "pi.user" && e.text === point).length,
        1,
        "Count actual Pi input entries, not only deduplicated public projections",
      );
      phase = `${point}.repeat`;
      const repeat = await h.api<D.AdmissionReceipt>(
        `/v1/conversations/${conversation.body.conversationId}/messages`,
        input,
      );
      assert.deepEqual(repeat, accepted);
    }
  } catch (error) {
    failure(error);
  } finally {
    phase = "cleanup";
    await h.close().catch(failure);
  }
});

test("premature cues from held or rejected marker transactions cannot become historical proof", {
  timeout: 90000,
}, async () => {
  for (const fault of ["hold", "reject"] as const) {
    const h = await processHarness();
    try {
      const agent = await h.api<D.Agent>("/v1/agents", {
        requestId: crypto.randomUUID(),
        name: "negative-marker",
        model: { providerId: "cloudflare", modelId: "@cf/zai-org/glm-5.3-flash" },
      });
      assert.equal(agent.status, 201);
      const probe = `/__test/agents/${agent.body.agentId}`;
      const conversation = await h.api<D.Conversation>(
        `/v1/agents/${agent.body.agentId}/conversations`,
        { requestId: crypto.randomUUID(), title: "marker rejection" },
      );
      assert.equal(conversation.status, 201);
      const canary = { nonce: crypto.randomUUID() };
      await h.api(`${probe}/canary`, canary, "PUT");
      const observation = await h.armBarrier(agent.body.agentId, "before-submit", fault);
      const input = {
        clientRequestId: crypto.randomUUID(),
        content: fault,
        busyBehavior: "followUp",
      };
      const lost = h
        .api(`/v1/conversations/${conversation.body.conversationId}/messages`, input)
        .catch(() => undefined);
      await eventually(async () => observation.cue(), Boolean);
      assert.equal(observation.cue(), false, "A cue is consumed once");
      await h.crash();
      await lost;
      await h.start();
      assert.equal(observation.cue(), false, "An old child pipe cannot cue its replacement");
      assert.deepEqual((await h.api(`${probe}/canary`)).body, canary);
      await assert.rejects(h.readWitness(observation.arm), /Missing committed historical marker/);
      assert.equal(
        (
          await h.api(`${probe}/fault`, {
            runId: observation.arm.runId,
            armId: observation.arm.armId,
            point: observation.arm.point,
          })
        ).status,
        409,
        "Replaying the old arm cannot refresh its generation",
      );
      const accepted = await h.api<D.AdmissionReceipt>(
        `/v1/conversations/${conversation.body.conversationId}/messages`,
        input,
      );
      assert.equal(accepted.status, 202);
      await eventually(
        async () =>
          (
            await h.api<D.ConversationProjection>(
              `/v1/conversations/${conversation.body.conversationId}`,
            )
          ).body,
        (s) => s.messages?.some((m) => m.content === `answer:${fault}`),
      );
      // Actual late submission/recovery has run in the replacement generation.
      // A read must still neither manufacture nor repair the rolled-back witness.
      await assert.rejects(h.readWitness(observation.arm), /Missing committed historical marker/);
      assert.deepEqual((await h.api(`${probe}/canary`)).body, canary);
    } finally {
      await h.close();
    }
  }
});

test("kill cues match only the exact run, agent, phase, arm and actor generation; no storage proof", () => {
  const arm = {
    runId: crypto.randomUUID(),
    agentId: "agent-local",
    point: "before-submit" as const,
    armId: crypto.randomUUID(),
    generation: crypto.randomUUID(),
  };
  const cue = `FORTIPI_PROCESS_CUE ${JSON.stringify(arm)}`;
  assert.equal(processCueMatches(cue, arm), true);
  for (const key of ["runId", "agentId", "point", "armId", "generation"] as const)
    assert.equal(processCueMatches(cue, { ...arm, [key]: "foreign" }), false);
  assert.equal(processCueMatches(`${cue} synthetic-private-canary`, arm), false);
  assert.equal(
    processCueMatches(
      `FORTIPI_PROCESS_CUE {"runId":"synthetic-private-canary",${JSON.stringify(arm).slice(1)}`,
      arm,
    ),
    false,
  );
  assert.equal(
    processCueMatches(
      `FORTIPI_PROCESS_CUE ${JSON.stringify({ ...arm, private: "synthetic-private-canary" })}`,
      arm,
    ),
    false,
  );
});
