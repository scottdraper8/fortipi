import test from "node:test";
import { executionDecisions } from "./execution.ts";

test("public remote and independent native consent retain one actual Pi child/start and receipt-gated completion", {
  timeout: 90000,
}, async () => {
  await executionDecisions();
});
