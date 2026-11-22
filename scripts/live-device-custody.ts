import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import type { CredentialRef } from "../packages/fortipi-contract/src/generated/types.ts";
import type { IssuedRole } from "../tests/clients/roles.ts";

export interface LiveDeviceCustodyFrame {
  sourceCommit: string;
  candidateSha256: string;
  repositoryId: number;
  runId: number;
  runAttempt: number;
  targetIdentitySha256: string;
  credentialRef: CredentialRef;
  createdAt: number;
  expiresAt: number;
}
export interface LiveDeviceCustodyEnvelope {
  schemaVersion: 1;
  frame: LiveDeviceCustodyFrame;
  nonce: string;
  ciphertext: string;
  tag: string;
}
const domain = "fortipi:live-device-custody:issued-role:v1";
const payloadBound = 65536;
const envelopeBound = 90 * 1024;
const reason = "Live device custody unavailable or inconsistent";
function closed(value: unknown, keys: string[]): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  assert.ok(
    Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
  );
  assert.deepEqual(Reflect.ownKeys(value).sort(), [...keys].sort());
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors)) assert.ok("value" in descriptor);
  return value as Record<string, unknown>;
}
function integer(value: unknown, minimum = 0): number {
  assert.ok(Number.isSafeInteger(value) && Number(value) >= minimum && !Object.is(value, -0));
  return Number(value);
}
function digest(value: unknown, length = 64): string {
  assert.ok(typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value));
  return value;
}
function credentialRef(value: unknown): CredentialRef {
  const ref = closed(value, ["credentialId", "generation", "grantVersion"]);
  assert.ok(
    typeof ref.credentialId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(ref.credentialId),
  );
  return Object.freeze({
    credentialId: ref.credentialId,
    generation: integer(ref.generation),
    grantVersion: integer(ref.grantVersion),
  });
}
function frame(value: unknown, now: number): LiveDeviceCustodyFrame {
  integer(now, 1);
  const row = closed(value, [
    "sourceCommit",
    "candidateSha256",
    "repositoryId",
    "runId",
    "runAttempt",
    "targetIdentitySha256",
    "credentialRef",
    "createdAt",
    "expiresAt",
  ]);
  const createdAt = integer(row.createdAt, 1),
    expiresAt = integer(row.expiresAt, 1);
  assert.ok(
    createdAt <= now &&
      now < expiresAt &&
      expiresAt > createdAt &&
      expiresAt - createdAt <= 3600000,
  );
  return Object.freeze({
    sourceCommit: digest(row.sourceCommit, 40),
    candidateSha256: digest(row.candidateSha256),
    repositoryId: integer(row.repositoryId, 1),
    runId: integer(row.runId, 1),
    runAttempt: integer(row.runAttempt, 1),
    targetIdentitySha256: digest(row.targetIdentitySha256),
    credentialRef: credentialRef(row.credentialRef),
    createdAt,
    expiresAt,
  });
}
function role(value: unknown, expected: LiveDeviceCustodyFrame): IssuedRole {
  const row = closed(value, ["credential", "token", "role", "expiresAt", "state"]);
  assert.equal(row.state, "issued");
  assert.ok(row.role === "client" || row.role === "executor" || row.role === "admin");
  assert.ok(
    typeof row.token === "string" &&
      row.token.length > 0 &&
      row.token.length <= 1024 &&
      [...row.token].length <= 512,
  );
  const credential = credentialRef(row.credential);
  assert.deepEqual(credential, expected.credentialRef);
  assert.equal(row.expiresAt, expected.expiresAt);
  return {
    credential,
    token: row.token,
    role: row.role,
    expiresAt: expected.expiresAt,
    state: "issued",
  };
}
function aad(value: LiveDeviceCustodyFrame): Buffer {
  const bytes = Buffer.from(`${domain}:aad\n${JSON.stringify(value)}`);
  assert.ok(bytes.length <= 1024);
  return bytes;
}
function key(value: unknown, nonce: Buffer, context: Buffer): Buffer {
  assert.ok(typeof value === "string" && value.length <= 4096 && value.isWellFormed());
  const input = Buffer.from(value);
  try {
    assert.ok(input.length >= 32 && input.length <= 4096);
    const salt = createHash("sha256").update(`${domain}:salt\0`).update(nonce).digest();
    return Buffer.from(
      hkdfSync("sha256", input, salt, Buffer.concat([Buffer.from(`${domain}:key\0`), context]), 32),
    );
  } finally {
    input.fill(0);
  }
}
function encoded(value: unknown, minimum: number, maximum: number): Buffer {
  assert.ok(
    typeof value === "string" &&
      value.length <= 4 * Math.ceil(maximum / 3) &&
      /^[A-Za-z0-9_-]+$/.test(value),
  );
  const bytes = Buffer.from(value, "base64url");
  assert.ok(bytes.length >= minimum && bytes.length <= maximum);
  assert.equal(bytes.toString("base64url"), value);
  return bytes;
}
function contains(value: string, secret: string): boolean {
  return value.includes(secret) || value.includes(JSON.stringify(secret).slice(1, -1));
}

