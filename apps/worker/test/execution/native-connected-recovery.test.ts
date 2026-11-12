import test from "node:test";
import { nativeProcessRecovery } from "./native-process.ts";

for (const mode of ["result", "receipt"] as const)
  test(
    `candidate SAFE ${mode} recovery with executor reconnected before Agent activation`,
    { timeout: 120000 },
    () => nativeProcessRecovery(mode, "executor-first"),
  );
