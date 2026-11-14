import assert from "node:assert/strict";
import { resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import Ajv from "ajv/dist/2020.js";
import { schemaRegistry } from "fortipi-contract";
import type * as D from "../../src/boundary/dto.js";
import { eventually, harness, setup } from "./harness.ts";

const ajv = new Ajv({ strict: true, validateFormats: false });
for (const schema of Object.values(schemaRegistry)) ajv.addSchema(schema);
const validError = ajv.compile({
  $ref: "https://fortipi.dev/schemas/1.0.0/common.schema.json#/$defs/ProtocolError",
});
interface Trace {
  control: { calls: number; lastFailureAt: number };
  local: {
    creations: { operationId: string; conversationId: string; due: number | null }[];
    growth: unknown;
  };
}
for (const mode of ["hold", "backoff"] as const)
  test(`creation and fork retain canonical ${mode} without retrying before eligibility`, async () => {
    for (const operation of ["create", "fork"] as const) {
      const h = await harness({
        main:
          process.env.FORTIPI_CREATION_RETRY_FAULT_WORKER ??
          resolve("apps/worker/test/agent/admission-backoff-worker.ts"),
      });
      try {
        const { agent, conversation } = await setup(h);
        const probe = h.env.AGENT_SESSIONS.getByName(agent.agentId);
        let through = 0;
        if (operation === "fork") {
          const sent = await h.api(`/v1/conversations/${conversation.conversationId}/messages`, {
            clientRequestId: crypto.randomUUID(),
            content: "fork-backoff",
            busyBehavior: "followUp",
          });
          assert.equal(sent.status, 202);
          const completed = await eventually(
            () =>
              h.api<D.ConversationProjection>(`/v1/conversations/${conversation.conversationId}`),
            (value) => value.body.conversation.taskState.state === "completed",
          );
          through = completed.body.lastEventSeq;
        }
        const raw = (path: string) => h.server.fetch(`http://fortipi.local${path}`);
        const trace = async (drain = false): Promise<Trace> =>
          (
            await raw(
              `/__admission-backoff/trace?agent=${agent.agentId}&cid=${conversation.conversationId}&drain=${drain}`,
            )
          ).json() as Promise<Trace>;
        await raw(`/__admission-backoff/mode?target=creation&mode=${mode}`);
        const path =
          operation === "create"
            ? `/v1/agents/${agent.agentId}/conversations`
            : `/v1/conversations/${conversation.conversationId}/fork`;
        const input = {
          requestId: crypto.randomUUID(),
          ...(operation === "fork" ? { through } : {}),
        };
        const failed = await h.api<D.ErrorBody>(path, input);
        assert.equal(failed.status, mode === "hold" ? 503 : 429, JSON.stringify(failed.body));
        assert.equal(validError(failed.body.error), true, JSON.stringify(validError.errors));
        const before = await trace();
        assert.equal(before.local.creations.length, 1);
        assert.equal(
          before.control.calls,
          1,
          "A known direct creation failure must not trigger an automatic second reservation",
        );
        if (mode === "hold")
          assert.equal(
            before.local.creations[0]?.due,
            null,
            "Direct creation failure must persist its hard hold before returning",
          );
        else
          assert.ok(
            (before.local.creations[0]?.due ?? 0) >= before.control.lastFailureAt + 120000,
            "Direct creation failure must persist its complete positive backoff before returning",
          );
        const repaired = await trace(true);
        assert.equal(
          repaired.control.calls,
          before.control.calls,
          "First drain cannot retry a known ineligible creation",
        );
        assert.equal(
          repaired.local.creations[0]?.operationId,
          before.local.creations[0]?.operationId,
        );
        assert.deepEqual(repaired.local.growth, before.local.growth);
        const due = repaired.local.creations[0]?.due;
        if (mode === "hold")
          assert.equal(
            due,
            null,
            "Hard creation pressure must be held instead of repeatedly reserving capacity",
          );
        else
          assert.ok(
            due && due >= repaired.control.lastFailureAt + 120000,
            "Creation repair must preserve the receiver's positive retry window",
          );
        const again = await trace(true);
        assert.equal(again.control.calls, repaired.control.calls);
        await raw("/__admission-backoff/mode");
        const accepted = await h.api<D.Conversation>(path, input);
        assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
        assert.equal(accepted.body.conversationId, before.local.creations[0]?.conversationId);
        const sample = await probe.lastPhysicalSample();
        await raw(`/__admission-backoff/mode?target=creation&mode=${mode}`);
        assert.deepEqual(
          await h.api(path, input),
          accepted,
          "Known completed creation precedes new capacity",
        );
        assert.equal(await probe.lastPhysicalSample(), sample);
        const changed = await h.api(path, { ...input, title: "changed" });
        assert.equal(changed.status, 409);
      } finally {
        await h.close();
      }
    }
  });
