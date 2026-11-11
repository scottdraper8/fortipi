import assert from "node:assert/strict";
import test from "node:test";
import { bootstrap, harness, request, scope, uuid, value } from "./harness.ts";

test("hash-only issuance, role separation, nondelegation and bootstrap tombstone", async () => {
  const h = await harness();
  try {
    const admin = await h.auth();
    assert.equal(admin.role, "admin");
    const body = {
      requestId: uuid(),
      role: "client" as const,
      grants: [{ grantId: "read", version: 1, resources: scope(["agents.read"]) }],
    };
    const issued = value(await h.cp.mintCredential(admin, request("mintCredential", body)));
    assert.equal(issued.status, 201);
    if (issued.status !== 201) throw new Error("Not issued");
    if (issued.body.state !== "issued") assert.fail("Expected first issuance");
    const client = await h.auth(issued.body.token);
    assert.equal(client.role, "client");
    const denied = value(
      await h.cp.authorize({
        principal: client,
        resources: scope(["jobs.dispatch"]),
        action: "jobs.dispatch",
      }),
    );
    assert.equal(denied.allowed, false);
    assert.equal(
      (await h.cp.mintCredential(client, request("mintCredential", { ...body, requestId: uuid() })))
        .ok,
      false,
    );
    const retry = value(await h.cp.mintCredential(admin, request("mintCredential", body)));
    assert.equal(retry.status, 201);
    if (retry.status === 201) {
      assert.equal(retry.body.state, "already-issued");
      assert.equal("token" in retry.body, false, "lost issuance cannot retrieve token");
      assert.equal(retry.body.credential.credentialId, issued.body.credential.credentialId);
    }
    const rotationBody = { requestId: uuid(), expectedGeneration: client.generation };
    const rotationRequest = request("rotateCredential", rotationBody, { id: client.credentialId });
    const rotation = value(await h.cp.rotateCredential(admin, rotationRequest));
    if (rotation.status !== 201) assert.fail("No rotation");
    assert.equal(rotation.body.replacement.state, "issued");
    assert.equal(
      (
        await h.cp.authenticate({
          bearer: issued.body.token,
          deploymentId: h.deploymentId,
          requestId: uuid(),
          deadline: Date.now() + 30000,
        })
      ).ok,
      false,
    );
    const rotationRetry = value(await h.cp.rotateCredential(await h.auth(), rotationRequest));
    if (rotationRetry.status !== 201) assert.fail("No rotation retry");
    assert.equal(rotationRetry.body.replacement.state, "already-issued");
    assert.equal("token" in rotationRetry.body.replacement, false);
    assert.deepEqual(
      rotationRetry.body.replacement.credential,
      rotation.body.replacement.credential,
    );
    assert.equal(rotationRetry.body.revocation.revocationId, rotation.body.revocation.revocationId);
    assert.equal(
      (
        await h.cp.rotateCredential(
          await h.auth(),
          request(
            "rotateCredential",
            { ...rotationBody, expectedGeneration: 99 },
            { id: client.credentialId },
          ),
        )
      ).ok,
      false,
      "changed rotation body cannot reuse an issuance",
    );
    const revoked = value(
      await h.cp.revokeCredential(
        admin,
        request(
          "revokeCredential",
          { requestId: uuid(), expectedGeneration: admin.generation },
          { id: admin.credentialId },
        ),
      ),
    );
    assert.equal(revoked.status, 200);
    assert.equal(
      (
        await h.cp.authenticate({
          bearer: bootstrap,
          deploymentId: h.deploymentId,
          requestId: uuid(),
          deadline: Date.now() + 30000,
        })
      ).ok,
      false,
    );
  } finally {
    await h.close();
  }
});
