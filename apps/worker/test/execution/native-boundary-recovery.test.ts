import test from "node:test";
import { nativeProcessRecovery } from "./native-process.ts";

for (const mode of ["attempted", "assign-ack", "result", "receipt"] as const)
  test(
    `candidate SAFE ${mode} boundary survives real service SIGKILL with retained execution identity`,
    {
      timeout: 120000,
    },
    () => nativeProcessRecovery(mode),
  );
