import assert from "node:assert/strict";
import { resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { eventually, pause } from "./harness.ts";
import { processHarness } from "./process-harness.ts";

interface State {
  barrier: string | null;
  creations: { conversationId: string; operationId: string; growthBytes: number }[];
  piIds: string[];
  copied: {
    conversationId: string;
    published: boolean;
    bookmark: string | null;
    messages: { id: string; characters: number }[];
  }[];
  growth: { claims: { operationId: string; bytes: number }[] };
}
test("SIGKILL after the actual fork prefix copy recovers one private child and original public messages", {
  timeout: 60000,
}, async (t) => {
  const h = await processHarness(
    process.env.FORTIPI_FORK_GROWTH_FAULT_WORKER ??
      resolve("apps/worker/test/agent/fork-growth-worker.ts"),
  );
  let phase = "create parent";
  try {
    const agent = await h.api<D.Agent>("/v1/agents", {
      requestId: crypto.randomUUID(),
      name: "fork-prefix-recovery",
      model: { providerId: "cloudflare", modelId: "@cf/zai-org/glm-5.3-flash" },
    });
    assert.equal(agent.status, 201);
    const created = await h.api<D.Conversation>(`/v1/agents/${agent.body.agentId}/conversations`, {
      requestId: crypto.randomUUID(),
    });
    assert.equal(created.status, 201);
    const cid = created.body.conversationId;
    const sent = await h.api<D.AdmissionReceipt>(`/v1/conversations/${cid}/messages`, {
      clientRequestId: crypto.randomUUID(),
      content: "large-answer",
      busyBehavior: "followUp",
    });
    assert.equal(sent.status, 202);
    // The original default12–20B faux progress shape stays unchanged. The known
    // strict Message-schema failure is separate from this storage crash oracle.
    phase = "complete original100KiB model answer";
    let parent = await h.api<D.ConversationProjection>(`/v1/conversations/${cid}`);
    const deadline = Date.now() + 30000;
    while (parent.body.conversation.taskState.state !== "completed" && Date.now() < deadline) {
      await pause(100);
      parent = await h.api<D.ConversationProjection>(`/v1/conversations/${cid}`);
    }
    assert.ok(
      parent.body.messages.some(
        (message) => message.role === "assistant" && message.content.length === 102400,
      ),
      JSON.stringify({
        taskState: parent.body.conversation.taskState,
        messages: parent.body.messages.map((message) => ({
          role: message.role,
          characters: message.content.length,
        })),
      }),
    );
    assert.equal(parent.body.conversation.taskState.state, "completed");
    phase = "inspect pre-fork state";
    const status = async () =>
      (await h.api<State>(`/__fork-growth/status?agent=${agent.body.agentId}`)).body;
    const before = await status();
    const probe = `/__test/agents/${agent.body.agentId}`;
    const canary = { nonce: crypto.randomUUID() };
    await h.api(`${probe}/canary`, canary, "PUT");
    await h.api(`${probe}/fault`, "fork-after-prefix-copy");
    const input: D.ForkInput = {
      requestId: crypto.randomUUID(),
      through: parent.body.lastEventSeq,
    };
    const path = `/v1/conversations/${cid}/fork`;
    const lost = h.api<D.Conversation>(path, input).catch(() => undefined);
    phase = "observe post-copy barrier";
    const held = await eventually(status, (value) => value.barrier === "fork-after-prefix-copy");
    const intent = held.creations.find(
      (row) => !before.creations.some((old) => old.operationId === row.operationId),
    );
    assert.ok(intent);
    const copied = held.copied.find((row) => row.conversationId === intent.conversationId);
    assert.ok(copied);
    assert.equal(copied.published, false);
    assert.ok(copied.bookmark);
    assert.deepEqual(
      copied.messages.map((row) => row.characters),
      [12, 102400],
    );
    assert.ok(held.growth.claims.some((row) => row.operationId === intent.operationId));
    assert.equal(held.piIds.length, before.piIds.length + 1);
    phase = "public unpublished-child read";
    const reads = Promise.all([
      h.api(`/v1/conversations/${intent.conversationId}`),
      h.api<D.ConversationProjection>(`/v1/conversations/${cid}`),
    ]).then(
      (value) => ({ kind: "ready" as const, value }),
      (error: unknown) => ({ kind: "failed" as const, error }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    let readResult: Awaited<typeof reads> | { kind: "held" };
    try {
      // Return WHILE the copy is held, not a latency/CPU claim. Both requests
      // are observed even if the generous liveness supervisor detects a hold.
      readResult = await Promise.race([
        reads,
        new Promise<{ kind: "held" }>((accept) => {
          timer = setTimeout(() => accept({ kind: "held" }), 2000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    assert.equal(
      readResult.kind,
      "ready",
      "Known/publication reads must return while creation remains held",
    );
    if (readResult.kind !== "ready") assert.fail("Reads queued behind unrelated creation repair");
    assert.equal(readResult.value[0].status, 404);
    const knownParent = readResult.value[1];
    assert.equal(knownParent.status, 200);
    assert.deepEqual(
      knownParent.body.messages,
      parent.body.messages,
      "A known projection may not queue behind the held creation repair",
    );
    phase = "SIGKILL/reopen";
    await h.crash();
    await lost;
    await h.start();
    assert.deepEqual((await h.api(`${probe}/canary`)).body, canary);
    phase = "recover original fork";
    const recovered = await h.api<D.Conversation>(path, input);
    assert.equal(recovered.status, 201, JSON.stringify(recovered.body));
    assert.equal(recovered.body.conversationId, intent.conversationId);
    const after = await status();
    assert.deepEqual(
      after.piIds,
      held.piIds,
      "Committed prefix recovery must not allocate/copy another Pi child",
    );
    const actual = await h.api<D.ConversationProjection>(
      `/v1/conversations/${intent.conversationId}`,
    );
    assert.equal(actual.status, 200);
    assert.deepEqual(
      actual.body.messages.map((row) => row.messageId),
      copied.messages.map((row) => row.id),
    );
    assert.deepEqual(
      actual.body.messages.map((row) => ({ role: row.role, content: row.content })),
      parent.body.messages.map((row) => ({ role: row.role, content: row.content })),
    );
    assert.equal(new Set(actual.body.messages.map((row) => row.messageId)).size, 2);
    const history = await h.api<{ users: number; bytes: number }>(
      `/__fork-growth/history?agent=${agent.body.agentId}&cid=${intent.conversationId}`,
    );
    assert.equal(history.body.users, 1);
    assert.ok(history.body.bytes > 102400);
    assert.deepEqual(await h.api(path, input), recovered);
    assert.equal((await h.api(path, { ...input, title: "changed" })).status, 409);
  } catch (error) {
    t.diagnostic(`Failed fork-copy phase: ${phase}`);
    throw error;
  } finally {
    await h.close();
  }
});
