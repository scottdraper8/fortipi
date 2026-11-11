import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { capacityBarrierWorker } from "./capacity-barrier.ts";
import { eventually } from "./harness.ts";
import { processHarness } from "./process-harness.ts";

test("an original scoped grant expiring after capacity returns cannot admit Pi input", {
  timeout: 30000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "fortipi-capacity-grant-")),
    main = join(directory, "worker.js");
  let h: Awaited<ReturnType<typeof processHarness>> | undefined;
  try {
    await capacityBarrierWorker(main, "expiry");
    h = await processHarness(main);
    const service = h;
    const created = await service.api<D.Agent>("/v1/agents", {
      requestId: crypto.randomUUID(),
      name: "capacity-grant",
      model: { providerId: "cloudflare", modelId: "@cf/zai-org/glm-5.3-flash" },
    });
    assert.equal(created.status, 201);
    const agentId = created.body.agentId,
      conversation = await service.api<D.Conversation>(`/v1/agents/${agentId}/conversations`, {
        requestId: crypto.randomUUID(),
      });
    assert.equal(conversation.status, 201);
    const cid = conversation.body.conversationId,
      probe = `/__test/agents/${agentId}`;
    await service.api(`${probe}/fault`, "after-capacity");
    const minted = await service.api<D.CredentialReceipt>("/v1/admin/credentials", {
      requestId: crypto.randomUUID(),
      role: "client",
      grants: [
        {
          grantId: crypto.randomUUID(),
          version: 1,
          expiresAt: Date.now() + 1800,
          resources: {
            agentIds: [agentId],
            conversationIds: [cid],
            workspaceIds: [],
            tools: [],
            executorIds: [],
            backendIds: [],
            actions: ["messages.submit"],
          },
        },
      ],
    });
    assert.equal(minted.status, 201);
    assert.equal(minted.body.state, "issued");
    if (minted.body.state !== "issued") assert.fail("Synthetic scoped credential was not issued");
    const response = await service.api<D.ErrorBody>(
      `/v1/conversations/${cid}/messages`,
      {
        clientRequestId: crypto.randomUUID(),
        content: "expired after capacity",
        busyBehavior: "followUp",
      },
      "POST",
      minted.body.token,
    );
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "unauthorized");
    const state = await eventually(
      async () =>
        (await service.api<{ barrier: string; admissions: unknown[] }>(`${probe}/state`)).body,
      (value) => value.barrier === "after-capacity",
    );
    assert.equal(state.admissions.length, 0);
    const actual = await service.api<{ entries: { kind: string }[] }>(
      `${probe}/inspect?cid=${cid}`,
    );
    assert.equal(actual.body.entries.filter((entry) => entry.kind === "pi.user").length, 0);
  } finally {
    await h?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
