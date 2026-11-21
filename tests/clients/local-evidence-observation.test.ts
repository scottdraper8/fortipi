import assert from "node:assert/strict";
import test from "node:test";
import {
  localBrowserLine,
  localEvidenceLine,
  observeLocalBrowser,
  observeLocalEvidence,
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
