import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import type { TestAgentSession } from "./enforcer-text-fidelity-worker.js";
import { eventually, harness, setup } from "./harness.ts";

test("public committed answer preserves Pi's supported result text across text blocks", async () => {
  const h = await harness({
    main: resolve("apps/worker/test/agent/enforcer-text-fidelity-worker.ts"),
  });
  try {
    const { agent, conversation } = await setup(h);
    const path = `/v1/conversations/${conversation.conversationId}`;
    const sent = await h.api<D.AdmissionReceipt>(`${path}/messages`, {
      clientRequestId: crypto.randomUUID(),
      content: "two text blocks",
      busyBehavior: "followUp",
    });
    assert.equal(sent.status, 202);
    const stub = h.env.AGENT_SESSIONS.getByName(
      agent.agentId,
    ) as unknown as DurableObjectStub<TestAgentSession>;
    const canonical = await stub.canonicalResult(
      conversation.conversationId,
      sent.body.operationId,
    );
    assert.equal(canonical.status, "done");
    if (canonical.status !== "done") assert.fail("Canonical Pi answer required");
    assert.equal(canonical.text, "alphaomega");
    const snapshot = await eventually(
      () => h.api<D.ConversationProjection>(path),
      (value) => value.body.conversation.taskState.state === "completed",
    );
    const publicText = snapshot.body.messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.content)
      .join("");
    console.log({ canonicalText: canonical.text, publicText });
    assert.equal(publicText, canonical.text, "Projection inserted text absent from Pi's answer");
  } finally {
    await h.close();
  }
});
