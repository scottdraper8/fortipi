import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { pause } from "../agent/harness.ts";
import { nativeService } from "./native-service.ts";

test("actual admitted Pi/native job retains query, lease and terminal closure under Free principal pressure", {
  timeout: 120000,
}, async () => {
  const n = await nativeService({ free: true });
  try {
    let starts = "";
    for (let i = 0; i < 800; i++) {
      starts = await readFile(n.marker, "utf8").catch(() => "");
      if (starts) break;
      await pause(30);
    }
    assert.equal(starts.match(/start/g)?.length, 1, "Actual admitted native child required");
    // Keep the process/lease live while leaving enough of the actual fixed
    // minute to distinguish repair headroom from a principal-window reset.
    if (Date.now() % 60000 > 25000) {
      const nextMinute = (Math.floor(Date.now() / 60000) + 1) * 60000;
      while (Date.now() < nextMinute) await pause(Math.min(500, nextMinute - Date.now()));
    }
    let pressure = 0;
    for (let i = 0; i < 20; i++) {
      const response = await n.h.api(
        `/v1/tasks/${n.sent.body.taskId}`,
        undefined,
        "GET",
        n.actor.token,
      );
      if (response.status === 429) {
        pressure = response.status;
        break;
      }
      assert.equal(response.status, 200);
    }
    assert.equal(pressure, 429);
    const pressureAt = Date.now();
    const ports = JSON.parse(await n.probe.activeJobPorts(n.job.jobId)) as {
      jobId: string;
      identity: D.ExecutionIdentity;
      leaseExpiresAt: number;
      query: string;
      renewal: string;
      delivery: string;
      facts: string;
    };
    console.log(
      JSON.stringify({
        activeJob: ports.jobId,
        target: ports.identity.target,
        leaseId: ports.identity.lease.leaseId,
        fence: ports.identity.lease.fence,
        leaseStillCurrent: ports.leaseExpiresAt > Date.now(),
        ports: {
          query: ports.query,
          renewal: ports.renewal,
          delivery: ports.delivery,
          facts: ports.facts,
        },
        actualProcessStarts: 1,
      }),
    );
    assert.ok(ports.leaseExpiresAt > Date.now(), "Distinguish pressure from an expired lease");
    assert.equal(ports.query, "running", "Existing query must retain completion headroom");
    assert.equal(ports.renewal, "renewed");
    assert.equal(ports.delivery, "delivered");
    assert.equal(ports.facts, "read");
    await writeFile(n.gate, "finish");
    let completed = false;
    for (let i = 0; i < 600; i++) {
      const current = await n.state();
      if (current.jobs[0]?.state === "completed" && n.f.ledger.get(n.job.jobId)?.committed) {
        completed = true;
        break;
      }
      await pause(40);
    }
    if (!completed) {
      console.log(await n.probe.jobDiagnosticsJson(n.job.jobId));
      const native = n.f.ledger.get(n.job.jobId);
      console.log(
        JSON.stringify({
          nativeState: native?.state,
          resultState: native?.result?.state,
          resultLeaseVersion: native?.result?.identity.lease.leaseVersion,
          actualLeaseVersion: native?.assignment.identity.lease.leaseVersion,
          CPphysicalCalls: await n.h.env.CONTROL_PLANE.getByName("control").ingressCounts(),
        }),
      );
    }
    assert.equal(
      completed,
      true,
      "Retain real terminal proof/receipt before the full principal window resets",
    );
    assert.ok(Date.now() - pressureAt < 30000);
    assert.equal(
      Math.floor(Date.now() / 60000),
      Math.floor(pressureAt / 60000),
      "A window reset is not repair headroom",
    );
    assert.equal(
      (await readFile(n.marker, "utf8")).match(/start/g)?.length,
      1,
      "Pressure cannot replay the native process",
    );
  } finally {
    await n.close();
  }
});
