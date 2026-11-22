import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Approvals } from "../../../../packages/fortipi-executor/dist/index.js";
import { pause } from "../agent/harness.ts";
import { nativeService } from "./native-service.ts";

test("native executor materializes an actual Computer-backed assignment through authorized public transport", {
  timeout: 45000,
}, async () => {
  const calls: { path: string; method: string; status: number }[] = [];
  const n = await nativeService({ computer: true, observeHttp: (value) => calls.push(value) });
  try {
    let starts = "",
      localConsent = false,
      requestFailure: string | undefined;
    for (let i = 0; i < 1000; i++) {
      starts = await readFile(n.marker, "utf8").catch(() => "");
      const row = n.f.ledger.get(n.job.jobId);
      if (row?.state === "pending" && row.decision === "pending") {
        const approvals = new Approvals(n.f.ledger),
          exact = approvals.list().find((entry) => entry.jobId === n.job.jobId);
        assert.ok(exact);
        approvals.decide(exact.jobId, exact.digest, "allow");
        localConsent = true;
        try {
          await n.runtime.tick();
        } catch (error) {
          requestFailure = error instanceof Error ? error.message : "Native request failed";
          break;
        }
      }
      if (
        starts ||
        row?.reason ||
        calls.some((call) => call.path.endsWith("/manifest") && call.status === 403)
      )
        break;
      await pause(20);
    }
    const row = n.f.ledger.get(n.job.jobId);
    console.log(
      JSON.stringify({
        actualAssignmentRetained: !!row,
        explicitLocalConsent: localConsent,
        requestFailure,
        storage: n.f.profile.bindings[0]?.providerKind,
        nativeState: row?.state,
        nativeReason: row?.reason,
        actualProcessStarts: starts.match(/start/g)?.length ?? 0,
        actualSDKcalls: calls,
      }),
    );
    assert.equal(
      starts.match(/start/g)?.length ?? 0,
      1,
      "Supported Computer/native composition must not require broadening executor audience to application routes",
    );
  } finally {
    await n.close();
  }
});
