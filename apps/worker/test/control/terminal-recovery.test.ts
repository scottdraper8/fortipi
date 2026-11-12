import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { assignedJob } from "./artifact-job.ts";
import { connected } from "./connection.ts";
import type { TerminalControl } from "./fixtures/terminal-recovery.js";
import { harness, request, scope, uuid, value } from "./harness.ts";

interface State {
  dropped: number;
  active: number[];
  indexed: number;
  commands: {
    seq: number;
    key: string;
    recipient: string;
    epoch: number;
    frame: D.ExecutorFrame;
    ack: D.DeliveryAck;
    digest: string;
    peerApplied: boolean;
  }[];
  recovery?: {
    generation: number;
    epoch: number;
    after: number;
    through: number;
    complete: boolean;
  };
  migration?: { after: number; through: number; complete: boolean };
  plan: string[];
}
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function eventually<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  for (let n = 0; n < 200; n++) {
    const value = await read();
    if (ready(value)) return value;
    await pause(10);
  }
  assert.fail("Expected bounded recovery observation");
}
async function fixture() {
  const h = await harness<TerminalControl>({
    fixturePath: "apps/worker/test/control/fixtures/terminal-recovery.ts",
  });
  const sockets: WebSocket[] = [];
  try {
    const channel = await connected(h);
    sockets.push(channel.socket);
    const authorities = [
      h.env.WORKSPACES.getByName("workspace"),
      h.env.AGENT_SESSIONS.getByName("agent"),
    ] as const;
    const seed = async () => {
      const issued = await h.mint({
        requestId: uuid(),
        role: "client",
        grants: [
          { grantId: uuid(), version: 1, resources: scope(["jobs.dispatch", "workspace.write"]) },
        ],
      });
      const owner = await h.auth(issued.token);
      const job = await assignedJob(h, owner);
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
      await h.cp.loseTerminalDelivery();
      const receipt = value(
        await h.cp.deliverExecutorFrame(owner, {
          executorId: "executor",
          generation: 1,
          connectionEpoch: channel.epoch,
          frame: { type: "job.committed", requestId: uuid(), payload: proof },
        }),
      );
      assert.equal(receipt.persisted, true);
      return { issued, owner, job, proof, receipt };
    };
    const initial = await seed();
    const state = async (): Promise<State> => JSON.parse(await h.cp.terminalState()) as State;
    const before = await state();
    assert.equal(before.dropped, 1);
    assert.equal(before.commands.length, 1);
    assert.equal(channel.frames.filter((frame) => frame.type === "job.committed").length, 0);
    return {
      h,
      channel,
      authorities,
      seed,
      state,
      initial,
      before,
      async reconnect(generation = 1) {
        const next = await connected(h, { generation });
        sockets.push(next.socket);
        return next;
      },
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
function heartbeat(channel: Awaited<ReturnType<typeof connected>>) {
  channel.send({
    type: "executor.heartbeat",
    requestId: uuid(),
    payload: {
      executorId: "executor",
      generation: 1,
      connectionEpoch: channel.epoch,
      timestamp: Date.now(),
    },
  });
}

function applicationAck(
  proof: D.JobCommitted,
): Extract<D.ExecutorFrame, { type: "job.committed_ack" }> {
  return { type: "job.committed_ack", requestId: uuid(), payload: proof };
}
// Controlled peer adapter: actual SQLite commit/close/reopen precedes its ACK.
// Product daemon/ledger behavior is independently owned and qualified by executor8.
function persistPeer(directory: string, proof: D.JobCommitted): void {
  const path = join(directory, "terminal-peer.sqlite");
  const db = new DatabaseSync(path);
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS terminal(execution TEXT PRIMARY KEY,payload TEXT NOT NULL)",
    );
    const known = db
      .prepare("SELECT payload FROM terminal WHERE execution=?")
      .get(proof.identity.executionId) as { payload: string } | undefined;
    if (known) assert.deepEqual(JSON.parse(known.payload), proof);
    else
      db.prepare("INSERT INTO terminal VALUES(?,?)").run(
        proof.identity.executionId,
        JSON.stringify(proof),
      );
  } finally {
    db.close();
  }
  const reopened = new DatabaseSync(path);
  try {
    const saved = reopened
      .prepare("SELECT payload FROM terminal WHERE execution=?")
      .get(proof.identity.executionId) as { payload: string } | undefined;
    assert.ok(saved);
    assert.deepEqual(JSON.parse(saved.payload), proof);
  } finally {
    reopened.close();
  }
}
async function proofReads(f: Awaited<ReturnType<typeof fixture>>) {
  return Promise.all(
    f.authorities.map(
      async (peer) =>
        (
          await peer.fetch(new Request("https://fixture/fixture/recovery-reads"))
        ).json() as Promise<number>,
    ),
  );
}

test("authenticated executor registration recovers a retained terminal command after transport ACK and lost delivery", async () => {
  const f = await fixture();
  try {
    const next = await f.reconnect();
    assert.ok(next.epoch > f.channel.epoch);
    const delivered = await next.wait("job.committed");
    assert.deepEqual(delivered.payload, f.initial.proof);
    const after = await f.state();
    assert.equal(after.commands.length, 1);
    assert.deepEqual(after.commands[0]?.ack, f.initial.receipt);
    assert.equal(after.commands[0]?.digest, f.before.commands[0]?.digest);
    assert.deepEqual(after.commands[0]?.frame, f.before.commands[0]?.frame);
    assert.equal(after.commands[0]?.epoch, next.epoch);
    assert.equal(next.frames.filter((frame) => frame.type === "job.assign").length, 0);
    assert.ok(after.plan.some((line) => line.includes("cp_recipient_page")));
  } finally {
    await f.close();
  }
});

test("legacy indexing preserves sequence and reaches the newest of six receipts through bounded authenticated pages", async () => {
  const f = await fixture();
  try {
    const seeded = [f.initial];
    for (let n = 0; n < 5; n++) seeded.push(await f.seed());
    const fourth = seeded[3],
      newest = seeded.at(-1);
    assert.ok(fourth && newest);
    const before = await f.state();
    assert.equal(before.commands.length, 6);
    await f.h.cp.legacyTerminalCommands();
    const legacy = await f.state();
    assert.ok(legacy.commands.every((command) => command.recipient === ""));
    const next = await f.reconnect();
    await next.wait(
      "job.committed",
      (frame) =>
        frame.type === "job.committed" &&
        frame.payload.identity.jobId === fourth.job.identity.jobId,
    );
    const first = await eventually(
      f.state,
      (state) => state.recovery?.after === before.commands[3]?.seq,
    );
    assert.equal(first.recovery?.complete, false);
    assert.equal(next.frames.filter((frame) => frame.type === "job.committed").length, 4);
    assert.equal(
      next.frames.some(
        (frame) =>
          frame.type === "job.committed" &&
          frame.payload.identity.jobId === newest.job.identity.jobId,
      ),
      false,
    );
    heartbeat(next);
    await next.wait(
      "job.committed",
      (frame) =>
        frame.type === "job.committed" &&
        frame.payload.identity.jobId === newest.job.identity.jobId,
    );
    const after = await eventually(f.state, (state) => state.recovery?.complete === true);
    assert.equal(next.frames.filter((frame) => frame.type === "job.committed").length, 6);
    assert.deepEqual(
      after.commands.map((row) => row.seq),
      before.commands.map((row) => row.seq),
      "SQLite UPSERT indexing must preserve the captured high-water coordinate",
    );
    assert.deepEqual(
      after.commands.map(({ seq, key, ack, digest, frame }) => ({ seq, key, ack, digest, frame })),
      before.commands.map(({ seq, key, ack, digest, frame }) => ({ seq, key, ack, digest, frame })),
    );
    assert.ok(after.commands.every((row) => row.epoch === next.epoch));
    assert.ok(after.migration?.complete);
    assert.equal(next.frames.filter((frame) => frame.type === "job.assign").length, 0);
  } finally {
    await f.close();
  }
});

test("registration cannot recover terminal delivery under revoked owner, wrong generation or missing authority proof", async () => {
  for (const fault of ["owner", "generation", "proof"] as const) {
    const f = await fixture();
    try {
      if (fault === "owner")
        value(
          await f.h.cp.revokeCredential(
            await f.h.auth(),
            request(
              "revokeCredential",
              { requestId: uuid(), expectedGeneration: 1 },
              { id: f.initial.owner.credentialId },
            ),
          ),
        );
      if (fault === "generation")
        value(
          await f.h.cp.revokeExecutor(
            await f.h.auth(),
            request(
              "revokeExecutor",
              { requestId: uuid(), expectedGeneration: 1 },
              { id: "executor" },
            ),
          ),
        );
      if (fault === "proof")
        await f.authorities[1].fetch(
          new Request(
            `https://fixture/fixture/recovery-proof?job=${f.initial.job.identity.jobId}`,
            { method: "DELETE" },
          ),
        );
      const next = await f.reconnect(fault === "generation" ? 2 : 1);
      await eventually(
        f.state,
        (state) => state.recovery?.epoch === next.epoch && state.recovery.complete,
      );
      const after = await f.state();
      assert.equal(
        next.frames.some((frame) => frame.type === "job.committed" || frame.type === "job.assign"),
        false,
        fault,
      );
      assert.equal(after.commands[0]?.epoch, f.before.commands[0]?.epoch, fault);
      assert.deepEqual(after.commands[0]?.ack, f.initial.receipt);
      assert.equal(after.commands[0]?.digest, f.before.commands[0]?.digest);
    } finally {
      await f.close();
    }
  }
});

test("superseding a registration during real proof waits preserves the old command until a current authenticated continuation", async () => {
  const f = await fixture();
  const agent = f.authorities[1];
  try {
    await agent.fetch(new Request("https://fixture/fixture/recovery-gate", { method: "PUT" }));
    const stale = await f.reconnect();
    await eventually(
      async () =>
        (
          await agent.fetch(new Request("https://fixture/fixture/recovery-gate"))
        ).json() as Promise<{ entered: boolean }>,
      (state) => state.entered,
    );
    const current = await f.reconnect();
    await agent.fetch(new Request("https://fixture/fixture/recovery-gate", { method: "DELETE" }));
    await eventually(f.state, (state) => !state.active.includes(stale.epoch));
    await f.h.cp.drainTerminalCommands();
    assert.equal(
      (await f.state()).commands[0]?.epoch,
      f.channel.epoch,
      "Neither a superseded proof nor an ordinary background drain may recapture a new epoch",
    );
    assert.equal(
      stale.frames.some((frame) => frame.type === "job.committed"),
      false,
    );
    assert.equal(
      current.frames.some((frame) => frame.type === "job.committed"),
      false,
    );
    heartbeat(current);
    const delivered = await current.wait("job.committed");
    assert.deepEqual(delivered.payload, f.initial.proof);
    assert.equal((await f.state()).commands[0]?.epoch, current.epoch);
    assert.equal(current.frames.filter((frame) => frame.type === "job.assign").length, 0);
    await agent.fetch(new Request("https://fixture/fixture/recovery-gate", { method: "PUT" }));
    const revoked = await f.reconnect();
    await eventually(
      async () =>
        (
          await agent.fetch(new Request("https://fixture/fixture/recovery-gate"))
        ).json() as Promise<{ entered: boolean }>,
      (state) => state.entered,
    );
    value(
      await f.h.cp.revokeCredential(
        await f.h.auth(),
        request(
          "revokeCredential",
          {
            requestId: uuid(),
            expectedGeneration: 1,
          },
          { id: f.initial.owner.credentialId },
        ),
      ),
    );
    await agent.fetch(new Request("https://fixture/fixture/recovery-gate", { method: "DELETE" }));
    await eventually(
      f.state,
      (state) => state.recovery?.epoch === revoked.epoch && state.recovery.complete,
    );
    assert.equal(
      (await f.state()).commands[0]?.epoch,
      current.epoch,
      "Revoking the original owner during proof retrieval cannot recapture the command",
    );
    assert.equal(
      revoked.frames.some((frame) => frame.type === "job.committed"),
      false,
    );
  } finally {
    await agent.fetch(new Request("https://fixture/fixture/recovery-gate", { method: "DELETE" }));
    await f.close();
  }
});

test("actual ordinary owner pressure leaves the terminal receipt and recovery cursor pending without repair quota", async () => {
  // Keep the bounded observation away from a calendar-window transition; the
  // actual receiver rate_limited response, not a fixed call count, is the oracle.
  const left = 60000 - (Date.now() % 60000);
  if (left < 6000) await pause(left + 20);
  const f = await fixture();
  try {
    let limited: D.Outcome<D.ExecutionObservation> | undefined;
    for (let n = 0; n < 64; n++) {
      limited = await f.h.cp.queryExecution(f.initial.owner, f.initial.job.identity);
      if (!limited.ok && limited.code === "rate_limited") break;
    }
    assert.ok(limited && !limited.ok && limited.code === "rate_limited");
    assert.ok((limited.details?.retryAfterMs ?? 0) > 0);
    const next = await f.reconnect();
    const held = await eventually(
      f.state,
      (state) => state.recovery?.epoch === next.epoch && !state.active.includes(next.epoch),
    );
    assert.equal(held.recovery?.complete, false);
    assert.equal(held.recovery?.after, 0);
    assert.equal(held.commands[0]?.epoch, f.channel.epoch);
    assert.deepEqual(held.commands[0]?.ack, f.initial.receipt);
    heartbeat(next);
    await eventually(f.state, (state) => !state.active.includes(next.epoch));
    assert.equal(
      next.frames.some((frame) => frame.type === "job.committed" || frame.type === "job.assign"),
      false,
    );
    assert.equal((await f.state()).recovery?.after, 0);
  } finally {
    await f.close();
  }
});

test("peer-applied ACK is durable, exact and idempotent, with no ACK-of-ACK or later registration replay", async () => {
  const f = await fixture();
  try {
    const next = await f.reconnect();
    const terminal = await next.wait("job.committed");
    assert.equal(terminal.type, "job.committed");
    persistPeer(f.h.directory, f.initial.proof);
    const ack = applicationAck(f.initial.proof);
    next.send(ack);
    const applied = await eventually(f.state, (state) => state.commands[0]?.peerApplied === true);
    assert.equal(applied.indexed, 0);
    assert.deepEqual(applied.commands[0]?.ack, f.initial.receipt);
    assert.equal(applied.commands[0]?.digest, f.before.commands[0]?.digest);
    next.send(ack);
    heartbeat(next);
    await next.wait("executor.heartbeat");
    assert.deepEqual((await f.state()).commands, applied.commands);
    assert.equal(
      next.frames.some((frame) => frame.requestId === ack.requestId),
      false,
    );
    const reads = await proofReads(f);
    const current = await f.reconnect();
    await eventually(
      f.state,
      (state) => state.recovery?.epoch === current.epoch && state.recovery.complete,
    );
    assert.equal(
      current.frames.some((frame) => frame.type === "job.committed" || frame.type === "job.assign"),
      false,
    );
    assert.deepEqual(
      await proofReads(f),
      reads,
      "Applied history requires no owner/proof reauthorization",
    );
    assert.deepEqual((await f.state()).commands, applied.commands);
  } finally {
    await f.close();
  }
});

test("six applied historical receipts do not delay the newest loss; missing application ACK redelivers and re-ACKs", async () => {
  const f = await fixture();
  try {
    const history = [f.initial];
    for (let n = 0; n < 5; n++) history.push(await f.seed());
    for (const item of history) {
      const known = (await f.state()).commands.find(
        (row) =>
          row.frame.type === "job.committed" &&
          row.frame.payload.identity.executionId === item.proof.identity.executionId,
      );
      assert.ok(known && known.frame.type === "job.committed");
      assert.deepEqual(
        value(
          await f.h.cp.deliverExecutorFrame(item.owner, {
            executorId: "executor",
            generation: 1,
            connectionEpoch: f.channel.epoch,
            frame: known.frame,
          }),
        ),
        item.receipt,
      );
      const delivered = await f.channel.wait(
        "job.committed",
        (frame) =>
          frame.type === "job.committed" &&
          frame.payload.identity.executionId === item.proof.identity.executionId,
      );
      assert.deepEqual(delivered.payload, item.proof);
      persistPeer(f.h.directory, item.proof);
      f.channel.send(applicationAck(item.proof));
      await eventually(
        f.state,
        (state) => state.commands.find((row) => row.key === known.key)?.peerApplied === true,
      );
    }
    const newest = await f.seed();
    const before = await f.state();
    assert.equal(before.commands.length, 7);
    assert.equal(
      before.indexed,
      1,
      "Only the newest unconfirmed receipt belongs to recovery selection",
    );
    const reads = await proofReads(f);
    const next = await f.reconnect();
    const delivered = await next.wait("job.committed");
    assert.deepEqual(delivered.payload, newest.proof);
    await eventually(
      f.state,
      (state) => state.recovery?.epoch === next.epoch && state.recovery.complete,
    );
    assert.equal(next.frames.filter((frame) => frame.type === "job.committed").length, 1);
    assert.deepEqual(
      await proofReads(f),
      reads.map((n) => n + 1),
    );
    persistPeer(f.h.directory, newest.proof); // Drop only the application ACK after actual local persistence.
    assert.equal((await f.state()).indexed, 1);
    const replacement = await f.reconnect();
    const repeated = await replacement.wait("job.committed");
    assert.deepEqual(repeated.payload, newest.proof);
    persistPeer(f.h.directory, newest.proof); // Idempotent readback of the already committed peer record.
    replacement.send(applicationAck(newest.proof));
    const final = await eventually(f.state, (state) => state.indexed === 0);
    assert.equal(final.commands.length, 7);
    assert.deepEqual(
      final.commands.map(({ key, ack, digest, frame }) => ({ key, ack, digest, frame })),
      before.commands.map(({ key, ack, digest, frame }) => ({ key, ack, digest, frame })),
    );
    assert.ok(final.commands.slice(0, 6).every((row) => row.epoch === f.channel.epoch));
    assert.equal(replacement.frames.filter((frame) => frame.type === "job.committed").length, 1);
    assert.equal(replacement.frames.filter((frame) => frame.type === "job.assign").length, 0);
  } finally {
    await f.close();
  }
});

test("wrong terminal ACK identities and facts or failed persistence cannot retire recovery", async () => {
  const f = await fixture();
  try {
    const next = await f.reconnect();
    await next.wait("job.committed");
    persistPeer(f.h.directory, f.initial.proof);
    const input: D.ExecutorDelivery = {
      executorId: "executor",
      generation: 1,
      connectionEpoch: next.epoch,
      frame: applicationAck(f.initial.proof),
    };
    const event = structuredClone(f.initial.proof);
    event.eventSeq++;
    const version = structuredClone(f.initial.proof);
    version.terminalVersion++;
    const zero = structuredClone(f.initial.proof);
    zero.terminalVersion = 0;
    const facts = structuredClone(f.initial.proof);
    assert.equal(facts.evidence.kind, "verified-unchanged");
    if (facts.evidence.kind !== "verified-unchanged")
      assert.fail("Controlled unchanged proof required");
    facts.evidence.manifestHash = "b".repeat(64);
    const before = await f.state();
    for (const invalid of [
      { ...input, connectionEpoch: f.channel.epoch },
      { ...input, generation: 2 },
      { ...input, executorId: "another" },
      ...[event, version, zero, facts].map((proof) => ({ ...input, frame: applicationAck(proof) })),
    ]) {
      const result = await f.h.cp.deliverExecutorFrame(next.executor, invalid);
      assert.equal(result.ok, false);
      if (!result.ok)
        assert.ok(
          ["unauthenticated", "unauthorized", "conflict"].includes(result.code),
          result.code,
        );
      assert.deepEqual((await f.state()).commands, before.commands);
    }
    for (const wrongPrincipal of [f.initial.owner, f.channel.executor]) {
      assert.equal((await f.h.cp.deliverExecutorFrame(wrongPrincipal, input)).ok, false);
      assert.deepEqual((await f.state()).commands, before.commands);
    }
    await f.h.cp.refuseTerminalConfirmation(true);
    assert.equal((await f.h.cp.deliverExecutorFrame(next.executor, input)).ok, false);
    assert.deepEqual(
      (await f.state()).commands,
      before.commands,
      "Rejected SQL mutation retains both pending index and original evidence",
    );
    await f.h.cp.refuseTerminalConfirmation(false);
    next.send(applicationAck(f.initial.proof));
    const applied = await eventually(f.state, (state) => state.commands[0]?.peerApplied === true);
    assert.equal(applied.indexed, 0);
    assert.deepEqual(
      value(await f.h.cp.deliverExecutorFrame(next.executor, input)),
      f.initial.receipt,
    );
    assert.deepEqual((await f.state()).commands, applied.commands);
  } finally {
    await f.h.cp.refuseTerminalConfirmation(false);
    await f.close();
  }
});

test("terminal ACK revalidates current peer authority after its actual digest await", async () => {
  for (const fault of ["epoch", "credential"] as const) {
    const f = await fixture();
    try {
      const input: D.ExecutorDelivery = {
        executorId: "executor",
        generation: 1,
        connectionEpoch: f.channel.epoch,
        frame: applicationAck(f.initial.proof),
      };
      persistPeer(f.h.directory, f.initial.proof);
      await f.h.cp.gateEpoch("hash");
      const pending = f.h.cp.deliverExecutorFrame(f.channel.executor, input);
      await eventually(() => f.h.cp.epochGateEntered(), Boolean);
      if (fault === "epoch") await f.reconnect();
      else
        value(
          await f.h.cp.revokeCredential(
            await f.h.auth(),
            request(
              "revokeCredential",
              {
                requestId: uuid(),
                expectedGeneration: 1,
              },
              { id: f.channel.executor.credentialId },
            ),
          ),
        );
      const before = await f.state();
      await f.h.cp.releaseEpochGate();
      const result = await pending;
      assert.equal(
        result.ok,
        false,
        `Awaited terminal ACK cannot retire recovery after current ${fault} authority changes`,
      );
      if (!result.ok) assert.equal(result.code, "unauthenticated");
      assert.deepEqual((await f.state()).commands, before.commands);
      assert.equal((await f.state()).indexed, 1);
    } finally {
      await f.h.cp.releaseEpochGate();
      await f.close();
    }
  }
});
