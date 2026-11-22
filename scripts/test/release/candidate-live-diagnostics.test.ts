import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";
import { observeCandidateDiagnostics } from "../../build-workspaces.ts";
import {
  liveRecoveryAwaitLine,
  liveRecoveryFailureLine,
  liveRecoveryPhaseLine,
  nativePublicationObservationLine,
  sourceFailureLines,
  sourceTestDiagnostic,
} from "../../source-test-processes.ts";

const host = JSON.stringify({
  diagnostic: "source-test-host",
  node: "26.13.1",
  availableParallelism: 4,
  files: 1,
});
const phase = `# ${JSON.stringify({
  diagnostic: "source-recovery-phase",
  event: "enter",
  phase: "after-submit.restart",
  elapsedMs: 100,
  phaseMs: 0,
})}`;

const privateValue = "synthetic-private-observation-canary";
const generation = {
  diagnostic: "recovery-generation-phase",
  mode: "supersession",
  phase: "successor",
  event: "aborted",
  stateSeen: true,
  lastRunning: true,
  lastArmPending: false,
  lastSuccessor: true,
  lastSecondDrain: false,
  lastRowsBounded: true,
};
const readiness = {
  diagnostic: "admission-runtime-readiness",
  event: "failed",
  invocation: 2,
  elapsedMs: 30000,
  attempts: 100,
  fetchFailures: 99,
  lastStatus: 503,
  spawnError: false,
  childAlive: false,
};

test("root phase and readiness forwarding rejects private or malformed records", async () => {
  const accepted: string[] = [];
  const startup = {
    diagnostic: "source-recovery-start-failure",
    sourcePath: "apps/worker/test/agent/process-recovery.test.ts",
    harnessOrdinal: 2,
    invocation: 1,
    marker: "unknown",
    exitCode: 1,
    signal: null,
  };
  for (const marker of [
    "address-in-use",
    "module-unavailable",
    "memory",
    "permission",
    "filesystem",
    "build-service",
    "runtime",
    "unknown",
  ])
    accepted.push(`# ${JSON.stringify({ ...startup, marker })}`);
  for (const patch of [
    { marker: privateValue },
    { sourcePath: privateValue },
    { sourcePath: "apps/worker/test/../private.test.ts" },
    { harnessOrdinal: 1_000_000 },
    { harnessOrdinal: 0 },
    { invocation: 1000 },
    { invocation: 0 },
    { exitCode: 256 },
    { exitCode: 1000 },
    { signal: privateValue },
    { payload: privateValue },
  ])
    assert.equal(sourceTestDiagnostic(`# ${JSON.stringify({ ...startup, ...patch })}`), false);
  const canonicalStartup = `# ${JSON.stringify(startup)}`;
  assert.equal(
    sourceTestDiagnostic(
      canonicalStartup.replace(
        '"marker":"unknown"',
        `"marker":"${privateValue}","marker":"unknown"`,
      ),
    ),
    false,
  );
  for (const lastPhase of [
    "prepare",
    "listen",
    "environment",
    "begin",
    "hold-idle",
    "sleep-successor",
    "observe-successor",
    "release-old",
    "settle-old",
    "check-wake",
  ]) {
    const record = { diagnostic: "source-fixed-wake-failure", lastPhase };
    accepted.push(`# ${JSON.stringify(record)}`);
    assert.equal(
      sourceTestDiagnostic(`# ${JSON.stringify({ ...record, error: privateValue })}`),
      false,
    );
  }
  assert.equal(
    sourceTestDiagnostic(
      `# ${JSON.stringify({ diagnostic: "source-fixed-wake-failure", lastPhase: privateValue })}`,
    ),
    false,
  );
  for (const mode of ["supersession", "hung takeover"])
    for (const phase of [
      "fixture",
      "begin",
      "initial",
      "takeover-delay",
      "takeover-alarm",
      "successor",
      "second-drain",
      "release-old",
      "release-new",
      "coalesce",
      "close",
    ])
      accepted.push(`# ${JSON.stringify({ ...generation, mode, phase })}`);
  for (const event of ["enter", "ready", "failed"])
    accepted.push(`# ${JSON.stringify({ ...readiness, event })}`);
  for (const phase of [
    "standalone-new-job",
    "standalone-job-read",
    "standalone-cancel",
    "standalone-cancel-retry",
  ])
    accepted.push(
      `# ${JSON.stringify({ diagnostic: "approval-phase", phase, event: "aborted", elapsedMs: 25000 })}`,
    );
  const refused = [
    { ...generation, mode: privateValue },
    { ...generation, phase: privateValue },
    { ...generation, lastRunning: 1 },
    { ...generation, stateSeen: null },
    { ...readiness, event: privateValue },
    { ...readiness, elapsedMs: null },
    { ...readiness, attempts: null },
    { ...readiness, invocation: 0 },
    { ...readiness, fetchFailures: 101 },
    { ...readiness, lastStatus: 600 },
    { ...readiness, childAlive: "false" },
    { ...readiness, event: { toString: privateValue } },
  ].map((r) => `# ${JSON.stringify(r)}`);
  for (const record of [generation, readiness])
    refused.push(`# ${JSON.stringify({ ...record, payload: privateValue })}`);
  const first = accepted.find((line) => line.includes('"mode":"supersession"'));
  assert.ok(first);
  refused.push(
    first.replace('"mode":"supersession"', `"mode":"${privateValue}","mode":"supersession"`),
  );
  for (const line of accepted) assert.equal(sourceTestDiagnostic(line), true, line);
  for (const line of refused) assert.equal(sourceTestDiagnostic(line), false, line);
  const stream = new PassThrough(),
    forwarded: string[] = [];
  observeCandidateDiagnostics(stream, (line) => forwarded.push(line));
  const ended = once(stream, "end");
  for (const line of [...refused, ...accepted]) {
    stream.write(line.slice(0, 25));
    stream.write(`${line.slice(25)}\n`);
  }
  stream.end();
  await ended;
  assert.deepEqual(
    forwarded,
    accepted.map((line) => `${line}\n`),
  );
});

