import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { pause } from "../agent/harness.ts";
import { nativeService } from "./native-service.ts";

test("actual retained native receipt closes Agent/CP/executor without another observation or complete manifest", {
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
    ) as D.LocalObserve;
    const local = n.runtime.locals.get("root");
    assert.ok(local);
    const observation = await local.observe(request);
    assert.equal(observation.state, "applied");
    if (observation.state !== "applied") assert.fail("Actual native journal apply required");
    assert.ok(observation.postManifest);
    // Setup uses the real producer, consumer validator and Workspace CAS, but
    // deliberately loses the reply before Agent receipt persistence. This does
    // not qualify the separate new CP-forwarded-observation authority path.
    const retained = JSON.parse(
      await n.probe.commitNativeAndLoseReply(n.job.jobId, JSON.stringify(observation)),
    ) as { commitId: string; manifestHash: string };
    assert.equal(typeof retained.commitId, "string", JSON.stringify(retained));
    const closed = JSON.parse(await n.probe.finishKnownReceiptWithoutObservation(n.job.jobId)) as {
      observeCalls: number;
      state: string;
      eventSeq: number | null;
      receiptRetained: boolean;
      notificationPending: boolean;
    };
    assert.equal(closed.state, "completed", JSON.stringify(closed));
    assert.equal(closed.observeCalls, 0);
    assert.equal(closed.receiptRetained, true, JSON.stringify(closed));
    assert.ok(closed.eventSeq && closed.eventSeq > 0);
    assert.equal(closed.notificationPending, false, JSON.stringify(closed));
    for (let i = 0; i < 200 && !n.f.ledger.get(n.job.jobId)?.committed; i++) await pause(20);
    const native = n.f.ledger.get(n.job.jobId);
    assert.ok(native?.committed);
    assert.equal(native.state, "closed");
    assert.equal(native.committed.evidence.kind, "committed");
    if (native.committed.evidence.kind === "committed")
      assert.equal(native.committed.evidence.receipt.commitId, retained.commitId);
    assert.equal((await readFile(n.marker, "utf8")).match(/start/g)?.length, 1);
    console.log(
      JSON.stringify({
        actualProcessStarts: 1,
        actualWorkspaceCommit: retained.commitId,
        agentState: closed.state,
        actualPersistedEventSeq: closed.eventSeq,
        nativeState: native.state,
        freshObservationCalls: 0,
      }),
    );
  } finally {
    await n.close();
  }
});
