import assert from "node:assert/strict";
import test from "node:test";
import {
  browserDiagnosticCodes,
  browserDiagnosticPhase,
  browserDiagnosticPhases,
  browserFailure,
  localBrowserLine,
  localEvidenceLine,
  observeLocalBrowser,
  observeLocalEvidence,
  projectBrowserDiagnostic,
} from "./local-evidence-observation.ts";

const canary = "private-role-ticket-payload-path-canary";
test("local evidence observations retain only closed phases and bounded facts", () => {
  assert.deepEqual(JSON.parse(localEvidenceLine("installed-browser", "exit", 152814.9, "fail")), {
    diagnostic: "local-evidence-phase",
    stage: "installed-browser",
    event: "exit",
    elapsedMs: 152815,
    outcome: "fail",
  });
  for (const value of [canary, {}, null, NaN, Infinity]) {
    const line = localEvidenceLine(value, value, value, value);
    assert.equal(line.includes(canary), false);
    assert.equal(JSON.parse(line).elapsedMs, 0);
  }
  assert.equal(
    JSON.parse(localEvidenceLine("write-evidence", "exit", 1e20, null)).elapsedMs,
    900000,
  );
  const observed = {
    stage: "public-flow",
    errorClass: "Error",
    cleanupComplete: false,
    diagnostic: {
      phase: "first-task-observe",
      code: "rate_limited",
      status: 429,
      completionDeadline: true,
      payload: canary,
    },
    message: canary,
    path: canary,
  };
  const line = localBrowserLine("report", { code: 1, timedOut: false, stdout: canary }, observed);
  assert.deepEqual(JSON.parse(line), {
    diagnostic: "local-browser-observation",
    event: "report",
    code: 1,
    timedOut: false,
    stage: "public-flow",
    errorClass: "Error",
    errorCode: null,
    cleanupComplete: false,
    publicPhase: "first-task-observe",
    publicCode: "rate_limited",
    publicStatus: 429,
    completionDeadline: true,
  });
  assert.equal(line.includes(canary), false);
  const selected = projectBrowserDiagnostic(observed.diagnostic);
  assert.deepEqual(selected, {
    phase: "first-task-observe",
    code: "rate_limited",
    status: 429,
    completionDeadline: true,
  });
  assert.notEqual(selected, observed.diagnostic);
  assert.deepEqual(
    JSON.parse(
      localBrowserLine(
        "report",
        { code: 1, timedOut: false },
        {
          ...observed,
          diagnostic: selected,
        },
      ),
    ),
    JSON.parse(line),
  );
  for (const code of ["subscribe_timeout", "handshake_timeout", "invalid_wire", "invalid_replay"])
    assert.equal(projectBrowserDiagnostic({ code }).code, code);
  for (const code of browserDiagnosticCodes) {
    const diagnostic = projectBrowserDiagnostic({
      phase: "revocation-arm",
      code,
      status: 429,
      payload: canary,
    });
    assert.deepEqual(diagnostic, {
      phase: "revocation-arm",
      code,
      status: 429,
      completionDeadline: null,
    });
    assert.equal(Object.keys(diagnostic).length, 4);
    const serialized = localBrowserLine(
      "report",
      { code: 1, timedOut: false },
      { stage: "browser-revocation-arm", diagnostic },
    );
    const projected = JSON.parse(serialized);
    assert.deepEqual(Object.keys(projected), Object.keys(JSON.parse(line)));
    assert.equal(projected.publicPhase, "revocation-arm");
    assert.equal(projected.publicCode, code);
    assert.equal(projected.publicStatus, 429);
    assert.equal(projected.completionDeadline, null);
    assert.equal(serialized.includes(canary), false);
    assert.ok(Buffer.byteLength(serialized) <= 512);
  }
  for (const status of [100, 200, 401, 403, 429, 599])
    assert.equal(projectBrowserDiagnostic({ status }).status, status);
  for (const status of [99, 600, 100.1, NaN, Infinity, "401", null, {}, canary])
    assert.equal(projectBrowserDiagnostic({ status }).status, null);
  for (const completionDeadline of [true, false])
    assert.equal(
      projectBrowserDiagnostic({ completionDeadline }).completionDeadline,
      completionDeadline,
    );
  for (const completionDeadline of ["true", 0, 1, {}, canary])
    assert.equal(projectBrowserDiagnostic({ completionDeadline }).completionDeadline, null);
  const withheld = { phase: null, code: null, status: null, completionDeadline: null };
  assert.deepEqual(
    projectBrowserDiagnostic({ phase: canary, code: canary, payload: canary }),
    withheld,
  );
  assert.deepEqual(projectBrowserDiagnostic(Object.create(observed.diagnostic)), withheld);
  for (const value of [
    { phase: canary, code: canary, status: "401", completionDeadline: "true", payload: canary },
    { phase: {}, code: { value: "invalid_wire" }, status: {}, completionDeadline: {} },
    Object.create(observed.diagnostic),
  ]) {
    const diagnostic = projectBrowserDiagnostic(value);
    assert.deepEqual(diagnostic, withheld);
    const serialized = localBrowserLine(
      "report",
      { code: 1, timedOut: false },
      { stage: "browser-revocation-arm", diagnostic: value },
    );
    const projected = JSON.parse(serialized);
    assert.deepEqual(Object.keys(projected), Object.keys(JSON.parse(line)));
    for (const key of ["publicPhase", "publicCode", "publicStatus", "completionDeadline"])
      assert.equal(projected[key], null);
    assert.equal(serialized.includes(canary), false);
  }
  const forged = JSON.parse(
    localBrowserLine(
      canary,
      { code: 256, timedOut: "true" },
      {
        stage: canary,
        errorClass: canary,
        errorCode: canary,
        cleanupComplete: 1,
        diagnostic: { phase: canary, code: canary, status: 600, completionDeadline: "true" },
      },
    ),
  );
  for (const [key, value] of Object.entries(forged))
    if (key !== "diagnostic") assert.equal(value, null);
  assert.ok(Buffer.byteLength(line) <= 512);
  for (const phase of browserDiagnosticPhases) {
    assert.equal(browserDiagnosticPhase(phase), phase);
    const projected = localBrowserLine(
      "report",
      { code: 1, timedOut: false },
      {
        stage: "browser-revocation-check",
        diagnostic: { phase, payload: canary },
      },
    );
    assert.equal(JSON.parse(projected).publicPhase, phase);
    assert.equal(Object.keys(JSON.parse(projected)).length, 12);
    assert.ok(Buffer.byteLength(projected) <= 512);
    assert.equal(projected.includes(canary), false);
  }
  assert.equal(browserDiagnosticPhase(canary), undefined);
  assert.deepEqual(browserFailure(new Error(`unauthenticated ${canary}`)), {
    errorClass: "Error",
    errorCode: "unauthenticated",
  });
  assert.equal(JSON.stringify(browserFailure(new Error(canary))).includes(canary), false);
});

