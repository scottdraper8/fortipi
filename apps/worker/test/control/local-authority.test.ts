import assert from "node:assert/strict";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { connected, localBinding } from "./connection.ts";
import { harness, request, uuid, value } from "./harness.ts";

async function setup(options: { leaseMs?: number; grantMs?: number } = {}) {
  const h = await harness({
    fixturePath: "apps/worker/test/control/fixtures/local-authority.ts",
    workspaceClass: "TestWorkspace",
  });
  let socket: WebSocket | undefined;
  try {
    let channel = await connected(h);
    socket = channel.socket;
    const binding = await localBinding(h, channel, { version: 1, entries: [] }, "imported_base");
    channel = binding.channel;
    socket = channel.socket;
    const resources: D.ResourceScope = {
      agentIds: ["agent"],
      conversationIds: ["conversation"],
      workspaceIds: [binding.workspaceId],
      executorIds: ["executor"],
      backendIds: [],
      tools: ["shell"],
      actions: ["jobs.dispatch", "workspace.write"],
    };
    const grantExpiresAt = options.grantMs ? Date.now() + options.grantMs : undefined;
    const issued = await h.mint({
      requestId: uuid(),
      role: "client",
      grants: [
        {
          grantId: "execute",
          version: 1,
          resources,
          ...(grantExpiresAt ? { expiresAt: grantExpiresAt } : {}),
        },
      ],
    });
    const auth = await h.auth(issued.token);
    const deadline = Date.now() + 60000;
    const reservation = value(
      await h.cp.reserveTarget(auth, {
        ownerKind: "job",
        jobId: uuid(),
        executionId: uuid(),
        operationId: uuid(),
        operationDigest: "a".repeat(64),
        agentId: "agent",
        conversationId: "conversation",
        workspaceId: binding.workspaceId,
        bindingVersion: 2,
        target: { kind: "executor", executorId: "executor", generation: 1 },
        actions: ["jobs.dispatch", "workspace.write"],
        deadline,
        expiresAt: Math.min(
          Date.now() + (options.leaseMs ?? 20000),
          grantExpiresAt ?? Number.MAX_SAFE_INTEGER,
        ),
      }),
    );
    assert.equal(reservation.ownerKind, "job");
    if (reservation.ownerKind !== "job") assert.fail("Job reservation required");
    const ws = h.env.WORKSPACES.getByName(binding.workspaceId);
    const workspaceAuth = { ...auth, registrationId: reservation.registrationIds.workspace };
    const lease = value(await ws.acquireLease(workspaceAuth, reservation));
    const prepare: D.LocalPrepare = {
      kind: "prepare",
      operationId: reservation.operationId,
      operationDigest: reservation.operationDigest,
      workspaceId: binding.workspaceId,
      bindingVersion: 2,
      rootBindingId: "root",
      executorId: "executor",
      executorGeneration: 1,
      credential: reservation.credential,
      baseRevision: binding.revision,
      lease,
      deadline,
      commitId: uuid(),
      expectedManifestHash: binding.manifestHash,
      mode: {
        kind: "native-execution",
        jobId: reservation.jobId,
        executionId: reservation.executionId,
        assignmentDigest: "b".repeat(64),
      },
    };
    const agentAuth = { ...auth, registrationId: reservation.registrationIds.agent };
    const reply = async () => {
      const frame = await channel.wait(
        "workspace.request",
        (f) => f.type === "workspace.request" && f.payload.request.kind === "prepare",
      );
      if (frame.type !== "workspace.request") assert.fail("Missing prepare");
      channel.send({
        type: "workspace.response",
        requestId: frame.requestId,
        payload: {
          requestId: frame.payload.requestId,
          correlationId: frame.payload.correlationId,
          response: {
            state: "prepared",
            preparationId: "actual_native_preparation",
            operationId: prepare.operationId,
            operationDigest: prepare.operationDigest,
            preManifestHash: prepare.expectedManifestHash,
            expiresAt: Math.min(prepare.lease.expiresAt, Date.now() + 10000),
          },
        },
      });
    };
    return {
      ...h,
      agentAuth,
      workspaceAuth,
      prepare,
      reservation,
      grantExpiresAt,
      issued,
      reply,
      ws,
      async close() {
        socket?.close();
        await h.close();
      },
    };
  } catch (error) {
    socket?.close();
    await h.close();
    throw error;
  }
}

