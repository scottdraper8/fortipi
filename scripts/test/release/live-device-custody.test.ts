import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import test from "node:test";
import type { IssuedRole } from "../../../tests/clients/roles.ts";
import {
  type LiveDeviceCustodyEnvelope,
  type LiveDeviceCustodyFrame,
  openLiveDeviceRole,
  sealLiveDeviceRole,
} from "../../live-device-custody.ts";

const domain = "fortipi:live-device-custody:issued-role:v1";
const key = 'synthetic-existing-admin-key-quote"backslash\\newline\n-only';
const token = 'synthetic-issued-role-quote"backslash\\newline\n-only';
const createdAt = 1800000000000,
  now = createdAt + 1000;
function fixture() {
  const frame: LiveDeviceCustodyFrame = {
    sourceCommit: "a".repeat(40),
    candidateSha256: "b".repeat(64),
    repositoryId: 1453249080,
    runId: 43365723539,
    runAttempt: 1,
    targetIdentitySha256: "c".repeat(64),
    credentialRef: { credentialId: "custody-role", generation: 3, grantVersion: 7 },
    createdAt,
    expiresAt: createdAt + 3600000,
  };
  const role: IssuedRole = {
    credential: { ...frame.credentialRef },
    token,
    role: "client",
    expiresAt: frame.expiresAt,
    state: "issued",
  };
  return { frame, role };
}
function denied(call: () => unknown) {
  assert.throws(call, (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "Live device custody unavailable or inconsistent");
    assert.equal(error.cause, undefined);
    for (const secret of [key, token]) {
      assert.equal(String(error.stack).includes(secret), false);
      assert.equal(String(error.stack).includes(JSON.stringify(secret).slice(1, -1)), false);
    }
    return true;
  });
}
// Independent Node-crypto peer for the fixed published wire recipe; never calls the helper's KDF.
function material(frame: LiveDeviceCustodyFrame, nonce: Buffer, purpose = domain) {
  const aad = Buffer.from(`${purpose}:aad\n${JSON.stringify(frame)}`);
  const salt = createHash("sha256").update(`${purpose}:salt\0`).update(nonce).digest();
  const derived = Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(key),
      salt,
      Buffer.concat([Buffer.from(`${purpose}:key\0`), aad]),
      32,
    ),
  );
  return { aad, derived };
}
function authenticatedPayload(
  payload: Buffer,
  frame: LiveDeviceCustodyFrame,
  purpose = domain,
): LiveDeviceCustodyEnvelope {
  const nonce = randomBytes(12),
    { aad, derived } = material(frame, nonce, purpose);
  try {
    const cipher = createCipheriv("aes-256-gcm", derived, nonce, { authTagLength: 16 });
    cipher.setAAD(aad);
    return {
      schemaVersion: 1,
      frame,
      nonce: nonce.toString("base64url"),
      ciphertext: Buffer.concat([cipher.update(payload), cipher.final()]).toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
    };
  } finally {
    derived.fill(0);
  }
}
test("real HKDF/AES-GCM roundtrip preserves the same issued role with fresh nonces and no plaintext transport", () => {
  const { frame, role } = fixture();
  const nonces = new Set<string>();
  for (let i = 0; i < 4; i++) {
    const envelope = sealLiveDeviceRole({ key, frame, role, now });
    nonces.add(envelope.nonce);
    assert.deepEqual(
      Object.keys(envelope).sort(),
      ["schemaVersion", "frame", "nonce", "ciphertext", "tag"].sort(),
    );
    assert.equal(Buffer.from(envelope.nonce, "base64url").length, 12);
    assert.equal(Buffer.from(envelope.tag, "base64url").length, 16);
    assert.ok(Buffer.from(envelope.ciphertext, "base64url").length <= 65536);
    assert.ok(Buffer.byteLength(JSON.stringify(envelope)) <= 90 * 1024);
    for (const secret of [key, token]) {
      assert.equal(JSON.stringify(envelope).includes(secret), false);
      assert.equal(JSON.stringify(envelope).includes(JSON.stringify(secret).slice(1, -1)), false);
    }
    assert.deepEqual(openLiveDeviceRole({ key, envelope, expectedFrame: { ...frame }, now }), role);
    const { aad, derived } = material(frame, Buffer.from(envelope.nonce, "base64url"));
    try {
      const reader = createDecipheriv(
        "aes-256-gcm",
        derived,
        Buffer.from(envelope.nonce, "base64url"),
        { authTagLength: 16 },
      );
      reader.setAAD(aad);
      reader.setAuthTag(Buffer.from(envelope.tag, "base64url"));
      const bytes = Buffer.concat([
        reader.update(Buffer.from(envelope.ciphertext, "base64url")),
        reader.final(),
      ]);
      assert.deepEqual(JSON.parse(bytes.toString()), role);
    } finally {
      derived.fill(0);
    }
    assert.ok(
      Object.isFrozen(envelope) &&
        Object.isFrozen(envelope.frame) &&
        Object.isFrozen(envelope.frame.credentialRef),
    );
  }
  assert.equal(nonces.size, 4);
});
test("tampered ciphertext, nonce, tag, every frame binding, wrong key and other purpose fail actual authentication", () => {
  const { frame, role } = fixture();
  const envelope = sealLiveDeviceRole({ key, frame, role, now });
  for (const field of ["nonce", "ciphertext", "tag"] as const) {
    const bytes = Buffer.from(envelope[field], "base64url");
    bytes[0] = bytes[0]! ^ 1;
    denied(() =>
      openLiveDeviceRole({
        key,
        envelope: { ...envelope, [field]: bytes.toString("base64url") },
        expectedFrame: frame,
        now,
      }),
    );
  }
  const alternatives: LiveDeviceCustodyFrame[] = [
    { ...frame, sourceCommit: "d".repeat(40) },
    { ...frame, candidateSha256: "d".repeat(64) },
    { ...frame, repositoryId: 2 },
    { ...frame, runId: 2 },
    { ...frame, runAttempt: 2 },
    { ...frame, targetIdentitySha256: "d".repeat(64) },
    { ...frame, credentialRef: { ...frame.credentialRef, credentialId: "other" } },
    { ...frame, credentialRef: { ...frame.credentialRef, generation: 4 } },
    { ...frame, credentialRef: { ...frame.credentialRef, grantVersion: 8 } },
    { ...frame, createdAt: frame.createdAt + 1 },
    { ...frame, expiresAt: frame.expiresAt - 1 },
  ];
  for (const expectedFrame of alternatives) {
    denied(() => openLiveDeviceRole({ key, envelope, expectedFrame, now }));
    denied(() =>
      openLiveDeviceRole({
        key,
        envelope: { ...envelope, frame: expectedFrame },
        expectedFrame,
        now,
      }),
    );
  }
  denied(() => openLiveDeviceRole({ key: `wrong-${key}`, envelope, expectedFrame: frame, now }));
  const other = authenticatedPayload(
    Buffer.from(JSON.stringify(role)),
    frame,
    "fortipi:other-purpose:v1",
  );
  denied(() => openLiveDeviceRole({ key, envelope: other, expectedFrame: frame, now }));
});
test("expiry/current/future policy, closed shapes and byte limits reject before key access", () => {
  const { frame, role } = fixture();
  const envelope = sealLiveDeviceRole({ key, frame, role, now });
  const longFrame = { ...frame, expiresAt: frame.createdAt + 3600001 };
  const longRole = { ...role, expiresAt: longFrame.expiresAt };
  denied(() => sealLiveDeviceRole({ key, frame: longFrame, role: longRole, now }));
  const longEnvelope = authenticatedPayload(Buffer.from(JSON.stringify(longRole)), longFrame);
  denied(() => openLiveDeviceRole({ key, envelope: longEnvelope, expectedFrame: longFrame, now }));
  for (const time of [frame.createdAt - 1, frame.expiresAt, frame.expiresAt + 1, NaN, Infinity, 0])
    denied(() => openLiveDeviceRole({ key, envelope, expectedFrame: frame, now: time }));
  for (const invalid of [
    { ...frame, expiresAt: frame.createdAt + 3600001 },
    { ...frame, createdAt: frame.expiresAt },
    { ...frame, runId: 0 },
    { ...frame, sourceCommit: "not-a-sha" },
    { ...frame, mode: "perform" },
  ])
    denied(() => sealLiveDeviceRole({ key, frame: invalid, role, now }));
  for (const invalid of [
    { ...envelope, mode: "perform" },
    { ...envelope, schemaVersion: 2 },
    { ...envelope, nonce: envelope.nonce + "=" },
    { ...envelope, tag: "a" },
    { ...envelope, ciphertext: Buffer.alloc(65537).toString("base64url") },
  ]) {
    let reads = 0;
    const options = new Proxy(
      { key, envelope: invalid, expectedFrame: frame, now },
      {
        get(target, property, receiver) {
          if (property === "key") reads++;
          return Reflect.get(target, property, receiver);
        },
      },
    );
    denied(() => openLiveDeviceRole(options));
    assert.equal(reads, 0);
  }
  denied(() =>
    sealLiveDeviceRole({ key, frame, role: { ...role, token: "x".repeat(65537) }, now }),
  );
  denied(() => sealLiveDeviceRole({ key: "short", frame, role, now }));
  denied(() => sealLiveDeviceRole({ key: "x".repeat(4097), frame, role, now }));
  const accessor = { key, envelope, expectedFrame: frame, now };
  let invoked = 0;
  Object.defineProperty(accessor, "key", {
    get() {
      invoked++;
      return key;
    },
    enumerable: true,
  });
  denied(() => openLiveDeviceRole(accessor));
  assert.equal(invoked, 0);
  const publicLeak = {
    ...frame,
    credentialRef: {
      ...frame.credentialRef,
      credentialId: role.token.replace(/[^A-Za-z0-9_-]/g, ""),
    },
  };
  denied(() =>
    sealLiveDeviceRole({
      key,
      frame: publicLeak,
      role: {
        ...role,
        credential: publicLeak.credentialRef,
        token: publicLeak.credentialRef.credentialId,
      },
      now,
    }),
  );
});
test("authenticated malformed plaintext still cannot substitute reference, expiry or an unissued role", () => {
  const { frame, role } = fixture();
  const invalid = [
    { ...role, credential: { ...role.credential, generation: 9 } },
    { ...role, credential: { ...role.credential, grantVersion: 9 } },
    { ...role, credential: { ...role.credential, credentialId: "other" } },
    { ...role, expiresAt: frame.expiresAt - 1 },
    { ...role, expiresAt: undefined },
    { ...role, state: "already-issued" },
    { ...role, mode: "perform" },
    { ...role, token: "" },
  ];
  for (const value of invalid) {
    const envelope = authenticatedPayload(Buffer.from(JSON.stringify(value)), frame);
    denied(() => openLiveDeviceRole({ key, envelope, expectedFrame: frame, now }));
  }
  for (const payload of [Buffer.alloc(65537, 97), Buffer.from("not JSON"), Buffer.from([0xff])]) {
    const envelope = authenticatedPayload(payload, frame);
    denied(() => openLiveDeviceRole({ key, envelope, expectedFrame: frame, now }));
  }
});
