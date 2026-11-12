import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { wireLimits } from "fortipi-contract";
import { FortiPiClient } from "../../../../packages/fortipi-client/dist/node.js";
import type * as D from "../../src/boundary/dto.js";
import { bootstrap, eventually, harness, setup } from "../agent/harness.ts";
import type { TestAgentSession } from "./stream-boundaries-worker.js";

test("a retained valid-message projection remains recoverable through the real public SDK JSON bound", async (t) => {
  const h = await harness({ main: resolve("apps/worker/test/api/stream-boundaries-worker.ts") });
  try {
    const { agent, conversation } = await setup(h);
    const probe = h.env.AGENT_SESSIONS.getByName(
      agent.agentId,
    ) as DurableObjectStub<TestAgentSession>;
    // Producer-only substitution: schema-validated individual64KiB messages, real app
    // commit/SQLite/snapshot/replay and the unmodified actual SDK receiver.
    await probe.appendStreamMessages(conversation.conversationId, 20, 65536);
    const { url } = await h.server.listen();
    const client = new FortiPiClient({
      endpoint: url.toString(),
      allowLoopbackHttp: true,
      credentials: async () => bootstrap,
    });
    await client.negotiate();
    const [snapshotResult, replayResult] = await Promise.allSettled([
      client.conversations.get(conversation.conversationId),
      client.conversations.events(conversation.conversationId, { after: 0, limit: 100 }),
    ]);
    t.diagnostic(
      JSON.stringify(
        [snapshotResult, replayResult].map((result) =>
          result.status === "fulfilled"
            ? "valid bounded response"
            : result.reason instanceof Error
              ? result.reason.message
              : "Receiver rejected response",
        ),
      ),
    );
    assert.equal(
      snapshotResult.status,
      "fulfilled",
      "Snapshot must fit the unmodified SDK receiver",
    );
    assert.equal(
      replayResult.status,
      "fulfilled",
      "Replay page must fit the unmodified SDK receiver",
    );
    if (snapshotResult.status !== "fulfilled" || replayResult.status !== "fulfilled")
      assert.fail("Wire recovery unavailable");
    const snapshot = snapshotResult.value;
    assert.equal(snapshot.conversation.conversationId, conversation.conversationId);
    assert.ok(new TextEncoder().encode(JSON.stringify(snapshot)).length <= wireLimits.jsonBytes);
    const ids: string[] = [];
    let after = 0;
    while (after < snapshot.lastEventSeq) {
      const page: D.ReplayPage = await client.conversations.events(conversation.conversationId, {
        after,
        through: snapshot.lastEventSeq,
        limit: 100,
      });
      assert.ok(page.nextAfter > after, "Replay must make progress within the exact wire bound");
      ids.push(...page.events.map((event) => event.eventId));
      after = page.nextAfter;
    }
    assert.equal(ids.length, 21);
    assert.equal(new Set(ids).size, ids.length);
  } finally {
    await h.close();
  }
});

test("a real public100KiB Pi answer remains readable by the strict unmodified SDK", async () => {
  const h = await harness({ modelChunkBytes: 256 });
  try {
    const { agent, conversation } = await setup(h);
    const { url } = await h.server.listen();
    const client = new FortiPiClient({
      endpoint: url.toString(),
      allowLoopbackHttp: true,
      credentials: async () => bootstrap,
    });
    const sent = await client.conversations.send(conversation.conversationId, {
      clientRequestId: crypto.randomUUID(),
      content: "large-answer",
      busyBehavior: "followUp",
    });
    const probe = h.env.AGENT_SESSIONS.getByName(agent.agentId);
    await eventually(
      async () => {
        await probe.runRepair();
        return probe.admissionStatus();
      },
      (rows) =>
        rows.find((row) => row.receipt?.operationId === sent.operationId)?.state === "settled",
    );
    const snapshot = await client.conversations.get(conversation.conversationId);
    assert.ok(
      snapshot.messages.some(
        (message) => message.role === "assistant" && message.content.length === 102400,
      ),
      "Actual retained model text must not be truncated to satisfy the wire receiver",
    );
  } finally {
    await h.close();
  }
});
