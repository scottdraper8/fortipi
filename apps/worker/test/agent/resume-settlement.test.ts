import assert from "node:assert/strict";
import { resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { eventually, harness, setup } from "./harness.ts";

interface Trace {
  control: {
    droppedReservationId?: string;
    drops: number;
    calls: Record<string, number>;
    rows: {
      reservationId: string;
      operationId: string;
      settlement: string | null;
      covered: boolean;
      growthBytes: number;
    }[];
  };
  local: {
    inspection: { inputSubmissions: number };
    continueCalls: number;
    controls: { id: string }[];
    admissions: {
      state: string;
      operationId: string;
      reservationId: string;
      continuationOperationId?: string;
      continuationReservationId?: string;
    }[];
    growth: {
      pending: number;
      claims: { operationId: string; bytes: number; reservationId?: string }[];
    };
    completed: unknown[];
    report: unknown;
  };
}
// Derived from Arendt's independent 550 lost-consumed-ACK counterexample.
test("resume waits for the preceding consumed ACK and retains both claims through real sample ACK", {
  timeout: 30000,
}, async () => {
  for (const lostAck of [false, true]) {
    const h = await harness({
      main:
        process.env.FORTIPI_RESUME_FAULT_WORKER ??
        resolve("apps/worker/test/agent/resume-settlement-worker.ts"),
    });
    try {
      const { agent, conversation } = await setup(h);
      const probe = h.env.AGENT_SESSIONS.getByName(agent.agentId);
      const raw = (path: string) => h.server.fetch(`http://fortipi.local${path}`);
      const trace = async (sample = false): Promise<Trace> =>
        (
          await raw(
            `/__resume-settlement/trace?agent=${agent.agentId}&cid=${conversation.conversationId}&sample=${sample}`,
          )
        ).json() as Promise<Trace>;
      if (lostAck) await raw("/__resume-settlement/arm");
      await probe.failNextModel();
      const sent = await h.api<D.AdmissionReceipt>(
        `/v1/conversations/${conversation.conversationId}/messages`,
        {
          clientRequestId: crypto.randomUUID(),
          content: "kept-original",
          busyBehavior: "followUp",
        },
      );
      assert.equal(sent.status, 202);
      await eventually(
        () => h.api<D.Task>(`/v1/tasks/${sent.body.taskId}`),
        (task) => task.body.status?.state === "waiting",
      );
      const before = await eventually(trace, (state) =>
        lostAck
          ? state.control.drops > 0 && state.local.admissions[0]?.state === "settlement_pending"
          : state.local.admissions[0]?.state === "settled",
      );
      const oldReservation = before.local.admissions[0]?.reservationId;
      assert.ok(oldReservation);
      assert.equal(
        before.control.rows.find((row) => row.reservationId === oldReservation)?.settlement,
        "consumed",
        "The original CP settlement really committed before its ACK was lost",
      );
      const input: D.TaskResume = { requestId: crypto.randomUUID(), continuation: "resume" };
      if (lostAck) {
        const blocked = await h.api<{ error: D.ProtocolError }>(
          `/v1/tasks/${sent.body.taskId}/resume`,
          input,
        );
        assert.equal(
          blocked.status,
          409,
          "Unacknowledged prior settlement must block new resume work",
        );
        assert.equal(blocked.body.error.code, "conflict");
        const held = await trace();
        assert.deepEqual(held.local.growth, before.local.growth, "No new prospective growth claim");
        assert.equal(held.local.controls.length, 0);
        assert.equal(held.local.continueCalls, 0);
        assert.equal(
          held.control.calls.reserveCapacity,
          before.control.calls.reserveCapacity,
          "Blocked resume must not reserve new CP capacity",
        );
        assert.equal(held.local.admissions[0]?.continuationOperationId, undefined);
        // Measuring without the old settlement ACK cannot refund its hold.
        const unsatisfied = await trace(true);
        assert.equal(unsatisfied.local.growth.claims.length, 1);
        assert.equal(
          unsatisfied.control.rows.find((row) => row.reservationId === oldReservation)?.covered,
          false,
        );
        await raw("/__resume-settlement/release");
        const repaired = await eventually(
          async () => {
            await probe.runRepair();
            return trace();
          },
          (value) => value.local.admissions[0]?.state === "settled",
        );
        assert.equal(repaired.local.admissions[0]?.state, "settled");
        assert.equal(
          repaired.local.growth.claims.length,
          1,
          "Settlement ACK alone retains local P",
        );
        assert.equal(
          repaired.local.completed.length,
          1,
          "Old ACK repair is durable before new work",
        );
      }
      // Lose the supported Pi continue reply once, after its real commit.
      await raw(`/__resume-settlement/lose-continue?agent=${agent.agentId}`);
      const resumed = await h.api<D.ControlReceipt>(`/v1/tasks/${sent.body.taskId}/resume`, input);
      assert.equal(resumed.status, 202, JSON.stringify(resumed.body));
      const retried = await h.api<D.ControlReceipt>(`/v1/tasks/${sent.body.taskId}/resume`, input);
      assert.deepEqual(retried, resumed, "Same-own continuation reentry retains its receipt");
      await eventually(
        async () =>
          JSON.parse(await probe.inspectionJson(conversation.conversationId)) as {
            entries: { text: string }[];
          },
        (state) => state.entries.some((entry) => entry.text === "resumed-without-input"),
      );
      for (let i = 0; i < 3; i++) await probe.runRepair();
      await eventually(
        () => h.api<D.Task>(`/v1/tasks/${sent.body.taskId}`),
        (task) => task.body.status?.state === "completed",
      ).catch(async (error) => {
        console.log(
          JSON.stringify({
            preflightIncomplete: await trace(),
            task: await h.api<D.Task>(`/v1/tasks/${sent.body.taskId}`),
          }),
        );
        throw error;
      });
      for (let i = 0; i < 3; i++) await probe.runRepair();
      const after = await trace(true);
      assert.equal(after.local.continueCalls, 1, "Actual Pi continuation is never replayed");
      assert.equal(after.local.controls.length, 0);
      assert.equal(after.local.admissions[0]?.state, "settled");
      assert.equal(after.local.admissions[0]?.continuationOperationId, resumed.body.operationId);
      assert.equal(
        after.local.inspection.inputSubmissions,
        1,
        "Resume never adds another user input",
      );
      assert.equal(
        after.local.growth.claims.length,
        0,
        "Completed old input and resumed turn must not orphan the preceding 32MiB growth claim after real M/sample ACK",
      );
      assert.equal(
        after.control.rows.find((row) => row.reservationId === oldReservation)?.covered,
        true,
        "The original consumed CP growth must also be covered",
      );
    } finally {
      await h.close();
    }
  }
});
