// Pure diagnostic wire checks only: no recovery coordinator, fixture or provider import.
import assert from "node:assert/strict";
import test from "node:test";
import {
  liveRecoveryAwaitLine,
  liveRecoveryFailureLine,
  liveRecoveryPhaseLine,
  sourceTestDiagnostic,
} from "../../source-test-processes.ts";

test("initial perform timeout retains the actual latest await and child elapsed times", () => {
  // Handwritten observations describe the missing CI boundary independently of
  // the encoder: preparation returned, installed-closure verification has entered.
  const stdout = [
    '{"diagnostic":"source-live-recovery-phase","phase":"outer-perform","event":"enter","elapsedMs":91000}',
    '{"diagnostic":"source-live-recovery-await","invocation":"initial-perform","step":"outer","event":"enter","elapsedMs":91001}',
    '{"diagnostic":"source-live-recovery-await","invocation":"initial-perform","step":"candidate-load","event":"enter","elapsedMs":91002}',
    '{"diagnostic":"source-live-recovery-await","invocation":"initial-perform","step":"candidate-load","event":"exit","elapsedMs":91003}',
    '{"diagnostic":"source-live-recovery-await","invocation":"initial-perform","step":"authorize","event":"enter","elapsedMs":91004}',
    '{"diagnostic":"source-live-recovery-await","invocation":"initial-perform","step":"authorize","event":"exit","elapsedMs":91005}',
    '{"diagnostic":"source-live-recovery-await","invocation":"initial-perform","step":"prepared","event":"enter","elapsedMs":91006}',
    '{"diagnostic":"source-live-recovery-await","invocation":"initial-perform","step":"prepared","event":"exit","elapsedMs":134000}',
    '{"diagnostic":"source-live-recovery-await","invocation":"initial-perform","step":"installed","event":"enter","elapsedMs":134001}',
  ];
  for (const line of stdout) assert.equal(sourceTestDiagnostic(`# ${line}`), true);
  const loading = JSON.parse(liveRecoveryFailureLine({ stdout: stdout.slice(0, 3).join("\n") }));
  assert.equal(loading.lastInvocation, "initial-perform");
  assert.equal(loading.lastAwaitEntered, "candidate-load");
  assert.equal(loading.lastAwaitEnteredElapsedMs, 91002);
  assert.equal(loading.lastAwaitExited, null);
  const line = liveRecoveryFailureLine({
    stdout: stdout.join("\n"),
    killed: true,
    signal: "SIGTERM",
  });
  assert.deepEqual(JSON.parse(line), {
    diagnostic: "source-live-recovery-failure",
    code: null,
    killed: true,
    signal: "SIGTERM",
    lastPhase: "outer-perform",
    lastPhaseAtError: null,
    lastInvocation: "initial-perform",
    lastAwaitEntered: "installed",
    lastAwaitExited: "prepared",
    lastPhaseElapsedMs: 91000,
    lastAwaitEnteredElapsedMs: 134001,
    lastAwaitExitedElapsedMs: 134000,
  });
  assert.equal(sourceTestDiagnostic(`# ${line}`), true);
});

test("timed encoding preserves deadline equality and unknown time without leaking arbitrary data", () => {
  const privateValue = "PRIVATE_INPUT_MUST_NOT_ESCAPE";
  assert.equal(
    liveRecoveryAwaitLine("initial-perform", "checkpoint-setup", "exit", 460000),
    '{"diagnostic":"source-live-recovery-await","invocation":"initial-perform","step":"checkpoint-setup","event":"exit","elapsedMs":460000}',
  );
  for (const elapsed of [-1, 460001, 1.5, Infinity, NaN, privateValue, {}]) {
    const line = liveRecoveryAwaitLine("initial-perform", "local-proof", "enter", elapsed);
    assert.equal(line.includes(privateValue), false);
    assert.equal(JSON.parse(line).elapsedMs, null);
    assert.equal(sourceTestDiagnostic(`# ${line}`), true);
  }
  const unknown = liveRecoveryAwaitLine(privateValue, privateValue, privateValue, 10);
  assert.equal(unknown.includes(privateValue), false);
  assert.equal(sourceTestDiagnostic(`# ${unknown}`), false);
});

