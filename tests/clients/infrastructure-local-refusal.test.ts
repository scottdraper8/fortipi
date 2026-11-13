import assert from "node:assert/strict";
import test from "node:test";
import { produceLocalRefusalRestoration } from "./infrastructure-local-refusal.ts";

test("LOCAL actual SQLite abort rolls back admission and real process reopen retains idempotency and pressure timing", {
  timeout: 60000,
}, async () => {
  const result = await produceLocalRefusalRestoration();
  assert.deepEqual(
    Object.keys(result).sort(),
    [
      "fault",
      "rowsBefore",
      "rowsAfterRefusal",
      "requestRowsAfterRefusal",
      "restoredReservationId",
      "retryReservationId",
      "unknownStorageReset",
      "knownRetryAt",
      "retainedRetryAtAfterReopen",
    ].sort(),
  );
  assert.equal(result.fault, "local-sqlite-capacity-insert-abort");
  assert.equal(result.rowsBefore, 0);
  assert.equal(result.rowsAfterRefusal, 0);
  assert.equal(result.requestRowsAfterRefusal, 0);
  assert.equal(result.restoredReservationId, result.retryReservationId);
  assert.equal(result.unknownStorageReset, null);
  assert.ok(result.knownRetryAt > 0);
  assert.equal(result.retainedRetryAtAfterReopen, result.knownRetryAt);
});