test("native preparation forwards the retained Workspace registration to the actual lease authority while preserving Agent ingress", async () => {
  const h = await setup();
  try {
    assert.notEqual(h.agentAuth.registrationId, h.workspaceAuth.registrationId);
    assert.ok(h.prepare.lease.ownerKind === "job" && h.prepare.mode.kind === "native-execution");
    for (const forged of [
      {
        ...h.prepare,
        lease: { ...h.prepare.lease, registrationId: h.agentAuth.registrationId ?? "missing" },
      },
      { ...h.prepare, lease: { ...h.prepare.lease, jobId: "another_job" } },
      { ...h.prepare, mode: { ...h.prepare.mode, executionId: "another_execution" } },
      { ...h.prepare, operationDigest: "c".repeat(64) },
    ])
      assert.equal(
        (await h.cp.requestLocalWorkspace(h.agentAuth, forged)).ok,
        false,
        "caller-selected registration/job/execution/digest cannot replace retained authority",
      );
    const pending = h.cp.requestLocalWorkspace(h.agentAuth, h.prepare);
    await h.reply();
    const outcome = await pending;
    assert.equal(
      outcome.ok,
      true,
      "Agent ingress must prepare through the actual retained Workspace lease registration",
    );
    assert.equal(await h.cp.rowCount("local_prepared"), 1);
    const captured = await (
      await h.ws.fetch(new Request("https://fixture/fixture/prepare"))
    ).json();
    assert.deepEqual(
      captured,
      { entered: false, auth: h.workspaceAuth },
      "handoff changes only the exact retained recipient registration",
    );
    assert.equal(h.agentAuth.registrationId, h.reservation.registrationIds.agent);
  } finally {
    await h.close();
  }
});

test("preparation cannot persist a CP acknowledgment after awaited Workspace authority loses current grant, lease or floors", async () => {
  for (const fault of ["credential", "executor", "lease", "grant"] as const) {
    const h = await setup({
      ...(fault === "lease" ? { leaseMs: 1500 } : {}),
      ...(fault === "grant" ? { grantMs: 1500 } : {}),
    });
    try {
      await h.ws.fetch(
        new Request("https://fixture/fixture/prepare", { method: "POST", body: "hold" }),
      );
      const pending = h.cp.requestLocalWorkspace(h.agentAuth, h.prepare);
      await h.reply();
      let entered = false;
      for (let n = 0; n < 100; n++) {
        const response = await h.ws.fetch(new Request("https://fixture/fixture/prepare"));
        const state: unknown = await response.json();
        if (state && typeof state === "object" && "entered" in state && state.entered === true) {
          entered = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(
        entered,
        true,
        "real Workspace lease guard must succeed before the response is held",
      );
      if (fault === "credential")
        value(
          await h.cp.revokeCredential(
            await h.auth(),
            request(
              "revokeCredential",
              {
                requestId: uuid(),
                expectedGeneration: 1,
              },
              { id: h.issued.credential.credentialId },
            ),
          ),
        );
      else if (fault === "executor")
        value(
          await h.cp.revokeExecutor(
            await h.auth(),
            request(
              "revokeExecutor",
              {
                requestId: uuid(),
                expectedGeneration: 1,
              },
              { id: "executor" },
            ),
          ),
        );
      else
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.max(
              0,
              Math.min(h.prepare.lease.expiresAt, h.grantExpiresAt ?? Number.MAX_SAFE_INTEGER) -
                Date.now() +
                20,
            ),
          ),
        );
      await h.ws.fetch(
        new Request("https://fixture/fixture/prepare", { method: "POST", body: "release" }),
      );
      assert.equal(
        (await pending).ok,
        false,
        `${fault}: awaited preparation must not acknowledge stale authority`,
      );
      assert.equal(
        await h.cp.rowCount("local_prepared"),
        0,
        `${fault}: stale preparation must not persist CP acknowledgment state`,
      );
    } finally {
      await h.close();
    }
  }
});
