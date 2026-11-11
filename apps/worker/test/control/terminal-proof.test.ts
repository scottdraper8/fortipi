import assert from "node:assert/strict";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { assignedJob } from "./artifact-job.ts";
import { connected } from "./connection.ts";
import type { ArtifactControl } from "./fixtures/artifacts.ts";
import { harness, request, scope, uuid, value } from "./harness.ts";

test("terminal forwarding uses bounded exact private proofs with current replacement authority and no public read grants", async () => {
  const h = await harness<ArtifactControl>({
    fixturePath: "apps/worker/test/control/fixtures/artifacts.ts",
  });
  let socket: WebSocket | undefined;
  try {
    const channel = await connected(h);
    socket = channel.socket;
    const makeActor = () =>
      h.mint({
        requestId: uuid(),
        role: "client",
        grants: [
          { grantId: uuid(), version: 1, resources: scope(["jobs.dispatch", "workspace.write"]) },
        ],
      });
    const original = await makeActor();
    const job = await assignedJob(h, await h.auth(original.token), {
      leaseExpiresAt: Date.now() + 3000,
    });
    const proof: D.JobCommitted = {
      identity: job.identity,
      terminalVersion: 2,
      eventSeq: 37,
      evidence: {
        kind: "verified-unchanged",
        workspaceId: "workspace",
        baseRevision: job.identity.baseRevision,
        executionId: job.identity.executionId,
        manifestHash: "a".repeat(64),
        observedAt: Date.now(),
      },
    };
    const authorities = [
      h.env.WORKSPACES.getByName("workspace"),
      h.env.AGENT_SESSIONS.getByName("agent"),
    ];
    for (const authority of authorities)
      assert.equal(
        (
          await authority.fetch(
            new Request("https://fixture/fixture/proof", {
              method: "POST",
              body: JSON.stringify(proof),
            }),
          )
        ).status,
        200,
      );
    const replacement = await h.mint({
      requestId: uuid(),
      role: "client",
      grants: [
        { grantId: uuid(), version: 1, resources: scope(["jobs.dispatch"]) },
        { grantId: uuid(), version: 1, resources: scope(["workspace.write"]) },
      ],
    });
    const ctx = await h.auth(replacement.token);
    value(
      await h.cp.revokeCredential(
        await h.auth(),
        request(
          "revokeCredential",
          { requestId: uuid(), expectedGeneration: 1 },
          { id: original.credential.credentialId },
        ),
      ),
    );
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, job.identity.lease.expiresAt - Date.now() + 10)),
    );
    const delivery: D.ExecutorDelivery = {
      executorId: "executor",
      generation: 1,
      connectionEpoch: channel.epoch,
      frame: { type: "job.committed", requestId: uuid(), payload: proof },
    };
    const ack = value(await h.cp.deliverExecutorFrame(ctx, delivery));
    assert.equal(ack.persisted, true);
    await channel.wait("job.committed");
    assert.equal(await h.cp.rowCount("command"), 1);
    for (let i = 0; i < authorities.length; i++) {
      const authority = authorities[i];
      assert.ok(authority);
      const captured = (await (
        await authority.fetch(new Request("https://fixture/fixture/proof"))
      ).json()) as { last: { path: string; auth: D.AuthContext; body: string } };
      assert.equal(
        captured.last.path,
        i === 0 ? "/__fortipi/terminal-proof" : `/__fortipi/terminal-proof/${job.identity.jobId}`,
      );
      assert.equal(captured.last.auth.credentialId, replacement.credential.credentialId);
      assert.ok(captured.last.auth.registrationId);
      const registered = JSON.parse(
        (await h.cp.registrationRecord(captured.last.auth.registrationId)) ?? "null",
      ) as D.AuthorityRegistration;
      assert.deepEqual(
        registered.resources.actions,
        [i === 0 ? "workspace.write" : "jobs.dispatch"],
        "each proof recipient receives its own original operation action, without requiring a combined grant",
      );
      assert.deepEqual(JSON.parse(captured.last.body), proof);
      assert.equal(
        captured.last.auth.grants.some(
          (g) =>
            g.resources.actions.includes("jobs.read") ||
            g.resources.actions.includes("conversations.read") ||
            g.resources.actions.includes("workspace.read"),
        ),
        false,
      );
    }
    const readRecovery = await h.mint({
      requestId: uuid(),
      role: "client",
      grants: [
        { grantId: uuid(), version: 1, resources: scope(["jobs.dispatch"]) },
        { grantId: uuid(), version: 1, resources: scope(["workspace.read"]) },
      ],
    });
    const readAck = value(
      await h.cp.deliverExecutorFrame(await h.auth(readRecovery.token), delivery),
    );
    assert.deepEqual(
      readAck,
      ack,
      "unchanged retained base may be proved with current read authority under the same immutable job evidence",
    );
    const changed = structuredClone(proof);
    changed.eventSeq = 38;
    const rejected = await h.cp.deliverExecutorFrame(ctx, {
      ...delivery,
      frame: { type: "job.committed", requestId: uuid(), payload: changed },
    });
    assert.equal(
      rejected.ok,
      false,
      "exact durable event coordinate is required, not a timestamp inference",
    );
    assert.equal(await h.cp.rowCount("command"), 1);
    const agent = authorities[1];
    assert.ok(agent);
    await agent.fetch(
      new Request("https://fixture/fixture/mode", { method: "POST", body: "wrong-event" }),
    );
    assert.equal(
      (await h.cp.deliverExecutorFrame(ctx, delivery)).ok,
      false,
      "CP must compare exact authoritative reply coordinates before acknowledging terminal delivery",
    );
    await agent.fetch(
      new Request("https://fixture/fixture/mode", { method: "POST", body: "oversize" }),
    );
    assert.equal(
      (await h.cp.deliverExecutorFrame(ctx, delivery)).ok,
      false,
      "even a cached authority command cannot bypass fresh bounded proof",
    );
    await agent.fetch(
      new Request("https://fixture/fixture/mode", { method: "POST", body: "hold" }),
    );
    const before = await h.cp.rowCount("command");
    const heldCtx = await h.auth(replacement.token);
    const pending = h.cp.deliverExecutorFrame(heldCtx, delivery);
    // Wait for actual private fetch entry rather than assuming a fixed scheduling delay.
    let entered = false;
    for (let n = 0; n < 100; n++) {
      const state = (await (
        await agent.fetch(new Request("https://fixture/fixture/proof"))
      ).json()) as { last?: { auth: D.AuthContext } };
      if (state.last?.auth.requestId === heldCtx.requestId) {
        entered = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      entered,
      true,
      "held terminal proof must actually enter its private authority before revocation",
    );
    value(
      await h.cp.revokeCredential(
        await h.auth(),
        request(
          "revokeCredential",
          { requestId: uuid(), expectedGeneration: 1 },
          { id: replacement.credential.credentialId },
        ),
      ),
    );
    assert.equal(
      (await pending).ok,
      false,
      "current credential floors are checked after awaited private proof",
    );
    assert.equal(await h.cp.rowCount("command"), before);
    await agent.fetch(
      new Request("https://fixture/fixture/mode", { method: "POST", body: "hold-grant" }),
    );
    const grantExpiry = Date.now() + 2000;
    const short = await h.mint({
      requestId: uuid(),
      role: "client",
      grants: [
        {
          grantId: uuid(),
          version: 1,
          resources: scope(["jobs.dispatch"]),
          expiresAt: grantExpiry,
        },
        {
          grantId: uuid(),
          version: 1,
          resources: scope(["workspace.write"]),
          expiresAt: grantExpiry,
        },
      ],
    });
    const shortCtx = await h.auth(short.token);
    const expiring = h.cp.deliverExecutorFrame(shortCtx, delivery);
    let grantProofEntered = false;
    for (let n = 0; n < 100; n++) {
      const state = (await (
        await agent.fetch(new Request("https://fixture/fixture/proof"))
      ).json()) as { last?: { auth: D.AuthContext } };
      if (state.last?.auth.requestId === shortCtx.requestId) {
        grantProofEntered = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      grantProofEntered,
      true,
      "expiring grant must be valid when its private proof actually starts",
    );
    assert.ok(Date.now() < grantExpiry);
    const expired = await expiring;
    assert.equal(
      expired.ok,
      false,
      "an awaited proof cannot outlive its matching grant while the credential remains active",
    );
    if (!expired.ok) assert.equal(expired.code, "unauthorized");
  } finally {
    socket?.close();
    await h.close();
  }
});

