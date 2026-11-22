import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { eventually } from "./harness.ts";
import { processHarness } from "./process-harness.ts";
import { unusedBarrierWorker } from "./unused-barrier.ts";

interface Growth {
  pending: number;
  claims: { operationId: string; reservationId?: string }[];
  rejections: { operationId: string; acknowledged: boolean; reclaimed: boolean }[];
}
test("SIGKILL after actual unused/0 settlement preserves rejection identity and reclaims only after measured ACK", {
  timeout: 45000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "fortipi-unused-kill-")),
    main = join(directory, "worker.js");
  let h: Awaited<ReturnType<typeof processHarness>> | undefined;
  try {
    await unusedBarrierWorker(main, process.env.FORTIPI_UNUSED_PROOF_FAULT === "1");
    h = await processHarness(main);
    const service = h;
    const agent = await service.api<D.Agent>("/v1/agents", {
      requestId: crypto.randomUUID(),
      name: "unused-recovery",
      model: { providerId: "cloudflare", modelId: "@cf/zai-org/glm-5.3-flash" },
    });
    assert.equal(agent.status, 201);
    const conversation = await service.api<D.Conversation>(
      `/v1/agents/${agent.body.agentId}/conversations`,
      { requestId: crypto.randomUUID() },
    );
    assert.equal(conversation.status, 201);
    const cid = conversation.body.conversationId,
      probe = `/__test/agents/${agent.body.agentId}`,
      input: D.SteerInput = {
        clientRequestId: crypto.randomUUID(),
        content: "unadmitted idle steering",
      },
      canary = { nonce: crypto.randomUUID() };
    await service.api(`${probe}/canary`, canary, "PUT");
    await service.api(`${probe}/fault`, "after-unused-ack");
    const lost = service.api(`${"/v1/conversations/"}${cid}/steer`, input).catch(() => undefined);
    await eventually(
      async () => (await service.api<{ barrier: string | null }>(`${probe}/state`)).body,
      (value) => value.barrier === "after-unused-ack",
    );
    const held = (await service.api<Growth>(`${probe}/growth`)).body;
    assert.ok(held.pending >= 33554432);
    assert.equal(held.claims.length, 1);
    assert.equal(held.rejections.length, 1);
    assert.equal(held.rejections[0]?.acknowledged, false);
    const originalOperation = held.claims[0]?.operationId;
    assert.ok(originalOperation);
    assert.equal(held.rejections[0]?.operationId, originalOperation);
    await service.crash();
    await lost;
    await service.start();
    assert.deepEqual((await service.api(`${probe}/canary`)).body, canary);
    const recovered = await eventually(
      async () => (await service.api<Growth>(`${probe}/growth`)).body,
      (value) =>
        value.pending === 0 && value.rejections.every((row) => row.acknowledged && row.reclaimed),
    );
    assert.equal(recovered.rejections.length, 1);
    assert.equal(recovered.rejections[0]?.operationId, originalOperation);
    const empty = await service.api<{ entries: { kind: string }[] }>(`${probe}/inspect?cid=${cid}`);
    assert.equal(empty.body.entries.filter((entry) => entry.kind === "pi.user").length, 0);
    const changed = await service.api(`/v1/conversations/${cid}/steer`, {
      ...input,
      content: "different",
    });
    assert.equal(changed.status, 409);
    const repeated = await service.api<D.ErrorBody>(`/v1/conversations/${cid}/steer`, input);
    assert.equal(
      repeated.status,
      409,
      "A reusable rejected request must reclaim the original Free slot",
    );
    assert.equal(repeated.body.error.message, "Conversation is idle");
    assert.equal((await service.api<Growth>(`${probe}/growth`)).body.pending, 0);
    const sent = await service.api<D.AdmissionReceipt>(`/v1/conversations/${cid}/messages`, {
      clientRequestId: crypto.randomUUID(),
      content: "after-unused-crash",
      busyBehavior: "followUp",
    });
    assert.equal(sent.status, 202, "A new valid admission must have the original Free slot");
    const actual = await service.api<{ entries: { kind: string }[] }>(
      `${probe}/inspect?cid=${cid}`,
    );
    assert.equal(actual.body.entries.filter((entry) => entry.kind === "pi.user").length, 1);
  } finally {
    await h?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
