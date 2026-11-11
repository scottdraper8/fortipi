import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { capacityBarrierWorker } from "./capacity-barrier.ts";
import { eventually } from "./harness.ts";
import { processHarness } from "./process-harness.ts";

test("SIGKILL after capacity reservation recovers the original admission without orphaning Free's active slot", {
  timeout: 60000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "fortipi-capacity-recovery-")),
    main = join(directory, "worker.js");
  let h: Awaited<ReturnType<typeof processHarness>> | undefined;
  try {
    await capacityBarrierWorker(main, "crash");
    h = await processHarness(main);
    const service = h;
    const agent = await service.api<D.Agent>("/v1/agents", {
      requestId: crypto.randomUUID(),
      name: "capacity-gap",
      model: { providerId: "cloudflare", modelId: "@cf/zai-org/glm-5.3-flash" },
    });
    assert.equal(agent.status, 201);
    const created = await service.api<D.Conversation>(
      `/v1/agents/${agent.body.agentId}/conversations`,
      { requestId: crypto.randomUUID() },
    );
    assert.equal(created.status, 201);
    const cid = created.body.conversationId,
      probe = `/__test/agents/${agent.body.agentId}`,
      canary = { nonce: crypto.randomUUID() },
      body: D.MessageSubmit = {
        clientRequestId: crypto.randomUUID(),
        content: "capacity crash gap",
        busyBehavior: "followUp",
      };
    assert.deepEqual((await service.api(`${probe}/canary`, canary, "PUT")).body, canary);
    await service.api(`${probe}/fault`, "after-capacity");
    const lost = service.api(`/v1/conversations/${cid}/messages`, body).catch(() => undefined);
    const before = await eventually(
      async () =>
        (
          await service.api<{
            barrier: string | null;
            admissions: unknown[];
            admissionIntents: {
              operationId: string;
              messageId: string;
              taskId: string;
              hasModel: boolean;
            }[];
          }>(`${probe}/state`)
        ).body,
      (value) => value.barrier === "after-capacity",
    );
    assert.equal(
      before.admissions.length,
      0,
      "Barrier is after real CP reservation, before full local Admission write",
    );
    assert.equal(
      before.admissionIntents.length,
      1,
      "Original identities must precede the capacity request",
    );
    const original = before.admissionIntents[0]!;
    assert.equal(
      original.hasModel,
      true,
      "Retain the actual selected configuration before reservation",
    );
    await service.crash();
    await lost;
    await service.start();
    assert.deepEqual((await service.api(`${probe}/canary`)).body, canary);
    const retry = await service.api<D.AdmissionReceipt | D.ErrorBody>(
      `/v1/conversations/${cid}/messages`,
      body,
    );
    console.log(
      JSON.stringify({
        canarySurvived: true,
        retryStatus: retry.status,
        code: "error" in retry.body ? retry.body.error.code : "accepted",
      }),
    );
    assert.equal(
      retry.status,
      202,
      "The original reserved operation must recover; a new random operation orphans the only active slot",
    );
    const accepted = retry.body;
    assert.ok("operationId" in accepted);
    assert.equal(accepted.operationId, original.operationId);
    assert.equal(accepted.messageId, original.messageId);
    assert.equal(accepted.taskId, original.taskId);
    assert.deepEqual(await service.api(`/v1/conversations/${cid}/messages`, body), retry);
    const actual = await eventually(
      async () =>
        (
          await service.api<{ entries: { kind: string; text: string }[] }>(
            `${probe}/inspect?cid=${cid}`,
          )
        ).body,
      (value) => value.entries.some((entry) => entry.text === "answer:capacity crash gap"),
    );
    assert.equal(
      actual.entries.filter((entry) => entry.kind === "pi.user" && entry.text === body.content)
        .length,
      1,
    );
    const changed = await service.api(`/v1/conversations/${cid}/messages`, {
      ...body,
      content: "changed payload",
    });
    assert.equal(changed.status, 409);
  } finally {
    await h?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
