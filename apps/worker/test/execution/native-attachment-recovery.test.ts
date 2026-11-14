import test from "node:test";
import { nativeProcessRecovery } from "./native-process.ts";

test(
  "candidate SAFE atomic child attachment survives SIGKILL before wait and one real native changed commit",
  {
    timeout: 120000,
  },
  () => nativeProcessRecovery("attached"),
);
