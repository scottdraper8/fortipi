import assert from "node:assert/strict";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { assignedJob } from "./artifact-job.ts";
import { connected } from "./connection.ts";
import type { CompletionControl } from "./fixtures/completion.ts";
import { harness, request, scope, uuid, value } from "./harness.ts";

async function setup(
  options: { expiry?: boolean; splitAfterExpiry?: boolean; unsent?: boolean } = {},
) {
  const h = await harness<CompletionControl>({
    fixturePath: "apps/worker/test/control/fixtures/completion.ts",
  });
  let channel: Awaited<ReturnType<typeof connected>> | undefined;
  try {
    const left = 60000 - (Date.now() % 60000);
    if (left < 12000) await new Promise((resolve) => setTimeout(resolve, left + 30));
    channel = await connected(h);
    const resources = {
      ...scope(["jobs.dispatch", "workspace.write"]),
      tools: ["shell"],
      backendIds: [],
    };
    const expiresAt = Date.now() + 1800;
    const grants: D.Grant[] = [
      {
        grantId: uuid(),
        version: 1,
        resources,
        ...(options.expiry || options.splitAfterExpiry ? { expiresAt } : {}),
      },
    ];
    if (options.splitAfterExpiry)
      for (const action of resources.actions)
        grants.push({
          grantId: uuid(),
          version: 1,
          resources: { ...resources, actions: [action] },
        });
    const issued = await h.mint({ requestId: uuid(), role: "client", grants });
    const raw = await h.auth(issued.token);
    const job = await assignedJob(h, raw, {
      leaseExpiresAt: options.expiry || options.splitAfterExpiry ? expiresAt : Date.now() + 20000,
      ...(options.unsent ? { deferAssignment: true } : {}),
    });
    const actor = { ...raw, registrationId: job.reservation.registrationIds.agent };
    const input: D.CancelRequest = {
      identity: job.identity,
      requestId: uuid(),
      reason: "Clean up this admitted execution",
    };
    return {
      ...h,
      channel,
      issued,
      raw,
      actor,
      resources,
      job,
      input,
      expiresAt,
      async close() {
        channel?.socket.close();
        await h.close();
      },
    };
  } catch (error) {
    channel?.socket.close();
    await h.close();
    throw error;
  }
}
const disposition: D.CancelDisposition = { state: "stopped", possibleExternalEffects: true };
async function cancelFrame(h: Awaited<ReturnType<typeof setup>>) {
  const frame = await h.channel.wait(
    "job.cancel",
    (frame) => frame.requestId === h.input.requestId,
  );
  if (frame.type !== "job.cancel") assert.fail("Actual cancellation command required");
  assert.deepEqual(frame, {
    type: "job.cancel",
    requestId: h.input.requestId,
    payload: { identity: h.job.identity, reason: h.input.reason },
  });
  return frame;
}
function acknowledge(h: Awaited<ReturnType<typeof setup>>) {
  h.channel.send({
    type: "job.cancel_ack",
    requestId: h.input.requestId,
    payload: { identity: h.job.identity, disposition },
  });
}
async function terminal(h: Awaited<ReturnType<typeof setup>>) {
  const proof: D.JobCommitted = {
    identity: h.job.identity,
    terminalVersion: 2,
    eventSeq: 37,
    evidence: {
      kind: "verified-unchanged",
      workspaceId: "workspace",
      baseRevision: h.job.identity.baseRevision,
      executionId: h.job.identity.executionId,
      manifestHash: "a".repeat(64),
      observedAt: Date.now(),
    },
  };
  // Existing controlled proof authorities qualify CP transport/closure only.
  for (const peer of [
    h.env.AGENT_SESSIONS.getByName("agent"),
    h.env.WORKSPACES.getByName("workspace"),
  ])
    assert.equal(
      (
        await peer.fetch(
          new Request("https://fixture/fixture/proof", {
            method: "POST",
            body: JSON.stringify(proof),
          }),
        )
      ).status,
      200,
    );
  value(
    await h.cp.deliverExecutorFrame(h.actor, {
      executorId: "executor",
      generation: 1,
      connectionEpoch: h.channel.epoch,
      frame: { type: "job.committed", requestId: uuid(), payload: proof },
    }),
  );
  await h.channel.wait("job.committed");
}

