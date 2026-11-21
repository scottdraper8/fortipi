import test from "node:test";
import { concurrentAdmissionBoundary } from "./oracles.ts";

test("actual queued SQLite arbitrates the last slot across conversations and restores the original refused intent", {
  timeout: 60000,
}, async () => {
  await concurrentAdmissionBoundary();
});
