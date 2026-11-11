import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  assertUtf8Bytes,
  canonicalJson,
  commitDigest,
  digestJson,
  knownEventTypes,
  manifestDigest,
  nextEventCursor,
} from "../dist/index.js";
import {
  eventBase,
  hash,
  lease,
  messageEvent,
  unknownDurable,
  validators,
} from "./fixtures/wire.ts";

const { get } = validators();
test("malformed known event cannot become an unknown extension", () => {
  const validate = get("ClientEvent");
  assert.equal(validate({ ...messageEvent, payload: {} }), false, "malformed-known exclusion");
  assert.equal(validate(messageEvent), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...messageEvent, eventSeq: 0 }), false);
  for (const type of knownEventTypes) {
    assert.equal(
      validate({ ...unknownDurable, type, payload: {} }),
      false,
      `malformed durable ${type}`,
    );
    assert.equal(
      validate({ ...eventBase, durability: "volatile", type, payload: {} }),
      false,
      `malformed volatile ${type}`,
    );
  }
  assert.equal(validate(unknownDurable), true);
  assert.equal(nextEventCursor(0, unknownDurable), 1);
  assert.equal(nextEventCursor(1, unknownDurable), 1);
  assert.throws(() => nextEventCursor(0, { ...unknownDurable, eventSeq: 2 }), /resync/);
});
test("commit identity survives lease renewal and changes with immutable authority", async () => {
  const input = {
    commitId: "commit_1",
    uploadId: "upload_1",
    operationId: lease.operationId,
    jobId: lease.jobId,
    workspaceId: lease.workspaceId,
    baseRevision: lease.baseRevision,
    manifestHash: hash,
    leaseIdentity: lease,
    storage: {
      kind: "local" as const,
      preparationId: "preparation_1",
      observationSeq: 1,
      preManifestHash: hash,
      postManifestHash: hash,
    },
  };
  const expected =
    '{"baseRevision":"revision_1","commitId":"commit_1","jobId":"job_1","leaseIdentity":{"baseRevision":"revision_1","credential":{"credentialId":"credential_1","generation":2,"grantVersion":3},"executorGeneration":4,"executorId":"executor_1","fence":"7","jobId":"job_1","leaseId":"lease_1","operationId":"operation_1","ownerKind":"job","registrationId":"registration_1","workspaceId":"workspace_1"},"manifestHash":"' +
    hash +
    '","operationId":"operation_1","storage":{"kind":"local","observationSeq":1,"postManifestHash":"' +
    hash +
    '","preManifestHash":"' +
    hash +
    '","preparationId":"preparation_1"},"uploadId":"upload_1","workspaceId":"workspace_1"}';
  const digest = await commitDigest(input);
  const { uploadId: _upload, ...nativeCommit } = input;
  assert.notEqual(
    await commitDigest(nativeCommit),
    digest,
    "Native local evidence needs no fictitious upload",
  );
  const renewedLease = { ...lease, expiresAt: 40000, leaseVersion: 2 };
  assert.equal(digest, createHash("sha256").update(`fortipi:commit:v1\n${expected}`).digest("hex"));
  assert.equal(
    digest,
    await commitDigest({
      ...input,
      leaseIdentity: renewedLease,
    }),
    "renewal is excluded from immutable identity",
  );
  for (const changed of [
    { ...input, leaseIdentity: { ...lease, fence: "8" } },
    { ...input, leaseIdentity: { ...lease, credential: { ...lease.credential, generation: 3 } } },
    { ...input, storage: { ...input.storage, observationSeq: 2 } },
  ])
    assert.notEqual(digest, await commitDigest(changed));
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
