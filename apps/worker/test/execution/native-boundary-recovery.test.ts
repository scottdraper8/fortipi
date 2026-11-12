import test from "node:test";
import { nativeProcessRecovery } from "./native-process.ts";
import { verifyNaturalLostAck } from "./native-reconciliation.ts";

for (const mode of ["attempted", "assign-ack", "result", "receipt"] as const)
  test(
    `SAFE ${mode} boundary survives real service SIGKILL with retained execution identity`,
    {
      timeout: 120000,
    },
    () =>
      nativeProcessRecovery(
        mode,
        "agent-first",
        mode === "assign-ack"
          ? {
              outage: "natural",
              verify: verifyNaturalLostAck,
            }
          : undefined,
      ),
  );
