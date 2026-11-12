import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { eventually, pause } from "../agent/harness.ts";
import { nativeService } from "./native-service.ts";

test("a retained actual renewal receipt clears its pending pre-ACK intent without another renewal", {
  timeout: 40000,
}, async () => {
  const n = await nativeService();
  try {
    for (let i = 0; i < 800 && !(await readFile(n.marker, "utf8").catch(() => "")); i++)
      await pause(30);
    assert.equal((await readFile(n.marker, "utf8")).match(/start/g)?.length, 1);
    const original = n.f.ledger.get(n.job.jobId)!.assignment.identity.lease.leaseVersion;
    assert.deepEqual(JSON.parse(await n.probe.retainRenewalBeforeDeliveryAck(n.job.jobId)), {
      retained: true,
    });
    const renewed = await eventually(
      async () => n.f.ledger.get(n.job.jobId)!.assignment.identity.lease.leaseVersion,
      (version) => version > original,
    );
    const actual = JSON.parse(await n.probe.replayRenewalReceipt(n.job.jobId)) as {
      pending: boolean;
      original: number;
      observed: number;
    };
    assert.equal(
      actual.pending,
      false,
      "Matching renewal receipt must retire the original pending request",
    );
    assert.equal(
      actual.original,
      original,
      "Immutable assignment is not a mutable lease projection",
    );
    assert.equal(actual.observed, renewed, "Recovery must not allocate an extra renewal");
    assert.equal(n.f.ledger.get(n.job.jobId)!.assignment.identity.lease.leaseVersion, renewed);
    assert.equal((await readFile(n.marker, "utf8")).match(/start/g)?.length, 1);
  } finally {
    await n.close();
  }
});
