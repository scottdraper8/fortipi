import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { eventually, harness, setup } from "./harness.ts";

test("fork high-water admission preserves a near-headroom copy and refuses further growth before effects", {
  timeout: 40000,
}, async () => {
  // Existing synthetic request headroom isolates physical admission; Free SQL,
  // growth and response bounds remain unchanged. This is not a Free-rate claim.
  const h = await harness({
    main: resolve("apps/worker/test/agent/fork-growth-worker.ts"),
    modelChunkBytes: 256,
  });
  try {
    const { agent, conversation } = await setup(h),
      probe = h.env.AGENT_SESSIONS.getByName(agent.agentId),
      path = `/v1/conversations/${conversation.conversationId}`;
    const input = {
      clientRequestId: crypto.randomUUID(),
      content: "large-answer",
      busyBehavior: "followUp",
    };
    const sent = await h.api<D.AdmissionReceipt>(`${path}/messages`, input);
    assert.equal(sent.status, 202);
    const completed = await eventually(
      () => h.api<D.ConversationProjection>(path),
      (value) => value.body.conversation.taskState.state === "completed",
    );
    await probe.runRepair();
    const endpoint = `/__fork-growth/status?agent=${agent.agentId}`;
    const status = async () =>
      (await (await h.server.fetch(`http://fortipi.local${endpoint}`)).json()) as {
        piIds: string[];
        growth: { claims: { operationId: string; bytes: number }[] };
      };
    const fill = async (side: "below" | "above") => {
      let state: { bytes: number; target: number; admission: number };
      do {
        state = (await (
          await h.server.fetch(
            `http://fortipi.local/__fork-growth/fill?agent=${agent.agentId}&side=${side}`,
          )
        ).json()) as typeof state;
      } while (state.bytes < state.target);
      return state;
    };
    const below = await fill("below"),
      forkInput = { requestId: crypto.randomUUID(), through: completed.body.lastEventSeq },
      fork = await h.api<D.Conversation>(`${path}/fork`, forkInput);
    assert.equal(fork.status, 201, JSON.stringify(fork.body));
    const copy = await h.api<D.ConversationProjection>(
      `/v1/conversations/${fork.body.conversationId}`,
    );
    assert.equal(
      copy.body.messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.content)
        .join(""),
      "x".repeat(102400),
    );
    await probe.runRepair();
    const above = await fill("above"),
      before = await status(),
      calls = await h.env.CONTROL_PLANE.getByName("control").ingressCounts(),
      refused = await h.api<D.ErrorBody>(`${path}/fork`, {
        ...forkInput,
        requestId: crypto.randomUUID(),
      });
    assert.equal(refused.status, 503, JSON.stringify(refused.body));
    assert.equal(refused.body.error.code, "quota_paused");
    const after = await status(),
      later = await h.env.CONTROL_PLANE.getByName("control").ingressCounts();
    assert.deepEqual(after.piIds, before.piIds, "Refusal cannot allocate another Pi child");
    assert.ok(
      after.growth.claims.every((claim) =>
        before.growth.claims.some((old) => old.operationId === claim.operationId),
      ),
      "Refusal can cover old ACKed claims with actual M, but cannot strand a NEW growth claim",
    );
    assert.equal(
      later.reserveCapacity,
      calls.reserveCapacity,
      "Physical refusal must precede new CP reservation",
    );
    assert.deepEqual(
      await h.api(`${path}/fork`, forkInput),
      fork,
      "An accepted fork retains its exact receipt under later growth pressure",
    );
    assert.deepEqual(await h.api(`${path}/messages`, input), sent);
    console.log(
      JSON.stringify({
        admittedSql: below.bytes,
        refusedSql: above.bytes,
        admissionLine: above.admission,
        exactCopiedCharacters: 102400,
        additionalPiChildren: 0,
        additionalReservations: 0,
      }),
    );
  } finally {
    await h.close();
  }
});
