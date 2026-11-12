import test from "node:test";
import { admissionRecovery, lifecycleRecovery } from "./oracles.ts";

test("integrated persistent runtime retains actual Pi input and repairs the same admission across both acknowledged SIGKILL boundaries", {
  timeout: 120000,
}, async () => {
  await admissionRecovery();
});
test("unfinished actual Pi task completes through Lifecycle after ungraceful same-storage reopen", {
  timeout: 60000,
}, async () => {
  await lifecycleRecovery();
});
