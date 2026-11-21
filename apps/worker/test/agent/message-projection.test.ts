import assert from "node:assert/strict";
import { resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { schemaRefs, schemaRegistry, wireLimits } from "fortipi-contract";
import type * as D from "../../src/boundary/dto.js";
import type { TestAgentSession } from "../api/stream-boundaries-worker.js";
import { harness } from "./harness.ts";

const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: false });
for (const schema of Object.values(schemaRegistry)) ajv.addSchema(schema);
const validMessage = ajv.compile<D.Message>({ $ref: schemaRefs.Message });

test("bounded Message parts preserve exact Unicode/control text and deterministic opaque IDs", async () => {
  const h = await harness({
    main:
      process.env.FORTIPI_MESSAGE_PROJECTION_WORKER ??
      resolve("apps/worker/test/api/stream-boundaries-worker.ts"),
  });
  try {
    const probe = h.env.AGENT_SESSIONS.getByName(
      "unicode-projection",
    ) as DurableObjectStub<TestAgentSession>;
    const messageParts = async (input: D.Message): Promise<D.Message[]> =>
      JSON.parse(await probe.messagePartsJson(input));
    for (const content of [
      "a".repeat(65536),
      "a".repeat(65537),
      `${"a".repeat(65535)}😀\u0000"\\\n${"z".repeat(40000)}`,
      "😀".repeat(65537),
    ]) {
      const input: D.Message = {
        messageId: "m".repeat(128),
        role: "assistant",
        content,
        timestamp: 123456,
      };
      const parts = await messageParts(input);
      assert.equal(parts.map((part) => part.content).join(""), content);
      assert.equal(parts[0]?.messageId, input.messageId);
      assert.equal(new Set(parts.map((part) => part.messageId)).size, parts.length);
      for (const part of parts) {
        assert.ok(validMessage(part), JSON.stringify(validMessage.errors));
        assert.ok(part.content.isWellFormed(), "A public part cannot end inside a surrogate pair");
        assert.equal(part.role, input.role);
        assert.equal(part.timestamp, input.timestamp);
        assert.ok(new TextEncoder().encode(JSON.stringify(part)).length < wireLimits.jsonBytes);
      }
      assert.deepEqual(await messageParts(input), parts);
    }
  } finally {
    await h.close();
  }
});
