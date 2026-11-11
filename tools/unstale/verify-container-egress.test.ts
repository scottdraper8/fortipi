import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyControls } from "./verify-container-egress.ts";

test("an allowed target on both sides is required to distinguish refusal from broken networking", () => {
  verifyControls(0, 1, 0);
  verifyControls(0, 124, 0);
  assert.throws(() => verifyControls(1, 1, 1));
  assert.throws(() => verifyControls(0, 124, 1));
});

test("a reachable denied target and Docker setup failures cannot count as policy refusal", () => {
  for (const status of [0, 125, 126, 127, 137]) {
    assert.throws(() => verifyControls(0, status, 0));
  }
});