test("native publication projection uses only observed request timing and closed facts", async () => {
  const observe = {
    kind: "observe",
    ok: false,
    code: "workspace.conflict",
    reason: "expired_lease",
    sockets: 0,
    startedAt: 100,
    finishedAt: 110,
    leaseExpiresAt: 105,
    message: privateValue,
  };
  const control = { local: [{ ...observe, kind: "prepare" }, observe], payload: privateValue };
  const timing = {
    assignmentLeaseExpiresAt: 105,
    deadline: 1000,
    reconnectStartedAt: 120,
    observedAt: 130,
  };
  const line = nativePublicationObservationLine(
    "result",
    "agent-first",
    control,
    { pressure: { code: "workspace.conflict", message: privateValue } },
    timing,
  );
  const record = JSON.parse(line);
  assert.deepEqual(record, {
    diagnostic: "source-native-publication-observation",
    mode: "result",
    activation: "agent-first",
    observeOk: false,
    observeCode: "workspace.conflict",
    observeReason: "expired_lease",
    observeSockets: 0,
    observeMs: 10,
    leaseExpiredAtObserve: true,
    observeBeforeReconnect: true,
    assignmentLeaseExpired: true,
    deadlineExpired: false,
    pressureCode: "workspace.conflict",
  });
  assert.equal(line.includes(privateValue), false);
  assert.equal(sourceTestDiagnostic(`# ${line}`), true);
  for (const patch of [
    { observeCode: privateValue },
    { observeReason: privateValue },
    { observeSockets: -1 },
    { observeMs: 60001 },
    { leaseExpiredAtObserve: 1 },
    { deadlineExpired: "false" },
    { pressureCode: { toString: privateValue } },
    { payload: privateValue },
  ])
    assert.equal(sourceTestDiagnostic(`# ${JSON.stringify({ ...record, ...patch })}`), false);
  let accessorCalls = 0;
  const opaque = {
    get local(): never {
      accessorCalls++;
      throw Error(privateValue);
    },
  };
  const unknown = JSON.parse(nativePublicationObservationLine(null, null, opaque, opaque, opaque));
  assert.equal(unknown.observeOk, null);
  assert.equal(unknown.assignmentLeaseExpired, null);
  assert.equal(accessorCalls, 0);
  const rows = [observe];
  Object.defineProperty(rows, "0", {
    get() {
      accessorCalls++;
      throw Error(privateValue);
    },
  });
  assert.doesNotThrow(() =>
    nativePublicationObservationLine(null, null, { local: rows }, null, null),
  );
  assert.equal(accessorCalls, 0);
  const missing = nativePublicationObservationLine(
    "result",
    "agent-first",
    { local: [] },
    null,
    {},
  );
  assert.equal(JSON.parse(missing).observeOk, null);
  assert.equal(sourceTestDiagnostic(`# ${missing}`), true);
  const stream = new PassThrough(),
    forwarded: string[] = [];
  observeCandidateDiagnostics(stream, (value) => forwarded.push(value));
  const ended = once(stream, "end");
  stream.end(`# ${line}\n# ${privateValue}\n`);
  await ended;
  assert.deepEqual(forwarded, [`# ${line}\n`]);
});