test("local observation projection ignores accessors and contains sink failures", () => {
  let accesses = 0;
  const opaque = Object.defineProperties(
    {},
    Object.fromEntries(
      [
        "code",
        "timedOut",
        "stage",
        "errorClass",
        "errorCode",
        "diagnostic",
        "cleanupComplete",
        "name",
        "message",
        "phase",
        "status",
        "completionDeadline",
        "toString",
      ].map((key) => [
        key,
        {
          get() {
            accesses++;
            throw Error(canary);
          },
        },
      ]),
    ),
  );
  assert.doesNotThrow(() => localBrowserLine(opaque, opaque, opaque));
  assert.doesNotThrow(() => localEvidenceLine(opaque, opaque, opaque, opaque));
  assert.equal(browserDiagnosticPhase(opaque), undefined);
  assert.deepEqual(browserFailure(opaque), { errorClass: "UnknownFailure" });
  const name = Object.getOwnPropertyDescriptor(opaque, "name"),
    message = Object.getOwnPropertyDescriptor(opaque, "message");
  assert.ok(name && message);
  const opaqueError = Object.defineProperties(new Error(), { name, message });
  assert.deepEqual(browserFailure(opaqueError), { errorClass: "Error" });
  const withheld = { phase: null, code: null, status: null, completionDeadline: null };
  assert.deepEqual(projectBrowserDiagnostic(opaque), withheld);
  const serialized = localBrowserLine(
    "report",
    { code: 1, timedOut: false },
    { stage: "browser-revocation-arm", diagnostic: opaque },
  );
  const projected = JSON.parse(serialized);
  assert.equal(Object.keys(projected).length, 12);
  for (const key of ["publicPhase", "publicCode", "publicStatus", "completionDeadline"])
    assert.equal(projected[key], null);
  assert.equal(serialized.includes(canary), false);
  const trapped = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw Error(canary);
      },
    },
  );
  assert.deepEqual(projectBrowserDiagnostic(trapped), withheld);
  assert.equal(accesses, 0);
  const broken = () => {
    throw Error(canary);
  };
  assert.doesNotThrow(() => observeLocalEvidence("cli-return", "exit", 0, null, broken));
  assert.doesNotThrow(() => observeLocalBrowser("report", opaque, opaque, broken));
  const lines: string[] = [];
  observeLocalEvidence("installed-integrity", "enter", 0, null, (line) => lines.push(line));
  observeLocalBrowser("coordinator-return", { code: null, timedOut: true }, null, (line) =>
    lines.push(line),
  );
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.ok(line.endsWith("\n"));
    assert.ok(Buffer.byteLength(line) <= 512);
    assert.equal(line.includes(canary), false);
  }
});
