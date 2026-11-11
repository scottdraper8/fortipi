import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { Approvals } from "../../../../packages/fortipi-executor/dist/index.js";
import type * as D from "../../src/boundary/dto.js";
import { pause } from "../agent/harness.ts";
import { nativeService } from "./native-service.ts";

test("actual file-bearing Computer snapshot reaches native stage, Workspace CAS and persisted terminal confirmation", {
  timeout: 65000,
}, async () => {
  const calls: { path: string; method: string; status: number }[] = [];
  const n = await nativeService({
    computer: true,
    computerFiles: 1,
    changed: true,
    observeHttp: (value) => calls.push(value),
  });
  try {
    let starts = "";
    for (let i = 0; i < 700; i++) {
      const row = n.f.ledger.get(n.job.jobId);
      if (row?.state === "pending" && row.decision === "pending") {
        const approvals = new Approvals(n.f.ledger),
          exact = approvals.list().find((entry) => entry.jobId === n.job.jobId);
        assert.ok(exact);
        approvals.decide(exact.jobId, exact.digest, "allow");
        await n.runtime.tick();
      }
      starts = await readFile(n.marker, "utf8").catch(() => "");
      if (starts) break;
      await pause(25);
    }
    if (!starts)
      console.log(
        JSON.stringify({
          nativeState: n.f.ledger.get(n.job.jobId)?.state,
          reason: n.f.ledger.get(n.job.jobId)?.reason,
          calls,
          diagnostic: JSON.parse(await n.probe.jobDiagnosticsJson(n.job.jobId)),
        }),
      );
    assert.equal(starts.match(/start/g)?.length, 1);
    await writeFile(n.gate, "finish");
    let job: D.Job | undefined;
    for (let i = 0; i < 700; i++) {
      const actual = await n.h.api<D.Job>(`/v1/jobs/${n.job.jobId}`);
      assert.equal(actual.status, 200);
      job = actual.body;
      if (
        job.state === "completed" ||
        job.state === "requires_reconciliation" ||
        job.state === "failed"
      )
        break;
      if (i % 25 === 0) {
        const diagnostic = JSON.parse(await n.probe.jobDiagnosticsJson(n.job.jobId)) as {
          pressure: { code: string; message: string } | null;
        };
        if (diagnostic.pressure?.code === "unauthorized") break;
      }
      await pause(50);
    }
    if (job?.state !== "completed") console.log(await n.probe.jobDiagnosticsJson(n.job.jobId));
    console.log(
      JSON.stringify({ state: job?.state, native: n.f.ledger.get(n.job.jobId)?.state, calls }),
    );
    assert.equal(job?.state, "completed");
    assert.ok(
      calls.some(
        (call) => call.path.includes("/blobs/") && call.method === "GET" && call.status === 200,
      ),
    );
    assert.ok(
      calls.some(
        (call) => call.path.endsWith("/uploads") && call.method === "POST" && call.status === 201,
      ),
    );
    assert.ok(calls.some((call) => call.path.endsWith("/validate") && call.status === 200));
    assert.ok(
      calls.some(
        (call) => call.path.includes("/chunks/") && call.method === "PUT" && call.status === 204,
      ),
    );
    for (let i = 0; i < 200 && !n.f.ledger.get(n.job.jobId)?.committed; i++) await pause(25);
    assert.ok(n.f.ledger.get(n.job.jobId)?.committed);
    assert.equal((await readFile(n.marker, "utf8")).match(/start/g)?.length, 1);
  } finally {
    await n.close();
  }
});
