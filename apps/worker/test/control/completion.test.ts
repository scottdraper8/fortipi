import assert from "node:assert/strict";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { assignedJob } from "./artifact-job.ts";
import { connected } from "./connection.ts";
import type { CompletionControl } from "./fixtures/completion.ts";
import { harness, request, scope, uuid, value } from "./harness.ts";

async function setup(options: { grantMs?: number; leaseMs?: number; actions?: string[] } = {}) {
  const h = await harness<CompletionControl>({
    fixturePath: "apps/worker/test/control/fixtures/completion.ts",
  });
  let socket: WebSocket | undefined;
  try {
    const channel = await connected(h);
    socket = channel.socket;
    const left = 60000 - (Date.now() % 60000);
    if (left < 12000) await new Promise((resolve) => setTimeout(resolve, left + 30));
    const resources = {
      ...scope(options.actions ?? ["jobs.dispatch", "workspace.write"]),
      tools: ["shell"],
      backendIds: [],
    };
    const issued = await h.mint({
      requestId: uuid(),
      role: "client",
      grants: [
        {
          grantId: "operation",
          version: 1,
          resources,
          ...(options.grantMs ? { expiresAt: Date.now() + options.grantMs } : {}),
        },
      ],
    });
    const auth = await h.auth(issued.token);
    const job = await assignedJob(h, auth, {
      leaseExpiresAt: Math.min(
        Date.now() + (options.leaseMs ?? 20000),
        auth.grants[0]?.expiresAt ?? Number.MAX_SAFE_INTEGER,
      ),
      ...(options.actions ? { actions: options.actions } : {}),
    });
    const registration = value(
      await h.cp.registerAuthorityRecipient(auth, {
        credential: issued.credential,
        recipient: { kind: "agent", id: "agent" },
        // The actual Agent job registration has dispatch, while the grant carries all retained actions.
        resources: { ...resources, actions: ["jobs.dispatch"] },
      }),
    );
    const actor = { ...auth, registrationId: registration.registrationId };
    const query = async (ctx = actor, identity = job.identity) => {
      channel.frames.splice(0);
      const pending = h.cp.queryExecution(ctx, identity);
      const frame = await channel.wait("job.query");
      if (frame.type !== "job.query") assert.fail("Missing actual query frame");
      channel.send({
        type: "job.query_result",
        requestId: frame.requestId,
        payload: { identity: frame.payload, state: "terminal" },
      });
      return pending;
    };
    return {
      ...h,
      channel,
      actor,
      unregistered: auth,
      issued,
      job,
      resources,
      query,
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

test("registered execution recovery checks its retained owner and one current logical grant, including historical and read-only jobs", async () => {
  for (const actions of [["jobs.dispatch", "workspace.write"], ["jobs.dispatch"]]) {
    const h = await setup({ leaseMs: 1500, actions });
    try {
      for (const ctx of [
        h.unregistered,
        { ...h.actor, registrationId: "missing" },
        { ...h.actor, registrationId: h.job.reservation.registrationIds.workspace },
      ])
        assert.equal(
          (await h.cp.queryExecution(ctx, h.job.identity)).ok,
          false,
          "raw and wrong recipient registrations cannot recover dispatch-only jobs",
        );
      for (const identity of [
        { ...h.job.identity, executionId: uuid() },
        { ...h.job.identity, lease: { ...h.job.identity.lease, fence: "2" } },
        {
          ...h.job.identity,
          lease: { ...h.job.identity.lease, expiresAt: h.job.identity.lease.expiresAt + 1 },
        },
      ])
        assert.equal(
          (await h.cp.queryExecution(h.actor, identity)).ok,
          false,
          "query cannot invent identity, fence or lease observations",
        );
      const withoutTool = value(
        await h.cp.registerAuthorityRecipient(h.actor, {
          credential: h.issued.credential,
          recipient: { kind: "agent", id: "agent" },
          resources: { ...h.resources, actions: ["jobs.dispatch"], tools: [] },
        }),
      );
      assert.equal(
        (
          await h.cp.queryExecution(
            { ...h.actor, registrationId: withoutTool.registrationId },
            h.job.identity,
          )
        ).ok,
        false,
        "trusted registration must cover the actual retained tool, not merely its Agent",
      );
      assert.equal(
        value(await h.query()).state,
        "terminal",
        "current registered dispatch query must require no hidden read or write grant",
      );
      if (actions.includes("workspace.write")) {
        const renewed = { ...h.job.identity.lease, leaseVersion: 2, expiresAt: Date.now() + 6000 };
        value(
          await h.cp.deliverExecutorFrame(h.actor, {
            executorId: "executor",
            generation: 1,
            connectionEpoch: h.channel.epoch,
            frame: {
              type: "job.lease_update",
              requestId: uuid(),
              payload: {
                identity: h.job.identity,
                leaseVersion: renewed.leaseVersion,
                expiresAt: renewed.expiresAt,
              },
            },
          }),
        );
        assert.equal(
          (await h.cp.queryExecution(h.actor, { ...h.job.identity, lease: renewed })).ok,
          true,
          "actual CP-validated renewal is a permitted observation without rewriting original identity",
        );
        assert.equal(
          (
            await h.cp.queryExecution(h.actor, {
              ...h.job.identity,
              lease: { ...renewed, leaseVersion: 3 },
            })
          ).ok,
          false,
          "private recovery cannot manufacture another renewal version",
        );
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, h.job.identity.lease.expiresAt - Date.now() + 15)),
      );
      assert.equal(
        value(await h.cp.queryExecution(h.actor, h.job.identity)).state,
        "terminal",
        "expired effect lease cannot block retained read-only recovery",
      );
      const before = await h.cp.admissions();
      assert.equal(value(await h.cp.queryExecution(h.actor, h.job.identity)).state, "terminal");
      const after = await h.cp.admissions();
      assert.equal(
        after.repair - before.repair,
        1,
        "each repeated physical query RPC spends one repair admission",
      );
      assert.equal(after.application, before.application);
    } finally {
      await h.close();
    }
  }
});

test("current registered queries use only unchanged repair headroom; wrong claims and durable terminal proof cannot borrow it", async () => {
  const h = await setup();
  try {
    value(await h.query()); // Actual WS evidence is now retained; subsequent calls are real CP RPCs.
    const extra = [];
    for (let n = 0; n < 3; n++) {
      const issued = await h.mint({
        requestId: uuid(),
        role: "client",
        grants: [{ grantId: uuid(), version: 1, resources: scope(["agents.list"]) }],
      });
      extra.push(await h.auth(issued.token));
    }
    for (const ctx of [h.unregistered, await h.auth(), ...extra])
      for (let n = 0; n < 31; n++) {
        const result = await h.cp.listAgents(ctx, request("listAgents", undefined));
        if (!result.ok && result.code === "rate_limited") break;
      }
    assert.equal(
      (await h.cp.admissions()).application,
      90,
      "actual distinct RPCs exhaust unchanged application capacity",
    );
    for (const [ctx, identity] of [
      [h.unregistered, h.job.identity],
      [h.actor, { ...h.job.identity, executionId: uuid() }],
      [{ ...h.actor, registrationId: "forged" }, h.job.identity],
    ] as const) {
      const result = await h.cp.queryExecution(ctx, identity);
      assert.equal(result.ok, false, "unvalidated recovery cannot borrow repair headroom");
      if (!result.ok)
        assert.equal(
          result.code,
          "rate_limited",
          "unvalidated queries must stay on ordinary admission",
        );
    }
    while ((await h.cp.admissions()).repair < 29)
      assert.equal(
        (await h.cp.queryExecution(h.actor, h.job.identity)).ok,
        true,
        "retained current query must survive new application pressure",
      );
    const race = await Promise.all([
      h.cp.queryExecution(h.actor, h.job.identity),
      h.cp.queryExecution(h.actor, h.job.identity),
    ]);
    assert.equal(
      race.filter((result) => result.ok).length,
      1,
      "exactly one actual query takes the final install and repair slot",
    );
    const exhausted = await h.cp.admissions();
    assert.equal(exhausted.application, 90);
    assert.equal(exhausted.repair, 30);
    assert.equal(
      (await h.cp.queryExecution(h.actor, h.job.identity)).ok,
      false,
      "same requestId and EID cannot hide physical retries",
    );
  } finally {
    await h.close();
  }

  const closed = await setup();
  try {
    value(await closed.query());
    const proof: D.JobCommitted = {
      identity: closed.job.identity,
      terminalVersion: 2,
      eventSeq: 37,
      evidence: {
        kind: "verified-unchanged",
        workspaceId: "workspace",
        baseRevision: closed.job.identity.baseRevision,
        executionId: closed.job.identity.executionId,
        manifestHash: "a".repeat(64),
        observedAt: Date.now(),
      },
    };
    for (const recipient of [
      closed.env.WORKSPACES.getByName("workspace"),
      closed.env.AGENT_SESSIONS.getByName("agent"),
    ])
      assert.equal(
        (
          await recipient.fetch(
            new Request("https://fixture/fixture/proof", {
              method: "POST",
              body: JSON.stringify(proof),
            }),
          )
        ).status,
        200,
      );
    value(
      await closed.cp.deliverExecutorFrame(closed.actor, {
        executorId: "executor",
        generation: 1,
        connectionEpoch: closed.channel.epoch,
        frame: { type: "job.committed", requestId: uuid(), payload: proof },
      }),
    );
    assert.equal(await closed.cp.rowCount("command"), 1);
    const before = await closed.cp.admissions();
    assert.equal(
      (await closed.cp.queryExecution(closed.actor, closed.job.identity)).ok,
      false,
      "actual retained durable terminal proof closes private recovery eligibility even without transport ACK",
    );
    const after = await closed.cp.admissions();
    assert.equal(after.repair, before.repair);
    assert.equal(after.application, before.application + 1);
  } finally {
    await closed.close();
  }
});

test("registered query revalidates credential, grant and executor floors after awaited native evidence", async () => {
  for (const fault of ["credential", "executor", "grant"] as const) {
    const h = await setup({ ...(fault === "grant" ? { grantMs: 1800 } : {}) });
    try {
      h.channel.frames.splice(0);
      const pending = h.cp.queryExecution(h.actor, h.job.identity);
      const frame = await h.channel.wait("job.query");
      if (frame.type !== "job.query") assert.fail("Missing actual query frame");
      if (fault === "credential")
        value(
          await h.cp.revokeCredential(
            await h.auth(),
            request(
              "revokeCredential",
              { requestId: uuid(), expectedGeneration: 1 },
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
          setTimeout(resolve, Math.max(0, (h.actor.grants[0]?.expiresAt ?? 0) - Date.now() + 20)),
        );
      h.channel.send({
        type: "job.query_result",
        requestId: frame.requestId,
        payload: { identity: h.job.identity, state: "terminal" },
      });
      assert.equal(
        (await pending).ok,
        false,
        "awaited query must not return retained evidence under stale owner authority",
      );
    } finally {
      await h.close();
    }
  }
});
