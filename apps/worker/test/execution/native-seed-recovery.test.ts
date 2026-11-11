import test from "node:test";
import { nativeProcessRecovery } from "./native-process.ts";

test(
  "job seed metadata survives SIGKILL before returning to the wrapper and retains one actual native identity",
  {
    timeout: 120000,
  },
  () => nativeProcessRecovery("seed"),
);