/** Caller authenticates producer/job/archive and obtains its existing admin key
 * BEFORE this call. Ciphertext is role transport, never source/job authority. */
export function sealLiveDeviceRole(input: {
  key: string;
  frame: LiveDeviceCustodyFrame;
  role: IssuedRole;
  now: number;
}): LiveDeviceCustodyEnvelope {
  let derived: Buffer | undefined, plaintext: Buffer | undefined;
  try {
    const options = closed(input, ["key", "frame", "role", "now"]);
    const bound = frame(options.frame, integer(options.now, 1));
    const issued = role(options.role, bound);
    const context = aad(bound);
    plaintext = Buffer.from(JSON.stringify(issued));
    assert.ok(plaintext);
    assert.ok(plaintext.length > 0 && plaintext.length <= payloadBound);
    const nonce = randomBytes(12);
    const secret = options.key;
    derived = key(secret, nonce, context);
    const cipher = createCipheriv("aes-256-gcm", derived, nonce, { authTagLength: 16 });
    cipher.setAAD(context);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope: LiveDeviceCustodyEnvelope = Object.freeze({
      schemaVersion: 1,
      frame: bound,
      nonce: nonce.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
    });
    const serialized = JSON.stringify(envelope);
    assert.ok(Buffer.byteLength(serialized) <= envelopeBound);
    assert.ok(!contains(serialized, issued.token) && !contains(serialized, String(secret)));
    return envelope;
  } catch {
    throw new Error(reason);
  } finally {
    derived?.fill(0);
    plaintext?.fill(0);
  }
}

/** expectedFrame/current time come from trusted independent caller context.
 * No environment, filesystem, key lookup, mint, provider call or logging. */
export function openLiveDeviceRole(input: {
  key: string;
  envelope: unknown;
  expectedFrame: LiveDeviceCustodyFrame;
  now: number;
}): IssuedRole {
  let derived: Buffer | undefined, decrypted: Buffer | undefined, plaintext: Buffer | undefined;
  try {
    const options = closed(input, ["key", "envelope", "expectedFrame", "now"]);
    const now = integer(options.now, 1),
      expected = frame(options.expectedFrame, now);
    const row = closed(options.envelope, ["schemaVersion", "frame", "nonce", "ciphertext", "tag"]);
    assert.equal(row.schemaVersion, 1);
    const actual = frame(row.frame, now);
    assert.deepEqual(actual, expected);
    const nonce = encoded(row.nonce, 12, 12),
      tag = encoded(row.tag, 16, 16),
      ciphertext = encoded(row.ciphertext, 1, payloadBound);
    const context = aad(expected);
    const serialized = JSON.stringify({
      schemaVersion: 1,
      frame: actual,
      nonce: row.nonce,
      ciphertext: row.ciphertext,
      tag: row.tag,
    });
    assert.ok(Buffer.byteLength(serialized) <= envelopeBound);
    const secret = options.key;
    derived = key(secret, nonce, context);
    const decipher = createDecipheriv("aes-256-gcm", derived, nonce, { authTagLength: 16 });
    decipher.setAAD(context);
    decipher.setAuthTag(tag);
    decrypted = decipher.update(ciphertext);
    plaintext = Buffer.concat([decrypted, decipher.final()]);
    assert.ok(plaintext);
    assert.ok(plaintext.length > 0 && plaintext.length <= payloadBound);
    const text = plaintext.toString("utf8");
    assert.ok(Buffer.from(text).equals(plaintext));
    const issued = role(JSON.parse(text), expected);
    assert.ok(!contains(serialized, issued.token) && !contains(serialized, String(secret)));
    return issued;
  } catch {
    throw new Error(reason);
  } finally {
    derived?.fill(0);
    decrypted?.fill(0);
    plaintext?.fill(0);
  }
}