test("live child failure preserves only bounded exit facts and actually observed phases", async () => {
  const stdout = [
    privateValue,
    liveRecoveryPhaseLine("packing", "enter"),
    liveRecoveryPhaseLine("prepare", "enter"),
    liveRecoveryPhaseLine("prepare", "caught"),
    liveRecoveryPhaseLine("cleanup", "enter"),
  ].join("\n");
  const line = liveRecoveryFailureLine({
    code: 1,
    killed: false,
    signal: null,
    stdout,
    stderr: privateValue,
    message: privateValue,
  });
  const record = JSON.parse(line);
  assert.deepEqual(record, {
    diagnostic: "source-live-recovery-failure",
    code: 1,
    killed: false,
    signal: null,
    lastPhase: "cleanup",
    lastPhaseAtError: "prepare",
    lastInvocation: null,
    lastAwaitEntered: null,
    lastAwaitExited: null,
  });
  assert.equal(line.includes(privateValue), false);
  assert.equal(sourceTestDiagnostic(`# ${line}`), true);
  const timed = JSON.parse(
    liveRecoveryFailureLine({ code: null, killed: true, signal: "SIGTERM" }),
  );
  assert.equal(timed.lastPhase, null);
  assert.equal(timed.lastPhaseAtError, null);
  assert.equal(timed.killed, true);
  assert.equal(timed.signal, "SIGTERM");
  const entered = JSON.parse(
    liveRecoveryFailureLine({
      code: null,
      killed: true,
      signal: "SIGTERM",
      stdout: [
        liveRecoveryAwaitLine("positive", "outer", "enter"),
        liveRecoveryAwaitLine("positive", "cached-bridge", "enter"),
        liveRecoveryAwaitLine("positive", "cached-bridge", "exit"),
        liveRecoveryAwaitLine("positive", "post-child", "enter"),
      ].join("\n"),
    }),
  );
  assert.equal(entered.lastInvocation, "positive");
  assert.equal(entered.lastAwaitEntered, "post-child");
  assert.equal(entered.lastAwaitExited, "cached-bridge");
  const reset = JSON.parse(
    liveRecoveryFailureLine({
      stdout: [
        liveRecoveryAwaitLine("positive", "outer", "enter"),
        liveRecoveryAwaitLine("positive", "outer", "exit"),
        liveRecoveryAwaitLine("tamper", "outer", "enter"),
        liveRecoveryAwaitLine("tamper", "original-reader", "enter"),
      ].join("\n"),
    }),
  );
  assert.equal(reset.lastInvocation, "tamper");
  assert.equal(reset.lastAwaitEntered, "original-reader");
  assert.equal(reset.lastAwaitExited, null, "A prior invocation cannot complete this await");
  const orphan = JSON.parse(
    liveRecoveryFailureLine({ stdout: liveRecoveryAwaitLine("omitted", "outer", "exit") }),
  );
  assert.equal(orphan.lastInvocation, null);
  assert.equal(orphan.lastAwaitExited, null);
  const forged = liveRecoveryPhaseLine("packing", "enter").replace(
    '"phase":"packing"',
    `"phase":"${privateValue}","phase":"packing"`,
  );
  const dropped = JSON.parse(
    liveRecoveryFailureLine({ code: privateValue, signal: privateValue, stdout: forged }),
  );
  assert.equal(dropped.code, null);
  assert.equal(dropped.signal, null);
  assert.equal(dropped.lastPhase, null);
  let accessorCalls = 0;
  const opaque = Object.defineProperties(
    {},
    Object.fromEntries(
      ["code", "killed", "signal", "stdout", "toString"].map((key) => [
        key,
        {
          get() {
            accessorCalls++;
            throw Error(privateValue);
          },
        },
      ]),
    ),
  );
  assert.doesNotThrow(() => liveRecoveryFailureLine(opaque));
  assert.equal(accessorCalls, 0);
  for (const patch of [
    { code: 256 },
    { code: privateValue },
    { killed: "true" },
    { signal: privateValue },
    { lastPhase: privateValue },
    { lastInvocation: privateValue },
    { lastAwaitEntered: privateValue },
    { lastAwaitExited: 1 },
    { payload: privateValue },
  ])
    assert.equal(sourceTestDiagnostic(`# ${JSON.stringify({ ...record, ...patch })}`), false);
  const setupPhases = [
    "setup-wrangler-import",
    "setup-wrangler-mock",
    "setup-installation",
    "setup-deployment",
    "setup-integrated-files",
    "setup-integrated-inventory",
    "setup-integrated-archive",
    "setup-proof-index",
    "setup-prepare-mock",
    "setup-reader-import",
    "setup-reader-mock",
    "setup-selection-import",
    "setup-selection-mock",
    "setup-outer-import",
    "guard-frame",
    "guard-authority",
    "guard-installed",
    "guard-selection",
    "outer-perform",
  ];
  for (const phase of setupPhases) {
    const failure = JSON.parse(
      liveRecoveryFailureLine({
        stdout: liveRecoveryPhaseLine(phase, "enter"),
        killed: true,
        signal: "SIGTERM",
      }),
    );
    assert.equal(failure.lastPhase, phase);
    assert.equal(sourceTestDiagnostic(`# ${JSON.stringify(failure)}`), true);
    assert.equal(failure.lastInvocation, null);
  }
  const phaseLines = ["packing", "prepare", ...setupPhases, "perform", "readonly", "cleanup"].map(
    (p) => liveRecoveryPhaseLine(p, "enter"),
  );
  const awaitLines: string[] = [];
  for (const invocation of ["positive", "tamper", "omitted"])
    for (const step of ["outer", "original-reader", "cached-bridge", "post-child"])
      for (const event of ["enter", "exit"])
        awaitLines.push(liveRecoveryAwaitLine(invocation, step, event));
  const awaitRecord = JSON.parse(liveRecoveryAwaitLine("positive", "post-child", "enter"));
  const refused = [
    ...[
      { invocation: privateValue },
      { invocation: 1 },
      { step: privateValue },
      { step: null },
      { event: privateValue },
      { event: "completed" },
      { payload: privateValue },
    ].map((patch) => JSON.stringify({ ...awaitRecord, ...patch })),
    JSON.stringify(awaitRecord).replace(
      '"invocation":"positive"',
      `"invocation":"${privateValue}","invocation":"positive"`,
    ),
    liveRecoveryAwaitLine(opaque, opaque, opaque),
  ];
  assert.equal(accessorCalls, 0);
  for (const marker of refused) assert.equal(sourceTestDiagnostic(`# ${marker}`), false);
  const forgedAwait = JSON.parse(liveRecoveryFailureLine({ stdout: refused.join("\n") }));
  assert.equal(forgedAwait.lastInvocation, null);
  assert.equal(forgedAwait.lastAwaitEntered, null);
  const overBound = JSON.parse(
    liveRecoveryFailureLine({
      stdout: `${"x".repeat(2_000_001)}\n${liveRecoveryAwaitLine("positive", "outer", "enter")}`,
    }),
  );
  assert.equal(overBound.lastInvocation, null);
  for (const marker of [...phaseLines, ...awaitLines, line])
    assert.ok(Buffer.byteLength(`# ${marker}`) <= 512);
  const stream = new PassThrough(),
    forwarded: string[] = [];
  observeCandidateDiagnostics(stream, (value) => forwarded.push(value));
  const ended = once(stream, "end");
  for (const marker of [...refused, ...phaseLines, ...awaitLines, line]) {
    stream.write(`# ${marker.slice(0, 23)}`);
    stream.write(`${marker.slice(23)}\n`);
  }
  stream.end(`# ${privateValue}`);
  await ended;
  assert.deepEqual(
    forwarded,
    [...phaseLines, ...awaitLines, line].map((p) => `# ${p}\n`),
  );
});