test("explicit job lease updates use the retained renewal and cannot regress, inflate or revive authority", async () => {
  const h = await harness<ArtifactControl>({
    fixturePath: "apps/worker/test/control/fixtures/artifacts.ts",
  });
  let socket: WebSocket | undefined;
  try {
    const channel = await connected(h);
    socket = channel.socket;
    const actor = await h.auth();
    const job = await assignedJob(h, actor, { leaseExpiresAt: Date.now() + 1500 });
    const update = (version: number, expiresAt: number): D.ExecutorDelivery => ({
      executorId: "executor",
      generation: 1,
      connectionEpoch: channel.epoch,
      frame: {
        type: "job.lease_update",
        requestId: uuid(),
        payload: { identity: job.identity, leaseVersion: version, expiresAt },
      },
    });
    const first = update(2, Date.now() + 2500);
    const ack = value(await h.cp.deliverExecutorFrame(actor, first));
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, job.identity.lease.expiresAt - Date.now() + 10)),
    );
    const second = update(3, Date.now() + 1500);
    const secondAck = value(await h.cp.deliverExecutorFrame(actor, second));
    assert.deepEqual(
      value(await h.cp.deliverExecutorFrame(actor, second)),
      secondAck,
      "a matching renewal delivery reuses its durable receipt",
    );
    const retained = await h.cp.leaseRecord(job.identity.lease.leaseId);
    assert.deepEqual(value(await h.cp.deliverExecutorFrame(actor, first)), ack);
    assert.equal(
      await h.cp.leaseRecord(job.identity.lease.leaseId),
      retained,
      "an older delivery receipt cannot regress the retained lease",
    );
    assert.equal(
      (await h.cp.deliverExecutorFrame(actor, update(3, Date.now() + 2000))).ok,
      false,
      "same renewal version with changed expiry conflicts",
    );
    assert.equal(
      (await h.cp.deliverExecutorFrame(actor, update(4, Date.now() + 40000))).ok,
      false,
      "no authority update may exceed the wire lease bound",
    );
    if (second.frame.type !== "job.lease_update") assert.fail("Not a lease update");
    const retainedExpiry = second.frame.payload.expiresAt;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, retainedExpiry - Date.now() + 10)),
    );
    assert.equal(
      (await h.cp.deliverExecutorFrame(actor, update(4, Date.now() + 1500))).ok,
      false,
      "an expired retained lease cannot be revived from the original assignment",
    );
  } finally {
    socket?.close();
    await h.close();
  }
});
