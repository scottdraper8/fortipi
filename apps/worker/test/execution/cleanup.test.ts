import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { Approvals } from "../../../../packages/fortipi-executor/dist/index.js";
import type * as D from "../../src/boundary/dto.js";
import { eventually, pause } from "../agent/harness.ts";
import type { ControlPlane, WorkspaceObject } from "./cleanup-worker.js";
import { nativeService } from "./native-service.ts";

test("cancelling an actual started native process retains an honest external-effects disposition", {
  timeout: 45000,
}, async () => {
  const n = await nativeService({
    control: true,
    main: resolve("apps/worker/test/execution/cleanup-worker.ts"),
  });
  try {
    for (let i = 0; i < 600; i++) {
      await n.runtime.tick();
      if ((await readFile(n.marker, "utf8").catch(() => "")).includes("start")) break;
      await pause(50);
    }
    assert.ok((await readFile(n.marker, "utf8")).includes("start"));
    const before = n.f.ledger.get(n.job.jobId);
    assert.ok(before);
    const identity = structuredClone(before.assignment.identity);
    const input: D.TaskControl = { requestId: crypto.randomUUID(), reason: "Stop started work" };
    const cancelled = await n.h.api<D.ControlReceipt>(
      `/v1/tasks/${n.sent.body.taskId}/cancel`,
      input,
      "POST",
      n.actor.token,
    );
    assert.equal(cancelled.status, 202, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.disposition.possibleExternalEffects, true);
    assert.deepEqual(
      await n.h.api(`/v1/tasks/${n.sent.body.taskId}/cancel`, input, "POST", n.actor.token),
      cancelled,
    );
    let terminal = await n.state();
    for (let i = 0; i < 600; i++) {
      terminal = await n.state();
      if (["requires_reconciliation", "cancelled"].includes(terminal.jobs[0]?.state ?? "")) break;
      await pause(50);
    }
    assert.ok(
      ["requires_reconciliation", "cancelled"].includes(terminal.jobs[0]?.state ?? ""),
      JSON.stringify({
        application: terminal,
        diagnostic: JSON.parse(await n.probe.jobDiagnosticsJson(n.job.jobId)),
      }),
    );
    const env = await n.h.server
      .getWorker<{ CONTROL_PLANE: DurableObjectNamespace<ControlPlane> }>()
      .getEnv();
    const cancellation = await env.CONTROL_PLANE.getByName("control").cancellationFacts();
    console.log(
      JSON.stringify({
        cancellation,
        terminal: terminal.jobs[0]?.state,
        nativeCancelled: n.f.ledger.get(n.job.jobId)?.cancelled ?? false,
      }),
    );
    assert.equal(
      cancellation?.ok,
      true,
      "The existing task cancellation authority must reach the admitted native job",
    );
    const native = await eventually(
      async () => {
        await n.runtime.tick();
        return n.f.ledger.get(n.job.jobId);
      },
      (value) => !!value?.result,
    );
    assert.ok(native?.result);
    assert.equal(native.result.state, "cancelled");
    assert.equal(native.result.possibleExternalEffects, true);
    assert.deepEqual(native.assignment.identity, identity);
    assert.equal(terminal.jobs.length, 1);
    assert.equal(terminal.tasks.filter((task) => task.kind === "fortipi.dispatch").length, 1);
    assert.equal(native.committed, undefined, "Cancellation is not successful publication");
    assert.equal((await readFile(n.marker, "utf8")).match(/start/g)?.length, 1);
    assert.deepEqual(
      await n.h.api(
        `/v1/conversations/${n.conversation.conversationId}/messages`,
        n.input,
        "POST",
        n.actor.token,
      ),
      n.sent,
    );
    console.log(
      JSON.stringify({
        started: 1,
        nativeCancelled: true,
        job: terminal.jobs[0]?.state,
        externalEffects: true,
      }),
    );
  } finally {
    await n.close();
  }
});