test("only reviewed generation, boundary, live and device titles survive failure projection", () => {
  for (const name of [
    "production Recovery supersession preserves distinct successor and bounded rows",
    "production Recovery hung takeover preserves distinct successor and bounded rows",
    ...["attempted", "assign-ack", "result", "receipt"].map(
      (mode) =>
        `SAFE ${mode} boundary survives real service SIGKILL with retained execution identity`,
    ),
    "trusted outer recovery preserves original receipts and child byte closure across perform/readonly verification",
    "cleanup-only ownership accepts completed failed/cancelled initial jobs without granting phase/custody proof; missing and unfinished ownership remain unavailable",
    "actual PiHarness fixed wake preserves sleeping work across an older idle outcome",
    "an RPC callback can reenter its pending initialization more than once",
  ]) {
    const output: string[] = [],
      accept = sourceFailureLines((line) => output.push(line));
    for (const line of [
      `not ok 1 - ${name}`,
      "  ---",
      "  failureType: testCodeFailure",
      "  code: ERR_ASSERTION",
      `  error: ${privateValue}`,
      "  ...",
    ])
      accept(line);
    assert.equal(output.length, 1);
    const projected = output[0];
    assert.ok(projected);
    assert.equal(JSON.parse(projected).name, name);
    assert.equal(projected.includes(privateValue), false);
    assert.equal(sourceTestDiagnostic(projected.trim()), true);
  }
});

