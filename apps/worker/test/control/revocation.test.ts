import assert from "node:assert/strict";
import test from "node:test";
import { harness, request, scope, uuid, value } from "./harness.ts";

test("deny immediately, remain pending until every recipient durably acknowledges its floor", async () => {
  const h = await harness();
  try {
    const admin = await h.auth();
    const issued = await h.mint({
      requestId: uuid(),
      role: "client",
      grants: [{ grantId: "all", version: 1, resources: scope() }],
    });
    const client = await h.auth(issued.token);
    const recipient = { kind: "workspace" as const, id: "workspace" };
    value(
      await h.cp.registerAuthorityRecipient(client, {
        credential: issued.credential,
        recipient,
        resources: scope(),
      }),
    );
    const ws = h.env.WORKSPACES.getByName("workspace");
    assert.equal(await ws.contractVersion, "1.0");
    await ws.setDrop(true);
    const response = value(
      await h.cp.revokeCredential(
        admin,
        request(
          "revokeCredential",
          { requestId: uuid(), expectedGeneration: 1 },
          { id: issued.credential.credentialId },
        ),
      ),
    );
    assert.equal(response.status, 202, "revocation stays pending until every persisted floor ack");
    if (response.status !== 202) assert.fail("Expected pending revocation");
    assert.equal(
      (
        await h.cp.registerAuthorityRecipient(client, {
          credential: issued.credential,
          recipient,
          resources: scope(),
        })
      ).ok,
      false,
    );
    assert.equal(
      (
        await h.cp.authenticate({
          bearer: issued.token,
          deploymentId: h.deploymentId,
          requestId: uuid(),
          deadline: Date.now() + 30000,
        })
      ).ok,
      false,
    );
    await h.cp.forceDue();
    await h.cp.drainTest();
    assert.equal(
      await ws.floor(`credential:${issued.credential.credentialId}`),
      2,
      "recipient writes floor before simulated lost acknowledgment",
    );
    assert.equal(
      (await h.cp.receiptTest(response.body.revocationId)).state,
      "pending",
      "send and durable remote floor alone are insufficient without receipt",
    );
    await ws.setDrop(false);
    await ws.setInvalidationDelay(50);
    await h.cp.forceDue();
    await Promise.all([h.cp.drainTest(), h.cp.drainTest()]);
    assert.equal(
      (await h.cp.receiptTest(response.body.revocationId)).state,
      "complete",
      "concurrent repair cannot consume a floor acknowledgment twice",
    );
  } finally {
    await h.close();
  }
});

test("registered recipient fanout crosses a page and remains pending on one lost durable ack", async () => {
  const h = await harness();
  try {
    const admin = await h.auth();
    const names = Array.from({ length: 20 }, (_, index) => `workspace_${index}`);
    const resources = { ...scope(), workspaceIds: names };
    const issued = await h.mint({
      requestId: uuid(),
      role: "client",
      grants: [{ grantId: "many", version: 1, resources }],
    });
    const client = await h.auth(issued.token);
    for (const name of names)
      value(
        await h.cp.registerAuthorityRecipient(client, {
          credential: issued.credential,
          recipient: { kind: "workspace", id: name },
          resources,
        }),
      );
    const last = h.env.WORKSPACES.getByName(names.at(-1) ?? "missing");
    await last.setDrop(true);
    const receipt = value(
      await h.cp.revokeCredential(
        admin,
        request(
          "revokeCredential",
          { requestId: uuid(), expectedGeneration: 1 },
          { id: issued.credential.credentialId },
        ),
      ),
    );
    assert.equal(receipt.status, 202);
    for (let turn = 0; turn < 4; turn++) {
      await h.cp.forceDue();
      await h.cp.drainTest();
    }
    for (const name of names)
      assert.equal(
        await h.env.WORKSPACES.getByName(name).floor(
          `credential:${issued.credential.credentialId}`,
        ),
        2,
      );
    assert.equal((await h.cp.receiptTest(receipt.body.revocationId)).state, "pending");
    await last.setDrop(false);
    await h.cp.forceDue();
    await h.cp.drainTest();
    assert.equal((await h.cp.receiptTest(receipt.body.revocationId)).state, "complete");
  } finally {
    await h.close();
  }
});
