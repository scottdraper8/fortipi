import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { pause } from "../agent/harness.ts";
import { nativeService } from "./native-service.ts";

test("actual original execution remains queryable after its supported lease update", {
  timeout: 40000,
}, async () => {
  const n = await nativeService();
  try {
    let starts = "";
    for (let i = 0; i < 800; i++) {
      starts = await readFile(n.marker, "utf8").catch(() => "");
      if (starts) break;
      await pause(30);
    }
    assert.equal(starts.match(/start/g)?.length, 1);
    const first = JSON.parse(await n.probe.activeJobPorts(n.job.jobId, true)) as {
      identity: D.ExecutionIdentity;
      query: string;
      renewal: string;
      beforeRenewalLease: D.Lease;
      renewedLease: D.Lease | null;
      delivery: string;
    };
    assert.equal(first.renewal, "renewed");
    assert.equal(first.delivery, "delivered");
    assert.ok(first.renewedLease);
    assert.equal(first.renewedLease.expiresAt, first.beforeRenewalLease.expiresAt);
    assert.equal(first.renewedLease.leaseVersion, first.beforeRenewalLease.leaseVersion + 1);
    const firstVersion = first.identity.lease.leaseVersion;
    let actualLease = n.f.ledger.get(n.job.jobId)!.assignment.identity.lease;
    for (let i = 0; i < 100; i++) {
      actualLease = n.f.ledger.get(n.job.jobId)!.assignment.identity.lease;
      if (
        actualLease.leaseVersion === first.renewedLease.leaseVersion &&
        actualLease.expiresAt === first.renewedLease.expiresAt
      )
        break;
      await pause(20);
    }
    const actualVersion = actualLease.leaseVersion;
    assert.ok(actualVersion > firstVersion, "Real native ledger must apply the renewal");
    assert.equal(actualVersion, first.renewedLease.leaseVersion);
    assert.equal(actualLease.expiresAt, first.renewedLease.expiresAt);
    const second = JSON.parse(await n.probe.activeJobPorts(n.job.jobId)) as typeof first;
    const trace = await n.h.env.CONTROL_PLANE.getByName("control").queryLeaseTrace(first.identity);
    console.log(JSON.stringify({ first: first.query, second: second.query, actualVersion, trace }));
    assert.equal(
      second.query,
      "running",
      "A lease renewal must not turn the same running execution into unknown",
    );
    const projection = await n.probe.leaseProjectionFacts(n.job.jobId);
    assert.equal(projection.originalVersion, firstVersion);
    assert.ok(projection.effectiveVersion > projection.historicalVersion);
    assert.deepEqual(projection.rejected, [
      "unknownVersion",
      "changedExpiry",
      "changedFence",
      "changedGeneration",
      "changedDigest",
      "changedTarget",
    ]);
    assert.equal((await readFile(n.marker, "utf8")).match(/start/g)?.length, 1);
  } finally {
    await n.close();
  }
});
