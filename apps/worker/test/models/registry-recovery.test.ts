import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { pause } from "../agent/harness.ts";
import { processHarness } from "../agent/process-harness.ts";

const openai: D.ModelConfig = {
  providerId: "openai",
  modelId: "gpt-5.4",
  auth: { kind: "secretRef", secretRef: "OPENAI_API_KEY" },
};
const anthropic: D.ModelConfig = {
  providerId: "anthropic",
  modelId: "claude-opus-4-7",
  auth: { kind: "secretRef", secretRef: "ANTHROPIC_API_KEY" },
};
const oauth: D.ModelConfig = {
  providerId: "openai",
  modelId: "gpt-5.4",
  auth: { kind: "oauth", providerId: "openai" },
};
type Facts = {
  openai: { calls: number; apiKeyCalls: number; oauthCalls: number };
  anthropic: { calls: number; authorized: boolean };
};
type State = {
  settled: boolean;
  selectedAuth: string | null;
  expiredAfterCommit: boolean;
  openaiBindingPresent: boolean;
  ready: boolean;
  missingBoundCredential?: boolean;
};
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "fortipi-registry-")),
    entry = join(directory, "worker.ts"),
    source = JSON.stringify(
      process.env.FORTIPI_T5_AUTH_WORKER ?? resolve("apps/worker/test/models/agent-auth-worker.ts"),
    );
  async function bindings(omitOpenai: boolean) {
    await writeFile(
      entry,
      `${omitOpenai ? `import { omitOpenaiBinding } from ${source}; omitOpenaiBinding();\n` : ""}export * from ${source};\nexport { default } from ${source};\n`,
    );
  }
  await bindings(false);
  const h = await processHarness(entry);
  return {
    ...h,
    bindings,
    close: async () => {
      await h.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function poll<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let i = 0; i < 180 && !accept(value); i++) {
    await pause(25);
    value = await read();
  }
  return value;
}
async function create(h: Fixture, model: D.ModelConfig) {
  const response = await h.api<D.Agent>("/v1/agents", {
    requestId: crypto.randomUUID(),
    name: "registry-recovery",
    model,
  });
  assert.equal(response.status, 201);
  return response.body.agentId;
}
async function conversation(h: Fixture, agent: string) {
  const response = await h.api<D.Conversation>(`/v1/agents/${agent}/conversations`, {
    requestId: crypto.randomUUID(),
  });
  assert.equal(response.status, 201);
  return response.body.conversationId;
}
async function complete(h: Fixture, agent: string, cid: string) {
  const sent = await h.api<D.AdmissionReceipt>(`/v1/conversations/${cid}/messages`, {
    clientRequestId: crypto.randomUUID(),
    content: "verify bound authentication",
    busyBehavior: "followUp",
  });
  assert.equal(sent.status, 202);
  const task = await poll(
    async () => (await h.api<D.Task>(`/v1/tasks/${sent.body.taskId}`)).body,
    (value) => value.status.state === "completed",
  );
  assert.equal(task.status.state, "completed");
  const state = await poll(
    async () => (await h.api<State>(`/__models/${agent}/state`)).body,
    (value) => value.settled,
  );
  assert.equal(state.settled, true, "Old provider work must actually finish and settle");
}
async function select(h: Fixture, agent: string, model: D.ModelConfig) {
  assert.equal(
    (
      await h.api(
        `/v1/agents/${agent}`,
        {
          requestId: crypto.randomUUID(),
          expectedVersion: 1,
          model,
        },
        "PATCH",
      )
    ).status,
    200,
  );
}

