import assert from "node:assert/strict";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { connected } from "./connection.ts";
import { harness, request, uuid, value } from "./harness.ts";

const limits: D.ExecutorTransferLimits = {
  chunkBytes: 65536,
  fileBytes: 1048576,
  snapshotBytes: 4194304,
  artifactBytes: 524288,
  manifestEntries: 64,
};
async function setup() {
  const h = await harness();
  const sockets: WebSocket[] = [];
  try {
    const admin = await h.auth();
    const first = await connected(h, { executorId: "storage" });
    sockets.push(first.socket);
    const second = await connected(h, { executorId: "selected", transferLimits: limits });
    sockets.push(second.socket);
    const created = value(
      await h.cp.createAgent(
        admin,
        request("createAgent", {
          requestId: uuid(),
          name: "Operational Agent",
          model: { providerId: "cloudflare", modelId: "selected-model" },
        }),
      ),
    );
    assert.equal(created.status, 201);
    if (created.status !== 201) assert.fail("Missing Agent");
    const local = value(
      await h.cp.handleApi(
        admin,
        request("createWorkspace", {
          requestId: uuid(),
          config: { kind: "local", executorId: "storage", rootBindingId: "root" },
        }),
      ),
    );
    const computer = value(
      await h.cp.handleApi(
        admin,
        request("createWorkspace", { requestId: uuid(), config: { kind: "computer" } }),
      ),
    );
    assert.equal(local.status, 201);
    assert.equal(computer.status, 201);
    if (local.status !== 201 || computer.status !== 201) assert.fail("Missing binding");
    if (
      !(
        "workspaceId" in local.body &&
        "config" in local.body &&
        "bindingVersion" in local.body &&
        "workspaceId" in computer.body &&
        "config" in computer.body &&
        "bindingVersion" in computer.body
      )
    )
      assert.fail("Actual binding responses required");
    return {
      ...h,
      admin,
      agentId: created.body.agentId,
      local: local.body,
      computer: computer.body,
      async close() {
        for (const socket of sockets) socket.close();
        await h.close();
      },
    };
  } catch (error) {
    for (const socket of sockets) socket.close();
    await h.close();
    throw error;
  }
}
function scope(agentId: string, workspaceId: string, executorId = "selected"): D.ResourceScope {
  return {
    agentIds: [agentId],
    conversationIds: ["conversation"],
    workspaceIds: [workspaceId],
    executorIds: [executorId],
    backendIds: [],
    tools: ["shell"],
    actions: ["jobs.dispatch", "workspace.write"],
  };
}
async function registration(
  h: Awaited<ReturnType<typeof setup>>,
  ctx: D.AuthContext,
  resources: D.ResourceScope,
  kind: "agent" | "workspace" = "agent",
) {
  const registered = value(
    await h.cp.registerAuthorityRecipient(ctx, {
      credential: {
        credentialId: ctx.credentialId,
        generation: ctx.generation,
        grantVersion: ctx.grantVersion,
      },
      recipient: {
        kind,
        id: kind === "agent" ? h.agentId : (resources.workspaceIds[0] ?? "missing"),
      },
      resources,
      executor: { executorId: resources.executorIds[0] ?? "missing", generation: 1 },
    }),
  );
  return { ...ctx, registrationId: registered.registrationId };
}

