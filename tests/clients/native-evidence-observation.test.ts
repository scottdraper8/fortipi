import assert from "node:assert/strict";
import test from "node:test";
import { nativeEvidenceFailureLine } from "./native-evidence-observation.ts";

const canary = "private-role-ticket-request-path-canary";
test("native failure diagnostics retain fixed checkpoints and bounded error class/code only", () => {
  const error = new assert.AssertionError({
    message: canary,
    actual: { token: canary },
    expected: canary,
    operator: "strictEqual",
  });
  Object.assign(error, { cause: Error(canary), payload: canary });
  Object.freeze(error);
  assert.deepEqual(
    JSON.parse(nativeEvidenceFailureLine("daemon-confinement-local-approval", error)),
    {
      diagnostic: "native-evidence-failure",
      phase: "daemon-confinement-local-approval",
      errorClass: "AssertionError",
      errorCode: "ERR_ASSERTION",
    },
  );
  for (const phase of [
    "candidate-metadata",
    "candidate-environment",
    "candidate-checkout",
    "candidate-workflow",
    "candidate-reference",
    "candidate-authentication",
    "candidate-payload",
    "evidence-producer",
    "evidence-fixture",
    "evidence-coordinator",
    "evidence-receipt",
    "service-native-setup",
    "service-dispatch-approval",
    "daemon-cleanup-stop",
  ]) {
    const line = nativeEvidenceFailureLine(phase, error);
    assert.equal(JSON.parse(line).phase, phase);
    assert.equal(line.includes(canary), false);
    assert.ok(Buffer.byteLength(line) <= 256);
  }
  const missing = Object.assign(Error(canary), { code: "ENOENT", path: canary });
  assert.deepEqual(JSON.parse(nativeEvidenceFailureLine("daemon-installed-module", missing)), {
    diagnostic: "native-evidence-failure",
    phase: "daemon-installed-module",
    errorClass: "Error",
    errorCode: "ENOENT",
  });
  assert.equal(
    JSON.parse(nativeEvidenceFailureLine("daemon-output", new TypeError(canary))).errorClass,
    "TypeError",
  );
  for (const value of [canary, `${canary}\nERR_ASSERTION`, {}, null, NaN, 23, Symbol(canary)]) {
    const line = nativeEvidenceFailureLine(value, { name: value, code: value, message: canary });
    assert.deepEqual(JSON.parse(line), {
      diagnostic: "native-evidence-failure",
      phase: null,
      errorClass: null,
      errorCode: null,
    });
    assert.equal(line.includes(canary), false);
  }
});

test("native failure projection never invokes getters, coercion or nested value serialization", () => {
  let accesses = 0;
  const fail = () => {
    accesses++;
    throw Error(canary);
  };
  const opaque = Object.defineProperties(
    Object.create(Error.prototype),
    Object.fromEntries(
      ["name", "code", "message", "stack", "cause", "actual", "expected", "toJSON"].map((key) => [
        key,
        { get: fail },
      ]),
    ),
  );
  Object.assign(opaque, { toString: fail, [Symbol.toPrimitive]: fail });
  assert.deepEqual(JSON.parse(nativeEvidenceFailureLine(opaque, opaque)), {
    diagnostic: "native-evidence-failure",
    phase: null,
    errorClass: null,
    errorCode: null,
  });
  assert.equal(accesses, 0);
  const proxy = Proxy.revocable({}, {});
  proxy.revoke();
  assert.doesNotThrow(() => nativeEvidenceFailureLine(proxy.proxy, proxy.proxy));
  assert.equal(nativeEvidenceFailureLine(proxy.proxy, proxy.proxy).includes(canary), false);
});
