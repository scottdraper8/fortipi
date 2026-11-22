import assert from "node:assert/strict";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { assignedJob } from "./artifact-job.ts";
import { connected } from "./connection.ts";
import type { CompletionControl } from "./fixtures/completion.ts";
import { harness, request, scope, uuid, value } from "./harness.ts";

async function setup(
  options: {
    grantMs?: number;
    leaseMs?: number;
    actions?: string[];
    deferAssignment?: boolean;
    controlledTime?: boolean;
  } = {},
) {
  const h = await harness<CompletionControl>({
    fixturePath: "apps/worker/test/control/fixtures/completion.ts",
  });
  const realNow = Date.now;
  let now: number | undefined;
  const setTime = async (time: number) => {
    assert.equal(options.controlledTime, true, "Only a clock-controlled fixture may advance time");
    await h.cp.setTime(time);
    now = time;
  };
  const restoreTime = async () => {
    if (options.controlledTime) {
      try {
        await h.cp.setTime(null);
      } finally {
        Date.now = realNow;
      }
    }
  };
  let socket: WebSocket | undefined;
  try {
    if (options.controlledTime) {
      // Start just before a minute boundary, without waiting for the wall clock.
      await setTime((Math.floor(realNow() / 60000) + 1) * 60000 - 1);
      // Keep the shared harness's minted timestamps/deadlines in the same clock domain.
      Date.now = () => now ?? realNow();
    }
    const channel = await connected(h);
    socket = channel.socket;
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
      ...(options.deferAssignment ? { deferAssignment: true } : {}),
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
      setTime,
      async close() {
        socket?.close();
        try {
          await restoreTime();
        } finally {
          await h.close();
        }
      },
    };
  } catch (error) {
    socket?.close();
    try {
      await restoreTime();
    } finally {
      await h.close();
    }
    throw error;
  }
}

