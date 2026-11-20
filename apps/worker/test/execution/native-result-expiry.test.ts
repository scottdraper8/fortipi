import assert from "node:assert/strict";
import test from "node:test";
import { nativeProcessRecovery } from "./native-process.ts";
import {
  assertExpiredResultPublication,
  type ResultPublicationDiagnostic,
  verifyNaturalResult,
} from "./native-reconciliation.ts";

test("Native RESULT publication expiry requires proven public reconciliation with one original execution", {
  timeout: 120000,
}, async () => {
  await nativeProcessRecovery("result", "agent-first", {
    outage: "until-lease-expired",
    verifyAfterOutcome: true,
    verify: async (c) => {
      const diagnostic = (
        await c.service.api<ResultPublicationDiagnostic>(
          `${c.probe}/job-diagnostics?job=${c.job.jobId}`,
        )
      ).body;
      const trace = (
        await c.service.api<{
          local: {
            kind: string;
            ok: boolean;
            sockets: number;
            startedAt: number;
            finishedAt: number;
            leaseExpiresAt: number;
          }[];
        }>(
          `/__test/dispatch-trace?${new URLSearchParams({ job: c.job.jobId, operation: c.job.operationId })}`,
        )
      ).body;
      assertExpiredResultPublication(diagnostic, trace, c.identity);
      for (const wrong of [
        { ...diagnostic, pressure: null },
        {
          ...diagnostic,
          pressure: {
            phase: "result_pending_commit",
            code: "workspace.conflict",
            message: "Stale lease identity",
          },
        },
        {
          ...diagnostic,
          observedLease: { ...c.identity.lease, expiresAt: diagnostic.now + 60000 },
        },
      ])
        assert.throws(() => assertExpiredResultPublication(wrong, trace, c.identity), {
          code: "ERR_ASSERTION",
        });
      assert.throws(() => assertExpiredResultPublication(diagnostic, { local: [] }, c.identity), {
        code: "ERR_ASSERTION",
      });
      const actual = await c.view();
      assert.throws(() => assert.equal(actual.jobs[0]?.state, "completed"), {
        code: "ERR_ASSERTION",
      });
      console.log(
        JSON.stringify({
          nativeResultExpiry: true,
          actualWorkspaceLeaseGuard: true,
          actualLocalObserveRetained: true,
          noAgentReceipt: true,
          missingAndWrongCauseRefused: true,
          contradictoryLiveLeaseRefused: true,
          missingObserveRefused: true,
          originalCompletionOracleRefused: true,
        }),
      );
      return verifyNaturalResult(c);
    },
  });
});