test("candidate stderr diagnostics arrive before child completion while original capture and failure survive", {
  timeout: 5000,
}, async () => {
  const stdout = `${host}\nsynthetic-private-stdout\n`;
  const stderr = `synthetic-private-stderr\n${host}\n${phase}`;
  const pending = promisify(execFile)(
    process.execPath,
    [
      "-e",
      `
    process.stdin.once('data', () => { process.stderr.write(${JSON.stringify(phase)}); process.exitCode = 7; process.stdin.destroy(); });
    process.stdout.write(${JSON.stringify(stdout)});
    process.stderr.write('synthetic-private-stderr\\n' + ${JSON.stringify(host.slice(0, 21))});
    setTimeout(() => process.stderr.write(${JSON.stringify(`${host.slice(21)}\n`)}), 10);
  `,
    ],
    { env: {}, timeout: 3000, maxBuffer: 4096 },
  );
  const result = pending.then(
    () => assert.fail("Expected original child failure"),
    (error: unknown) => error,
  );
  let settled = false;
  void result.then(() => {
    settled = true;
  });
  const forwarded: string[] = [];
  let sinkFailures = 0;
  let acceptLive = () => {};
  const live = new Promise<void>((accept) => {
    acceptLive = accept;
  });
  assert.ok(pending.child.stderr && pending.child.stdin);
  observeCandidateDiagnostics(pending.child.stderr, (line) => {
    forwarded.push(line);
    acceptLive();
    if (line === `${phase}\n`) {
      sinkFailures++;
      throw new Error("synthetic-private-canary");
    }
  });
  await live;
  assert.equal(settled, false, "The child must still be waiting for the parent");
  assert.deepEqual(forwarded, [`${host}\n`]);
  pending.child.stdin.end("finish");
  const error = (await result) as { code: number; stdout: string; stderr: string };
  assert.equal(error.code, 7);
  assert.equal(error.stdout, stdout);
  assert.equal(error.stderr, stderr);
  assert.deepEqual(forwarded, [`${host}\n`, `${phase}\n`]);
  assert.equal(sinkFailures, 1, "A diagnostic sink failure cannot replace the child failure");
});

