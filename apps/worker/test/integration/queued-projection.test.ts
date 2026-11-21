import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { provision } from "./fixture-state.ts";
import { compileQueuedProjectionFixture } from "./queued-projection-compiler.ts";
import { poll, type Runtime, start } from "./runtime.ts";

interface GateState {
  entered: boolean;
  released: boolean;
  caller: number | null;
  returned: boolean;
  more: boolean | null;
  pageDrained: boolean;
  pendingCount: number;
  onlyQueuedPending: boolean;
  tasks: {
    id: number;
    kind: string;
    owner: number | null;
    state: { kind: string; on?: number[] };
  }[];
  submissions: { requestId?: string; status: string; entry: number | null }[];
}
test("a distinct queued input cannot hold the previous generation's actual afterRun projection", {
  timeout: 60000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "fortipi-queued-projection-"));
  let runtime: Runtime | undefined, control: string | undefined;
  try {
    const main = await compileQueuedProjectionFixture(directory);
    runtime = await start({ main });
    const r = runtime,
      fixture = await provision(r),
      conversation = fixture.conversations[0];
    assert.ok(conversation);
    const cid = conversation.conversationId;
    control = `/__integration/queued-projection/${fixture.agent.agentId}`;
    const gatePath = control;
    const gate = async () => (await r.api<GateState>(gatePath, { action: "state" })).body;
    assert.equal((await r.api(control, { action: "arm", conversationId: cid })).status, 200);
    const firstInput: D.MessageSubmit = {
      clientRequestId: randomUUID(),
      content: "queued-projection-first",
      busyBehavior: "followUp",
    };
    const secondInput: D.MessageSubmit = {
      clientRequestId: randomUUID(),
      content: "queued-projection-second",
      busyBehavior: "followUp",
    };
    assert.ok(firstInput.clientRequestId !== secondInput.clientRequestId);
    const send = (input: D.MessageSubmit) =>
      r.api<D.AdmissionReceipt>(
        `/v1/conversations/${cid}/messages`,
        input,
        "POST",
        fixture.client.token,
      );
    const task = (id: string) =>
      r.api<D.Task>(`/v1/tasks/${id}`, undefined, "GET", fixture.client.token);
    const first = await send(firstInput);
    assert.equal(first.status, 202);
    const held = await poll(gate, (g) => g.entered);
    const caller = held.caller;
    assert.equal(typeof caller, "number");
    assert.ok(
      !held.released &&
        held.tasks.some(
          (t) => t.id === held.caller && t.kind === "fortipi.project" && t.state.kind === "running",
        ),
      "Gate acknowledgment must come from the actual afterRun task",
    );
    // Public completion may precede afterRun completion; settle the first Free slot without releasing the gate.
    await poll(
      async () => (await task(first.body.taskId)).body,
      (t) => t.status.state === "completed",
    );
    await poll(
      async () => {
        await task(first.body.taskId);
        return gate();
      },
      (g) => g.pageDrained && g.pendingCount === 0,
    );
    const second = await poll(
      async () => {
        const result = await send(secondInput);
        assert.ok(
          result.status === 202 || result.status === 429,
          "Only real Free-slot backpressure may precede acceptance",
        );
        return result;
      },
      (result) => result.status === 202,
    );
    assert.ok(
      second.body.taskId !== first.body.taskId,
      "Different client IDs require distinct accepted tasks",
    );
    const retry = await send(secondInput);
    assert.equal(retry.status, 202);
    assert.ok(
      ["operationId", "messageId", "taskId", "eventSeq", "revision"].every(
        (key) =>
          retry.body[key as keyof D.AdmissionReceipt] ===
          second.body[key as keyof D.AdmissionReceipt],
      ),
      "Retry must preserve the second accepted receipt",
    );
    const queued = await gate();
    assert.ok(queued.entered && !queued.released && queued.caller === held.caller);
    assert.ok(
      queued.pageDrained && queued.pendingCount === 1 && queued.onlyQueuedPending,
      "Earlier entries must be fully projected; only the future queued input may remain pending",
    );
    assert.ok(
      queued.submissions.some(
        (s) => s.requestId === second.body.operationId && s.status === "queued" && s.entry === null,
      ),
      "The distinct accepted input must actually be queued in Pi, not already placed",
    );
    assert.ok(
      queued.tasks.some(
        (t) =>
          t.kind === "pi.generation" &&
          t.state.kind === "waiting" &&
          typeof caller === "number" &&
          t.state.on?.includes(caller),
      ),
      "Prior generation must still wait for the acknowledged projection child",
    );
    assert.equal((await r.api(control, { action: "release" })).status, 200);
    const returned = await poll(gate, (g) => g.returned);
    assert.equal(
      returned.more,
      false,
      "An observed projection return must not block an already drained page on a future queued input",
    );
    for (const receipt of [first.body, second.body])
      await poll(
        async () => (await task(receipt.taskId)).body,
        (t) => t.status.state === "completed",
      );
    const snapshot = await poll(
      async () =>
        (
          await r.api<D.ConversationProjection>(
            `/v1/conversations/${cid}`,
            undefined,
            "GET",
            fixture.client.token,
          )
        ).body,
      (s) =>
        [firstInput.content, secondInput.content].every((text) =>
          s.messages.some((m) => m.role === "assistant" && m.content === `answer:${text}`),
        ),
    );
    for (const input of [firstInput, secondInput])
      assert.ok(
        snapshot.messages.filter((m) => m.role === "user" && m.content === input.content).length ===
          1,
      );
    const publicUsers = snapshot.messages.filter((m) => m.role === "user");
    assert.ok(
      publicUsers.length === 2 &&
        publicUsers[0]?.messageId === first.body.messageId &&
        publicUsers[1]?.messageId === second.body.messageId,
      "Canonical public input IDs and ordering must match both actual receipts",
    );
    const inspected = (
      await r.api<{ entries: { kind: string; text: string }[] }>(
        `/__test/agents/${fixture.agent.agentId}/inspect?cid=${cid}`,
      )
    ).body;
    for (const input of [firstInput, secondInput])
      assert.ok(
        inspected.entries.filter((e) => e.kind === "pi.user" && e.text === input.content).length ===
          1,
        "Each distinct ID must leave one actual Pi input",
      );
    const piUsers = inspected.entries.filter((e) => e.kind === "pi.user");
    assert.ok(
      piUsers.length === 2 &&
        piUsers[0]?.text === firstInput.content &&
        piUsers[1]?.text === secondInput.content,
      "Actual Pi placement order must agree with canonical public input order",
    );
    assert.ok((await gate()).released);
  } finally {
    try {
      if (runtime && control) await runtime.api(control, { action: "release" });
    } finally {
      try {
        await runtime?.dispose();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
});
