import test from "node:test";
import { nativeProcessRecovery } from "./native-process.ts";

test(
  "candidate safe wrapper recovers one actual native execution across service SIGKILL and changed receipt closure",
  {
    timeout: 120000,
  },
  () => nativeProcessRecovery(),
);
