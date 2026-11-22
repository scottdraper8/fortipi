import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import Ajv from "ajv/dist/2020.js";
import { schemaRegistry } from "fortipi-contract";
import type * as D from "../../src/boundary/dto.js";
import { harness, setup } from "./harness.ts";

const ajv = new Ajv({ strict: true, validateFormats: false });
for (const schema of Object.values(schemaRegistry)) ajv.addSchema(schema);
const validError = ajv.compile({
  $ref: "https://fortipi.dev/schemas/1.0.0/common.schema.json#/$defs/ProtocolError",
});
interface Trace {
  control: { calls: number; lastFailureAt: number };
  local: {
    progress?: D.DrainProgress;
    intents: { operationId: string; due: number | null }[];
    growth: { pending: number; claims: unknown[] };
    inspection: { inputSubmissions: number };
  };
}
for (const mode of ["hold", "backoff"] as const)
  test(`admission repair honors canonical ${mode} without replacing its stable intent`, async () => {
    const h = await harness({
      main: resolve("apps/worker/test/agent/admission-backoff-worker.ts"),
    });
    try {
      const { agent, conversation } = await setup(h);
      const raw = (path: string) => h.server.fetch(`http://fortipi.local${path}`);
      const trace = async (drain = false): Promise<Trace> =>
        (
          await raw(
            `/__admission-backoff/trace?agent=${agent.agentId}&cid=${conversation.conversationId}&drain=${drain}`,
          )
        ).json() as Promise<Trace>;
      await raw(`/__admission-backoff/mode?mode=${mode}`);
      const input: D.MessageSubmit = {
        clientRequestId: crypto.randomUUID(),
        content: "stable held input",
        busyBehavior: "followUp",
      };
      const path = `/v1/conversations/${conversation.conversationId}/messages`;
      const failed = await h.api<D.ErrorBody>(path, input);
      assert.equal(failed.status, mode === "hold" ? 503 : 429, JSON.stringify(failed.body));
      assert.equal(validError(failed.body.error), true, JSON.stringify(validError.errors));
      const before = await trace();
      assert.equal(before.local.intents.length, 1);
      assert.equal(
        before.control.calls,
        1,
        "A known direct admission failure must not automatically reserve again",
      );
      if (mode === "hold")
        assert.equal(
          before.local.intents[0]?.due,
          null,
          "Direct admission failure must persist its hard hold before returning",
        );
      else
        assert.ok(
          (before.local.intents[0]?.due ?? 0) >= before.control.lastFailureAt + 120000,
          "Direct admission failure must persist its complete positive backoff before returning",
        );
      const pending = await trace(true);
      assert.equal(
        pending.control.calls,
        before.control.calls,
        "First drain cannot retry a known ineligible admission",
      );
      assert.equal(pending.local.inspection.inputSubmissions, 0);
      assert.equal(pending.local.intents[0]?.operationId, before.local.intents[0]?.operationId);
      assert.deepEqual(pending.local.growth, before.local.growth);
      if (mode === "hold") {
        assert.equal(
          pending.local.intents[0]?.due,
          null,
          "Hard unknown storage with no reset must be durably held, not polled",
        );
      } else {
        const due = pending.local.intents[0]?.due;
        assert.ok(
          due && due >= pending.control.lastFailureAt + 120000,
          "Canonical positive backoff must never be shortened to the default repair delay",
        );
        assert.ok((pending.local.progress?.nextWakeAt ?? 0) >= due);
      }
      const again = await trace(true);
      assert.equal(
        again.control.calls,
        pending.control.calls,
        "No automatic retry before eligibility",
      );
      assert.equal(again.local.inspection.inputSubmissions, 0);
      // An explicit matching caller retry can recover a hard hold after action.
      await raw("/__admission-backoff/mode");
      const accepted = await h.api<D.AdmissionReceipt>(path, input);
      assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
      assert.equal(accepted.body.operationId, before.local.intents[0]?.operationId);
      const admitted = await trace();
      assert.equal(admitted.local.intents.length, 0);
      assert.equal(admitted.local.inspection.inputSubmissions, 1);
      const changed = await h.api(path, { ...input, content: "changed" });
      assert.equal(changed.status, 409);
    } finally {
      await h.close();
    }
  });