test("a registered unsent intent can be queried without borrowing attempted-work repair capacity", async () => {
  const h = await setup({ deferAssignment: true });
  try {
    const actor = {
      ...h.actor,
      registrationId: h.job.reservation.registrationIds.agent,
    };
    const before = await h.cp.admissions();
    const result = await h.cp.queryExecution(actor, h.job.identity);
    assert.equal(
      result.ok,
      true,
      "The exact registered dispatch owner must recover its retained pre-send intent",
    );
    assert.deepEqual(value(result), { identity: h.job.identity, state: "unknown" });
    const after = await h.cp.admissions();
    assert.equal(after.application, before.application + 1);
    assert.equal(after.repair, before.repair, "Unsent work cannot borrow completion headroom");
    for (const ctx of [
      h.unregistered,
      { ...actor, registrationId: "missing" },
      { ...actor, registrationId: h.job.reservation.registrationIds.workspace },
    ])
      assert.equal((await h.cp.queryExecution(ctx, h.job.identity)).ok, false);
    assert.equal(
      (
        await h.cp.queryExecution(actor, {
          ...h.job.identity,
          lease: { ...h.job.identity.lease, fence: "changed" },
        })
      ).ok,
      false,
    );
    assert.equal(value(await h.cp.queryExecution(actor, h.job.identity)).state, "unknown");
    assert.equal(h.channel.frames.filter((frame) => frame.type === "job.assign").length, 0);
    assert.equal(h.channel.frames.filter((frame) => frame.type === "job.query").length, 0);
  } finally {
    await h.close();
  }
});

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
      const reservedActor = {
        ...h.actor,
        registrationId: h.job.reservation.registrationIds.agent,
      };
      const beforeReserved = await h.cp.admissions();
      const reservedResult = await h.cp.queryExecution(reservedActor, h.job.identity);
      assert.equal(
        reservedResult.ok,
        true,
        "the exact retained reservation registration derives its tool from the dispatch and current grant",
      );
      assert.equal(value(reservedResult).state, "terminal");
      const afterReserved = await h.cp.admissions();
      assert.equal(afterReserved.repair - beforeReserved.repair, 1);
      assert.equal(afterReserved.application, beforeReserved.application);
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
  const h = await setup({ controlledTime: true });
  try {
    const ordinary = await h.auth();
    const previous = { ...(await h.cp.admissionWindow()) };
    const lifetime = { ...(await h.cp.admissions()) };
    assert.ok(previous.application > 0, "Actual setup RPCs occupied the previous minute");
    await h.setTime((previous.minute + 1) * 60000);
    assert.deepEqual(
      { ...(await h.cp.admissionWindow()) },
      previous,
      "Reading admission counters must not roll over the production window",
    );
    assert.deepEqual({ ...(await h.cp.admissions()) }, lifetime);
    value(await h.cp.listAgents(ordinary, request("listAgents", undefined)));
    assert.deepEqual(
      { ...(await h.cp.admissionWindow()) },
      { minute: previous.minute + 1, application: 1, repair: 0, install: 1 },
      "A public ordinary request must roll over the admission window",
    );
    assert.deepEqual(
      { ...(await h.cp.admissions()) },
      { application: lifetime.application + 1, repair: lifetime.repair },
    );
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
      (await h.cp.admissionWindow()).application,
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
    const leaseUpdate: D.ExecutorDelivery = {
      executorId: "executor",
      generation: 1,
      connectionEpoch: h.channel.epoch,
      frame: {
        type: "job.lease_update",
        requestId: uuid(),
        payload: { identity: h.job.identity, leaseVersion: 2, expiresAt: Date.now() + 6000 },
      },
    };
    for (const invalid of [
      { ...leaseUpdate, executorId: "another" },
      { ...leaseUpdate, connectionEpoch: h.channel.epoch + 1 },
    ]) {
      const rejected = await h.cp.deliverExecutorFrame(h.actor, invalid);
      assert.equal(rejected.ok, false);
      if (!rejected.ok) assert.equal(rejected.code, "rate_limited");
    }
    const beforeRenewal = await h.cp.admissionWindow();
    assert.equal(
      (await h.cp.deliverExecutorFrame(h.actor, leaseUpdate)).ok,
      true,
      "retained lease delivery must survive new application pressure",
    );
    const afterRenewal = await h.cp.admissionWindow();
    assert.equal(afterRenewal.minute, beforeRenewal.minute);
    assert.equal(afterRenewal.application, beforeRenewal.application);
    assert.equal(afterRenewal.repair, beforeRenewal.repair + 1);
    while ((await h.cp.admissionWindow()).repair < 29)
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
    const exhausted = await h.cp.admissionWindow();
    assert.equal(exhausted.minute, beforeRenewal.minute);
    assert.equal(exhausted.application, 90);
    assert.equal(exhausted.repair, 30);
    assert.equal(exhausted.install, 120);
    assert.equal(
      (await h.cp.queryExecution(h.actor, h.job.identity)).ok,
      false,
      "same requestId and EID cannot hide physical retries",
    );
  } finally {
    await h.close();
  }

  const closed = await setup({ controlledTime: true });
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
    for (let n = 0; n < 31; n++) {
      const result = await closed.cp.listAgents(closed.actor, request("listAgents", undefined));
      if (!result.ok && result.code === "rate_limited") break;
    }
    const beforeTerminal = await closed.cp.admissionWindow();
    value(
      await closed.cp.deliverExecutorFrame(closed.actor, {
        executorId: "executor",
        generation: 1,
        connectionEpoch: closed.channel.epoch,
        frame: { type: "job.committed", requestId: uuid(), payload: proof },
      }),
    );
    const afterTerminal = await closed.cp.admissionWindow();
    assert.equal(afterTerminal.minute, beforeTerminal.minute);
    assert.equal(afterTerminal.application, beforeTerminal.application);
    assert.equal(afterTerminal.repair, beforeTerminal.repair + 1);
    assert.equal(await closed.cp.rowCount("command"), 1);
    const before = await closed.cp.admissionWindow();
    assert.equal(
      (await closed.cp.queryExecution(closed.actor, closed.job.identity)).ok,
      false,
      "actual retained durable terminal proof closes private recovery eligibility even without transport ACK",
    );
    const after = await closed.cp.admissionWindow();
    assert.equal(after.minute, before.minute);
    assert.equal(after.repair, before.repair);
    assert.equal(after.application, before.application);
  } finally {
    await closed.close();
  }
});

test("registered query revalidates credential, grant and executor floors after awaited native evidence", async () => {
  for (const fault of ["credential", "executor", "grant"] as const) {
    const h = await setup({
      ...(fault === "grant" ? { grantMs: 1800, controlledTime: true } : {}),
    });
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
      else {
        const expiresAt = h.actor.grants[0]?.expiresAt;
        assert.equal(typeof expiresAt, "number");
        assert.ok(expiresAt !== undefined && Date.now() < expiresAt);
        // The real executor has received the query. Expire only its grant now,
        // leaving the pending RPC deadline and credential current.
        await h.setTime(expiresAt);
        assert.ok(Date.now() >= expiresAt && Date.now() < h.actor.deadline);
        assert.equal((await h.auth(h.issued.token)).credentialId, h.actor.credentialId);
      }
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
