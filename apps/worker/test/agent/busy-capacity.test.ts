import assert from "node:assert/strict";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { errorStatuses, schemaRefs, schemaRegistry } from "fortipi-contract";
import type * as D from "../../src/boundary/dto.js";
import { eventually, harness, setup } from "./harness.ts";

const ajv = new Ajv2020({ strict: true, validateFormats: false });
for (const schema of Object.values(schemaRegistry)) ajv.addSchema(schema);
const validError = ajv.compile({ $ref: schemaRefs.ProtocolError });
test("a real busy Free slot refuses new growth while preserving admitted work and the deferred identity", async () => {
  // Synthetic request-rate headroom isolates the unchanged Free concurrency
  // and growth policy. This does not claim that the diagnostic calls fit30/min.
  const h = await harness();
  let release: (() => Promise<unknown>) | undefined;
  try {
    const { agent, conversation } = await setup(h),
      probe = h.env.AGENT_SESSIONS.getByName(agent.agentId),
      path = `/v1/conversations/${conversation.conversationId}`,
      internal = `/__test/agents/${agent.agentId}`;
    release = async () => probe.releaseCompletion();
    const issued = await h.api<D.CredentialReceipt>("/v1/admin/credentials", {
      requestId: crypto.randomUUID(),
      role: "client",
      grants: [
        {
          grantId: crypto.randomUUID(),
          version: 1,
          resources: {
            agentIds: [agent.agentId],
            conversationIds: [conversation.conversationId],
            workspaceIds: [],
            executorIds: [],
            backendIds: [],
            tools: [],
            actions: ["messages.submit", "conversations.read", "events.read"],
          },
        },
      ],
    });
    assert.equal(issued.status, 201);
    if (issued.body.state !== "issued") assert.fail("Actual ordinary scoped credential required");
    const token = issued.body.token;
    const firstInput: D.MessageSubmit = {
      clientRequestId: crypto.randomUUID(),
      content: "hold-completion",
      busyBehavior: "followUp",
    };
    const first = await h.api<D.AdmissionReceipt>(`${path}/messages`, firstInput, "POST", token);
    assert.equal(first.status, 202);
    const inspect = async () =>
      JSON.parse(await probe.inspectionJson(conversation.conversationId)) as {
        modelCalls: number;
        entries: { kind: string; text: string }[];
      };
    await eventually(inspect, (value) => value.modelCalls === 1);
    const deferredInput: D.MessageSubmit = {
      clientRequestId: crypto.randomUUID(),
      content: "after busy slot",
      busyBehavior: "reject",
    };
    const refused = await h.api<D.ErrorBody>(`${path}/messages`, deferredInput, "POST", token);
    assert.equal(refused.status, errorStatuses.quota_exceeded, JSON.stringify(refused.body));
    assert.equal(refused.body.error.code, "quota_exceeded");
    assert.ok(validError(refused.body.error), JSON.stringify(validError.errors));
    assert.equal(refused.body.error.retryable, true);
    assert.deepEqual(
      refused.body.error.details && "pressure" in refused.body.error.details
        ? [
            refused.body.error.details.pressure.resource,
            refused.body.error.details.pressure.limit,
            refused.body.error.details.pressure.remaining,
          ]
        : [],
      ["concurrency", 1, 0],
    );
    const held = (
      await h.api<{
        admissionIntents: { operationId: string; messageId: string; taskId: string }[];
      }>(`${internal}/state`)
    ).body;
    assert.equal(held.admissionIntents.length, 1);
    const pending = held.admissionIntents[0]!;
    const growth = (
      await h.api<{ pending: number; claims: { operationId: string; reservationId?: string }[] }>(
        `${internal}/growth`,
      )
    ).body;
    assert.equal(growth.claims.length, 2);
    assert.ok(growth.pending >= 2 * 33554432);
    assert.equal(
      growth.claims.find((claim) => claim.operationId === pending.operationId)?.reservationId,
      undefined,
    );
    assert.equal((await inspect()).entries.filter((entry) => entry.kind === "pi.user").length, 1);
    assert.deepEqual(await h.api(`${path}/messages`, firstInput, "POST", token), first);
    assert.equal(
      (await h.api(`${path}/messages`, { ...deferredInput, content: "changed" }, "POST", token))
        .status,
      409,
    );
    await release();
    await eventually(
      async () => {
        await probe.runRepair();
        const tasks = JSON.parse(await probe.toolStateJson(conversation.conversationId)) as {
          tasks: { kind: string; status: string }[];
        };
        return {
          settled: (await probe.admissionStatus()).some(
            (row) => row.receipt?.operationId === first.body.operationId && row.state === "settled",
          ),
          idle: tasks.tasks
            .filter((task) => task.kind === "pi.generation")
            .every((task) => task.status === "terminal"),
        };
      },
      (value) => value.settled && value.idle,
    );
    const admitted = await h.api<D.AdmissionReceipt>(
      `${path}/messages`,
      deferredInput,
      "POST",
      token,
    );
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
    assert.deepEqual(
      [admitted.body.operationId, admitted.body.messageId, admitted.body.taskId],
      [pending.operationId, pending.messageId, pending.taskId],
    );
    assert.deepEqual(await h.api(`${path}/messages`, deferredInput, "POST", token), admitted);
    const after = await eventually(inspect, (value) =>
      value.entries.some((entry) => entry.text === "answer:after busy slot"),
    );
    assert.deepEqual(
      after.entries.filter((entry) => entry.kind === "pi.user").map((entry) => entry.text),
      [firstInput.content, deferredInput.content],
    );
    console.log(
      JSON.stringify({
        concurrencyLimit: 1,
        heldGrowth: growth.pending,
        deferredIdentityStable: true,
        actualInputs: 2,
        admittedReceiptPreserved: true,
      }),
    );
  } finally {
    await release?.();
    await h.close();
  }
});
