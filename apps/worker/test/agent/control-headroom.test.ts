import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { eventually, harness, setup } from "./harness.ts";

for (const operation of ["resume", "cancel"] as const)
  test(`near physical headroom ${operation} preserves known receipts and acknowledged growth accounting`, {
    timeout: 30000,
  }, async () => {
    const h = await harness({ main: resolve("apps/worker/test/agent/control-headroom-worker.ts") });
    try {
      const { agent, conversation } = await setup(h);
      const probe = h.env.AGENT_SESSIONS.getByName(agent.agentId);
      const input: D.MessageSubmit = {
        clientRequestId: crypto.randomUUID(),
        content: "control under physical pressure",
        busyBehavior: "followUp",
      };
      if (operation === "resume") await probe.failNextModel();
      else {
        const workspace = await h.api<D.WorkspaceBinding>("/v1/workspaces", {
          requestId: crypto.randomUUID(),
          config: { kind: "computer" },
        });
        assert.equal(workspace.status, 201);
        await probe.queueTool(
          JSON.stringify({
            tool: "javascript",
            arguments: { code: "return 42" },
            workspaceId: workspace.body.workspaceId,
            baseRevision: workspace.body.revision,
            target: { kind: "backend", backendId: "cloud", generation: 1 },
            capabilities: ["javascript"],
          }),
        );
      }
      const path = `/v1/conversations/${conversation.conversationId}/messages`;
      const sent = await h.api<D.AdmissionReceipt>(path, input);
      assert.equal(sent.status, 202, JSON.stringify(sent.body));
      if (operation === "resume") {
        await eventually(
          async () => {
            await probe.runRepair();
            return probe.admissionStatus();
          },
          (value) => value[0]?.state === "settled",
        );
      } else
        await eventually(
          async () =>
            JSON.parse(await probe.toolStateJson(conversation.conversationId)) as {
              jobs: { state: string }[];
            },
          (value) => value.jobs[0]?.state === "awaiting_approval",
        );
      const before = await probe.growthReport();
      assert.ok(before.pending >= 33554432);
      const response = await h.server.fetch(
        `http://fortipi.local/__control-headroom/fill?agent=${agent.agentId}`,
      );
      const physical = (await response.json()) as { start: number; end: number };
      assert.ok(physical.end >= 50 * 1048576);
      const snapshot = await probe.lastPhysicalSample();
      assert.deepEqual(
        await h.api(path, input),
        sent,
        "Known receipt precedes any pressure admission",
      );
      assert.equal(
        await probe.lastPhysicalSample(),
        snapshot,
        "Receipt retry does not initiate sampling",
      );
      const controlInput = {
        requestId: crypto.randomUUID(),
        ...(operation === "resume"
          ? { continuation: "resume" }
          : { reason: "stop under pressure" }),
      };
      const control = await h.api<D.ControlReceipt>(
        `/v1/tasks/${sent.body.taskId}/${operation}`,
        controlInput,
      );
      assert.equal(
        control.status,
        202,
        "Acknowledged reclaimable growth must not falsely prevent continuation: " +
          JSON.stringify(control.body),
      );
      assert.deepEqual(
        await h.api(`/v1/tasks/${sent.body.taskId}/${operation}`, controlInput),
        control,
      );
      if (operation === "resume") {
        const claims = await probe.growthReport();
        assert.equal(claims.claims.length, 1);
        assert.equal(claims.claims[0]?.operationId, control.body.operationId);
        const report = JSON.parse(await probe.lastPhysicalSample()) as {
          input: { coverage: { bytes: number }; coveredReservationIds: string[] };
        };
        assert.ok(report.input.coverage.bytes >= physical.end);
        const trace = (await (
          await h.server.fetch(
            `http://fortipi.local/__resume-settlement/trace?agent=${agent.agentId}&cid=${conversation.conversationId}`,
          )
        ).json()) as { control: { rows: { reservationId: string; covered: boolean }[] } };
        assert.equal(
          trace.control.rows.find((row) => row.reservationId === before.claims[0]?.reservationId)
            ?.covered,
          true,
          "Old growth clears only after actual matching CP sample coverage",
        );
        await eventually(
          () => h.api<D.ConversationProjection>(`/v1/conversations/${conversation.conversationId}`),
          (value) =>
            value.body.messages.some((message) => message.content === "resumed-without-input"),
        );
      } else {
        const claims = await probe.growthReport();
        assert.ok(
          claims.claims.every((row) => row.operationId === sent.body.operationId),
          "Cancel creates no new model growth claim",
        );
        await eventually(
          async () =>
            JSON.parse(await probe.toolStateJson(conversation.conversationId)) as {
              jobs: { state: string; hasExecution: boolean }[];
            },
          (value) => value.jobs[0]?.state === "cancelled" && !value.jobs[0]?.hasExecution,
        );
      }
      const inspection = JSON.parse(await probe.inspectionJson(conversation.conversationId)) as {
        inputSubmissions: number;
      };
      assert.equal(inspection.inputSubmissions, 1);
    } finally {
      await h.close();
    }
  });