test("strict trace decoding rejects private payloads, unknown labels and forged times", () => {
  const valid = {
    diagnostic: "source-live-recovery-await",
    invocation: "initial-perform",
    step: "initial-observe",
    event: "enter",
    elapsedMs: 180000,
  };
  const privateValue = "PRIVATE_INPUT_MUST_NOT_ESCAPE";
  for (const patch of [
    { invocation: privateValue },
    { step: privateValue },
    { event: privateValue },
    { elapsedMs: -1 },
    { elapsedMs: 460001 },
    { elapsedMs: 1.5 },
    { elapsedMs: privateValue },
    { provider: privateValue },
  ]) {
    const forged = JSON.stringify({ ...valid, ...patch });
    assert.equal(sourceTestDiagnostic(`# ${forged}`), false);
    const summary = liveRecoveryFailureLine({ stdout: `${forged}\n`, message: privateValue });
    assert.equal(summary.includes(privateValue), false);
    assert.equal(JSON.parse(summary).lastInvocation, null);
  }
  const encoded = JSON.stringify(valid);
  assert.equal(sourceTestDiagnostic(`# ${encoded} `), false);
  assert.equal(sourceTestDiagnostic(`# ${JSON.stringify({ ...valid, elapsedMs: 0 })}`), true);
});

test("invocation changes and legacy observations cannot inherit stale elapsed times", () => {
  const stdout = [
    liveRecoveryAwaitLine("initial-perform", "outer", "enter", 10),
    liveRecoveryAwaitLine("initial-perform", "post-child", "enter", 20),
    liveRecoveryAwaitLine("initial-perform", "post-child", "exit", 30),
    liveRecoveryAwaitLine("positive", "outer", "enter"),
    liveRecoveryAwaitLine("positive", "original-reader", "enter", 40),
  ].join("\n");
  const summary = JSON.parse(liveRecoveryFailureLine({ stdout }));
  assert.equal(summary.lastInvocation, "positive");
  assert.equal(summary.lastAwaitEntered, "original-reader");
  assert.equal(summary.lastAwaitEnteredElapsedMs, 40);
  assert.equal(summary.lastAwaitExited, null);
  assert.equal(summary.lastAwaitExitedElapsedMs, null);
  assert.equal(summary.lastPhaseElapsedMs, null);
  const orphan = JSON.parse(
    liveRecoveryFailureLine({
      stdout: liveRecoveryAwaitLine("initial-perform", "installed", "exit", 99),
    }),
  );
  assert.equal(orphan.lastInvocation, null);
  assert.equal(orphan.lastAwaitExited, null);
  assert.equal(orphan.lastAwaitExitedElapsedMs, null);
});

test("legacy markers and summaries retain their exact format and roundtrip", () => {
  const phase = liveRecoveryPhaseLine("outer-perform", "enter");
  const awaited = liveRecoveryAwaitLine("positive", "outer", "enter");
  assert.equal(
    phase,
    '{"diagnostic":"source-live-recovery-phase","phase":"outer-perform","event":"enter"}',
  );
  assert.equal(
    awaited,
    '{"diagnostic":"source-live-recovery-await","invocation":"positive","step":"outer","event":"enter"}',
  );
  const summary = liveRecoveryFailureLine({
    stdout: `${phase}\n${awaited}\n`,
    code: 1,
    killed: false,
  });
  assert.deepEqual(JSON.parse(summary), {
    diagnostic: "source-live-recovery-failure",
    code: 1,
    killed: false,
    signal: null,
    lastPhase: "outer-perform",
    lastPhaseAtError: null,
    lastInvocation: "positive",
    lastAwaitEntered: "outer",
    lastAwaitExited: null,
  });
  for (const line of [phase, awaited, summary])
    assert.equal(sourceTestDiagnostic(`# ${line}`), true);
});

test("bounded failure-tail retention keeps a late timed boundary and ignores discarded history", () => {
  const stdout = [
    liveRecoveryPhaseLine("packing", "enter", 0),
    ...Array.from({ length: 70 }, () => "untrusted-output".repeat(10)),
    liveRecoveryAwaitLine("initial-perform", "child-setup", "enter", 219999),
  ].join("\n");
  const summary = JSON.parse(liveRecoveryFailureLine({ stdout }));
  assert.equal(summary.lastPhase, null);
  assert.equal(summary.lastInvocation, "initial-perform");
  assert.equal(summary.lastAwaitEntered, "child-setup");
  assert.equal(summary.lastAwaitEnteredElapsedMs, 219999);
  const oversized = JSON.parse(
    liveRecoveryFailureLine({ stdout: `${stdout}${"x".repeat(2000000)}` }),
  );
  assert.equal(oversized.lastInvocation, null);
  assert.equal(Object.hasOwn(oversized, "lastAwaitEnteredElapsedMs"), false);
});
