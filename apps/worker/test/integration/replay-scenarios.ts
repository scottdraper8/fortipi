import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { FortiPiClient } from "../../../../packages/fortipi-client/dist/node.js";
import type { DurableEvent } from "../../../../packages/fortipi-contract/dist/index.js";
import { RoleContext } from "../../../../tests/clients/roles.ts";
import type * as D from "../../src/boundary/dto.js";
import { provision } from "./fixture-state.ts";
import { poll, type Runtime, start } from "./runtime.ts";

export async function replayAll(
  client: FortiPiClient,
  cid: string,
  after: number,
  through?: number,
) {
  const events: DurableEvent[] = [];
  for (let n = 0; n < 64; n++) {
    const page = await client.conversations.events(cid, {
      after,
      limit: 100,
      ...(through === undefined ? {} : { through }),
    });
    through ??= page.through;
    assert.equal(page.through, through);
    for (const event of page.events) {
      assert.equal(event.eventSeq, after + 1);
      after = event.eventSeq;
      events.push(event);
    }
    assert.equal(page.nextAfter, after);
    if (!page.hasMore) {
      assert.equal(after, through);
      return events;
    }
  }
  throw new Error("Canonical replay exceeded its bounded page allowance");
}
const make = (runtime: Runtime, token: string, Client = FortiPiClient) =>
  new Client({
    endpoint: runtime.endpoint,
    allowLoopbackHttp: true,
    credentials: async () => token,
  });
