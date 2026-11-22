import test from "node:test";
import { approvalReconciliation, dispatchRecovery } from "./dispatch-recovery.ts";

test("actual Pi attachment and retained workspace receipt survive acknowledged service loss with one fsynced native start", {
  timeout: 240000,
}, async () => {
  await dispatchRecovery();
});
test("actual unknown effects remain uncertain and explicit retry creates a separately consented job", {
  timeout: 180000,
}, async () => {
  await approvalReconciliation();
});
