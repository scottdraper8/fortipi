import test from "node:test";
import { nativeProcessRecovery } from "./native-process.ts";
import { verifyNaturalRunning } from "./native-reconciliation.ts";

test(
  "candidate safe wrapper recovers one actual native execution across service SIGKILL and changed receipt closure",
  {
    timeout: 120000,
  },
  () =>
    nativeProcessRecovery("running", "agent-first", {
      outage: "natural",
      verifyAfterOutcome: true,
      verify: verifyNaturalRunning,
    }),
);

test(
  "Agent-first running recovery completes after a real registered query-boundary handoff",
  {
    timeout: 120000,
  },
  () =>
    nativeProcessRecovery("running", "agent-first", {
      outage: "query-ready",
      verify: () => Promise.resolve("continue" as const),
    }),
);

test(
  "A real offline running query disproves unconditional completion and uses public reconciliation",
  {
    timeout: 120000,
  },
  () =>
    nativeProcessRecovery("running", "agent-first", {
      outage: "until-uncertain",
      verifyAfterOutcome: true,
      verify: verifyNaturalRunning,
    }),
);