async function turn(client: FortiPiClient, cid: string, content: string) {
  const receipt = await client.conversations.send(cid, {
    clientRequestId: randomUUID(),
    content,
    busyBehavior: "followUp",
  });
  await poll(
    () => client.tasks.get(receipt.taskId),
    (task) => task.status.state === "completed",
  );
  return receipt;
}
export async function replayLiveRace(Client = FortiPiClient) {
  const runtime = await start(),
    roles = new RoleContext(runtime.endpoint, runtime.admin);
  let control = "";
  const subscriptions: ReturnType<FortiPiClient["conversations"]["subscribe"]>[] = [];
  try {
    const state = await provision(runtime, (body) => roles.issue(body)),
      cid = state.conversations[0]!.conversationId;
    const client = make(runtime, state.client.token, Client),
      second = make(runtime, state.client.token, Client);
    const first = client.conversations.subscribe(cid, {
      agentId: state.agent.agentId,
      maxReconnects: 0,
      onSnapshot() {},
      onEvent() {},
    });
    subscriptions.push(first);
    await first.ready;
    const saved = first.cursor,
      scope = first.scope;
    assert.ok(scope);
    first.close();
    await first.done;
    await turn(second, cid, "seed1010-before-highwater");
    control = `/__integration/actor/${state.agent.agentId}/control`;
    await runtime.api(control, { action: "hold-replay", conversationId: cid });
    const applied: DurableEvent[] = [];
    let cursor = saved,
      volatile = 0;
    const resumed = client.conversations.subscribe(cid, {
      agentId: state.agent.agentId,
      after: saved,
      scope,
      maxReconnects: 0,
      onSnapshot() {
        throw new Error("Retained initialized projection unexpectedly reset");
      },
      onEvent(event) {
        if (event.durability === "volatile") {
          volatile++;
          return;
        }
        assert.equal(event.eventSeq, cursor + 1);
        cursor = event.eventSeq;
        applied.push(structuredClone(event));
      },
    });
    subscriptions.push(resumed);
    void resumed.done.catch(() => {});
    await poll(
      async () => (await runtime.api<{ replay: boolean }>(control, { action: "state" })).body,
      (value) => value.replay,
    );
    // The fixture acknowledges an already computed actual HTTP replay page.
    // This real completion occurs after its high-water and before live attach.
    const raced = await turn(second, cid, "seed1010-between-highwater-and-live");
    await runtime.api(control, { action: "release-replay" });
    await resumed.ready;
    await poll(
      async () =>
        applied.some((event) => event.type === "task.completed" && event.taskId === raced.taskId),
      Boolean,
    );
    const stored = await replayAll(second, cid, saved, cursor);
    assert.deepEqual(
      applied,
      stored,
      "Live attachment must deliver each original canonical stored envelope once and in order",
    );
    assert.equal(new Set(applied.map((e) => e.eventId)).size, applied.length);
    assert.equal(resumed.cursor, cursor);
    return {
      actualCapturedHttpReplay: true,
      committedBetweenHighWaterAndLive: true,
      actualTaskId: raced.taskId,
      originalEnvelopeCount: stored.length,
      contiguousAppliedOnce: true,
      volatileEventsObserved: volatile,
      cursor: resumed.cursor,
    };
  } finally {
    if (control) await runtime.api(control, { action: "release-replay" }).catch(() => {});
    for (const subscription of subscriptions) {
      subscription.close();
      await subscription.done.catch(() => {});
    }
    const cleanup = await roles.cleanup();
    await runtime.dispose();
    assert.ok(cleanup.every((r) => r.state === "complete"));
  }
}
export async function storedHistoryLifecycle(Client = FortiPiClient) {
  const runtime = await start(),
    roles = new RoleContext(runtime.endpoint, runtime.admin);
  try {
    const state = await provision(runtime, (body) => roles.issue(body)),
      cid = state.conversations[0]!.conversationId;
    const client = make(runtime, state.client.token, Client);
    await turn(client, cid, "seed1010-retained-prefix");
    const prefix = await client.conversations.get(cid),
      original = await replayAll(client, cid, 0, prefix.lastEventSeq);
    await turn(client, cid, "seed1010-later-parent");
    const forkInput = {
      requestId: randomUUID(),
      through: prefix.lastEventSeq,
      title: "seed1010-independent-fork",
    };
    const forked = await client.conversations.fork(cid, forkInput);
    assert.notEqual(forked.conversationId, cid);
    assert.deepEqual(await client.conversations.fork(cid, forkInput), forked);
    const forkRole = await roles.issue({
      requestId: randomUUID(),
      role: "client",
      grants: [
        {
          grantId: randomUUID(),
          version: 1,
          resources: {
            agentIds: [state.agent.agentId],
            conversationIds: [forked.conversationId],
            workspaceIds: [],
            executorIds: [],
            backendIds: [],
            tools: [],
            actions: [
              "conversations.read",
              "messages.submit",
              "events.read",
              "tasks.read",
              "tickets.mint",
            ],
          },
        },
      ],
    });
    const child = make(runtime, forkRole.token, Client);
    const forkSnapshot = await child.conversations.get(forked.conversationId);
    assert.deepEqual(
      forkSnapshot.messages.map((m) => [m.role, m.content]),
      prefix.messages.map((m) => [m.role, m.content]),
    );
    const forkEvents = await replayAll(child, forked.conversationId, 0);
    const reference = forkEvents.find((e) => e.type === "conversation.forked");
    assert.ok(reference);
    const payload = reference.payload as { parentConversationId: string; parentEventSeq: number };
    assert.equal(payload.parentConversationId, cid);
    assert.equal(payload.parentEventSeq, prefix.lastEventSeq);
    assert.equal(forkEvents[0]?.eventSeq, 1);
    await turn(child, forked.conversationId, "seed1010-child-continuation");
    const parent = await client.conversations.get(cid);
    assert.ok(!parent.messages.some((m) => m.content.includes("seed1010-child-continuation")));
    const control = `/__integration/actor/${state.agent.agentId}/control`;
    const compact = await runtime.api<{ actualSupportedPiApi: boolean; taskId: string }>(control, {
      action: "compact",
      conversationId: cid,
    });
    assert.equal(compact.status, 200);
    assert.equal(compact.body.actualSupportedPiApi, true);
    assert.ok(compact.body.taskId);
    const reset = await runtime.api(control, { action: "reset", conversationId: cid });
    assert.equal(reset.status, 200);
    await runtime.stopAbruptly();
    await runtime.reopenSameStorage();
    const after = await replayAll(client, cid, 0, prefix.lastEventSeq);
    assert.deepEqual(
      after,
      original,
      "Compaction/reset/fork/reopen must preserve original committed application envelopes byte-for-byte",
    );
    return {
      actualPiCompactionTask: compact.body.taskId,
      actualPiReset: true,
      actualWorkerdReopen: true,
      originalEnvelopeCount: original.length,
      unchangedOriginalEnvelopes: true,
      independentForkSequence: true,
      exactParentReference: true,
      independentChildContinuation: true,
    };
  } finally {
    const cleanup = await roles.cleanup();
    await runtime.dispose();
    assert.ok(cleanup.every((r) => r.state === "complete"));
  }
}
export async function retainedReplayBounds() {
  const runtime = await start({ events: 6 }),
    roles = new RoleContext(runtime.endpoint, runtime.admin);
  try {
    const state = await provision(runtime, (body) => roles.issue(body)),
      cid = state.conversations[0]!.conversationId;
    const client = make(runtime, state.client.token);
    for (let i = 0; i < 4; i++) await turn(client, cid, `seed1010-retention-${i}`);
    const snapshot = await client.conversations.get(cid);
    assert.ok(snapshot.retainedFloor > 0);
    const expired = await runtime.api<D.ErrorBody>(
      `/v1/conversations/${cid}/events?after=0`,
      undefined,
      "GET",
      state.client.token,
    );
    assert.equal(expired.status, 410);
    assert.equal(expired.body.error.code, "cursor.expired");
    const future = await runtime.api<D.ErrorBody>(
      `/v1/conversations/${cid}/events?after=${snapshot.lastEventSeq + 1}`,
      undefined,
      "GET",
      state.client.token,
    );
    assert.equal(future.status, 400);
    assert.equal(future.body.error.code, "cursor.invalid");
    const kept = await replayAll(client, cid, snapshot.retainedFloor, snapshot.lastEventSeq);
    assert.ok(kept.length <= 6);
    return {
      lowerFixtureRetainedEvents: 6,
      retainedFloor: snapshot.retainedFloor,
      expiredStatus: 410,
      expiredCode: "cursor.expired",
      futureStatus: 400,
      futureCode: "cursor.invalid",
      retainedOriginalEvents: kept.length,
      actualFreeCeilingClaim: false,
    };
  } finally {
    const cleanup = await roles.cleanup();
    await runtime.dispose();
    assert.ok(cleanup.every((r) => r.state === "complete"));
  }
}
