import assert from "node:assert/strict";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { assignedJob } from "./artifact-job.ts";
import { connected } from "./connection.ts";
import type { ArtifactControl } from "./fixtures/artifacts.ts";
import { harness, scope, uuid, value } from "./harness.ts";

const options = { fixturePath: "apps/worker/test/control/fixtures/artifacts.ts" };
function renewal(identity: D.ExecutionIdentity): D.ExecutorDelivery {
  return {
    executorId: "executor",
    generation: 1,
    frame: {
      type: "job.lease_update",
      requestId: uuid(),
      payload: { identity, leaseVersion: 2, expiresAt: Date.now() + 20000 },
    },
  };
}
async function entered(cp: Pick<ArtifactControl, "epochGateEntered">) {
  for (let n = 0; n < 100; n++) {
    if (await cp.epochGateEntered()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("actual command await must enter its controlled gate");
}

test("dispatch-only outbound omission captures one actual epoch; supplied epochs and executor ingress remain strict", async () => {
  const h = await harness<ArtifactControl>(options);
  let socket: WebSocket | undefined;
  try {
    const channel = await connected(h);
    socket = channel.socket;
    const job = await assignedJob(h, await h.auth());
    const credential = await h.mint({
      requestId: uuid(),
      role: "client",
      grants: [{ grantId: "dispatch", version: 1, resources: scope(["jobs.dispatch"]) }],
    });
    const ctx = await h.auth(credential.token);
    const input = renewal(job.identity);
    const admitted = await h.cp.deliverExecutorFrame(ctx, input);
    assert.equal(
      admitted.ok,
      true,
      "dispatch-only authority must forward without an executor list grant or guessed epoch",
    );
    const ack = value(admitted);
    await channel.wait("job.lease_update");
    const stored = JSON.parse(await h.cp.epochCommands()) as { delivery: D.ExecutorDelivery }[];
    assert.equal(
      stored[0]?.delivery.connectionEpoch,
      channel.epoch,
      "stored command must contain a concrete captured epoch",
    );
    assert.deepEqual(
      value(await h.cp.deliverExecutorFrame(ctx, { ...input, connectionEpoch: channel.epoch })),
      ack,
    );
    for (const epoch of [channel.epoch + 1, 0, -1, 1.5, Number.NaN])
      assert.equal(
        (await h.cp.deliverExecutorFrame(ctx, { ...input, connectionEpoch: epoch })).ok,
        false,
        "provided noncurrent or malformed epoch cannot be treated as omitted",
      );
    const missingIngress = await h.cp.deliverExecutorFrame(channel.executor, {
      executorId: "executor",
      generation: 1,
      frame: {
        type: "job.output",
        requestId: uuid(),
        payload: {
          identity: job.identity,
          sequence: 1,
          stream: "stdout",
          text: "unfenced ingress",
        },
      },
    });
    assert.equal(
      missingIngress.ok,
      false,
      "executor ingress still requires an explicit current epoch",
    );
    if (!missingIngress.ok) assert.equal(missingIngress.code, "unauthenticated");
    assert.equal(await h.cp.rowCount("inbox"), 0);
  } finally {
    socket?.close();
    await h.close();
  }
});

test("reconnect during actual hash or arming invalidates the captured attempt; deferred drain never rebinds it", async () => {
  for (const stage of ["hash", "arm", "drain"] as const) {
    const h = await harness<ArtifactControl>(options);
    const sockets: WebSocket[] = [];
    try {
      const channel = await connected(h);
      sockets.push(channel.socket);
      const actor = await h.auth();
      const job = await assignedJob(h, actor);
      const input = renewal(job.identity);
      await h.cp.gateEpoch(stage);
      const pending = h.cp.deliverExecutorFrame(actor, input);
      await entered(h.cp);
      const replacement = await connected(h);
      sockets.push(replacement.socket);
      assert.equal(replacement.epoch, channel.epoch + 1);
      await h.cp.releaseEpochGate();
      const result = await pending;
      if (stage !== "drain") {
        assert.equal(
          result.ok,
          false,
          `${stage}: reconnect after capture must reject before command persistence`,
        );
        assert.equal(await h.cp.rowCount("command"), 0);
      } else {
        assert.equal(result.ok, true, "persisted receipt does not certify socket delivery");
        const stored = JSON.parse(await h.cp.epochCommands()) as { delivery: D.ExecutorDelivery }[];
        assert.equal(stored[0]?.delivery.connectionEpoch, channel.epoch);
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(
          replacement.frames.some((frame) => frame.type === "job.lease_update"),
          false,
          "deferred command must never be sent on a replacement epoch",
        );
      }
      const retry = value(await h.cp.deliverExecutorFrame(actor, input));
      if (result.ok)
        assert.deepEqual(
          retry,
          result.value,
          "authorized recapture keeps the same digest and transport receipt",
        );
      await replacement.wait("job.lease_update");
      const stored = JSON.parse(await h.cp.epochCommands()) as { delivery: D.ExecutorDelivery }[];
      assert.equal(stored[0]?.delivery.connectionEpoch, replacement.epoch);
      const frame = stored[0]?.delivery.frame;
      assert.ok(frame && frame.type === "job.lease_update");
      assert.equal(frame.payload.identity.executionId, job.identity.executionId);
    } finally {
      for (const socket of sockets) socket.close();
      await h.close();
    }
  }
});

test("reconnect while actual private terminal proof is awaited invalidates the attempt before persisting a command", async () => {
  const h = await harness<ArtifactControl>(options);
  const sockets: WebSocket[] = [];
  try {
    const channel = await connected(h);
    sockets.push(channel.socket);
    const actor = await h.auth();
    const job = await assignedJob(h, actor);
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
    const agent = h.env.AGENT_SESSIONS.getByName("agent");
    for (const authority of [agent, h.env.WORKSPACES.getByName("workspace")])
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
    await agent.fetch(
      new Request("https://fixture/fixture/mode", { method: "POST", body: "hold" }),
    );
    const pending = h.cp.deliverExecutorFrame(actor, {
      executorId: "executor",
      generation: 1,
      frame: { type: "job.committed", requestId: uuid(), payload: proof },
    });
    let started = false;
    for (let n = 0; n < 100; n++) {
      const state = (await (
        await agent.fetch(new Request("https://fixture/fixture/proof"))
      ).json()) as { last?: { auth: D.AuthContext } };
      if (state.last?.auth.requestId === actor.requestId) {
        started = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(started, true, "actual private terminal proof must be in flight before reconnect");
    const replacement = await connected(h);
    sockets.push(replacement.socket);
    assert.equal(
      (await pending).ok,
      false,
      "terminal proof cannot authorize a replacement connection epoch",
    );
    assert.equal(await h.cp.rowCount("command"), 0);
    assert.equal(
      replacement.frames.some((frame) => frame.type === "job.committed"),
      false,
    );
  } finally {
    for (const socket of sockets) socket.close();
    await h.close();
  }
});