test("candidate diagnostic lines resynchronize only after newline and flush only valid EOF records", async () => {
  const stream = new PassThrough(),
    forwarded: string[] = [];
  observeCandidateDiagnostics(stream, (line) => forwarded.push(line));
  stream.write(`synthetic-private-canary ${host}\n`);
  stream.write(`{"diagnostic":"synthetic-private-canary",${host.slice(1)}\n`);
  stream.write(`${"x".repeat(1_000_000)}${host}\n`);
  stream.write(host.slice(0, 20));
  stream.write(`${host.slice(20)}\r`);
  assert.deepEqual(forwarded, []);
  stream.write("\n");
  assert.deepEqual(forwarded, [`${host}\n`]);
  const ended = once(stream, "end");
  stream.end(phase);
  await ended;
  assert.deepEqual(forwarded, [`${host}\n`, `${phase}\n`]);
  for (const tail of [
    Buffer.from(host.slice(0, -1)),
    Buffer.concat([Buffer.from(host), Buffer.from([0xc3])]),
  ]) {
    const incomplete = new PassThrough(),
      out: string[] = [];
    observeCandidateDiagnostics(incomplete, (line) => out.push(line));
    const done = once(incomplete, "end");
    incomplete.end(tail);
    await done;
    assert.deepEqual(out, []);
  }
  const closed = new PassThrough(),
    out: string[] = [];
  observeCandidateDiagnostics(closed, (line) => out.push(line));
  closed.write(host);
  const done = once(closed, "close");
  closed.destroy();
  await done;
  assert.deepEqual(out, [], "An interrupted unterminated record is discarded");
});

test("diagnostic observation preserves execFile output bounds and timeout failures", {
  timeout: 5000,
}, async () => {
  for (const mode of ["buffer", "timeout"] as const) {
    const script =
      mode === "buffer"
        ? "process.stderr.write('x'.repeat(10000));"
        : "setInterval(() => {}, 1000);";
    const pending = promisify(execFile)(process.execPath, ["-e", script], {
      env: {},
      maxBuffer: 256,
      timeout: mode === "buffer" ? 3000 : 300,
    });
    assert.ok(pending.child.stderr);
    const forwarded: string[] = [];
    observeCandidateDiagnostics(pending.child.stderr, (line) => forwarded.push(line));
    await assert.rejects(pending, (error: unknown) => {
      const e = error as { code: string; killed: boolean; signal: string; stderr: string };
      const observation = liveRecoveryFailureLine(error);
      assert.equal(sourceTestDiagnostic(`# ${observation}`), true);
      const facts = JSON.parse(observation);
      assert.equal(facts.lastPhase, null, "A child without markers cannot acquire a phase");
      if (mode === "buffer") {
        assert.equal(e.code, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
        assert.equal(e.stderr.length, 256);
        assert.equal(facts.code, e.code);
      } else {
        assert.equal(e.killed, true);
        assert.equal(e.signal, "SIGTERM");
        assert.equal(facts.killed, true);
        assert.equal(facts.signal, "SIGTERM");
      }
      return true;
    });
    assert.deepEqual(forwarded, []);
  }
});