test("postcommit authority rejection cannot leave same-model API-key auth after OAuth retry", {
  timeout: 45000,
}, async () => {
  const h = await fixture();
  try {
    const agent = await create(h, openai),
      cid = await conversation(h, agent);
    await complete(h, agent, cid);
    const initial = (await h.api<Facts>(`/__models/${agent}/facts`)).body;
    assert.equal(initial.openai.apiKeyCalls, 1);
    assert.equal(
      (
        await h.api(
          "/v1/admin/models/openai/auth",
          {
            requestId: crypto.randomUUID(),
            expectedVersion: null,
            credential: {
              type: "oauth",
              access: "synthetic-registry-oauth-access",
              refresh: "synthetic-registry-oauth-refresh",
              expires: Date.now() + 3600000,
              providerFields: {
                clientId: "synthetic-client",
                scopes: ["chatgpt.tokens.use.direct"],
              },
            },
          },
          "PUT",
        )
      ).status,
      200,
    );
    await select(h, agent, oauth);
    await h.api(`/__models/${agent}/expire-final-selection`);
    const retry = { requestId: crypto.randomUUID() },
      path = `/v1/agents/${agent}/conversations`;
    const rejected = await h.api(path, retry);
    assert.equal(rejected.status, 403, "Real Authority must reject the expired final check");
    const persisted = (await h.api<State>(`/__models/${agent}/state`)).body;
    assert.equal(persisted.selectedAuth, "oauth");
    assert.equal(persisted.expiredAfterCommit, true);
    const accepted = await h.api<D.Conversation>(path, retry);
    assert.equal(accepted.status, 201);
    await complete(h, agent, accepted.body.conversationId);
    const facts = (await h.api<Facts>(`/__models/${agent}/facts`)).body;
    const proof = {
      selectionCommitted: persisted.selectedAuth === "oauth",
      finalAuthorityRejected: persisted.expiredAfterCommit,
      oauthUsed: facts.openai.oauthCalls > 0,
      staleApiKeyReused: facts.openai.apiKeyCalls > initial.openai.apiKeyCalls,
    };
    console.log(JSON.stringify(proof));
    assert.equal(proof.oauthUsed, true, "Valid retry must use committed OAuth authentication");
    assert.equal(proof.staleApiKeyReused, false, "Retired API-key registry must never be reused");
  } finally {
    await h.close();
  }
});

test("finished historical provider with removed optional binding cannot veto current-provider reopen", {
  timeout: 45000,
}, async () => {
  const h = await fixture();
  try {
    const agent = await create(h, openai),
      old = await conversation(h, agent);
    await complete(h, agent, old);
    await select(h, agent, anthropic);
    const next = await conversation(h, agent);
    await complete(h, agent, next);
    await h.api(`/__models/${agent}/canary`, {}, "PUT");
    await h.crash();
    await h.bindings(true);
    await h.start();
    const state = await h.api<State>(`/__models/${agent}/state`);
    const proof = {
      currentProviderReady: state.status === 200 && state.body.ready === true,
      missingBoundCredential: state.body.missingBoundCredential === true,
    };
    console.log(JSON.stringify(proof));
    assert.equal(
      proof.currentProviderReady,
      true,
      "Unused provider credential must not veto Lifecycle startup",
    );
    assert.equal(state.body.openaiBindingPresent, false);
    assert.equal(
      (await h.api<{ committed: boolean }>(`/__models/${agent}/canary`)).body.committed,
      true,
    );
    await complete(h, agent, next);
    const facts = (await h.api<Facts>(`/__models/${agent}/facts`)).body;
    assert.equal(facts.openai.calls, 0, "Inactive provider must not be invoked on reopen");
    assert.equal(facts.anthropic.authorized, true);
  } finally {
    await h.close();
  }
});

test("removing the CURRENT provider binding still rejects real startup without ambient fallback", {
  timeout: 30000,
}, async () => {
  const h = await fixture();
  try {
    const agent = await create(h, openai),
      cid = await conversation(h, agent);
    await complete(h, agent, cid);
    await h.crash();
    await h.bindings(true);
    await h.start();
    const state = await h.api<State>(`/__models/${agent}/state`);
    assert.equal(state.status, 500);
    assert.equal(state.body.ready, false);
    assert.equal(state.body.missingBoundCredential, true);
  } finally {
    await h.close();
  }
});

test("OWN pending admission-intent models are restored while absent/null selections are ignored", {
  timeout: 30000,
}, async () => {
  const h = await fixture();
  try {
    const agent = await create(h, anthropic);
    await conversation(h, agent);
    assert.equal((await h.api(`/__models/${agent}/pending-model-intents`)).status, 200);
    const retained = await h.api<{ providers: string[] }>(`/__models/${agent}/retained-models`);
    assert.equal(retained.status, 200);
    assert.deepEqual(retained.body.providers, ["anthropic", "openai"]);
  } finally {
    await h.close();
  }
});
