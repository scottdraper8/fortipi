import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { pause } from "../agent/harness.ts";
import { nativeService } from "./native-service.ts";

test("actual pending native local consent remains an explicit local-policy wait", {
  timeout: 60000,
}, async () => {
  const n = await nativeService({ localConsent: false });
  try {
    let pending = false;
    for (let i = 0; i < 800; i++) {
      const row = n.f.ledger.get(n.job.jobId);
      if (row?.state === "pending" && row.decision === "pending") {
        pending = true;
        break;
      }
      await pause(30);
    }
    assert.equal(
      pending,
      true,
      "Actual native approval journal must be pending before assessing service state",
    );
    let task: D.Task | undefined;
    for (let i = 0; i < 800; i++) {
      const result = await n.h.api<D.Task>(
        `/v1/tasks/${n.sent.body.taskId}`,
        undefined,
        "GET",
        n.actor.token,
      );
      assert.equal(result.status, 200);
      task = result.body;
      if (task.status.state === "waiting" && task.status.reason === "local-policy") break;
      const current = await n.state();
      if (current.jobs[0]?.state === "requires_reconciliation") break;
      await pause(30);
    }
    const state = await n.state(),
      row = n.f.ledger.get(n.job.jobId),
      starts = await readFile(n.marker, "utf8").catch(() => "");
    console.log(
      JSON.stringify({
        nativeState: row?.state,
        nativeDecision: row?.decision,
        applicationJobState: state.jobs[0]?.state,
        publicTask: task?.status,
        actualProcessStarts: starts.match(/start/g)?.length ?? 0,
      }),
    );
    assert.equal(starts, "");
    assert.deepEqual(task?.status, {
      state: "waiting",
      reason: "local-policy",
      supportedContinuations: [],
    });
  } finally {
    await n.close();
  }
});