test("exact registered attempted owner cancels without user task/backend cancel grants; duplicates retain one command and disposition", async () => {
  const h = await setup();
  try {
    assert.deepEqual(h.actor.grants[0]?.resources.actions, ["jobs.dispatch", "workspace.write"]);
    for (const actor of [
      h.raw,
      { ...h.actor, registrationId: "missing" },
      { ...h.actor, registrationId: h.job.reservation.registrationIds.workspace },
    ])
      assert.equal(
        (await h.cp.cancelExecution(actor, h.input)).ok,
        false,
        "Raw dispatch permission or a wrong registration cannot cancel",
      );
    for (const identity of [
      { ...h.job.identity, executionId: uuid() },
      { ...h.job.identity, lease: { ...h.job.identity.lease, fence: "changed" } },
      {
        ...h.job.identity,
        lease: { ...h.job.identity.lease, expiresAt: h.job.identity.lease.expiresAt + 1 },
      },
    ])
      assert.equal((await h.cp.cancelExecution(h.actor, { ...h.input, identity })).ok, false);
    const other = await h.mint({
      requestId: uuid(),
      role: "client",
      grants: [{ grantId: uuid(), version: 1, resources: h.resources }],
    });
    const otherRaw = await h.auth(other.token);
    const registration = value(
      await h.cp.registerAuthorityRecipient(otherRaw, {
        credential: other.credential,
        recipient: { kind: "agent", id: "agent" },
        resources: h.resources,
      }),
    );
    assert.equal(
      (
        await h.cp.cancelExecution(
          { ...otherRaw, registrationId: registration.registrationId },
          h.input,
        )
      ).ok,
      false,
      "Another registered dispatcher is not the original owner",
    );
    assert.equal(h.channel.frames.filter((frame) => frame.type === "job.cancel").length, 0);
    const before = await h.cp.admissions();
    const first = h.cp.cancelExecution(h.actor, h.input);
    const duplicate = h.cp.cancelExecution(h.actor, h.input);
    await cancelFrame(h);
    acknowledge(h);
    assert.deepEqual(value(await first), disposition);
    assert.deepEqual(value(await duplicate), disposition);
    assert.deepEqual(value(await h.cp.cancelExecution(h.actor, h.input)), disposition);
    const after = await h.cp.admissions();
    assert.equal(after.application, before.application);
    assert.equal(
      after.repair,
      before.repair + 3,
      "Every physical cleanup RPC spends bounded repair capacity",
    );
    assert.equal(
      (await h.cp.cancelExecution(h.actor, { ...h.input, requestId: uuid() })).ok,
      false,
    );
    assert.equal(
      (await h.cp.cancelExecution(h.actor, { ...h.input, reason: "changed" })).ok,
      false,
    );
    assert.equal(h.channel.frames.filter((frame) => frame.type === "job.cancel").length, 1);
    assert.equal(h.channel.frames.filter((frame) => frame.type === "job.assign").length, 1);
    await terminal(h);
    const closed = await h.cp.admissions();
    assert.equal(
      (await h.cp.cancelExecution(h.actor, h.input)).ok,
      false,
      "Durable terminal proof closes even cached owner cleanup",
    );
    assert.equal((await h.cp.admissions()).repair, closed.repair);
    assert.equal(h.channel.frames.filter((frame) => frame.type === "job.cancel").length, 1);
  } finally {
    await h.close();
  }
});

test("cancellation rechecks original credential, target, grant and one-grant coverage after the actual executor await", async () => {
  for (const fault of ["credential", "executor", "grant", "split"] as const) {
    const h = await setup({
      ...(fault === "grant" ? { expiry: true } : {}),
      ...(fault === "split" ? { splitAfterExpiry: true } : {}),
    });
    try {
      const pending = h.cp.cancelExecution(h.actor, h.input);
      await cancelFrame(h);
      if (fault === "credential")
        value(
          await h.cp.revokeCredential(
            await h.auth(),
            request(
              "revokeCredential",
              { requestId: uuid(), expectedGeneration: h.actor.generation },
              { id: h.actor.credentialId },
            ),
          ),
        );
      else if (fault === "executor")
        value(
          await h.cp.revokeExecutor(
            await h.auth(),
            request(
              "revokeExecutor",
              { requestId: uuid(), expectedGeneration: 1 },
              { id: "executor" },
            ),
          ),
        );
      else
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, h.expiresAt - Date.now() + 20)),
        );
      if (fault !== "executor") acknowledge(h);
      assert.equal(
        (await pending).ok,
        false,
        "A physical cancellation is not permission to disclose its result after authority changes",
      );
      assert.equal(
        (await h.cp.cancelExecution(h.actor, h.input)).ok,
        false,
        "Stale authority cannot read a retained cancellation disposition",
      );
      assert.equal(h.channel.frames.filter((frame) => frame.type === "job.cancel").length, 1);
      assert.equal(h.channel.frames.filter((frame) => frame.type === "job.assign").length, 1);
    } finally {
      await h.close();
    }
  }
});

test("only attempted exact owner cleanup can use unchanged completion headroom after actual application exhaustion", async () => {
  const h = await setup();
  try {
    const unsent = await assignedJob(h, h.raw, { deferAssignment: true });
    const actors = [h.raw, await h.auth()];
    for (let i = 0; i < 3; i++) {
      const issued = await h.mint({
        requestId: uuid(),
        role: "client",
        grants: [{ grantId: uuid(), version: 1, resources: scope(["agents.list"]) }],
      });
      actors.push(await h.auth(issued.token));
    }
    for (const actor of actors)
      for (let i = 0; i < 31; i++) {
        const result = await h.cp.listAgents(actor, request("listAgents", undefined));
        if (!result.ok && result.code === "rate_limited") break;
      }
    assert.equal((await h.cp.admissions()).application, 90);
    const before = await h.cp.admissions();
    for (const [actor, input] of [
      [h.raw, h.input],
      [{ ...h.actor, registrationId: "missing" }, h.input],
      [h.actor, { ...h.input, identity: { ...h.job.identity, executionId: uuid() } }],
      [
        { ...h.raw, registrationId: unsent.reservation.registrationIds.agent },
        { ...h.input, identity: unsent.identity },
      ],
    ] as const) {
      const result = await h.cp.cancelExecution(actor, input);
      assert.equal(result.ok, false);
      if (!result.ok)
        assert.equal(
          result.code,
          "rate_limited",
          "Ineligible cleanup cannot borrow repair capacity",
        );
    }
    assert.equal((await h.cp.admissions()).repair, before.repair);
    const pending = h.cp.cancelExecution(h.actor, h.input);
    await cancelFrame(h);
    acknowledge(h);
    assert.deepEqual(value(await pending), disposition);
    const after = await h.cp.admissions();
    assert.equal(after.application, 90);
    assert.equal(after.repair, before.repair + 1);
    assert.equal(h.channel.frames.filter((frame) => frame.type === "job.cancel").length, 1);
    assert.equal(h.channel.frames.filter((frame) => frame.type === "job.assign").length, 1);
  } finally {
    await h.close();
  }
});
