import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Approvals } from "../../../../packages/fortipi-executor/dist/index.js";
import type * as D from "../../src/boundary/dto.js";
import { pause } from "../agent/harness.ts";
import { nativeService } from "./native-service.ts";

test("default Free preparation of31 actual Computer files preserves its admitted native identity through request pressure", {
  // Actual30/min can require two60s backoffs for31 files because each GET
  // crosses two physical CP admissions. The assignment deadline stays unchanged.
  timeout: 330000,
}, async () => {
  const calls: {
    path: string;
    method: string;
    status: number;
    code?: string;
    retryAfterMs?: number;
    message?: string;
    pressure?: D.InfrastructurePressure;
  }[] = [];
  const n = await nativeService({
    free: true,
    computer: true,
    computerFiles: 31,
    observeHttp: (value) => calls.push(value),
  });
  try {
    let starts = "",
      requestFailure: string | undefined,
      admitted:
        | {
            leaseVersion: number;
            leaseExpiresAt: number;
            deadline: number;
            window: number;
            observedAt: number;
          }
        | undefined;
    for (let i = 0; i < 800; i++) {
      const row = n.f.ledger.get(n.job.jobId);
      if (row?.state === "pending" && row.decision === "pending") {
        // Keep the actual short pressure attempt within one fixed UTC minute.
        // This is real waiting, not a fake clock or a changed policy limit.
        const remaining = 60000 - (Date.now() % 60000);
        if (remaining < 8000) await pause(remaining + 20);
        admitted = {
          leaseVersion: row.assignment.identity.lease.leaseVersion,
          leaseExpiresAt: row.assignment.identity.lease.expiresAt,
          deadline: row.assignment.identity.deadline,
          window: Math.floor(Date.now() / 60000),
          observedAt: Date.now(),
        };
        const approvals = new Approvals(n.f.ledger),
          exact = approvals.list().find((entry) => entry.jobId === n.job.jobId);
        assert.ok(exact);
        approvals.decide(exact.jobId, exact.digest, "allow");
        try {
          await n.runtime.tick();
        } catch (error) {
          requestFailure = error instanceof Error ? error.message : "Snapshot request failed";
        }
      }
      starts = await readFile(n.marker, "utf8").catch(() => "");
      if (starts || requestFailure || n.f.ledger.get(n.job.jobId)?.state === "closed") break;
      await pause(30);
    }
    const row = n.f.ledger.get(n.job.jobId),
      app = await n.state();
    const cpCounts = await n.h.env.CONTROL_PLANE.getByName("control").ingressCounts();
    console.log(
      JSON.stringify({
        baseFiles: 31,
        distinctContentBlobs: 1,
        publicWriteOnlyBaseSetup: true,
        originalJobRetained: !!row,
        nativeState: row?.state,
        localDecision: row?.decision,
        nativeReason: row?.reason,
        applicationState: app.jobs[0]?.state,
        processStarts: starts.match(/start/g)?.length ?? 0,
        requestFailure,
        admitted,
        finalLeaseVersion: row?.assignment.identity.lease.leaseVersion,
        finalLeaseExpiresAt: row?.assignment.identity.lease.expiresAt,
        observedWindow: Math.floor(Date.now() / 60000),
        cpCounts,
        blobReads: calls.filter((call) => call.method === "GET" && call.path.includes("/blobs/"))
          .length,
        firstFailure: calls.find((call) => call.status >= 400),
      }),
    );
    assert.equal(
      starts.match(/start/g)?.length ?? 0,
      1,
      "A valid existing admitted preparation must back off under soft ingress pressure without discarding its identity",
    );
  } finally {
    await n.close();
  }
});
