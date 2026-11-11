import assert from "node:assert/strict";
import test from "node:test";
import { harness, request, scope, uuid, value } from "./harness.ts";

test("shared artifact action allows scoped clients while preserving role and grant boundaries", async () => {
  const h = await harness();
  try {
    const issued = await h.mint({
      requestId: uuid(),
      role: "client",
      grants: [
        {
          grantId: "artifact-reader",
          version: 1,
          resources: scope(["artifacts.read", "models.auth.status"]),
        },
      ],
    });
    const client = await h.auth(issued.token);
    const read = { action: "artifacts.read", resources: scope(["artifacts.read"]) };
    assert.equal(
      value(await h.cp.authorize({ principal: client, ...read })).allowed,
      true,
      "a scoped client must retain application artifacts.read despite the shared admin route action",
    );
    assert.equal(
      value(
        await h.cp.authorize({
          principal: client,
          ...read,
          resources: { ...read.resources, workspaceIds: ["another-workspace"] },
        }),
      ).allowed,
      false,
    );
    assert.equal(
      value(
        await h.cp.authorize({
          principal: client,
          action: "workspace.read",
          resources: scope(["workspace.read"]),
        }),
      ).allowed,
      false,
      "artifact permission does not imply workspace read access",
    );
    const adminOnly = await h.cp.getProviderAuthStatus(
      client,
      request("getProviderAuthStatus", undefined, { providerId: "openai" }),
    );
    assert.equal(
      adminOnly.ok,
      false,
      "an explicit grant cannot bypass an admin-only action audience",
    );
    const workspaceReader = await h.mint({
      requestId: uuid(),
      role: "client",
      grants: [{ grantId: "workspace-only", version: 1, resources: scope(["workspace.read"]) }],
    });
    assert.equal(
      value(await h.cp.authorize({ principal: await h.auth(workspaceReader.token), ...read }))
        .allowed,
      false,
    );
    const executor = await h.mint({
      requestId: uuid(),
      role: "executor",
      executorId: "executor",
      grants: [{ grantId: "executor", version: 1, resources: scope(["artifacts.read"]) }],
    });
    assert.equal(
      value(await h.cp.authorize({ principal: await h.auth(executor.token), ...read })).allowed,
      false,
      "shared actions do not expand executor role authority",
    );
    const limitedAdmin = await h.mint({
      requestId: uuid(),
      role: "admin",
      grants: [{ grantId: "limited-admin", version: 1, resources: scope(["workspace.read"]) }],
    });
    assert.equal(
      value(await h.cp.authorize({ principal: await h.auth(limitedAdmin.token), ...read })).allowed,
      false,
      "admin role does not supply an absent artifact grant",
    );
    value(
      await h.cp.revokeCredential(
        await h.auth(),
        request(
          "revokeCredential",
          { requestId: uuid(), expectedGeneration: client.generation },
          { id: client.credentialId },
        ),
      ),
    );
    assert.equal(
      (await h.cp.authorize({ principal: client, ...read })).ok,
      false,
      "current credential authority is still required for shared actions",
    );
  } finally {
    await h.close();
  }
});
