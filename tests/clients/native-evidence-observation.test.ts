import assert from "node:assert/strict";
import test from "node:test";
import {
  distributionInstallFailureLine,
  distributionInstallPhaseLine,
  nativeEvidenceFailureLine,
} from "./native-evidence-observation.ts";

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
    "candidate-checkout-head",
    "candidate-checkout-status",
    "candidate-workflow",
    "candidate-reference",
    "candidate-authentication",
    "candidate-producer-authentication",
    "candidate-zip-authentication",
    "candidate-staging-protection",
    "candidate-package-archive",
    "candidate-payload",
    "payload-protection",
    "payload-bytes",
    "evidence-producer",
    "evidence-fixture",
    "evidence-coordinator",
    "evidence-receipt",
    "native-output-protection",
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
  assert.deepEqual(JSON.parse(distributionInstallPhaseLine("install-one", "fortipi-cli")), {
    diagnostic: "distribution-install-phase",
    phase: "install-one",
    package: "fortipi-cli",
  });
  const installLine = distributionInstallFailureLine(
    "dry-build",
    canary,
    error,
    Object.freeze({ code: null, timedOut: true, firstLimit: "deadline", stdout: canary }),
  );
  assert.deepEqual(JSON.parse(installLine), {
    diagnostic: "distribution-install-failure",
    phase: "dry-build",
    package: null,
    errorClass: "AssertionError",
    errorCode: "ERR_ASSERTION",
    resultObserved: true,
    code: null,
    timedOut: true,
    firstLimit: "deadline",
  });
  assert.equal(installLine.includes(canary), false);
  assert.ok(Buffer.byteLength(installLine) <= 512);
  for (const result of [
    null,
    { code: 256, timedOut: false, firstLimit: null },
    { code: -256, timedOut: false, firstLimit: null },
    { code: 1.5, timedOut: false, firstLimit: null },
    { code: 1, timedOut: "false", firstLimit: null },
    { code: 1, timedOut: false, firstLimit: "deadline" },
    { code: null, timedOut: true, firstLimit: null },
    { code: null, timedOut: true, firstLimit: canary },
  ]) {
    const observed = JSON.parse(distributionInstallFailureLine("prepare", canary, canary, result));
    assert.equal(observed.resultObserved, false);
    assert.equal(observed.code, null);
    assert.equal(observed.timedOut, null);
    assert.equal(observed.firstLimit, null);
    assert.equal(JSON.stringify(observed).includes(canary), false);
  }
  assert.equal(
    JSON.parse(
      distributionInstallFailureLine("inventory-before", "fortipi-cli", error, {
        code: 1,
        timedOut: false,
        firstLimit: null,
      }),
    ).resultObserved,
    false,
    "A different install stage cannot inherit a command result",
  );
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
  const result = Object.defineProperties(
    {},
    Object.fromEntries(
      ["code", "timedOut", "firstLimit", "stdout", "toJSON"].map((key) => [key, { get: fail }]),
    ),
  );
  const installLine = distributionInstallFailureLine("dry-build", canary, opaque, result);
  assert.deepEqual(JSON.parse(installLine), {
    diagnostic: "distribution-install-failure",
    phase: "dry-build",
    package: null,
    errorClass: null,
    errorCode: null,
    resultObserved: false,
    code: null,
    timedOut: null,
    firstLimit: null,
  });
  assert.equal(accesses, 0);
  assert.equal(installLine.includes(canary), false);
  assert.deepEqual(JSON.parse(distributionInstallPhaseLine(proxy.proxy, proxy.proxy)), {
    diagnostic: "distribution-install-phase",
    phase: null,
    package: null,
  });
  assert.doesNotThrow(() =>
    distributionInstallFailureLine(proxy.proxy, proxy.proxy, proxy.proxy, proxy.proxy),
  );
});
