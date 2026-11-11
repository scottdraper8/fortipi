import assert from "node:assert/strict";
import test from "node:test";
import type { ControlPlaneRpc } from "../../src/boundary/control-plane.js";
import type * as D from "../../src/boundary/dto.js";
import { connected } from "./connection.ts";
import { harness, request, uuid, value } from "./harness.ts";

test("CP publishes actual binding ack only; pending import scope is exact and lost ack retry never changes version again", async () => {
  const h = await harness();
  let socket: WebSocket | undefined;
  try {
    const channel = await connected(h);
    socket = channel.socket;
    const admin = await h.auth();
    const api = h.cp as unknown as Pick<ControlPlaneRpc, "handleApi">;
    const creating = request("createWorkspace", {
      requestId: uuid(),
      config: { kind: "local", executorId: "executor", rootBindingId: "root" },
    });
    const concurrent = await Promise.all([
      api.handleApi(admin, creating),
      api.handleApi(admin, creating),
    ]);
    const created = value(concurrent[0]);
    assert.deepEqual(
      value(concurrent[1]),
      created,
      "concurrent binding retries recover one actual authority ack",
    );
    if (created.status !== 201) assert.fail("No binding ack");
    const binding = created.body;
    assert.equal(binding.availability, "unknown", "no fabricated empty host proof");
    const generation = value(
      await h.cp.resolveExecutorGeneration(admin, {
        workspaceId: binding.workspaceId,
        bindingVersion: 1,
        executorId: "executor",
      }),
    );
    assert.equal(generation.executorGeneration, 1);
    const authority = h.env.WORKSPACES.getByName(binding.workspaceId);
    await authority.setBindingDrop(true);
    const manifest: D.Manifest = {
      version: 1,
      entries: [{ type: "directory", path: "imported", mode: 493 }],
    };
    const body: D.WorkspaceBindingPatch = {
      requestId: uuid(),
      expectedVersion: 1,
      newBindingVersion: 2,
      config: { kind: "local", executorId: "executor", rootBindingId: "root" },
      import: { revision: "operator_import_revision", manifest, acknowledgeExternalEffects: true },
    };
    const rebind = api.handleApi(
      admin,
      request("rebindWorkspace", body, { workspaceId: binding.workspaceId }),
    );
    const pending = await channel.wait("workspace.request");
    if (pending.type !== "workspace.request") assert.fail("Missing owner request");
    const local = pending.payload.request;
    assert.equal(local.kind, "snapshot");
    assert.equal(local.bindingVersion, 2);
    assert.equal(local.operationId, body.requestId);
    assert.equal(
      local.credential.credentialId,
      admin.credentialId,
      "caller ref must not be replaced by executor credential",
    );
    assert.equal(
      (
        await h.cp.resolveExecutorGeneration(admin, {
          workspaceId: binding.workspaceId,
          bindingVersion: 2,
          executorId: "executor",
        })
      ).ok,
      false,
      "future binding needs matching pending registration",
    );
    const { manifestDigest } = await import("fortipi-contract");
    const manifestHash = await manifestDigest(manifest);
    channel.send({
      type: "workspace.response",
      requestId: pending.requestId,
      payload: {
        requestId: pending.payload.requestId,
        correlationId: pending.payload.correlationId,
        response: {
          kind: "snapshot",
          result: {
            workspaceId: binding.workspaceId,
            revision: body.import.revision,
            manifestHash,
            manifest,
          },
        },
      },
    });
    assert.equal((await rebind).ok, false, "lost authority ack cannot publish a binding");
    const before = value(await api.handleApi(admin, request("listWorkspaces", undefined)));
    if (before.status !== 200) assert.fail("Missing list");
    assert.equal(before.body.items[0]?.bindingVersion, 1);
    await authority.setBindingDrop(false);
    const repaired = value(
      await api.handleApi(
        await h.auth(),
        request("rebindWorkspace", body, { workspaceId: binding.workspaceId }),
      ),
    );
    if (repaired.status !== 200) assert.fail("Missing repaired binding");
    assert.equal(repaired.body.bindingVersion, 2);
    assert.equal(repaired.body.revision, body.import.revision);
    assert.equal(repaired.body.manifestHash, manifestHash);
    const retried = value(
      await api.handleApi(
        await h.auth(),
        request("rebindWorkspace", body, { workspaceId: binding.workspaceId }),
      ),
    );
    assert.equal(retried.status, 200);
    assert.equal(
      channel.frames.filter((frame) => frame.type === "workspace.request").length,
      1,
      "durable authority receipt prevents another owner snapshot request",
    );
    assert.equal(
      (
        await h.cp.resolveExecutorGeneration(admin, {
          workspaceId: binding.workspaceId,
          bindingVersion: 3,
          executorId: "executor",
        })
      ).ok,
      false,
    );
  } finally {
    socket?.close();
    await h.close();
  }
});
