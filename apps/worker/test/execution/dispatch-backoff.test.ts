import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { eventually, harness, setup } from "../agent/harness.ts";
import { routingPeer } from "./routing-peer.ts";

for (const mode of ["declared", "unspecified", "unknown"] as const)
  test(`actual Pi dispatch sleep honors ${mode} retry timing without losing ordinary recovery`, async () => {
    const h = await harness({
      main: resolve("apps/worker/test/execution/dispatch-backoff-worker.ts"),
    });
    let native: Awaited<ReturnType<typeof routingPeer>> | undefined;
    try {
      const { agent, conversation } = await setup(h),
        probe = h.env.AGENT_SESSIONS.getByName(agent.agentId);
      const raw = (path: string) =>
        h.server.fetch(`http://fortipi.local/__dispatch-backoff/${path}&agent=${agent.agentId}`);
      await raw(`mode?mode=${mode}`);
      const binding = await h.api<D.WorkspaceBinding>("/v1/workspaces", {
        requestId: crypto.randomUUID(),
        config: { kind: "computer" },
      });
      assert.equal(binding.status, 201);
      native = await routingPeer(h, binding.body, agent.agentId, conversation.conversationId);
      await probe.queueTool(
        JSON.stringify({
          tool: "shell",
          arguments: { command: "echo awaiting-approval" },
          workspaceId: binding.body.workspaceId,
          baseRevision: binding.body.revision,
          target: { kind: "executor", executorId: native.executorId, generation: 1 },
          capabilities: ["shell"],
        }),
      );
      const sent = await h.api<D.AdmissionReceipt>(
        `/v1/conversations/${conversation.conversationId}/messages`,
        {
          clientRequestId: crypto.randomUUID(),
          content: "dispatch backoff characterization",
          busyBehavior: "followUp",
        },
      );
      assert.equal(sent.status, 202);
      const trace = async () =>
        (await (await raw("trace?read=true")).json()) as {
          calls: number;
          failedAt: number;
          tasks: { id: number; status: string; until: number | null }[];
        };
      const actual = await eventually(
        trace,
        (value) => value.calls > 0 && value.tasks[0]?.status === "sleeping",
      );
      const until = actual.tasks[0]?.until;
      assert.ok(until);
      const expected = mode === "declared" ? 120000 : 30000;
      assert.ok(
        until >= actual.failedAt + expected,
        "Declared receiver backoff must not be shortened",
      );
      assert.ok(
        until <= actual.failedAt + expected + 5000,
        "No declared retry time must preserve the ordinary30s fallback, not park until operation expiry",
      );
      await probe.runRepair();
      assert.equal(
        (await trace()).calls,
        actual.calls,
        "Application repair must not bypass the actual Pi sleep",
      );
      console.log(
        JSON.stringify({ mode, calls: actual.calls, persistedSleepMs: until - actual.failedAt }),
      );
    } finally {
      await native?.close();
      await h.close();
    }
  });
