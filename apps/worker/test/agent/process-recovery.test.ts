import assert from "node:assert/strict";
import test from "node:test";
import { sourceTestDiagnostic } from "../../../../scripts/source-test-processes.ts";
import type * as D from "../../src/boundary/dto.js";
import { eventually } from "./harness.ts";
import {
  createProcessBarrierObserver,
  processHarness,
  processRequestFailure,
  processStageDiagnostic,
} from "./process-harness.ts";

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
  let runtimeStages: (() => string[]) | undefined;
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
      for (const record of runtimeStages?.() ?? []) t.diagnostic(record);
    } catch {
      /* Diagnostics must not replace the original thrown value. */
    }
    throw error;
  };
  const h = await processHarness().catch(failure);
  runtimeStages = h.runtimeStages;
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
      const before = await eventually(
        async () => observation.snapshot(),
        (s) => s.barrier === point,
      );
      const identity = before.admissions.find((a) => !previous.includes(a.operationId));
      assert.ok(identity);
      assert.equal(identity.receipt, null);
      phase = `${point}.crash`;
      await h.crash();
      await lost;
      phase = `${point}.restart`;
      await h.start();
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

test("recovery stage diagnostics reconstruct only closed nonsecret enums", () => {
  const line = "FORTIPI_PROCESS_STAGE after-submit marker-committed";
  const record = processStageDiagnostic(line);
  assert.equal(
    record,
    '{"diagnostic":"source-recovery-stage","point":"after-submit","stage":"marker-committed"}',
  );
  assert.ok(record && sourceTestDiagnostic(`# ${record}`));
  for (const stage of ["notify-status-204", "notify-status-409", "notify-throw-type"]) {
    const status = processStageDiagnostic(line.replace("marker-committed", stage));
    assert.ok(status && sourceTestDiagnostic(`# ${status}`));
  }
  for (const changed of [
    `${line} synthetic-private-canary`,
    `synthetic-private-canary ${line}`,
    line.replace("after-submit", "synthetic-private-canary"),
    line.replace("marker-committed", "synthetic-private-canary"),
    line.replace("marker-committed", "notify-status-099"),
    line.replace("marker-committed", "notify-status-600"),
    line.replace("marker-committed", "notify-throw-synthetic-private-canary"),
  ])
    assert.equal(processStageDiagnostic(changed), undefined);
  for (const changed of [
    `# ${record} synthetic-private-canary`,
    `# ${record?.replace('"point":', '"private":"synthetic-private-canary","point":')}`,
    `# ${record?.replace('"point":', '"point":"synthetic-private-canary","point":')}`,
    `# ${record?.replace("marker-committed", "synthetic-private-canary")}`,
  ])
    assert.equal(sourceTestDiagnostic(changed), false);
});

test("loopback barrier notifications require the current run, agent, phase and one-use arm; no storage proof", async () => {
  const observer = await createProcessBarrierObserver();
  const foreign = await createProcessBarrierObserver();
  const send = async (body: string, token = observer.token) => {
    try {
      const response = await fetch(observer.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(20000),
      });
      assert.equal(await response.text(), "");
      return response.status;
    } catch (error) {
      if (error instanceof TypeError) return 0;
      throw error;
    }
  };
  try {
    const arm = observer.arm("agent-local", "before-submit");
    const notice = {
      observationId: arm.observationId,
      agentId: arm.agentId,
      barrier: arm.point,
      admissions: [],
    };
    assert.equal(await send(JSON.stringify(notice), foreign.token), 403);
    assert.ok(observer.diagnostics().some((line) => line.includes('"receiver-headers-refused"')));
    for (const changed of [
      { ...notice, agentId: "foreign-agent" },
      { ...notice, barrier: "after-submit" },
    ])
      assert.equal(await send(JSON.stringify(changed)), 409);
    assert.ok(observer.diagnostics().some((line) => line.includes('"receiver-binding-refused"')));
    assert.equal(
      await send(JSON.stringify({ ...notice, rawBody: "synthetic-private-canary" })),
      400,
    );
    assert.equal(
      await send(`{"observationId":"synthetic-private-canary",${JSON.stringify(notice).slice(1)}`),
      400,
    );
    assert.notEqual(await send("x".repeat(65537)), 204);
    assert.ok(
      observer.diagnostics().some((line) => line.includes('"receiver-validation-refused"')),
    );
    assert.ok(observer.diagnostics().some((line) => line.includes('"receiver-body-refused"')));
    assert.ok(observer.diagnostics().length <= 64);
    assert.ok(observer.diagnostics().every((line) => sourceTestDiagnostic(`# ${line}`)));
    assert.ok(observer.diagnostics().every((line) => !line.includes("synthetic-private-canary")));
    assert.deepEqual(observer.snapshot(arm), { barrier: null, admissions: [] });
    const current = observer.arm(arm.agentId, "after-submit");
    assert.equal(observer.diagnostics().length, 1);
    assert.equal(await send(JSON.stringify(notice)), 409);
    assert.throws(() => observer.snapshot(arm));
    const row = {
      operationId: "operation",
      messageId: "message",
      taskId: "task",
      receipt: {
        operationId: "operation",
        messageId: "message",
        taskId: "task",
        revision: "revision",
        eventSeq: 1,
      },
    };
    const accepted = {
      ...notice,
      observationId: current.observationId,
      barrier: current.point,
      admissions: [row],
    };
    assert.equal(
      await send(
        JSON.stringify({
          ...accepted,
          admissions: [{ ...row, receipt: { ...row.receipt, revision: 0 } }],
        }),
      ),
      400,
    );
    assert.equal(await send(JSON.stringify(accepted)), 204);
    assert.ok(observer.diagnostics().some((line) => line.includes('"receiver-204-emitted"')));
    assert.deepEqual(observer.snapshot(current), { barrier: current.point, admissions: [row] });
    assert.equal(await send(JSON.stringify(accepted)), 409);
    observer.invalidate();
    assert.deepEqual(observer.diagnostics(), []);
    assert.equal(await send(JSON.stringify(accepted)), 409);
  } finally {
    await observer.close();
    await observer.close();
    await foreign.close();
  }
});
