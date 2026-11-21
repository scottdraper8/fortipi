import assert from "node:assert/strict";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { config, harness, request, uuid, value } from "../control/harness.ts";
import type { TestControlPlane } from "./factory-worker.js";

test("actual Worker selected Pi adapters delegate complete OAuth to real encrypted CP and keep startup local", async () => {
  const h = await harness<TestControlPlane>({
    fixturePath: "apps/worker/test/models/factory-worker.ts",
  });
  try {
    const admin = await h.auth();
    const configured = structuredClone(config);
    configured.version = 2;
    configured.models = configured.models.map((model) =>
      model.providerId === "openai-codex" ? { ...model, modelId: "gpt-6-sol" } : model,
    );
    const updated = value(
      await h.cp.handleApi(
        admin,
        request("patchConfiguration", {
          requestId: uuid(),
          expectedVersion: 1,
          configuration: configured,
        }),
      ),
    );
    assert.equal(updated.status, 200);
    for (const [providerId, modelId] of [
      ["openai", "gpt-5.4"],
      ["anthropic", "claude-opus-4-7"],
      ["openai-codex", "gpt-6-sol"],
    ] as const) {
      const credential: D.OAuthCredential = {
        type: "oauth",
        access: "synthetic-original-access",
        refresh: "synthetic-original-refresh",
        expires: 0,
        ...(providerId === "openai"
          ? {
              providerFields: {
                clientId: "synthetic-client",
                scopes: ["openid", "chatgpt.tokens.use.direct"],
              },
            }
          : providerId === "openai-codex"
            ? { providerFields: { accountId: "synthetic-account" } }
            : {}),
      };
      const seeded = value(
        await h.cp.putProviderAuth(
          admin,
          request(
            "putProviderAuth",
            { requestId: uuid(), expectedVersion: null, credential },
            { providerId },
          ),
        ),
      );
      assert.equal(seeded.status, 200);
      const proof = JSON.parse(await h.cp.factoryAuthProbe(providerId, modelId, "oauth")) as {
        ok: boolean;
        startupCalls: number;
        resolutions: number;
        modelSelected: boolean;
        providerCount: number;
        complete: boolean;
        accountBinding?: boolean;
        openaiFields: boolean;
        aborted: boolean;
        credentialStatus: D.ProviderAuthStatus;
      };
      assert.equal(proof.ok, true, JSON.stringify(proof));
      assert.equal(proof.startupCalls, 0);
      assert.equal(proof.modelSelected, true);
      assert.equal(proof.providerCount, 1);
      assert.equal(proof.complete, true);
      assert.equal(proof.aborted, true);
      assert.equal(
        proof.credentialStatus.version,
        2,
        "Real encrypted CP must persist refresh before factory auth returns",
      );
      assert.equal(proof.openaiFields, true);
      if (providerId === "openai-codex") assert.equal(proof.accountBinding, true);
      assert.equal((await h.cp.encryptedRows()).includes("synthetic-"), false);
    }
    for (const [providerId, modelId] of [
      ["openai", "gpt-5.4"],
      ["anthropic", "claude-opus-4-7"],
    ]) {
      assert.ok(providerId && modelId);
      const proof = JSON.parse(await h.cp.factoryAuthProbe(providerId, modelId, "secret")) as {
        ok: boolean;
        startupCalls: number;
        resolutions: number;
        complete: boolean;
        modelSelected: boolean;
      };
      assert.equal(proof.ok, true);
      assert.equal(proof.startupCalls, 0);
      assert.equal(proof.resolutions, 0);
      assert.equal(proof.complete, true);
      assert.equal(proof.modelSelected, true);
    }
  } finally {
    await h.close();
  }
});
test("actual Workers AI factory reaches its binding with the selected model and returns Pi output", async () => {
  const h = await harness<TestControlPlane>({
    fixturePath: "apps/worker/test/models/factory-worker.ts",
  });
  try {
    const proof = JSON.parse(await h.cp.workersAiProbe()) as {
      calls: { model: string; raw: boolean; user: boolean }[];
      provider: string;
      modelId: string;
      text: string;
      stopReason: string;
      resolutions: number;
    };
    assert.deepEqual(proof.calls, [{ model: "@cf/zai-org/glm-5.3-flash", raw: true, user: true }]);
    assert.equal(proof.provider, "cloudflare");
    assert.equal(proof.modelId, "@cf/zai-org/glm-5.3-flash");
    assert.equal(proof.text, "selected Workers AI output");
    assert.equal(proof.stopReason, "stop");
    assert.equal(proof.resolutions, 0);
  } finally {
    await h.close();
  }
});
