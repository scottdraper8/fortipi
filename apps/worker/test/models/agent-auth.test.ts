import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { pause } from "../agent/harness.ts";
import { processHarness } from "../agent/process-harness.ts";

type Facts = {
  openai: { calls: number; authorized: boolean };
  anthropic: { calls: number; authorized: boolean };
};
const selections: D.ModelConfig[] = [
  {
    providerId: "openai",
    modelId: "gpt-5.4",
    auth: { kind: "secretRef", secretRef: "OPENAI_API_KEY" },
  },
  {
    providerId: "anthropic",
    modelId: "claude-opus-4-7",
    auth: { kind: "secretRef", secretRef: "ANTHROPIC_API_KEY" },
  },
];
const worker =
  process.env.FORTIPI_T5_AUTH_WORKER ?? resolve("apps/worker/test/models/agent-auth-worker.ts");
async function poll<T>(fn: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  let value = await fn();
  for (let i = 0; i < 180 && !accept(value); i++) {
    await pause(25);
    value = await fn();
  }
  return value;
}
test("first real AgentSession admission resolves synthetic bound credentials before any reopen", {
  timeout: 45000,
}, async () => {
  const h = await processHarness(worker);
  try {
    for (const model of selections) {
      const created = await h.api<D.Agent>("/v1/agents", {
        requestId: crypto.randomUUID(),
        name: "first-bound-auth",
        model,
      });
      assert.equal(created.status, 201);
      const agent = created.body.agentId,
        conversation = await h.api<D.Conversation>(`/v1/agents/${agent}/conversations`, {
          requestId: crypto.randomUUID(),
        });
      assert.equal(conversation.status, 201);
      const cid = conversation.body.conversationId;
      const sent = await h.api<D.AdmissionReceipt>(`/v1/conversations/${cid}/messages`, {
        clientRequestId: crypto.randomUUID(),
        content: "first admission",
        busyBehavior: "followUp",
      });
      assert.equal(sent.status, 202);
      const provider = model.providerId === "openai" ? "openai" : "anthropic";
      const facts = await poll(
        async () => (await h.api<Facts>(`/__models/${agent}/facts`)).body,
        (value) => value[provider].calls > 0,
      );
      console.log(
        JSON.stringify({
          provider,
          reachedProvider: facts[provider].calls > 0,
          correctBoundCredential: facts[provider].authorized,
        }),
      );
      assert.equal(
        facts[provider].authorized,
        true,
        "Actual Pi generation must resolve the factory credential store on first admission",
      );
      const task = await poll(
        async () => (await h.api<D.Task>(`/v1/tasks/${sent.body.taskId}`)).body,
        (value) => value.status.state === "completed",
      );
      assert.equal(task.status.state, "completed");
    }
  } finally {
    await h.close();
  }
});

test("cross-provider outstanding generation restores its own provider and credential after SIGKILL", {
  timeout: 45000,
}, async () => {
  const h = await processHarness(worker);
  try {
    const a = selections[0]!,
      b = selections[1]!;
    const created = await h.api<D.Agent>("/v1/agents", {
      requestId: crypto.randomUUID(),
      name: "cross-provider",
      model: a,
    });
    assert.equal(created.status, 201);
    const agent = created.body.agentId,
      oldConversation = await h.api<D.Conversation>(`/v1/agents/${agent}/conversations`, {
        requestId: crypto.randomUUID(),
      });
    assert.equal(oldConversation.status, 201);
    assert.equal((await h.api(`/__models/${agent}/hold`)).status, 200);
    const original: D.MessageSubmit = {
      clientRequestId: crypto.randomUUID(),
      content: "retain provider A across replacement",
      busyBehavior: "followUp",
    };
    const old = await h.api<D.AdmissionReceipt>(
      `/v1/conversations/${oldConversation.body.conversationId}/messages`,
      original,
    );
    assert.equal(old.status, 202);
    const before = await poll(
      async () => (await h.api<Facts>(`/__models/${agent}/facts`)).body,
      (value) => value.openai.calls > 0,
    );
    assert.equal(before.openai.authorized, true);
    const changed = await h.api<D.Agent>(
      `/v1/agents/${agent}`,
      { requestId: crypto.randomUUID(), expectedVersion: 1, model: b },
      "PATCH",
    );
    assert.equal(changed.status, 200);
    const nextConversation = await h.api<D.Conversation>(`/v1/agents/${agent}/conversations`, {
      requestId: crypto.randomUUID(),
    });
    assert.equal(nextConversation.status, 201);
    // Default Free admits one active run. Creating B installs its selection
    // without inventing a second active slot while the original A waits.
    assert.equal(
      (await h.api<{ committed: boolean }>(`/__models/${agent}/canary`, {}, "PUT")).body.committed,
      true,
    );
    await h.crash();
    await h.start();
    assert.equal(
      (await h.api<{ committed: boolean }>(`/__models/${agent}/canary`)).body.committed,
      true,
      "Actual persisted canary must survive",
    );
    await h.api(`/__models/${agent}/entries?cid=${oldConversation.body.conversationId}`);
    const after = await poll(
      async () => (await h.api<Facts>(`/__models/${agent}/facts`)).body,
      (value) => value.openai.calls > 0,
    );
    console.log(
      JSON.stringify({
        canarySurvived: true,
        oldProviderReached: after.openai.calls > 0,
        oldCredentialCorrect: after.openai.authorized,
      }),
    );
    assert.equal(
      after.openai.authorized,
      true,
      "Persisted outstanding A generation must retain A even while latest selection is B",
    );
    const oldTask = await poll(
      async () => (await h.api<D.Task>(`/v1/tasks/${old.body.taskId}`)).body,
      (value) => value.status.state === "completed",
    );
    assert.equal(oldTask.status.state, "completed");
    const next = await h.api<D.AdmissionReceipt>(
      `/v1/conversations/${nextConversation.body.conversationId}/messages`,
      { clientRequestId: crypto.randomUUID(), content: "new provider B", busyBehavior: "followUp" },
    );
    assert.equal(next.status, 202);
    const nextTask = await poll(
      async () => (await h.api<D.Task>(`/v1/tasks/${next.body.taskId}`)).body,
      (value) => value.status.state === "completed",
    );
    assert.equal(nextTask.status.state, "completed");
    const retry = await h.api<D.AdmissionReceipt>(
      `/v1/conversations/${oldConversation.body.conversationId}/messages`,
      original,
    );
    assert.equal(retry.status, 202);
    assert.deepEqual(retry.body, old.body);
  } finally {
    await h.close();
  }
});
