import assert from "node:assert/strict";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { harness, request, uuid, value } from "./harness.ts";

test("redirected or oversized refresh never exposes auth or blindly retries a rotating token", async () => {
  const h = await harness();
  try {
    const admin = await h.auth();
    let version: number | null = null;
    for (const mode of ["redirect", "oversize"] as const) {
      await h.cp.setTokenResponseMode(mode);
      const seeded: D.OperationResponse<"putProviderAuth"> = value(
        await h.cp.putProviderAuth(
          admin,
          request(
            "putProviderAuth",
            {
              requestId: uuid(),
              expectedVersion: version,
              credential: {
                type: "oauth",
                access: "synthetic-original-access",
                refresh: "synthetic-original-refresh",
                expires: 0,
                providerFields: {
                  clientId: "synthetic-client",
                  scopes: ["chatgpt.tokens.use.direct"],
                },
              },
            },
            { providerId: "openai" },
          ),
        ),
      );
      if (seeded.status !== 200) assert.fail("No seed");
      version = seeded.body.version;
      const deadline = Date.now() + 30000;
      const context: D.ModelResolutionContext = {
        kind: "model-resolution",
        action: "resolve-provider-auth",
        deploymentId: h.deploymentId,
        agentId: "agent",
        factoryId: "factory",
        providerId: "openai",
        modelId: "gpt-5.4",
        deadline,
      };
      const input = { providerId: "openai", modelId: "gpt-5.4", deadline };
      const failed = await h.cp.providerProbe(context, input);
      assert.equal(failed.ok, false);
      assert.equal(JSON.stringify(failed).includes("synthetic"), false);
      const status = value(
        await h.cp.getProviderAuthStatus(
          admin,
          request("getProviderAuthStatus", undefined, { providerId: "openai" }),
        ),
      );
      if (status.status !== 200) assert.fail("No status");
      assert.equal(status.body.state, "reauth_required");
      assert.equal(
        (await h.cp.providerProbe(context, input)).ok,
        false,
        "uncertain rotating exchange cannot be replayed",
      );
      assert.equal((await h.cp.encryptedRows()).includes("synthetic"), false);
    }
  } finally {
    await h.close();
  }
});

test("actual Worker Models.getAuth refreshes once and persists encrypted complete credential before return", async () => {
  const h = await harness();
  try {
    const admin = await h.auth();
    const put: D.ProviderAuthPut = {
      requestId: uuid(),
      expectedVersion: null,
      credential: {
        type: "oauth",
        access: "synthetic-original-access",
        refresh: "synthetic-original-refresh",
        expires: 0,
        providerFields: {
          clientId: "synthetic-client",
          scopes: ["openid", "chatgpt.tokens.use.direct"],
        },
      },
    };
    const result = value(
      await h.cp.putProviderAuth(admin, request("putProviderAuth", put, { providerId: "openai" })),
    );
    assert.equal(result.status, 200);
    assert.deepEqual(
      value(
        await h.cp.putProviderAuth(
          admin,
          request("putProviderAuth", put, { providerId: "openai" }),
        ),
      ),
      result,
    );
    const encrypted = await h.cp.encryptedRows();
    assert.equal(encrypted.includes("synthetic-original"), false);
    assert.equal(encrypted.includes("synthetic-client"), false);
    const crypto = await h.cp.cryptoProbe();
    assert.equal(crypto.wrongKey, true);
    assert.equal(
      crypto.wrongKeyDelete,
      true,
      "a wrong key cannot erase protected ciphertext through the public Pi store delete port",
    );
    assert.equal(crypto.wrongAad, true);
    assert.equal(crypto.tamper, true);
    assert.equal(crypto.ciphertextPreserved, true);
    const ctx: D.ModelResolutionContext = {
      kind: "model-resolution",
      action: "resolve-provider-auth",
      deploymentId: h.deploymentId,
      agentId: "agent",
      factoryId: "factory",
      providerId: "openai",
      modelId: "gpt-5.4",
      deadline: Date.now() + 30000,
    };
    const resolved = value(
      await h.cp.providerProbe(ctx, {
        providerId: "openai",
        modelId: "gpt-5.4",
        deadline: ctx.deadline,
      }),
    );
    assert.equal(resolved.isFresh, true);
    assert.equal(resolved.calls, 1);
    assert.equal(resolved.version, 2);
    const status = value(
      await h.cp.getProviderAuthStatus(
        admin,
        request("getProviderAuthStatus", undefined, { providerId: "openai" }),
      ),
    );
    assert.equal(status.status, 200);
    assert.equal(JSON.stringify(status).includes("synthetic-"), false);
    const removed = value(
      await h.cp.deleteProviderAuth(
        admin,
        request(
          "deleteProviderAuth",
          { requestId: uuid(), expectedVersion: 2 },
          { providerId: "openai" },
        ),
      ),
    );
    assert.equal(removed.status, 200);
    if (removed.status === 200) {
      assert.equal(removed.body.state, "absent");
      assert.equal(removed.body.generation, 2);
    }
    assert.equal(
      (
        await h.cp.putProviderAuth(
          admin,
          request(
            "putProviderAuth",
            { ...put, requestId: uuid(), expectedVersion: null },
            { providerId: "openai" },
          ),
        )
      ).ok,
      false,
      "logout tombstone forbids initial-version resurrection",
    );
  } finally {
    await h.close();
  }
});

