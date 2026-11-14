import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { eventually, pause } from "../agent/harness.ts";
import type { TestAgentSession } from "../agent/runtime-worker.js";
import { nativeService } from "./native-service.ts";

test("Free maximum encoded tool response retains cancel and known receipts under actual SQLite pressure", {
  timeout: 100000,
}, async (t) => {
  const n = await nativeService({ free: true, approve: false, maximumToolModel: true });
  try {
    const before = JSON.parse(
      await n.probe.inspectionJson(n.conversation.conversationId),
    ) as Awaited<ReturnType<TestAgentSession["inspectConversation"]>>;
    const assistant = before.entries.find((entry) => entry.kind === "pi.assistant");
    assert.ok(assistant);
    assert.ok(assistant.assistantBytes > 190000 && assistant.assistantBytes <= 262144);
    assert.ok(assistant.toolArgumentBytes > 62000 && assistant.toolArgumentBytes <= 65536);
    const textEndMinimumBytes = 2 * new TextEncoder().encode(assistant.text).length;
    assert.ok(
      textEndMinimumBytes > 260000 && textEndMinimumBytes < 262144,
      "Actual admitted text_end contains two copies of this complete text within the unchanged event cap",
    );
    const pending = await n.probe.growthReport();
    assert.ok(pending.pending >= 33554432);
    let physical = JSON.parse(await n.probe.storageReport()) as {
      bytes: number;
      objectBytes: number;
      headroomFraction: number;
    };
    const line = Math.floor(physical.objectBytes * (1 - physical.headroomFraction));
    for (let index = 0; index < 20 && physical.bytes < line; index++)
      physical = JSON.parse(await n.probe.fillStorageHeadroom()) as typeof physical;
    assert.ok(physical.bytes >= line && physical.bytes < physical.objectBytes);
    assert.deepEqual(
      await n.h.api(
        `/v1/conversations/${n.conversation.conversationId}/messages`,
        n.input,
        "POST",
        n.actor.token,
      ),
      n.sent,
      "The original accepted receipt survives completion-headroom pressure",
    );
    const control: D.TaskControl = {
      requestId: crypto.randomUUID(),
      reason: "Cancel retained maximum-output work before approval",
    };
    const receipt = await n.h.api<D.ControlReceipt>(
      `/v1/tasks/${n.sent.body.taskId}/cancel`,
      control,
      "POST",
      n.actor.token,
    );
    assert.equal(receipt.status, 202, JSON.stringify(receipt.body));
    const settled = await eventually(n.state, (value) => value.jobs[0]?.state === "cancelled");
    assert.equal(settled.jobs[0]?.hasExecution, false);
    assert.equal(await readFile(n.marker, "utf8").catch(() => ""), "");
    assert.equal(n.f.ledger.get(n.job.jobId), undefined);
    const cp = n.h.env.CONTROL_PLANE.getByName("control");
    const beforeControlRetry = await cp.ingressCounts();
    const controlRetry = await n.h.api<D.ControlReceipt | D.ErrorBody>(
      `/v1/tasks/${n.sent.body.taskId}/cancel`,
      control,
      "POST",
      n.actor.token,
    );
    const afterControlRetry = await cp.ingressCounts();
    t.diagnostic(
      JSON.stringify({
        firstControlRetry: {
          status: controlRetry.status,
          authenticateCalls:
            (afterControlRetry.authenticate ?? 0) - (beforeControlRetry.authenticate ?? 0),
          authenticateDenied:
            (afterControlRetry["authenticate.denied"] ?? 0) -
            (beforeControlRetry["authenticate.denied"] ?? 0),
          authorizeCalls: (afterControlRetry.authorize ?? 0) - (beforeControlRetry.authorize ?? 0),
          registrationCalls:
            (afterControlRetry.registerAuthorityRecipient ?? 0) -
            (beforeControlRetry.registerAuthorityRecipient ?? 0),
        },
      }),
    );
    if (controlRetry.status === 202) assert.deepEqual(controlRetry, receipt);
    else {
      // Setup and current-authority RPCs share this actor's ordinary Free
      // allowance. A known receipt does not bypass authentication/authorization.
      assert.equal(controlRetry.status, 429);
      assert.ok("error" in controlRetry.body);
      assert.equal(controlRetry.body.error.code, "rate_limited");
      assert.equal(controlRetry.body.error.retryable, true);
      const retryAfterMs = controlRetry.body.error.details?.retryAfterMs;
      assert.ok(retryAfterMs && retryAfterMs > 0 && retryAfterMs <= 60000);
    }
    let beforeRetry = await cp.ingressCounts();
    const known = () =>
      n.h.api<D.AdmissionReceipt | D.ErrorBody>(
        `/v1/conversations/${n.conversation.conversationId}/messages`,
        n.input,
        "POST",
        n.actor.token,
      );
    let retried = await known();
    // Calendar-window boundaries can admit another immediate retry. Preserve
    // its exact receipt, then fill only ordinary ingress with this same known
    // identity: no new model input, job, grant or synthetic rate allowance.
    for (let index = 0; index < 31 && retried.status === 202; index++) {
      assert.deepEqual(retried, n.sent);
      beforeRetry = await cp.ingressCounts();
      retried = await known();
    }
    assert.equal(retried.status, 429, "Actual ordinary Free ingress must remain bounded");
    // If the last admitted authenticate hit its limit in a later owner call,
    // the next identical request demonstrates the authentication gate itself.
    beforeRetry = await cp.ingressCounts();
    retried = await known();
    const responseReceivedAt = Date.now();
    assert.equal(retried.status, 429);
    {
      const afterRetry = await cp.ingressCounts();
      assert.equal((afterRetry.authenticate ?? 0) - (beforeRetry.authenticate ?? 0), 1);
      assert.equal(
        (afterRetry["authenticate.denied"] ?? 0) - (beforeRetry["authenticate.denied"] ?? 0),
        1,
      );
      for (let index = 0; index < 3; index++) await n.probe.runRepair();
      const original = (await n.probe.admissionStatus()).find(
        (row) => row.receipt?.operationId === n.sent.body.operationId,
      );
      assert.deepEqual(original?.receipt, n.sent.body);
      assert.equal(
        original.state,
        "settled",
        "Existing completion repair survives ordinary ingress pressure",
      );
      assert.equal(await cp.reservationState(original.reservationId), "settled");
      t.diagnostic(
        JSON.stringify({
          afterCancelKnownRetry: {
            status: retried.status,
            calls: Object.fromEntries(
              Object.entries(afterRetry)
                .map(([key, value]) => [key, value - (beforeRetry[key] ?? 0)])
                .filter(([, value]) => value !== 0),
            ),
            retainedSameReceipt: JSON.stringify(original?.receipt) === JSON.stringify(n.sent.body),
            admissionState: original?.state,
            capacityState: original ? await cp.reservationState(original.reservationId) : "missing",
          },
        }),
      );
    }
    const after = JSON.parse(
      await n.probe.inspectionJson(n.conversation.conversationId),
    ) as typeof before;
    assert.equal(after.entries.filter((entry) => entry.kind === "pi.user").length, 1);
    assert.deepEqual(
      after.entries.filter((entry) => entry.kind === "pi.assistant").map((entry) => entry.text),
      before.entries.filter((entry) => entry.kind === "pi.assistant").map((entry) => entry.text),
    );
    const growth = await n.probe.growthReport();
    assert.ok(
      growth.claims.every((claim) =>
        pending.claims.some((old) => old.operationId === claim.operationId),
      ),
      "Cancel may not allocate another model growth claim",
    );
    const current = JSON.parse(await n.probe.storageReport()) as typeof physical;
    assert.ok(current.bytes < current.objectBytes);
    t.diagnostic(
      JSON.stringify({
        physicalBeforeCancel: physical.bytes,
        physicalAfterCancel: current.bytes,
        assistantBytes: assistant.assistantBytes,
        toolArgumentBytes: assistant.toolArgumentBytes,
        textEndMinimumBytes,
        starts: 0,
        originalPiInputs: 1,
        policy: "actual Free; explicit256B progress",
      }),
    );
    assert.ok("error" in retried.body, "Ordinary refusal must provide the typed backoff contract");
    if (retried.status === 429 && "error" in retried.body) {
      assert.equal(retried.body.error.code, "rate_limited");
      assert.equal(retried.body.error.retryable, true);
      const retryAfterMs = retried.body.error.details?.retryAfterMs;
      assert.ok(retryAfterMs && retryAfterMs > 0 && retryAfterMs <= 60000);
      // Ordinary authentication quota applies even to known receipt reads.
      // Wait the actual declared window; storage pressure never changes caps.
      await pause(Math.max(0, responseReceivedAt + retryAfterMs + 25 - Date.now()));
      const recovered = await n.h.api(
        `/v1/conversations/${n.conversation.conversationId}/messages`,
        n.input,
        "POST",
        n.actor.token,
      );
      assert.deepEqual(
        recovered,
        n.sent,
        "The exact receipt must recover after actual advertised backoff",
      );
      assert.deepEqual(
        await n.h.api(`/v1/tasks/${n.sent.body.taskId}/cancel`, control, "POST", n.actor.token),
        receipt,
        "The same cancel intent must recover its exact receipt after ordinary backoff",
      );
      const recoveredPi = JSON.parse(
        await n.probe.inspectionJson(n.conversation.conversationId),
      ) as typeof before;
      assert.equal(recoveredPi.entries.filter((entry) => entry.kind === "pi.user").length, 1);
      assert.equal(recoveredPi.modelCalls, before.modelCalls);
      const recoveredGrowth = await n.probe.growthReport();
      assert.ok(
        recoveredGrowth.claims.every((claim) =>
          pending.claims.some((old) => old.operationId === claim.operationId),
        ),
        "Receipt recovery after real backoff cannot allocate another model claim",
      );
      assert.deepEqual(
        (await n.state()).jobs.map((job) => job.jobId),
        settled.jobs.map((job) => job.jobId),
      );
      t.diagnostic(
        "Actual ordinary-ingress backoff recovered the exact original receipt with one Pi input; no authentication bypass.",
      );
    }
  } finally {
    await n.close();
  }
});
