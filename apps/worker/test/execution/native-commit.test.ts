import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { pause } from "../agent/harness.ts";
import { nativeService } from "./native-service.ts";

test("real Pi/native changed result commits a complete manifest and persisted terminal proof exactly once", {
  timeout: 60000,
}, async () => {
  const n = await nativeService({ changed: true });
  try {
    let job: D.Job | undefined;
    for (let i = 0; i < 900; i++) {
      const view = await n.h.api<D.Job>(`/v1/jobs/${n.job.jobId}`);
      assert.equal(view.status, 200);
      job = view.body;
      if (job.state === "completed") break;
      if (i % 10 === 0) {
        const diagnostic = JSON.parse(await n.probe.jobDiagnosticsJson(n.job.jobId)) as {
          receiptRetained: boolean;
          nativeReceiptAck: boolean | null;
          pressure: { code: string } | null;
        };
        if (diagnostic.pressure?.code === "unauthorized") break;
      }
      await pause(40);
    }
    if (job?.state !== "completed") console.log(await n.probe.jobDiagnosticsJson(n.job.jobId));
    const input = JSON.parse(await n.probe.registrationDebugInput(n.job.jobId)) as {
      auth: D.AuthContext;
      identity: D.ExecutionIdentity;
    };
    console.log(
      await n.h.env.CONTROL_PLANE.getByName("control").registrationDebug(
        input.auth,
        input.identity,
      ),
    );
    const proof = JSON.parse(await n.probe.nativeProofMatrix(n.job.jobId)) as {
      positive: boolean;
      rejected: string[];
      realManifestEntries: number;
    };
    assert.equal(proof.positive, true);
    assert.equal(proof.realManifestEntries, 1);
    assert.deepEqual(proof.rejected, [
      "hashOnly",
      "wrongExecution",
      "wrongHash",
      "wrongPreparation",
      "wrongDigest",
      "wrongManifest",
    ]);
    assert.equal(job?.state, "completed");
    if (job?.state !== "completed") assert.fail("Actual retained completed job required");
    assert.equal(
      await readFile(join(n.f.rootPath, "native-result.txt"), "utf8"),
      "actual native change",
    );
    assert.equal((await readFile(n.marker, "utf8")).match(/start/g)?.length, 1);
    assert.equal(job.evidence.kind, "committed");
    if (job.evidence.kind !== "committed")
      assert.fail("Changed native execution needs a real workspace receipt");
    assert.equal(job.evidence.receipt.jobId, n.job.jobId);
    assert.equal(job.evidence.receipt.baseRevision, "imported_base");
    assert.notEqual(job.evidence.receipt.manifestHash, n.f.initial.manifestHash);
    for (let i = 0; i < 200 && !n.f.ledger.get(n.job.jobId)?.committed; i++) await pause(25);
    assert.equal(
      n.f.ledger.get(n.job.jobId)?.state,
      "closed",
      "Executor must accept persisted Agent sameJobCommitted+eventSeq and actual Workspace receipt",
    );
    assert.ok(n.f.ledger.get(n.job.jobId)?.committed);
    const snapshot = await n.h.api<D.ConversationProjection>(
      `/v1/conversations/${n.conversation.conversationId}`,
      undefined,
      "GET",
      n.actor.token,
    );
    assert.equal(snapshot.status, 200);
    assert.ok(snapshot.body.lastEventSeq > 0);
    console.log(
      JSON.stringify({
        jobState: job.state,
        receipt: job.evidence.receipt.commitId,
        physicalExecutionCount: 1,
        nativeState: n.f.ledger.get(n.job.jobId)?.state,
        eventSeq: snapshot.body.lastEventSeq,
        changedManifest: true,
      }),
    );
    const counts = await n.h.env.CONTROL_PLANE.getByName("control").ingressCounts();
    const completion = await n.probe.completionGuardMatrix(n.job.jobId);
    assert.equal(completion.duplicate, true);
    assert.equal(completion.finalDuplicate, true);
    assert.equal(completion.versionUnchanged, true);
    assert.deepEqual(completion.rejected, [
      "wrongRegistration",
      "missingTool",
      "splitActions",
      "resultGrantExpiredAfterAwait",
      "finalizeGrantExpiredAfterAwait",
      "floorAfterAwait",
    ]);
    const terminal = await n.probe.terminalProofMatrix(n.job.jobId);
    assert.equal(terminal.positive, true);
    assert.deepEqual(terminal.rejected, [
      "missingTool",
      "expiredContext",
      "differentEvent",
      "floorAfterEventAwait",
      "currentFloor",
    ]);
    const after = await n.h.env.CONTROL_PLANE.getByName("control").ingressCounts();
    assert.equal(
      after.authorize,
      counts.authorize,
      "Private terminal proof must not add an ordinary CP authorization hop",
    );
    const spoof = await n.h.server.fetch(
      `http://fortipi.local/__fortipi/terminal-proof/${n.job.jobId}`,
      {
        method: "POST",
        headers: { "X-Fortipi-Context": "{}", "X-Fortipi-Socket": "{}" },
        body: "{}",
      },
    );
    assert.equal(spoof.status, 404);
  } finally {
    await n.close();
  }
});
