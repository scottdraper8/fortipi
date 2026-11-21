import assert from "node:assert/strict";
import test from "node:test";
import { resourceId } from "../../src/api/common.ts";
import type * as D from "../../src/boundary/dto.js";
import { pause } from "../agent/harness.ts";
import { nativeService } from "./native-service.ts";

test("reconciliation verifies an actual native receipt and preserves the original uncertain Pi disposition", {
  timeout: 45000,
}, async () => {
  const n = await nativeService({ changed: true, holdCommit: true });
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
    await n.probe.releaseNativeCommit();
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
    const current = await n.h.api<D.Job>(`/v1/jobs/${n.job.jobId}`);
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
