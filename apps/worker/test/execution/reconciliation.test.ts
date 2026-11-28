import assert from "node:assert/strict";
import test from "node:test";
import { resourceId } from "../../src/api/common.ts";
import type * as D from "../../src/boundary/dto.js";
import { eventually, pause } from "../agent/harness.ts";
import { nativeService } from "./native-service.ts";

test("reconciliation verifies an actual native receipt and preserves the original uncertain Pi disposition", {
  timeout: 45000,
}, async () => {
  const n = await nativeService({ changed: true, holdCommit: true, control: true });
  try {
    for (let i = 0; i < 700; i++) {
      if ((await n.state()).jobs[0]?.state === "result_pending_commit") break;
      await pause(30);
    }
    assert.equal((await n.state()).jobs[0]?.state, "result_pending_commit");
    const request = JSON.parse(
        await n.probe.nativeObservationRequest(n.job.jobId),
      ) as D.LocalObserve,
      local = n.runtime.locals.get("root");
    assert.ok(local);
    const observation = await local.observe(request);
    assert.equal(observation.state, "applied");
    const committed = JSON.parse(
      await n.probe.commitNativeAndLoseReply(n.job.jobId, JSON.stringify(observation)),
    ) as {
      commitId: string;
      commitDigest: string;
    };
    assert.equal(typeof committed.commitDigest, "string");
    const receipt = await n.h.api<D.CommitReceipt>(
      `/v1/workspaces/${n.workspaceId}/commits/${committed.commitId}?commitDigest=${committed.commitDigest}`,
    );
    assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
    const interrupted = await n.probe.interruptForReconciliation(n.job.jobId);
    assert.equal(interrupted.state, "requires_reconciliation");
    const originalJob = await n.h.api<D.Job>(`/v1/jobs/${n.job.jobId}`);
    assert.equal(originalJob.status, 200);
    assert.equal(originalJob.body.version, interrupted.version);
    await n.probe.releaseNativeCommit();
    const taskPath = `/v1/tasks/${n.sent.body.taskId}`;
    const cancellation = await n.h.api<D.ControlReceipt>(
      `${taskPath}/cancel`,
      { requestId: crypto.randomUUID(), reason: "Stop the original run before reconciliation" },
      "POST",
      n.actor.token,
    );
    assert.equal(cancellation.status, 202);
    assert.equal(cancellation.body.durableIntent, true);
    await eventually(
      async () => {
        await n.probe.runRepair();
        return n.probe.admissionStatus();
      },
      (rows) =>
        rows.some((row) => row.receipt?.taskId === n.sent.body.taskId && row.state === "settled"),
    );
    const terminalTask = await eventually(
      () => n.h.api<D.Task>(taskPath),
      (value) =>
        value.status === 200 &&
        ["completed", "failed", "cancelled", "interrupted"].includes(value.body.status.state),
    );
    assert.equal(terminalTask.body.taskId, n.sent.body.taskId);
    assert.deepEqual(await n.h.api<D.Job>(`/v1/jobs/${n.job.jobId}`), originalJob);
    const result = n.f.ledger.get(n.job.jobId)?.result;
    assert.ok(result);
    const input: D.ReconcileInput = {
      requestId: crypto.randomUUID(),
      expectedVersion: interrupted.version,
      reason: "Verify the retained publication without rewriting the failed Pi call",
      action: { kind: "accept-result", result, receipt: receipt.body },
    };
    const accepted = await n.h.api<D.ReconcileReceipt>(`/v1/jobs/${n.job.jobId}/reconcile`, input);
    assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
    let facts: Awaited<ReturnType<typeof n.probe.reconciliationFacts>> | undefined;
    for (let i = 0; i < 200; i++) {
      facts = await n.probe.reconciliationFacts(accepted.body.operationId);
      if (facts.applied) break;
      await pause(20);
    }
    assert.equal(facts?.applied, true);
    assert.equal(facts?.evidenceRetained, true);
    assert.equal(facts?.originalDisposition, "requires_reconciliation");
    assert.equal(facts?.piOutcomePreserved, true);
    assert.deepEqual(
      await n.h.api<D.Task>(taskPath),
      terminalTask,
      "Reconciliation must preserve the original terminal task and its version",
    );
    const after = await n.h.api<D.Job>(`/v1/jobs/${n.job.jobId}`);
    assert.equal(after.body.state, "requires_reconciliation");
    assert.equal(after.body.version, interrupted.version + 1);
    assert.deepEqual(await n.h.api(`/v1/jobs/${n.job.jobId}/reconcile`, input), accepted);
    const acknowledged = await n.h.api<D.ReconcileReceipt>(`/v1/jobs/${n.job.jobId}/reconcile`, {
      requestId: crypto.randomUUID(),
      expectedVersion: after.body.version,
      reason: "Acknowledge remaining external uncertainty",
      action: { kind: "acknowledge-unknown" },
    });
    assert.equal(acknowledged.status, 202);
    assert.equal(acknowledged.body.disposition, "unknown-acknowledged");
    assert.deepEqual(
      await n.h.api<D.Task>(taskPath),
      terminalTask,
      "Acknowledging uncertain effects must preserve the original terminal task",
    );
    const current = await n.h.api<D.Job>(`/v1/jobs/${n.job.jobId}`);
    assert.equal(current.body.state, after.body.state);
    assert.deepEqual(current.body.execution, after.body.execution);
    assert.equal(current.body.version, after.body.version + 1);
    const drifted: D.ReconcileInput = {
      requestId: crypto.randomUUID(),
      expectedVersion: current.body.version,
      reason: "Do not silently retry against a different committed base",
      action: {
        kind: "new-job",
        authorizationId: crypto.randomUUID(),
        newJobId: resourceId("j", n.agent.agentId),
      },
    };
    const denied = await n.h.api(`/v1/jobs/${n.job.jobId}/reconcile`, drifted);
    assert.equal(denied.status, 409, JSON.stringify(denied.body));
    assert.equal(
      (await n.state()).jobs.length,
      1,
      "Changed actual Workspace base cannot seed another job",
    );
    assert.equal(
      (await n.state()).tasks.filter((task) => task.kind === "fortipi.dispatch").length,
      1,
    );
    assert.equal(
      n.f.ledger.get(n.job.jobId)?.committed,
      undefined,
      "Reconciliation cannot forge an earlier Pi success proof",
    );
  } finally {
    await n.close();
  }
});