test("current Agent write metadata separates selected execution from local/Computer storage; Workspace and legacy reads stay storage-bound", async () => {
  const h = await setup();
  try {
    const resources = scope(h.agentId, h.local.workspaceId);
    const issued = await h.mint({
      requestId: uuid(),
      role: "client",
      grants: [
        {
          grantId: "write",
          version: 1,
          resources: {
            ...resources,
            workspaceIds: [h.local.workspaceId, h.computer.workspaceId],
            executorIds: ["storage", "selected"],
          },
        },
      ],
    });
    const raw = await h.auth(issued.token);
    const actor = await registration(h, raw, { ...resources, actions: ["jobs.dispatch"] });
    const keyed = { workspaceId: h.local.workspaceId, bindingVersion: 1, executorId: "selected" };
    assert.equal(
      (await h.cp.resolveExecutorGeneration(raw, keyed)).ok,
      false,
      "unregistered application grant cannot query operational executor metadata",
    );
    const selected = await h.cp.resolveExecutorGeneration(actor, keyed);
    assert.equal(
      selected.ok,
      true,
      "registered Agent must resolve its selected executor independently of the local storage owner",
    );
    assert.deepEqual(value(selected), {
      executorId: "selected",
      executorGeneration: 1,
      transferLimits: limits,
    });
    const cloudActor = await registration(h, raw, {
      ...resources,
      workspaceIds: [h.computer.workspaceId],
      actions: ["jobs.dispatch"],
    });
    assert.deepEqual(
      value(
        await h.cp.resolveExecutorGeneration(cloudActor, {
          ...keyed,
          workspaceId: h.computer.workspaceId,
        }),
      ),
      value(selected),
      "Computer binding plus registered native execution target must return actual selected generation and measured limits",
    );
    assert.equal(
      (await h.cp.resolveExecutorGeneration(actor, { ...keyed, bindingVersion: 2 })).ok,
      false,
      "operational metadata cannot use a future or stale binding",
    );
    assert.equal(
      (await h.cp.resolveExecutorGeneration(actor, { ...keyed, executorId: "storage" })).ok,
      false,
      "grant alone cannot replace the registered selected executor",
    );
    assert.equal(
      (
        await h.cp.resolveExecutorGeneration(actor, {
          ...keyed,
          workspaceId: h.computer.workspaceId,
        })
      ).ok,
      false,
    );
    assert.equal(
      (await h.cp.resolveExecutorGeneration(h.admin, keyed)).ok,
      false,
      "legacy workspace.read remains bound to the actual local storage owner",
    );
    const storage = await registration(
      h,
      raw,
      { ...resources, executorIds: ["storage"], tools: [], actions: ["workspace.write"] },
      "workspace",
    );
    assert.equal(
      value(await h.cp.resolveExecutorGeneration(storage, { ...keyed, executorId: "storage" }))
        .executorId,
      "storage",
    );
    const wrongStorage = await registration(
      h,
      raw,
      { ...resources, actions: ["workspace.write"] },
      "workspace",
    );
    assert.equal(
      (await h.cp.resolveExecutorGeneration(wrongStorage, keyed)).ok,
      false,
      "Workspace registration cannot query an unrelated selected execution target",
    );
    const cloudStorage = await registration(
      h,
      raw,
      { ...resources, workspaceIds: [h.computer.workspaceId], actions: ["workspace.write"] },
      "workspace",
    );
    assert.equal(
      (
        await h.cp.resolveExecutorGeneration(cloudStorage, {
          ...keyed,
          workspaceId: h.computer.workspaceId,
        })
      ).ok,
      false,
    );
    const listing = value(await h.cp.handleApi(actor, request("listExecutors", undefined)));
    assert.ok(listing.status === 200 && "items" in listing.body);
    assert.equal(
      listing.body.items.length,
      0,
      "keyed operational metadata grants no executor listing",
    );
    const admitted = await h.cp.reserveCapacity(actor, {
      operationId: uuid(),
      ownerId: "conversation",
      policyVersion: 1,
      bytes: 16384,
      admissionSlots: 0,
    });
    assert.equal(
      admitted.ok,
      true,
      "job metadata must use its registered conversation operation without hidden capacity grants",
    );
    const claim = value(admitted);
    assert.equal(
      value(
        await h.cp.settleCapacity(actor, {
          reservationId: claim.reservationId,
          disposition: "consumed",
          observedBytes: 1024,
        }),
      ).state,
      "settled",
      "job metadata reserves and settles against its actual registered conversation without capacity grants",
    );
    assert.equal(
      (
        await h.cp.reserveCapacity(actor, {
          operationId: uuid(),
          ownerId: "unbound-job",
          policyVersion: 1,
          bytes: 16384,
          admissionSlots: 0,
        })
      ).ok,
      false,
    );
    assert.equal(
      (
        await h.cp.fetch(
          new Request(`https://control.internal/internal/agents/${h.agentId}/model`, {
            headers: { "X-Fortipi-Context": JSON.stringify(actor) },
          }),
        )
      ).status,
      403,
      "job dispatch metadata must not imply model-using authority",
    );
  } finally {
    await h.close();
  }
});

test("operational executor metadata requires one covering grant and current credential/executor floors and expiry", async () => {
  const h = await setup();
  try {
    const resources = scope(h.agentId, h.local.workspaceId);
    const union = await h.mint({
      requestId: uuid(),
      role: "client",
      grants: [
        {
          grantId: "dispatch",
          version: 1,
          resources: { ...resources, actions: ["jobs.dispatch"] },
        },
        { grantId: "write", version: 1, resources: { ...resources, actions: ["workspace.write"] } },
      ],
    });
    const split = await registration(h, await h.auth(union.token), {
      ...resources,
      actions: ["jobs.dispatch"],
    });
    const keyed = { workspaceId: h.local.workspaceId, bindingVersion: 1, executorId: "selected" };
    assert.equal(
      (await h.cp.resolveExecutorGeneration(split, keyed)).ok,
      false,
      "separate dispatch/write grants cannot be unioned for operational metadata",
    );
    const expiresAt = Date.now() + 1500;
    const short = await h.mint({
      requestId: uuid(),
      role: "client",
      grants: [{ grantId: "short", version: 1, resources, expiresAt }],
    });
    const expiring = await registration(h, await h.auth(short.token), {
      ...resources,
      actions: ["jobs.dispatch"],
    });
    assert.equal((await h.cp.resolveExecutorGeneration(expiring, keyed)).ok, true);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, expiresAt - Date.now() + 20)));
    assert.equal(
      (await h.cp.resolveExecutorGeneration(expiring, keyed)).ok,
      false,
      "retained registration must not outlive its matching current grant",
    );
    const issued = await h.mint({
      requestId: uuid(),
      role: "client",
      grants: [{ grantId: "current", version: 1, resources }],
    });
    const actor = await registration(h, await h.auth(issued.token), {
      ...resources,
      actions: ["jobs.dispatch"],
    });
    assert.equal(
      (
        await h.cp.resolveExecutorGeneration(
          { ...actor, registrationId: expiring.registrationId },
          keyed,
        )
      ).ok,
      false,
      "registration references cannot move between credentials",
    );
    value(
      await h.cp.revokeExecutor(
        h.admin,
        request("revokeExecutor", { requestId: uuid(), expectedGeneration: 1 }, { id: "selected" }),
      ),
    );
    assert.equal(
      (await h.cp.resolveExecutorGeneration(actor, keyed)).ok,
      false,
      "executor revocation floor precedes operational metadata",
    );
    value(
      await h.cp.revokeCredential(
        h.admin,
        request(
          "revokeCredential",
          { requestId: uuid(), expectedGeneration: 1 },
          { id: issued.credential.credentialId },
        ),
      ),
    );
    const stale = await h.cp.resolveExecutorGeneration(actor, keyed);
    assert.equal(stale.ok, false, "credential floor precedes operational metadata");
    if (!stale.ok) assert.equal(stale.code, "unauthenticated");
  } finally {
    await h.close();
  }
});
