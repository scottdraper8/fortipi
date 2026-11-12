import assert from "node:assert/strict";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { schemaRefs, schemaRegistry, wireLimits } from "fortipi-contract";
import type * as D from "../../src/boundary/dto.js";
import { harness, setup } from "./harness.ts";

// Oracle: the published schema and negotiated JSON byte limit determine valid
// input. A lower private forwarding limit must not reject an allowed message.
test("schema-valid maximum escaped input fits the advertised HTTP envelope", async () => {
  const h = await harness();
  try {
    const { agent, conversation } = await setup(h);
    const stub = h.env.AGENT_SESSIONS.getByName(agent.agentId);
    await stub.failNextModel();
    const body: D.MessageSubmit = {
      clientRequestId: crypto.randomUUID(),
      content: "\u0000".repeat(65536),
      busyBehavior: "followUp",
    };
    const ajv = new Ajv2020({ strict: true, validateFormats: false });
    for (const schema of Object.values(schemaRegistry)) ajv.addSchema(schema);
    assert.ok(ajv.compile({ $ref: schemaRefs.MessageSubmit })(body));
    const requestBytes = new TextEncoder().encode(JSON.stringify(body)).length;
    assert.ok(requestBytes < wireLimits.jsonBytes);
    const protocol = await h.api<{ limits: { jsonBytes: number } }>("/v1/protocol");
    assert.equal(protocol.status, 200);
    assert.ok(requestBytes < protocol.body.limits.jsonBytes);
    const path = `/v1/conversations/${conversation.conversationId}/messages`;
    const first = await h.api<{ error?: D.ProtocolError }>(path, body);
    const repeated = await h.api<{ error?: D.ProtocolError }>(path, body);
    const inspect = JSON.parse(await stub.inspectionJson(conversation.conversationId)) as {
      inputSubmissions: number;
      entries: { kind: string; text: string }[];
    };
    console.log({
      requestBytes,
      requestLimit: protocol.body.limits.jsonBytes,
      firstStatus: first.status,
      firstCode: first.body.error?.code,
      repeatedStatus: repeated.status,
      inputSubmissions: inspect.inputSubmissions,
      exactPiInput: inspect.entries.some(
        (entry) => entry.kind === "pi.user" && entry.text === body.content,
      ),
    });
    assert.equal(repeated.status, first.status);
    assert.equal(
      first.status,
      202,
      "Schema-valid MessageSubmit below the advertised JSON limit hits an unadvertised lower Agent forwarding limit",
    );
  } finally {
    await h.close();
  }
});
