import assert from "node:assert/strict";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { harness, request, uuid, value } from "./harness.ts";

const chosen: D.ModelConfig = {
  providerId: "openai",
  modelId: "persisted-selection",
  endpoint: "https://api.openai.com/v1",
  auth: { kind: "secretRef", secretRef: "OPENAI_API_KEY" },
};
function scope(agentId: string, action = "conversations.create"): D.ResourceScope {
  return {
    agentIds: [agentId],
    conversationIds: action === "conversations.create" ? [] : ["conversation"],
    workspaceIds: [],
    executorIds: [],
    backendIds: [],
    tools: [],
    actions: [action],
  };
}
async function create(h: Awaited<ReturnType<typeof harness>>, ctx: D.AuthContext, model = chosen) {
  const result = value(
    await h.cp.createAgent(
      ctx,
      request("createAgent", { requestId: uuid(), name: "Selected model", model }),
    ),
  );
  assert.equal(result.status, 201);
  if (result.status !== 201) assert.fail("Expected configured Agent");
  return result.body.agentId;
}
async function register(
  h: Awaited<ReturnType<typeof harness>>,
  auth: D.AuthContext,
  resources: D.ResourceScope,
) {
  const result = value(
    await h.cp.registerAuthorityRecipient(auth, {
      credential: {
        credentialId: auth.credentialId,
        generation: auth.generation,
        grantVersion: auth.grantVersion,
      },
      recipient: { kind: "agent", id: resources.agentIds[0] ?? "missing" },
      resources,
    }),
  );
  return { ...auth, registrationId: result.registrationId };
}
function internal(agentId: string, auth?: D.AuthContext, suffix = "", method = "GET") {
  return new Request(`https://control.internal/internal/agents/${agentId}/model${suffix}`, {
    method,
    headers: auth ? { "X-Fortipi-Context": JSON.stringify(auth) } : {},
  });
}

test("private configured-model fetch returns the persisted full selection only to its current registered Agent operation", async () => {
  const h = await harness();
  try {
    const admin = await h.auth();
    const agentId = await create(h, admin);
    const another = await create(h, admin, { providerId: "cloudflare", modelId: "another-agent" });
    const ownScope = scope(agentId);
    const issued = await h.mint({
      requestId: uuid(),
      role: "client",
      grants: [
        {
          grantId: "operation",
          version: 1,
          resources: { ...ownScope, agentIds: [agentId, another] },
        },
      ],
    });
    const raw = await h.auth(issued.token);
    const own = await register(h, raw, ownScope);
    assert.equal(
      (await h.cp.fetch(internal(agentId, raw))).status,
      403,
      "raw application grant cannot resolve private configuration",
    );
    assert.equal(
      (await h.cp.fetch(internal(another, own))).status,
      403,
      "registered Agent cannot resolve another Agent model",
    );
    assert.equal(
      (await h.cp.fetch(internal(agentId, admin))).status,
      403,
      "administrator without an operational registration does not enter the private model lane",
    );
    const { url } = await h.server.listen();
    const response = await fetch(new URL(`/internal/agents/${agentId}/model`, url), {
      headers: { "X-Fortipi-Context": JSON.stringify(own) },
    });
    assert.equal(
      response.status,
      200,
      "minimal conversation creation authority must resolve its own selected model",
    );
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("X-Fortipi-Agent-Config-Version"), "1");
    assert.deepEqual(
      await response.json(),
      chosen,
      "private lookup must use the persisted full ModelConfig, not the installation catalog or public reference",
    );
    assert.equal(
      (await h.cp.describeAgent(own, request("describeAgent", undefined, { agentId }))).ok,
      false,
      "private model resolution must not grant public agents.read",
    );
    assert.equal(
      (await h.cp.handleApi(own, request("describeAgent", undefined, { agentId }))).ok,
      false,
    );
    const updated: D.ModelConfig = {
      providerId: "cloudflare",
      modelId: "new-configured-selection",
    };
    value(
      await h.cp.configureAgent(
        admin,
        request(
          "configureAgent",
          { requestId: uuid(), expectedVersion: 1, model: updated },
          { agentId },
        ),
      ),
    );
    const current = await h.cp.fetch(internal(agentId, own));
    assert.equal(current.headers.get("X-Fortipi-Agent-Config-Version"), "2");
    assert.deepEqual(
      await current.json(),
      updated,
      "config-version and selection must come from the same actual retained Agent row",
    );
    for (const malformed of [
      internal(agentId),
      internal(agentId, own, "?model=guessed"),
      internal(agentId, own, "", "POST"),
    ])
      assert.notEqual((await h.cp.fetch(malformed)).status, 200);
    for (const envelope of [
      "{",
      "null",
      JSON.stringify({ ...own, generation: own.generation + 1 }),
      "x".repeat(65537),
    ])
      assert.equal(
        (
          await h.cp.fetch(
            new Request(internal(agentId), { headers: { "X-Fortipi-Context": envelope } }),
          )
        ).status,
        401,
        "malformed, over-bound or noncurrent internal authority must fail closed",
      );
    assert.equal(
      (
        await h.cp.fetch(
          new Request(internal(agentId, own), {
            headers: {
              "X-Fortipi-Context": JSON.stringify(own),
              Origin: "https://untrusted.invalid",
            },
          }),
        )
      ).status,
      403,
    );
  } finally {
    await h.close();
  }
});

test("private model resolution revalidates current grants, registration references, credential floors and model-using action", async () => {
  const h = await harness();
  try {
    const admin = await h.auth();
    const agentId = await create(h, admin);
    const resources = scope(agentId, "messages.submit");
    const expiresAt = Date.now() + 1500;
    const short = await h.mint({
      requestId: uuid(),
      role: "client",
      grants: [{ grantId: "short", version: 1, resources, expiresAt }],
    });
    const own = await register(h, await h.auth(short.token), resources);
    assert.equal((await h.cp.fetch(internal(agentId, own))).status, 200);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, expiresAt - Date.now() + 20)));
    assert.equal(
      (await h.cp.fetch(internal(agentId, own))).status,
      403,
      "operational model resolution cannot outlive the matching grant",
    );
    const issued = await h.mint({
      requestId: uuid(),
      role: "client",
      grants: [{ grantId: "current", version: 1, resources }],
    });
    const current = await register(h, await h.auth(issued.token), resources);
    assert.equal(
      (await h.cp.fetch(internal(agentId, { ...current, registrationId: own.registrationId })))
        .status,
      403,
      "another credential cannot reuse the original Agent registration",
    );
    value(
      await h.cp.revokeCredential(
        admin,
        request(
          "revokeCredential",
          { requestId: uuid(), expectedGeneration: 1 },
          { id: issued.credential.credentialId },
        ),
      ),
    );
    assert.equal(
      (await h.cp.fetch(internal(agentId, current))).status,
      401,
      "current credential floor must precede model exposure",
    );
    for (const actions of [["conversations.read"], ["messages.submit", "conversations.read"]]) {
      const read = { ...resources, actions };
      const credential = await h.mint({
        requestId: uuid(),
        role: "client",
        grants: [{ grantId: "read", version: 1, resources: read }],
      });
      const actor = await register(h, await h.auth(credential.token), read);
      assert.equal(
        (await h.cp.fetch(internal(agentId, actor))).status,
        403,
        "read-only or ambiguous registered actions cannot imply model-using authority",
      );
    }
  } finally {
    await h.close();
  }
});
