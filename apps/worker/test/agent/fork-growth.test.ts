import assert from "node:assert/strict";
import { resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { eventually, harness, setup } from "./harness.ts";

test("fork reserves real copied public history with durable identity and pending growth before CP returns", async () => {
  const h = await harness({
    main:
      process.env.FORTIPI_FORK_GROWTH_FAULT_WORKER ??
      resolve("apps/worker/test/agent/fork-growth-worker.ts"),
    modelChunkBytes: 256,
  });
  try {
    const { agent, conversation } = await setup(h);
    const path = `/v1/conversations/${conversation.conversationId}`;
    const sent = await h.api<D.AdmissionReceipt>(`${path}/messages`, {
      clientRequestId: crypto.randomUUID(),
      content: "large-answer",
      busyBehavior: "followUp",
    });
    assert.equal(sent.status, 202);
    const completed = await eventually(
      () => h.api<D.ConversationProjection>(path),
      (value) =>
        value.body.messages.some(
          (row) => row.role === "assistant" && row.content.length === 102400,
        ) && value.body.conversation.taskState.state === "completed",
    );
    const input: D.ForkInput = {
      requestId: crypto.randomUUID(),
      through: completed.body.lastEventSeq,
    };
    const fork = await h.api<D.Conversation>(`${path}/fork`, input);
    assert.equal(fork.status, 201, JSON.stringify(fork.body));
    const copied = (await (
      await h.server.fetch(
        `http://fortipi.local/__fork-growth/history?agent=${agent.agentId}&cid=${fork.body.conversationId}`,
      )
    ).json()) as { bytes: number; users: number; physical: number };
    const proofs = (await (
      await h.server.fetch("http://fortipi.local/__fork-growth/proofs")
    ).json()) as {
      input: { operationId: string; bytes: number; admissionSlots: number };
      proof: {
        intent: boolean;
        claim: { operationId: string; bytes: number } | null;
        physical: number;
      };
    }[];
    const proof = proofs.at(-1);
    assert.ok(proof);
    assert.ok(copied.bytes > 102400);
    assert.equal(copied.users, 1);
    assert.ok(
      proof.input.bytes >= copied.bytes,
      "Fork growth must account for copied public Pi history, not only serialized fork instructions",
    );
    assert.equal(
      proof.proof.intent,
      true,
      "Durable fork identity must precede the actual capacity response",
    );
    assert.equal(proof.proof.claim?.operationId, proof.input.operationId);
    assert.equal(proof.proof.claim?.bytes, proof.input.bytes);
    assert.equal(proof.input.admissionSlots, 0);
    assert.deepEqual(await h.api(`${path}/fork`, input), fork);
    const changed = await h.api(`${path}/fork`, { ...input, title: "changed" });
    assert.equal(changed.status, 409);
  } finally {
    await h.close();
  }
});