test("discard-staging waits for actual cleanup ACK and matching retry repairs a lost abort reply", {
  timeout: 60000,
}, async () => {
  const n = await nativeService({
    computer: true,
    changed: true,
    holdCommit: true,
    reconciliation: true,
    main: resolve("apps/worker/test/execution/cleanup-worker.ts"),
  });
  try {
    // A remote approval does not replace this native, exact-digest consent.
    for (let i = 0; i < 600; i++) {
      const row = n.f.ledger.get(n.job.jobId);
      if (row?.state === "pending" && row.decision === "pending") {
        const approvals = new Approvals(n.f.ledger),
          exact = approvals.list().find((entry) => entry.jobId === n.job.jobId);
        assert.ok(exact);
        approvals.decide(exact.jobId, exact.digest, "allow");
      }
      await n.runtime.tick();
      if ((await n.state()).jobs[0]?.state === "result_pending_commit") break;
      await pause(25);
    }
    const job = await n.h.api<D.Job>(`/v1/jobs/${n.job.jobId}`);
    assert.equal(job.body.state, "result_pending_commit");
    assert.equal(job.body.preparedResult?.state, "succeeded");
    const uploadId = job.body.preparedResult?.uploadId;
    assert.ok(uploadId, "Actual native Computer transfer must retain a real staged upload");
    const env = await n.h.server
      .getWorker<{ WORKSPACES: DurableObjectNamespace<WorkspaceObject> }>()
      .getEnv();
    const workspace = env.WORKSPACES.getByName(n.workspaceId);
    await workspace.loseAbortReply(true);
    const interrupted = await n.probe.interruptForReconciliation(n.job.jobId);
    await n.probe.releaseNativeCommit();
    const input: D.ReconcileInput = {
      requestId: crypto.randomUUID(),
      expectedVersion: interrupted.version,
      reason: "Discard staged bytes without publishing",
      action: { kind: "discard-staging" },
    };
    const lost = await n.h.api<D.ErrorBody>(
      `/v1/jobs/${n.job.jobId}/reconcile`,
      input,
      "POST",
      n.actor.token,
    );
    assert.equal(lost.status, 409, JSON.stringify(lost.body));
    assert.equal(lost.body.error.code, "interrupted");
    assert.ok((await workspace.abortFacts()).committed >= 1);
    const status = await n.h.api<D.UploadStatus>(
      `/v1/workspaces/${n.workspaceId}/uploads/${uploadId}`,
      undefined,
      "GET",
      n.actor.token,
    );
    assert.equal(status.status, 200, JSON.stringify(status.body));
    assert.equal(status.body.state, "aborted");
    assert.equal(
      (await n.h.api<D.Job>(`/v1/jobs/${n.job.jobId}`)).body.version,
      interrupted.version,
    );
    await workspace.loseAbortReply(false);
    const acknowledged = await n.h.api<D.ReconcileReceipt>(
      `/v1/jobs/${n.job.jobId}/reconcile`,
      input,
      "POST",
      n.actor.token,
    );
    assert.equal(acknowledged.status, 202, JSON.stringify(acknowledged.body));
    assert.equal(acknowledged.body.disposition, "staging-discarded");
    assert.deepEqual(
      await n.h.api(`/v1/jobs/${n.job.jobId}/reconcile`, input, "POST", n.actor.token),
      acknowledged,
    );
    const facts = await n.probe.reconciliationFacts(acknowledged.body.operationId);
    assert.equal(facts.applied, true);
    assert.equal(facts.piOutcomePreserved, true);
    const current = await n.h.api<D.Job>(`/v1/jobs/${n.job.jobId}`);
    assert.equal(current.body.version, interrupted.version + 1);
    assert.equal(current.body.state, interrupted.state);
    assert.equal(n.f.ledger.get(n.job.jobId)?.committed, undefined);
    assert.equal((await readFile(n.marker, "utf8")).match(/start/g)?.length, 1);
    console.log(
      JSON.stringify({
        actualAbortedUpload: true,
        lostReplyNotAcknowledged: true,
        matchingRetry: true,
        processStarts: 1,
      }),
    );
  } finally {
    await n.close();
  }
});
