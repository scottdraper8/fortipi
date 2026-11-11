import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  assertUtf8Bytes,
  canonicalJson,
  digestJson,
  manifestDigest,
  nextEventCursor,
} from "../dist/index.js";
import { eventBase, messageEvent, unknownDurable, validators } from "./fixtures/wire.ts";

const { get } = validators();
test("malformed known event cannot become an unknown extension", () => {
  const validate = get("ClientEvent");
  assert.equal(validate({ ...messageEvent, payload: {} }), false, "malformed-known exclusion");
  assert.equal(validate(messageEvent), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...messageEvent, eventSeq: 0 }), false);
  assert.equal(validate(unknownDurable), true);
  assert.equal(nextEventCursor(0, unknownDurable), 1);
  assert.equal(nextEventCursor(1, unknownDurable), 1);
  assert.throws(() => nextEventCursor(0, { ...unknownDurable, eventSeq: 2 }), /resync/);
});
test("volatile deltas omit sequence and never advance durable cursor", () => {
  const delta = {
    ...eventBase,
    durability: "volatile" as const,
    type: "message.delta",
    payload: { messageId: "message_1", text: "x" },
  };
  assert.equal(get("ClientEvent")(delta), true);
  assert.equal(nextEventCursor(2, delta), 2);
  assert.equal(get("ClientEvent")({ ...delta, eventSeq: 3 }), false);
  assert.equal(
    get("ClientEvent")({ ...delta, type: "future.progress", payload: { anything: true } }),
    true,
  );
  assert.equal(get("ClientEvent")({ ...unknownDurable, type: "message.delta" }), false);
});
test("canonical identity has independent byte/hash oracle and rejects non-JSON", async () => {
  assert.equal(canonicalJson({ z: [-0, true], a: "é" }), '{"a":"é","z":[0,true]}');
  assert.doesNotThrow(() => assertUtf8Bytes("é".repeat(8192), 16384));
  assert.throws(() => assertUtf8Bytes("é".repeat(8193), 16384));
  for (const v of [NaN, Infinity, undefined, 1n, "\ud800", { x: undefined }, new Date(), Array(1)])
    assert.throws(() => canonicalJson(v));
  const expected = createHash("sha256").update('fortipi:operation:v1\n{"a":1,"b":2}').digest("hex");
  assert.equal(await digestJson("operation", { b: 2, a: 1 }), expected);
  assert.notEqual(await digestJson("assignment", { a: 1, b: 2 }), expected);
  const a = { path: "a", type: "directory" as const, mode: 493 as const };
  const z = { path: "z", type: "directory" as const, mode: 493 as const };
  assert.equal(
    await manifestDigest({ version: 1, entries: [z, a] }),
    await manifestDigest({ version: 1, entries: [a, z] }),
  );
});