test("all supported Worker adapters use their distinct pinned refresh protocols; per-provider store retains lock through async work", async () => {
  const h = await harness();
  try {
    const admin = await h.auth();
    for (const providerId of ["anthropic", "openai-codex", "openai"]) {
      const providerFields =
        providerId === "openai"
          ? { clientId: "synthetic-client", scopes: ["chatgpt.tokens.use.direct"] }
          : providerId === "openai-codex"
            ? { accountId: "synthetic-account" }
            : undefined;
      const credential: D.OAuthCredential = {
        type: "oauth",
        access: "synthetic-access",
        refresh: "synthetic-refresh",
        expires: 0,
        ...(providerFields ? { providerFields } : {}),
      };
      value(
        await h.cp.putProviderAuth(
          admin,
          request(
            "putProviderAuth",
            { requestId: uuid(), expectedVersion: null, credential },
            { providerId },
          ),
        ),
      );
      const modelId = providerId === "anthropic" ? "claude-opus-4-7" : "gpt-5.4";
      const deadline = Date.now() + 30000;
      const context: D.ModelResolutionContext = {
        kind: "model-resolution",
        action: "resolve-provider-auth",
        deploymentId: h.deploymentId,
        agentId: "agent",
        factoryId: "factory",
        providerId,
        modelId,
        deadline,
      };
      const result = value(await h.cp.providerProbe(context, { providerId, modelId, deadline }));
      assert.equal(result.calls, 1);
      assert.equal(result.isFresh, true);
    }
    const store = await h.cp.storeProbe();
    assert.equal(store.unchanged, true);
    assert.equal(store.queuedCanceled, true);
    assert.equal(store.independent, true);
    assert.deepEqual(store.order, ["refresh-start", "refresh-persist", "logout"]);
    assert.equal(store.state, "absent");
  } finally {
    await h.close();
  }
});

test("cancelled resolver wait does not release a rotating refresh or let stale ingest overwrite it", async () => {
  const h = await harness();
  try {
    const admin = await h.auth();
    const credential: D.OAuthCredential = {
      type: "oauth",
      access: "synthetic-access",
      refresh: "synthetic-refresh",
      expires: 0,
      providerFields: { clientId: "synthetic-client", scopes: ["chatgpt.tokens.use.direct"] },
    };
    value(
      await h.cp.putProviderAuth(
        admin,
        request(
          "putProviderAuth",
          { requestId: uuid(), expectedVersion: null, credential },
          { providerId: "openai" },
        ),
      ),
    );
    const deadline = Date.now() + 5;
    const context: D.ModelResolutionContext = {
      kind: "model-resolution",
      action: "resolve-provider-auth",
      deploymentId: h.deploymentId,
      agentId: "agent",
      factoryId: "factory",
      providerId: "openai",
      modelId: "gpt-5.4",
      deadline,
    };
    assert.equal(
      (await h.cp.providerProbe(context, { providerId: "openai", modelId: "gpt-5.4", deadline }))
        .ok,
      false,
    );
    const stale = await h.cp.putProviderAuth(
      admin,
      request(
        "putProviderAuth",
        { requestId: uuid(), expectedVersion: 1, credential },
        { providerId: "openai" },
      ),
    );
    assert.equal(stale.ok, false, "ingest waits for active refresh then sees advanced version");
    const status = value(
      await h.cp.getProviderAuthStatus(
        admin,
        request("getProviderAuthStatus", undefined, { providerId: "openai" }),
      ),
    );
    assert.equal(status.status, 200);
    if (status.status === 200) assert.equal(status.body.version, 2);
  } finally {
    await h.close();
  }
});
