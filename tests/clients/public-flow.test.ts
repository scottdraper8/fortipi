import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createOfflineCompletionWait } from "./public-flow.ts";

const pressure = (wait = 60000) =>
  Object.assign(new Error("public refusal"), {
    code: "rate_limited",
    status: 429,
    retryable: true,
    details: { retryAfterMs: wait },
  });
const deadline = /Public committed completion\/replay deadline exceeded/;
async function tick(t: TestContext, milliseconds: number) {
  t.mock.timers.tick(milliseconds);
  // Drain the real wait's predicate/timeout promise continuations.
  for (let i = 0; i < 4; i++) await Promise.resolve();
}
function observe(promise: Promise<void>) {
  let state = "pending";
  const done = promise.then(
    () => {
      state = "fulfilled";
    },
    (error: unknown) => {
      state = "rejected";
      return error;
    },
  );
  return { done, state: () => state };
}

test("a current server hold permits only an actual matching completion after twenty seconds", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const wait = createOfflineCompletionWait(0),
    owner = {},
    completed = new Set(["other-task"]);
  wait.accept(owner);
  const wireRefusal = {
    ...pressure(),
    status: undefined,
    retryAfterMs: 1000,
  };
  assert.equal(wait.httpWait(wireRefusal), undefined, "A wire error cannot authorize HTTP retry");
  wait.onStatus(owner, "reconnecting", wireRefusal);
  await tick(t, 10000);
  const result = observe(wait.wait(() => completed.has("admitted-task")));
  await tick(t, 0);
  await tick(t, 20000);
  assert.equal(result.state(), "pending");
  await tick(t, 30000);
  wait.onStatus(owner, "online");
  await tick(t, 10000);
  assert.equal(result.state(), "pending");
  completed.add("admitted-task");
  await tick(t, 25);
  await result.done;
  assert.equal(result.state(), "fulfilled");
});

test("missing or invalid hints cannot postpone the ordinary no-completion deadline", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const getter = Object.defineProperty(pressure(), "details", {
    get() {
      throw new Error("must not inspect accessor");
    },
  });
  for (const issue of [
    undefined,
    { ...pressure(), retryable: false },
    { ...pressure(), status: 503 },
    { ...pressure(), status: null },
    { ...pressure(), status: undefined, details: {} },
    pressure(0),
    pressure(60001),
    getter,
  ]) {
    const began = Date.now(),
      wait = createOfflineCompletionWait(began),
      owner = {};
    wait.accept(owner);
    wait.onStatus(owner, "reconnecting", issue);
    const result = observe(wait.wait(() => false));
    await tick(t, 0);
    await tick(t, 19975);
    assert.equal(result.state(), "pending");
    await tick(t, 25);
    assert.match(String(await result.done), deadline);
    assert.equal(Date.now() - began, 20000);
  }
});

test("a server hold never replaces the missing committed event", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const wait = createOfflineCompletionWait(0),
    owner = {},
    refusal = pressure();
  wait.accept(owner);
  wait.onStatus(owner, "reconnecting", refusal);
  await tick(t, 10000);
  const result = observe(wait.wait(() => false));
  await tick(t, 0);
  await tick(t, 50000);
  wait.onStatus(owner, "reconnecting", refusal);
  assert.equal(result.state(), "pending");
  await tick(t, 19975);
  assert.equal(result.state(), "pending");
  await tick(t, 25);
  assert.match(String(await result.done), deadline);
  assert.equal(Date.now(), 80000);
});

test("duplicates, stale observers and resumed overlapping holds cannot buy extra time", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const wait = createOfflineCompletionWait(0),
    owner = {},
    stale = {},
    first = pressure();
  wait.accept(owner);
  wait.onStatus(owner, "reconnecting", first);
  const result = observe(wait.wait(() => false));
  await tick(t, 0);
  await tick(t, 10000);
  wait.onStatus(owner, "reconnecting", first);
  wait.onStatus(owner, "reconnecting", pressure(20000));
  await tick(t, 5000);
  wait.onStatus(stale, "online");
  wait.onStatus(stale, "reconnecting", pressure());
  assert.equal(wait.httpWait(pressure(1)), 1, "Only two distinct current refusals consumed slots");
  await tick(t, 25000);
  wait.onStatus(owner, "reconnecting");
  wait.onStatus(owner, "reconnecting", first);
  await tick(t, 19975);
  assert.equal(result.state(), "pending");
  await tick(t, 25);
  assert.match(String(await result.done), deadline);
  assert.equal(Date.now(), 60000, "Only the actual held union until resume is credited");
});

test("HTTP waits and stream holds share three refusals and retain the first excess error", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const wait = createOfflineCompletionWait(0),
    owner = {},
    third = pressure(),
    fourth = pressure(1);
  assert.equal(wait.httpWait(pressure(10)), 10);
  assert.equal(wait.httpWait(pressure(20)), 20);
  wait.accept(owner);
  wait.onStatus(owner, "offline", third);
  wait.onStatus(owner, "reconnecting", third);
  wait.onStatus(owner, "reconnecting", third);
  assert.doesNotThrow(() => wait.onStatus(owner, "reconnecting", fourth));
  wait.onStatus(owner, "reconnecting", pressure(1));
  await assert.rejects(
    wait.wait(() => false),
    (error) => error === fourth,
  );
});

test("the existing absolute flow ceiling wins over credited server holds", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 220000 });
  const wait = createOfflineCompletionWait(0),
    owner = {};
  wait.accept(owner);
  wait.onStatus(owner, "reconnecting", pressure(20000));
  const result = observe(wait.wait(() => false));
  await tick(t, 0);
  await tick(t, 19975);
  assert.equal(result.state(), "pending");
  await tick(t, 25);
  assert.match(String(await result.done), deadline);
  assert.equal(Date.now(), 240000);
});
