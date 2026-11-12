import test from "node:test";
import { nativeProcessRecovery } from "./native-process.ts";
import { verifyNativeReconciliation } from "./native-reconciliation.ts";

for (const mode of ["assign-ack", "result"] as const)
  test(
    `Agent-first ${mode} exposes honest uncertainty/expiry and public reconciliation without replay`,
    { timeout: 120000 },
    () =>
      nativeProcessRecovery(mode, "agent-first", {
        outage: mode === "result" ? "until-lease-expired" : "until-uncertain",
        verify: (c) => verifyNativeReconciliation(c, mode),
      }),
  );
