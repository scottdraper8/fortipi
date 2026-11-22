import test from "node:test";
import {
  replayLiveRace,
  retainedReplayBounds,
  storedHistoryLifecycle,
} from "./replay-scenarios.ts";

test("actual committed activity between captured HTTP replay and native live attach applies once in order", {
  timeout: 60000,
}, async () => {
  await replayLiveRace();
});
test("original application envelopes survive supported Pi compact/reset, independent fork and runtime death", {
  timeout: 90000,
}, async () => {
  await storedHistoryLifecycle();
});
test("actual retained cursor expiry and future cursor errors remain distinct under a lower fixture allocation", {
  timeout: 60000,
}, async () => {
  await retainedReplayBounds();
});
