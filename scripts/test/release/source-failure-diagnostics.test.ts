import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { type ClientRequest, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { processHarness } from "../../../apps/worker/test/agent/process-harness.ts";
import {
  processProfile,
  processProfileLines,
} from "../../../apps/worker/test/agent/process-profile.ts";
import { observeCandidateDiagnostics, observeSourceTestFailures } from "../../build-workspaces.ts";
import {
  nativeRecoveryFailureLine,
  nativeRecoveryObservationLine,
  sourceFailureLines,
  sourceRecoveryPath,
  sourceReentryFailureLine,
  sourceTestDiagnostic,
} from "../../source-test-processes.ts";

const reviewedName =
  "SIGKILL/reopen preserves canary, allocation provenance and stable accepted input";
const reviewedAdmissionName =
  "integrated persistent runtime retains actual Pi input and repairs the same admission across both acknowledged SIGKILL boundaries";
const canary = "synthetic-private-diagnostic-canary";
const helper = new URL("../../build-workspaces.ts", import.meta.url);

function runtimeCallFrame(lines: string[], call: "await poll(" | "await launch();"): string {
  const matches = lines.flatMap((line, index) => (line.trim() === call ? [{ line, index }] : []));
  assert.equal(matches.length, 1, "The reviewed runtime call must have one source location");
  const match = matches[0];
  assert.ok(match);
  return `apps/worker/test/integration/runtime.ts:${match.index + 1}:${match.line.indexOf(call) + 1}`;
}

test("reentry failure observation forwards bounded phases without error payloads", async () => {
  for (const phase of [
    "listen",
    "fetch-once",
    "fetch-twice",
    "close",
    "close-harness",
    "close-directory",
  ]) {
    for (const [name, kind] of [
      ["TimeoutError", "timeout"],
      ["AbortError", "abort"],
      ["AssertionError", "assertion"],
      [canary, "other"],
    ]) {
      const line = sourceReentryFailureLine(phase, { name, message: canary, stack: canary }, 5000);
      assert.equal(line.includes(canary), false);
      assert.deepEqual(JSON.parse(line), {
        diagnostic: "source-reentry-failure",
        phase,
        kind,
        elapsedMs: 5000,
      });
      assert.equal(sourceTestDiagnostic(`# ${line}`), true);
    }
    for (const [code, kind] of [
      ["ENOTEMPTY", "directory-not-empty"],
      ["EBUSY", "resource-busy"],
      ["EPERM", "permission"],
      ["EACCES", "permission"],
      ["EMFILE", "file-limit"],
      ["ENFILE", "file-limit"],
      [canary, "other"],
    ]) {
      const line = sourceReentryFailureLine(phase, { code, message: canary, stack: canary }, 19);
      assert.equal(line.includes(canary), false);
      assert.equal(JSON.parse(line).kind, kind);
      assert.equal(sourceTestDiagnostic(`# ${line}`), true);
    }
  }
  const line = sourceReentryFailureLine(
    "fetch-once",
    new DOMException(canary, "TimeoutError"),
    5000,
  );
  const record = JSON.parse(line);
  for (const changed of [
    { ...record, phase: canary },
    { ...record, kind: canary },
    { ...record, error: canary },
    { ...record, elapsedMs: -1 },
    { ...record, elapsedMs: 60001 },
    { ...record, elapsedMs: "5000" },
  ]) {
    assert.equal(sourceTestDiagnostic(`# ${JSON.stringify(changed)}`), false);
  }
  const opaque = {
    get name(): never {
      throw new Error(canary);
    },
  };
  assert.equal(sourceReentryFailureLine(canary, opaque, Number.NaN).includes(canary), false);
  const opaqueCode = {
    get code(): never {
      throw new Error(canary);
    },
  };
  assert.equal(sourceReentryFailureLine("close-directory", opaqueCode, 19).includes(canary), false);
  const forgedPhase = { toString: () => "listen", payload: canary };
  assert.equal(sourceReentryFailureLine(forgedPhase, opaque, 5000).includes(canary), false);
  const output: string[] = [],
    stream = new PassThrough();
  observeCandidateDiagnostics(stream, (chunk) => output.push(chunk));
  const ended = once(stream, "end");
  stream.end(`# ${line}\n# ${canary}\n`);
  await ended;
  assert.deepEqual(output, [`# ${line}\n`]);
});

test("native recovery observation admits only closed query and receipt facts", async () => {
  const control = {
    query: {
      ok: true,
      state: "unknown",
      sockets: 0,
      attempted: true,
      startedAt: 100,
      finishedAt: 101,
      message: canary,
    },
    grants: canary,
  };
  const agent = { receiptRetained: false, nativeReceiptAck: null, payload: canary };
  const line = nativeRecoveryObservationLine("running", "agent-first", control, "succeeded", agent);
  assert.equal(line.includes(canary), false);
  const expected = {
    diagnostic: "source-native-recovery-observation",
    mode: "running",
    activation: "agent-first",
    queryState: "unknown",
    querySockets: 0,
    queryAttempted: true,
    queryMs: 1,
    nativeResult: "succeeded",
    receiptRetained: false,
    receiptAck: null,
  };
  assert.deepEqual(JSON.parse(line), expected);
  assert.equal(sourceTestDiagnostic(`# ${line}`), true);
  for (const changed of [
    { ...expected, mode: canary },
    { ...expected, activation: canary },
    { ...expected, queryState: canary },
    { ...expected, querySockets: 1000 },
    { ...expected, querySockets: -1 },
    { ...expected, queryMs: 60001 },
    { ...expected, queryMs: "1" },
    { ...expected, queryAttempted: "true" },
    { ...expected, nativeResult: canary },
    { ...expected, receiptRetained: 1 },
    { ...expected, receiptAck: "false" },
    { ...expected, message: canary },
  ]) {
    assert.equal(sourceTestDiagnostic(`# ${JSON.stringify(changed)}`), false);
  }
  const unknown = nativeRecoveryObservationLine(
    canary,
    canary,
    {
      query: {
        ok: canary,
        state: canary,
        sockets: canary,
        attempted: canary,
        startedAt: canary,
        finishedAt: canary,
      },
    },
    canary,
    { receiptRetained: canary, nativeReceiptAck: canary },
  );
  assert.equal(unknown.includes(canary), false);
  assert.equal(sourceTestDiagnostic(`# ${unknown}`), true);
  const opaque = {
    get query(): never {
      throw new Error(canary);
    },
  };
  assert.equal(
    nativeRecoveryObservationLine(null, null, opaque, null, null).includes(canary),
    false,
  );
  const output: string[] = [],
    stream = new PassThrough();
  observeCandidateDiagnostics(stream, (chunk) => output.push(chunk));
  const ended = once(stream, "end");
  stream.end(`# ${line}\n# ${canary}\n`);
  await ended;
  assert.deepEqual(output, [`# ${line}\n`]);
});

test("approval abort and native completion diagnostics exclude arbitrary payloads", () => {
  const approval = {
    diagnostic: "approval-phase",
    phase: "close",
    event: "aborted",
    elapsedMs: 25000,
  };
  for (const phase of [
    "fixture",
    "original-approval-wait",
    "original-approval-snapshot",
    "original-approval-read",
    "original-reject",
    "original-cancel-wait",
    "acknowledge-rejection",
    "fresh-authority",
    "fresh-request",
    "fresh-approval-wait",
    "fresh-identity",
    "fresh-reject",
    "fresh-cancel-wait",
    "narrow-authority",
    "identity-conflicts",
    "standalone-cancel",
    "standalone-cancel-wait",
    "final-job-read",
    "close",
  ])
    assert.equal(sourceTestDiagnostic(`# ${JSON.stringify({ ...approval, phase })}`), true);
  for (const changed of [
    { ...approval, phase: canary },
    { ...approval, event: "entered" },
    { ...approval, elapsedMs: "25000" },
    { ...approval, elapsedMs: -1 },
    { ...approval, elapsedMs: 60001 },
    { ...approval, error: canary },
  ])
    assert.equal(sourceTestDiagnostic(`# ${JSON.stringify(changed)}`), false);
  const line = nativeRecoveryFailureLine("requires_reconciliation", "result", false, true);
  assert.equal(sourceTestDiagnostic(`# ${line}`), true);
  const record = JSON.parse(line);
  for (const changed of [
    { ...record, applicationState: canary },
    { ...record, ledgerState: canary },
    { ...record, connected: "true" },
    { ...record, committed: 1 },
    { ...record, error: canary },
  ])
    assert.equal(sourceTestDiagnostic(`# ${JSON.stringify(changed)}`), false);
  const redacted = nativeRecoveryFailureLine(canary, canary, false, false);
  assert.equal(redacted.includes(canary), false);
  assert.equal(sourceTestDiagnostic(`# ${redacted}`), true);
});

test("Pi wake failure forwarding admits only fixed phases without error details", () => {
  for (const phase of [
    "setup",
    "listen",
    "bind",
    "prepare",
    "drive",
    "observe-failure",
    "recover",
    "replacement",
    "release",
    "wait-drive",
    "interim",
    "terminal",
    "attempts",
    "cleanup",
    "observe-replacement",
    "check-replacement",
    "settle-old",
    "check-old",
    "observe-terminal",
    "check-terminal",
  ]) {
    const record = { diagnostic: "source-pi-wake-failure", phase };
    assert.equal(sourceTestDiagnostic(`# ${JSON.stringify(record)}`), true);
    assert.equal(sourceTestDiagnostic(`# ${JSON.stringify({ ...record, error: canary })}`), false);
  }
  assert.equal(
    sourceTestDiagnostic(
      `# ${JSON.stringify({ diagnostic: "source-pi-wake-failure", phase: canary })}`,
    ),
    false,
  );
});

test("Pi wake phase forwarding requires canonical prefixed closed records", () => {
  for (const phase of [
    "setup",
    "listen",
    "bind",
    "prepare",
    "drive",
    "observe-failure",
    "recover",
    "replacement",
    "release",
    "wait-drive",
    "interim",
    "terminal",
    "attempts",
    "cleanup",
  ]) {
    const line = `# ${JSON.stringify({ diagnostic: "source-pi-wake-phase", phase })}`;
    assert.equal(sourceTestDiagnostic(line), true);
    assert.ok(Buffer.byteLength(line) <= 128);
  }
  for (const diagnostic of ["source-pi-wake-phase", "source-pi-wake-failure"]) {
    const record = { diagnostic, phase: "setup" };
    const line = `# ${JSON.stringify(record)}`;
    for (const bad of [
      JSON.stringify(record),
      `# ${JSON.stringify({ phase: "setup", diagnostic })}`,
      `${line} `,
      `${line}\n`,
      line.replace('"phase":"setup"', `"phase":"${canary}","phase":"setup"`),
      `# ${JSON.stringify({ ...record, phase: canary })}`,
      `# ${JSON.stringify({ ...record, phase: null })}`,
      `# ${JSON.stringify({ ...record, error: canary })}`,
      `# ${JSON.stringify({ ...record, message: canary })}`,
      `# ${JSON.stringify({ ...record, stack: canary })}`,
      `# ${JSON.stringify({ ...record, code: "ERR_ASSERTION" })}`,
    ])
      assert.equal(sourceTestDiagnostic(bad), false);
  }
  assert.equal(
    sourceTestDiagnostic('# {"diagnostic":"source-pi-wake-phase","phase":"observe-replacement"}'),
    false,
  );
});

test("Pi wake retry failure identification retains its literal name without private TAP fields", () => {
  const name = "actual PiHarness retry rereads replacement delayed work after a failed reopen";
  for (const [input, expected] of [
    [name, name],
    [`${name} ${canary}`, null],
  ]) {
    const output: string[] = [];
    const consume = sourceFailureLines((line) => output.push(line));
    for (const line of [
      `not ok 1 - ${input}`,
      "  ---",
      "  failureType: 'testCodeFailure'",
      `  error: '${canary}'`,
      "  code: 'ERR_ASSERTION'",
      `  actual: '${canary}'`,
      `  expected: '${canary}'`,
      "  stack: |-",
      `    ${canary}`,
      "  ...",
    ])
      consume(line);
    assert.equal(output.length, 1);
    assert.deepEqual(JSON.parse(output[0] ?? ""), {
      diagnostic: "source-test-failure",
      name: expected,
      location: null,
      category: "testCodeFailure",
      code: "ERR_ASSERTION",
    });
    assert.equal(output.join("").includes(canary), false);
    assert.equal(sourceTestDiagnostic((output[0] ?? "").trimEnd()), true);
  }
});

test("current candidate read failure diagnostics preserve literal names and bounded source locations", async () => {
  const names = [
    "completed candidate job authenticates actual ZIP metadata while parent is running, without promoting source bootstrap",
    "wrong caller, incomplete candidate and mismatched producer facts fail before ZIP download or payload permission",
    "actual ZIP/member replacement and post-await attempt/main/expiry changes never confer candidate read permission",
  ];
  const sources = await Promise.all(
    [
      [
        "scripts/test/release/current-candidate-read.test.ts",
        "await verifyCurrentCandidateRead(f.c, f.hash, reference, f.request);",
      ],
      ["scripts/current-candidate-read.ts", 'assert.equal(env.GITHUB_ACTIONS, "true");'],
    ].map(async ([path, needle]) => {
      assert.ok(path && needle);
      const text = await readFile(new URL(`../../../${path}`, import.meta.url), "utf8");
      const lines = text.split("\n");
      const matches = lines.flatMap((line, index) => (line.trim() === needle ? [index] : []));
      assert.equal(matches.length, 1);
      const index = matches[0];
      assert.ok(index !== undefined);
      return { path, text, lines, line: index + 1, endColumn: (lines[index]?.length ?? 0) + 1 };
    }),
  );
  for (const name of names) assert.ok(sources[0]?.text.includes(`test("${name}"`));
  const classify = (
    name: string,
    location: string,
    expectedName: string | null,
    expectedLocation: string | null,
  ) => {
    const output: string[] = [];
    const consume = sourceFailureLines((line) => output.push(line));
    for (const line of [
      `not ok 1 - ${name}`,
      "  ---",
      "  failureType: 'testCodeFailure'",
      `  location: '${location}'`,
      `  error: '${canary}'`,
      "  code: 'ERR_ASSERTION'",
      `  actual: '${canary}'`,
      `  expected: '${canary}'`,
      "  stack: |-",
      `    private (/${canary}/private.ts:1:1)`,
      `    private (${location})`,
      "  ...",
    ])
      consume(line);
    assert.equal(output.length, 1);
    const record = {
      diagnostic: "source-test-failure",
      name: expectedName,
      location: expectedLocation,
      category: "testCodeFailure",
      code: "ERR_ASSERTION",
    };
    assert.deepEqual(JSON.parse(output[0] ?? ""), record);
    assert.equal(output.join("").includes(canary), false);
    assert.equal(sourceTestDiagnostic((output[0] ?? "").trimEnd()), true);
    assert.equal(sourceTestDiagnostic(JSON.stringify({ ...record, error: canary })), false);
    assert.equal(sourceTestDiagnostic(JSON.stringify({ ...record, name: canary })), false);
  };
  for (const name of names)
    for (const source of sources)
      for (const column of [1, source.endColumn]) {
        const location = `${source.path}:${source.line}:${column}`;
        classify(name, location, name, location);
      }
  const name = names[0];
  assert.ok(name);
  for (const source of sources) {
    const location = `${source.path}:${source.line}:1`;
    for (const unknown of [canary, `${name} ${canary}`])
      classify(unknown, location, null, location);
    for (const invalid of [
      `${source.path}:0:1`,
      `${source.path}:${source.line}:0`,
      `${source.path}:${source.lines.length + 1}:1`,
      `${source.path}:${source.line}:${source.endColumn + 1}`,
      `scripts/../../${source.path}:${source.line}:1`,
      `scripts/${canary}.ts:1:1`,
    ])
      classify(name, invalid, name, null);
  }
});

test("an actual admission polling failure retains its reviewed inner location without its error text", {
  timeout: 10000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "fortipi-admission-diagnostic-"));
  try {
    const runtime = new URL("../../../apps/worker/test/integration/runtime.ts", import.meta.url);
    const childFile = join(directory, "failure.mjs");
    await writeFile(
      childFile,
      `import test from 'node:test';
import { poll } from ${JSON.stringify(runtime.href)};
test(${JSON.stringify(reviewedAdmissionName)}, () => poll(async () => false, Boolean, 0));
`,
      { flag: "wx", mode: 0o600 },
    );
    const forwarded: string[] = [];
    const pending = promisify(execFile)(
      process.execPath,
      ["--test", "--test-reporter=tap", childFile],
      { env: { PATH: process.env.PATH }, timeout: 8000, maxBuffer: 262144 },
    );
    assert.ok(pending.child.stdout);
    observeSourceTestFailures(pending.child.stdout, (line) => forwarded.push(line));
    await assert.rejects(pending, (error: unknown) => {
      const result = error as { code: number; stdout: string };
      assert.equal(result.code, 1);
      assert.ok(result.stdout.includes("Expected durable boundary"));
      return true;
    });
    assert.equal(forwarded.length, 1);
    const forwardedLine = forwarded[0];
    assert.ok(forwardedLine);
    const record = JSON.parse(forwardedLine);
    const lines = (await readFile(runtime, "utf8")).split("\n");
    const line =
      lines.findIndex((value) => value.includes('throw new Error("Expected durable boundary')) + 1;
    assert.deepEqual(record, {
      diagnostic: "source-test-failure",
      name: reviewedAdmissionName,
      location: `apps/worker/test/integration/runtime.ts:${line}:9`,
      category: "testCodeFailure",
      code: "ERR_TEST_FAILURE",
    });
    assert.equal(sourceTestDiagnostic(forwardedLine.trimEnd()), true);
    assert.ok(!forwardedLine.includes("Expected durable boundary"));
    assert.ok(!forwardedLine.includes(directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("admission caller records retain only two distinct reviewed frames and closed private-free facts", async () => {
  const runtime = new URL("../../../apps/worker/test/integration/runtime.ts", import.meta.url);
  const oracles = new URL("../../../apps/worker/test/integration/oracles.ts", import.meta.url);
  const lines = (await readFile(runtime, "utf8")).split("\n");
  const inner = `apps/worker/test/integration/runtime.ts:${lines.findIndex((line) => line.includes('throw new Error("Expected durable boundary')) + 1}:9`;
  const launch = runtimeCallFrame(lines, "await poll(");
  const start = runtimeCallFrame(lines, "await launch();");
  const oracleLines = (await readFile(oracles, "utf8")).split("\n");
  const oracle = `apps/worker/test/integration/oracles.ts:${oracleLines.findIndex((line) => line.includes("await poll(async () => observation.cue()")) + 1}:7`;
  const summary = {
    diagnostic: "source-test-failure",
    name: reviewedAdmissionName,
    location: inner,
    category: "testCodeFailure",
    code: "ERR_TEST_FAILURE",
  };
  const caller = (location: string, rank: number) => ({
    diagnostic: "source-test-failure-caller",
    name: reviewedAdmissionName,
    location: inner,
    rank,
    caller: location,
  });
  const fixture = (name: string) =>
    `not ok 1 - ${name}\n  ---\n  failureType: 'testCodeFailure'\n  code: 'ERR_TEST_FAILURE'\n  error: '${canary}'\n  stack: |-\n    private (${fileURLToPath(runtime)}:${inner.split(":").slice(-2).join(":")})\n    private (${oracle})\n    private (${oracle})\n    ${canary} (/${canary}/private.ts:1:1)\n    invalid (apps/worker/test/integration/oracles.ts:999999:1)\n    other (scripts/build-workspaces.ts:1:1)\n    private (${launch})\n    third (${start})\n  ...\n`;
  const stdout = new PassThrough(),
    stderr = new PassThrough(),
    classified: string[] = [],
    forwarded: string[] = [];
  observeSourceTestFailures(stdout, (line) => {
    classified.push(line);
    stderr.write(line);
  });
  observeCandidateDiagnostics(stderr, (line) => forwarded.push(line));
  stdout.write(`${canary.repeat(1000)}\n`);
  for (const byte of Buffer.from(fixture(reviewedAdmissionName))) stdout.write(Buffer.from([byte]));
  const done = once(stdout, "end");
  stdout.end();
  await done;
  const stderrDone = once(stderr, "end");
  stderr.end();
  await stderrDone;
  assert.deepEqual(
    classified.map((line) => JSON.parse(line)),
    [summary, caller(oracle, 0), caller(launch, 1)],
  );
  assert.deepEqual(forwarded, classified);
  assert.ok(
    forwarded.every((line) => line.trimEnd().length <= 512 && sourceTestDiagnostic(line.trimEnd())),
  );
  assert.ok(!forwarded.join("").includes(canary));
  assert.ok(!forwarded.join("").includes(fileURLToPath(runtime)));
  const boundedStack: string[] = [];
  const acceptStack = sourceFailureLines((line) => boundedStack.push(line));
  for (const line of [
    `not ok 1 - ${reviewedAdmissionName}`,
    "  ---",
    "  failureType: 'testCodeFailure'",
    "  code: 'ERR_TEST_FAILURE'",
    "  stack: |-",
    `    private (${inner})`,
    `    private (${oracle})`,
    "  error: |-",
    `    ${canary} (${launch})`,
    "  ...",
  ])
    acceptStack(line);
  assert.deepEqual(
    boundedStack.map((line) => JSON.parse(line)),
    [summary, caller(oracle, 0)],
  );
  const unrelated: string[] = [];
  const consume = sourceFailureLines((line) => unrelated.push(line));
  for (const line of [fixture(reviewedName), fixture(canary)].join("").split("\n")) consume(line);
  assert.deepEqual(
    unrelated.map((line) => JSON.parse(line)),
    [
      { ...summary, name: reviewedName },
      { ...summary, name: null },
    ],
  );
  const safe = caller(launch, 0);
  for (const value of [
    { ...safe, name: reviewedName },
    { ...safe, location: null },
    { ...safe, rank: -1 },
    { ...safe, rank: 2 },
    { ...safe, rank: "0" },
    { ...safe, caller: inner },
    { ...safe, caller: "scripts/build-workspaces.ts:1:1" },
    { ...safe, caller: "apps/worker/test/integration/../integration/runtime.ts:1:1" },
    { ...safe, caller: "apps/worker/test/integration/runtime.ts:999999:1" },
    { ...safe, caller: "apps/worker/test/integration/runtime.ts:1:999999" },
    { ...safe, error: canary },
  ])
    assert.equal(sourceTestDiagnostic(JSON.stringify(value)), false);
  assert.equal(
    sourceTestDiagnostic(JSON.stringify(safe).replace('"rank":0', `"rank":"${canary}","rank":0`)),
    false,
  );
  assert.equal(sourceTestDiagnostic(`${JSON.stringify(safe)} `), false);
  assert.equal(sourceTestDiagnostic(`${JSON.stringify(safe)}${" ".repeat(512)}`), false);
  assert.equal(
    sourceTestDiagnostic(
      JSON.stringify({
        diagnostic: safe.diagnostic,
        name: safe.name,
        location: safe.location,
        caller: safe.caller,
        rank: safe.rank,
      }),
    ),
    false,
  );
});

test("actual startup poll retains reviewed callers with its original error and owned cleanup", {
  timeout: 60000,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "fortipi-admission-caller-"));
  try {
    const runtime = new URL("../../../apps/worker/test/integration/runtime.ts", import.meta.url);
    const lines = (await readFile(runtime, "utf8")).split("\n");
    const callers = [
      runtimeCallFrame(lines, "await poll("),
      runtimeCallFrame(lines, "await launch();"),
    ];
    const worker = fileURLToPath(
      new URL("../../../apps/worker/test/integration/fixture-worker.ts", import.meta.url),
    );
    const main = join(directory, "worker.ts"),
      childFile = join(directory, "failure.mjs");
    await writeFile(
      main,
      `export * from ${JSON.stringify(worker)};
import worker from ${JSON.stringify(worker)};
export default { fetch(request, env) {
  if (new URL(request.url).pathname === '/health') return new Response(null, {status:503});
  return worker.fetch(request, env);
}};
`,
      { flag: "wx", mode: 0o600 },
    );
    await writeFile(
      childFile,
      `import assert from 'node:assert/strict';
import {ChildProcess,execFile} from 'node:child_process';
import {subscribe,unsubscribe} from 'node:diagnostics_channel';
import {once} from 'node:events';
import test from 'node:test';
import {start} from ${JSON.stringify(runtime.href)};
test(${JSON.stringify(reviewedAdmissionName)}, {timeout:45000}, async t => {
  const owned=[],closed=[];
  let health503=0,forced=false;
  const observe=({process:child}) => {
    if (!(child instanceof ChildProcess)) return;
    child.once('spawn', () => {
      if (child.spawnfile !== process.execPath) return;
      owned.push(child);closed.push(once(child,'close'));
    });
  };
  const response=({request,response}) => {if(request.path==='/health'&&response.statusCode===503)health503++;};
  subscribe('child_process',observe);subscribe('undici:request:headers',response);
  const guard=setTimeout(() => {
    for(const child of owned)if(child.exitCode===null&&child.signalCode===null){
      forced=true;
      if(process.platform==='win32')execFile('taskkill',['/PID',String(child.pid),'/T','/F'],()=>{});
      else try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}
    }
  },42000);guard.unref();
  t.after(async () => {
    try {
      await Promise.all(closed);
      assert.equal(owned.length,2);
      assert.equal(forced,false);
      assert.ok(health503>0);
      assert.ok(owned.every(child=>child.exitCode!==null||child.signalCode!==null));
      t.diagnostic('owned-startup-control '+JSON.stringify({health503,closed:true,forced}));
    } finally {clearTimeout(guard);unsubscribe('child_process',observe);unsubscribe('undici:request:headers',response);}
  });
  try {
    const unexpected=await start({main:${JSON.stringify(main)}});
    await unexpected.dispose();
    assert.fail('Expected original startup poll failure');
  } catch(error) {
    assert.ok(error instanceof Error);
    assert.equal(error.name,'Error');
    assert.equal(error.message,'Expected durable boundary did not become observable before its deadline');
    assert.equal(error.code,undefined);
    throw error;
  }
});
`,
      { flag: "wx", mode: 0o600 },
    );
    const classified: string[] = [],
      forwarded: string[] = [],
      stream = new PassThrough();
    observeCandidateDiagnostics(stream, (line) => forwarded.push(line));
    const pending = promisify(execFile)(
      process.execPath,
      ["--test", "--test-reporter=tap", childFile],
      { env: { PATH: process.env.PATH }, timeout: 55000, maxBuffer: 262144 },
    );
    assert.ok(pending.child.stdout);
    observeSourceTestFailures(pending.child.stdout, (line) => {
      classified.push(line);
      stream.write(line);
    });
    await assert.rejects(pending, (error: unknown) => {
      const result = error as { code: number; stdout: string };
      assert.equal(result.code, 1);
      assert.ok(
        result.stdout.includes(
          "Expected durable boundary did not become observable before its deadline",
        ),
      );
      assert.match(result.stdout, /# pass 0\n# fail 1\n# cancelled 0\n# skipped 0\n/);
      assert.match(
        result.stdout,
        /owned-startup-control \{"health503":\d+,"closed":true,"forced":false\}/,
      );
      for (const caller of callers)
        assert.ok(
          result.stdout.includes(`${runtime.href}:${caller.split(":").slice(-2).join(":")}`),
        );
      return true;
    });
    const done = once(stream, "end");
    stream.end();
    await done;
    const location = `apps/worker/test/integration/runtime.ts:${lines.findIndex((line) => line.includes('throw new Error("Expected durable boundary')) + 1}:9`;
    const expected = {
      diagnostic: "source-test-failure",
      name: reviewedAdmissionName,
      location,
      category: "testCodeFailure",
      code: "ERR_TEST_FAILURE",
    };
    const summaryLine = classified[0];
    assert.ok(summaryLine);
    assert.deepEqual(JSON.parse(summaryLine), expected);
    t.diagnostic(summaryLine.trimEnd());
    assert.deepEqual(
      classified.slice(1).map((line) => JSON.parse(line)),
      callers.map((caller, rank) => ({
        diagnostic: "source-test-failure-caller",
        name: reviewedAdmissionName,
        location,
        rank,
        caller,
      })),
    );
    assert.deepEqual(forwarded, classified);
    assert.ok(
      forwarded.every(
        (line) => line.trimEnd().length <= 512 && sourceTestDiagnostic(line.trimEnd()),
      ),
    );
    assert.ok(!forwarded.join("").includes(directory));
    assert.ok(!forwarded.join("").includes("Expected durable boundary"));
    for (const line of forwarded.slice(1)) t.diagnostic(line.trimEnd());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("live failing child yields only closed reviewed facts while pass/failure and private captures survive", {
  timeout: 10000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "fortipi-failure-diagnostic-"));
  try {
    await mkdir(join(directory, "empty"));
    const childFile = join(directory, "child.mjs");
    await writeFile(
      childFile,
      `
import test from 'node:test';
import assert from 'node:assert/strict';
import { tests } from ${JSON.stringify(helper.href)};
test(${JSON.stringify(reviewedName)}, () => tests(['empty'], false, undefined, {directory: ${JSON.stringify(directory)}}));
test(${JSON.stringify(canary)}, () => assert.fail(${JSON.stringify(canary)}));
`,
      { mode: 0o600 },
    );
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        private: true,
        scripts: { test: "node --test --test-reporter=tap child.mjs" },
      }),
    );
    const config = join(directory, "empty.npmrc");
    await writeFile(config, "", { mode: 0o600 });
    const runner = join(directory, "runner.mjs");
    await writeFile(
      runner,
      `
import { execute } from ${JSON.stringify(new URL("../../prepare-release.ts", import.meta.url).href)};
import { pnpmExecutable } from ${JSON.stringify(new URL("../../pnpm-executable.ts", import.meta.url).href)};
const result = await execute(await pnpmExecutable(), ['run', 'test'], ${JSON.stringify(directory)}, {
 PATH: process.env.PATH, NPM_CONFIG_USERCONFIG: ${JSON.stringify(config)}, NPM_CONFIG_GLOBALCONFIG: ${JSON.stringify(config)}
}, 5000, true);
console.log(JSON.stringify({code:result.code,timedOut:result.timedOut,captured:result.stdout.includes(${JSON.stringify(canary)})}));
process.exitCode=result.code ?? 1;
`,
      { mode: 0o600 },
    );
    let settled = false;
    const observedBeforeSettlement: boolean[] = [],
      forwarded: string[] = [];
    const pending = promisify(execFile)(process.execPath, [runner], {
      env: { PATH: process.env.PATH },
      timeout: 8000,
      maxBuffer: 262144,
    });
    assert.ok(pending.child.stderr);
    observeCandidateDiagnostics(pending.child.stderr, (line) => {
      observedBeforeSettlement.push(!settled);
      forwarded.push(line);
    });
    await assert.rejects(pending, (error: unknown) => {
      const result = error as { code: number; stdout: string; stderr: string };
      assert.equal(result.code, 1);
      assert.deepEqual(JSON.parse(result.stdout), { code: 1, timedOut: false, captured: true });
      assert.ok(
        result.stderr.includes(canary),
        "Original private progress capture remains available",
      );
      return true;
    });
    settled = true;
    assert.deepEqual(observedBeforeSettlement, [true, true]);
    assert.equal(forwarded.length, 2);
    const known = JSON.parse(forwarded[0] as string),
      unknown = JSON.parse(forwarded[1] as string);
    const lines = (await readFile(fileURLToPath(helper), "utf8")).split("\n");
    const sourceLine =
      lines.findIndex((line) => line.includes("Required test suite has no tests:")) + 1;
    assert.equal(known.name, reviewedName);
    assert.match(known.location, new RegExp(`^scripts/build-workspaces\\.ts:${sourceLine}:\\d+$`));
    assert.equal(known.category, "testCodeFailure");
    assert.equal(known.code, "ERR_TEST_FAILURE");
    assert.deepEqual(unknown, {
      diagnostic: "source-test-failure",
      name: null,
      location: null,
      category: "testCodeFailure",
      code: "ERR_ASSERTION",
    });
    assert.ok(!forwarded.join("").includes(canary));
    assert.ok(!forwarded.join("").includes("Required test suite has no tests:"));
    assert.ok(!forwarded.join("").includes(directory));
    assert.ok(forwarded.every((line) => sourceTestDiagnostic(line.trimEnd())));

    await writeFile(
      childFile,
      `import test from 'node:test'; test('pass', () => console.log(${JSON.stringify(canary)}));`,
    );
    const pass = promisify(execFile)(process.execPath, [runner], {
      env: { PATH: process.env.PATH },
      timeout: 8000,
      maxBuffer: 262144,
    });
    assert.ok(pass.child.stderr);
    observeCandidateDiagnostics(pass.child.stderr, (line) => forwarded.push(line));
    const result = await pass;
    assert.deepEqual(JSON.parse(result.stdout), { code: 0, timedOut: false, captured: true });
    assert.equal(forwarded.length, 2, "A passing child emits no failed-test record");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bounded TAP and closed-record validation discard unknown/private fields and resynchronize", async () => {
  const output: string[] = [],
    stream = new PassThrough();
  observeSourceTestFailures(stream, (line) => output.push(line));
  stream.write(`${canary.repeat(1000)}\n`);
  const fixture = `not ok 1 - ${canary}\n  ---\n  failureType: '${canary}'\n  code: '${canary}'\n  error: |-\n    ${canary}\n    not ok 2 - ${reviewedName}\n    code: 'ERR_ASSERTION'\n  location: '/${canary}/scripts/build-workspaces.ts:1:1'\n  ...\n`;
  for (const byte of Buffer.from(fixture)) stream.write(Buffer.from([byte]));
  const ended = once(stream, "end");
  stream.end();
  await ended;
  const safe = {
    diagnostic: "source-test-failure",
    name: null,
    location: null,
    category: null,
    code: null,
  };
  assert.deepEqual(output, [`${JSON.stringify(safe)}\n`]);
  for (const record of [
    { ...safe, name: canary },
    { ...safe, location: "scripts/build-workspaces.ts:999999:1" },
    { ...safe, location: "scripts/../scripts/build-workspaces.ts:1:1" },
    { ...safe, code: canary },
    { ...safe, error: canary },
  ])
    assert.equal(sourceTestDiagnostic(JSON.stringify(record)), false);
  assert.equal(
    sourceTestDiagnostic(
      JSON.stringify(safe).replace('"name":null', `"name":"${canary}","name":null`),
    ),
    false,
  );
  assert.equal(sourceTestDiagnostic(JSON.stringify(safe)), true);
  const startup = {
    diagnostic: "source-recovery-start",
    event: "ready",
    invocation: 1,
    elapsedMs: 100,
    attempts: 1,
    deadlines: 0,
    transports: 0,
    status: 200,
    exitCode: null,
    signal: null,
    logStage: "ready-log",
  };
  assert.equal(sourceTestDiagnostic(`# ${JSON.stringify(startup)}`), true);
  const path = "apps/worker/test/agent/process-recovery.test.ts";
  assert.equal(sourceRecoveryPath(path), path);
  assert.equal(sourceRecoveryPath(join(tmpdir(), `${canary}.test.ts`)), null);
  const attributed = {
    ...startup,
    sourcePath: path,
    harnessOrdinal: 1,
    announcedPortMatches: true,
  };
  assert.equal(sourceTestDiagnostic(`# ${JSON.stringify(attributed)}`), true);
  for (const changed of [
    { ...attributed, sourcePath: canary },
    { ...attributed, sourcePath: "apps/worker/test/../private.test.ts" },
    { ...attributed, announcedPortMatches: canary },
    { ...attributed, harnessOrdinal: canary },
    { ...attributed, port: 12345 },
  ])
    assert.equal(sourceTestDiagnostic(`# ${JSON.stringify(changed)}`), false);
  const runtime = {
    diagnostic: "source-recovery-process",
    sourcePath: path,
    harnessOrdinal: 2,
    invocation: 5,
    runtimeCount: 1,
    runnableCount: 0,
    rssKiB: 123456,
    cpuMs: 1250,
  };
  assert.equal(sourceTestDiagnostic(`# ${JSON.stringify(runtime)}`), true);
  assert.equal(
    sourceTestDiagnostic(
      `# ${JSON.stringify({ ...runtime, runtimeCount: null, runnableCount: null, rssKiB: null, cpuMs: null })}`,
    ),
    true,
  );
  for (const changed of [
    { ...runtime, sourcePath: canary },
    { ...runtime, sourcePath: "apps/worker/test/../private.test.ts" },
    { ...runtime, runtimeCount: -1 },
    { ...runtime, cpuMs: canary },
    { ...runtime, rssKiB: Number.MAX_SAFE_INTEGER },
    { ...runtime, pid: 12345 },
    { ...runtime, output: canary },
  ])
    assert.equal(sourceTestDiagnostic(`# ${JSON.stringify(changed)}`), false);
  assert.ok(!output.join("").includes(canary));
});

test("profile summary and ranked hashes survive bounded forwarding while private or malformed records do not", async () => {
  const identity = {
    diagnostic: "source-recovery-profile",
    sourcePath: "apps/worker/test/agent/process-recovery.test.ts",
    harnessOrdinal: 1,
    invocation: 5,
  };
  const methods = ["Profiler.enable", "Profiler.start", "Profiler.stop", "Profiler.disable"].map(
    (method) => [method, "ok", null],
  );
  const profile = { bytes: 398, sha256: "a".repeat(64), nodes: 2, samples: 1, durationUs: 516555 };
  const summary = { ...identity, status: "available", stage: "complete", methods, profile };
  const frame = {
    ...identity,
    profileSha256: profile.sha256,
    rank: 0,
    functionSha256: "b".repeat(64),
    urlSha256: "c".repeat(64),
    line: -1,
    column: -1,
    samples: 1,
  };
  const encode = (value: unknown) => `# ${JSON.stringify(value)}`;
  const lines = [
    encode(summary),
    ...Array.from({ length: 5 }, (_, rank) => encode({ ...frame, rank })),
  ];
  assert.ok(lines.every((line) => line.length <= 512 && sourceTestDiagnostic(line)));
  const unavailable = {
    ...summary,
    status: "unavailable",
    stage: "cdp",
    methods: [
      ["Profiler.enable", "cdp-error", -32601],
      ["Profiler.start", "not-sent", null],
      ["Profiler.stop", "not-sent", null],
      ["Profiler.disable", "ok", null],
    ],
    profile: null,
  };
  assert.equal(sourceTestDiagnostic(encode(unavailable)), true);
  const rejected = [
    { ...summary, body: canary },
    { ...summary, sourcePath: canary },
    { ...summary, sourcePath: "apps/worker/test/../private.test.ts" },
    { ...summary, harnessOrdinal: 1000000 },
    { ...summary, invocation: 0 },
    { ...summary, stage: canary },
    { ...summary, profile: { ...profile, source: canary } },
    { ...summary, profile: { ...profile, bytes: 2097153 } },
    { ...summary, profile: { ...profile, durationUs: 5000001 } },
    { ...summary, methods: [[canary, "ok", null], ...methods.slice(1)] },
    { ...unavailable, methods: [["Profiler.enable", "cdp-error", -32769], ...methods.slice(1)] },
    { ...summary, methods: [["Profiler.enable", "ok", 1], ...methods.slice(1)] },
    { ...frame, urlSha256: canary },
    { ...frame, profileSha256: canary },
    { ...frame, functionName: canary },
    { ...frame, rank: 5 },
    { ...frame, line: 10000000 },
    { ...frame, column: -2 },
    { ...frame, samples: 100001 },
  ].map(encode);
  rejected.push(encode(summary).replace('"bytes":398', `"bytes":"${canary}","bytes":398`));
  rejected.push(
    encode(summary).replace(
      '"status":"available","stage":"complete"',
      '"stage":"complete","status":"available"',
    ),
  );
  rejected.push(`${lines[0]} `);
  assert.ok(rejected.every((line) => !sourceTestDiagnostic(line)));
  const forwarded: string[] = [],
    stream = new PassThrough();
  observeCandidateDiagnostics(stream, (line) => forwarded.push(line));
  for (const line of [...rejected, ...lines]) {
    for (const byte of Buffer.from(`${line}\n`)) stream.write(Buffer.from([byte]));
  }
  const ended = once(stream, "end");
  stream.end();
  await ended;
  assert.deepEqual(
    forwarded,
    lines.map((line) => `${line}\n`),
  );
  assert.ok(!forwarded.join("").includes(canary));
});

test("owned Wrangler returns a real bounded CPU profile after unchanged healthy readiness", {
  timeout: 45000,
}, async (t) => {
  let discoveries = 0;
  const observed = (message: unknown) => {
    const request = (message as { request: ClientRequest }).request;
    if (request.path === "/json" && request.host === "127.0.0.1") discoveries++;
  };
  subscribe("http.client.request.start", observed);
  let h: Awaited<ReturnType<typeof processHarness>> | undefined;
  try {
    h = await processHarness();
    assert.equal(discoveries, 0, "A passing original startup must not invoke the profiler");
    const result = await processProfile(h.inspectorPort);
    assert.equal(discoveries, 1);
    assert.equal(result.status, "available");
    assert.equal(result.stage, "complete");
    assert.deepEqual(
      result.methods,
      [
        ["Profiler.enable", "ok", null],
        ["Profiler.start", "ok", null],
        ["Profiler.stop", "ok", null],
        ["Profiler.disable", "ok", null],
      ],
      "Actual CDP void acknowledgments must be accepted",
    );
    assert.ok(
      result.profile &&
        result.profile.bytes > 0 &&
        result.profile.nodes > 0 &&
        result.profile.samples > 0,
    );
    assert.match(result.profile.sha256, /^[a-f0-9]{64}$/);
    assert.ok(result.profile.durationUs > 0 && result.top.length > 0);
    const lines = processProfileLines(result, sourceRecoveryPath(), 1, 1).map(
      (line) => `# ${line}`,
    );
    assert.ok(lines.every((line) => line.length <= 512 && sourceTestDiagnostic(line)));
    const stream = new PassThrough(),
      forwarded: string[] = [];
    observeCandidateDiagnostics(stream, (line) => forwarded.push(line));
    for (const line of lines) stream.write(`${line}\n`);
    const ended = once(stream, "end");
    stream.end();
    await ended;
    assert.deepEqual(
      forwarded,
      lines.map((line) => `${line}\n`),
      "Actual profile facts cross the unchanged capture boundary",
    );
    assert.ok(
      forwarded
        .slice(1)
        .every((line) => JSON.parse(line.slice(2)).profileSha256 === result.profile?.sha256),
    );
    for (const line of forwarded) t.diagnostic(line.slice(2).trimEnd());
  } finally {
    unsubscribe("http.client.request.start", observed);
    await h?.close();
  }
});

test("owned proxy discovery refuses a foreign WebSocket port before contacting it", {
  timeout: 5000,
}, async () => {
  let contacts = 0,
    discoveries = 0;
  const foreign = createServer((_req, res) => {
    contacts++;
    res.end();
  });
  const discovery = createServer((req, res) => {
    discoveries++;
    assert.equal(req.url, "/json");
    res.setHeader("Connection", "close");
    res.end(
      JSON.stringify([
        {
          id: "12345678-1234-4123-8123-123456789abc",
          type: "node",
          description: "workers",
          webSocketDebuggerUrl: `ws://127.0.0.1:${foreignPort}/ws`,
          devtoolsFrontendUrl: frontend,
          devtoolsFrontendUrlCompat: frontend,
          title: "Cloudflare Worker",
          faviconUrl: "https://workers.cloudflare.com/favicon.ico",
        },
      ]),
    );
  });
  discovery.on("upgrade", (_req, socket) => {
    contacts++;
    socket.destroy();
  });
  let foreignPort = 0,
    frontend = "";
  try {
    await new Promise<void>((accept) => foreign.listen(0, "127.0.0.1", accept));
    await new Promise<void>((accept) => discovery.listen(0, "127.0.0.1", accept));
    const a = foreign.address(),
      b = discovery.address();
    assert.ok(a && typeof a !== "string" && b && typeof b !== "string");
    foreignPort = a.port;
    frontend = `https://devtools.devprod.cloudflare.dev/js_app?theme=systemPreferred&debugger=true&ws=127.0.0.1:${b.port}/ws`;
    const result = await processProfile(b.port);
    assert.equal(result.status, "unavailable");
    assert.equal(result.stage, "discovery");
    assert.ok(result.methods.every((entry) => entry[1] === "not-sent"));
    assert.equal(discoveries, 1);
    assert.equal(contacts, 0);
  } finally {
    await Promise.all(
      [foreign, discovery].map(
        (server) =>
          new Promise<void>((accept, reject) => {
            server.close((error) => (error ? reject(error) : accept()));
            server.closeAllConnections();
          }),
      ),
    );
  }
});

test("failure role records forward only canonical bounded correlated facts", async () => {
  const prefix = "apps/worker/test/",
    suffix = ".test.ts";
  const sourcePath = prefix + "x".repeat(64 - prefix.length - suffix.length) + suffix;
  const record = {
    diagnostic: "source-recovery-role",
    sourcePath,
    harnessOrdinal: 999999,
    invocation: 999,
    status: "available",
    stage: "complete",
    elapsedMs: 5000,
    roles: [
      { role: "proxy", ticks: 1000000, state: "R" },
      { role: "user", ticks: 1000000, state: "S" },
    ],
  };
  const encode = (value: unknown) => `# ${JSON.stringify(value)}`;
  const available = encode(record);
  assert.ok(Buffer.byteLength(`${available}\n`) <= 512);
  const absent = {
    ...record,
    sourcePath: null,
    status: "unavailable",
    stage: "unsupported",
    elapsedMs: null,
    roles: null,
  };
  const accepted = [
    available,
    ...["unsupported", "owner", "executable", "lineage", "socket", "identity", "bounds"].map(
      (stage) => encode({ ...absent, stage }),
    ),
  ];
  assert.ok(accepted.every(sourceTestDiagnostic));
  const invalid = [
    { ...record, sourcePath: `/${canary}/private.test.ts` },
    { ...record, sourcePath: "apps/worker/test/../private.test.ts" },
    { ...record, sourcePath: "apps/worker/test/./private.test.ts" },
    { ...record, sourcePath: "apps/worker/test//private.test.ts" },
    { ...record, sourcePath: sourcePath.replace("x", "xx") },
    { ...record, sourcePath: "unknown/private.test.ts" },
    { ...record, harnessOrdinal: 0 },
    { ...record, harnessOrdinal: 1000000 },
    { ...record, harnessOrdinal: 1.5 },
    { ...record, invocation: 0 },
    { ...record, invocation: 1000 },
    { ...record, invocation: "1" },
    { ...record, elapsedMs: 499 },
    { ...record, elapsedMs: 5001 },
    { ...record, status: "unknown" },
    { ...record, stage: "socket" },
    { ...record, roles: null },
    { ...record, roles: [record.roles[0]] },
    { ...record, roles: [...record.roles, record.roles[0]] },
    { ...record, roles: [record.roles[1], record.roles[0]] },
    { ...record, roles: [{ ...record.roles[0], ticks: -1 }, record.roles[1]] },
    { ...record, roles: [{ ...record.roles[0], ticks: 1000001 }, record.roles[1]] },
    { ...record, roles: [{ ...record.roles[0], state: canary }, record.roles[1]] },
    { ...record, roles: [{ ...record.roles[0], pid: 123 }, record.roles[1]] },
    { ...record, roles: [{ ticks: 0, role: "proxy", state: "R" }, record.roles[1]] },
    { ...absent, stage: "complete" },
    { ...absent, roles: record.roles },
    { ...absent, elapsedMs: 500 },
    { ...record, phase: "failure" },
    { ...record, socket: { raw: canary } },
    { ...record, profile: canary },
    { ...record, error: canary },
    { ...record, port: 12345 },
    { ...record, env: canary },
  ].map(encode);
  invalid.push(available.replace('"invocation":999', `"invocation":"${canary}","invocation":999`));
  invalid.push(
    available.replace(
      '"diagnostic":"source-recovery-role","sourcePath"',
      '"sourcePath":"x","diagnostic":"source-recovery-role","sourcePath"',
    ),
  );
  invalid.push(`${available} `, `${available}${" ".repeat(512)}`, `# ${canary.repeat(1000)}`);
  assert.ok(invalid.every((line) => !sourceTestDiagnostic(line)));
  const stream = new PassThrough(),
    forwarded: string[] = [];
  observeCandidateDiagnostics(stream, (line) => forwarded.push(line));
  for (const line of [...invalid, ...accepted])
    for (const byte of Buffer.from(`${line}\n`)) stream.write(Buffer.from([byte]));
  const done = once(stream, "end");
  stream.end();
  await done;
  assert.deepEqual(
    forwarded,
    accepted.map((line) => `${line}\n`),
  );
  assert.ok(!forwarded.join("").includes(canary));
});

test("kernel records are closed, bounded and explicit about unavailable data", async () => {
  const prefix = "apps/worker/test/",
    suffix = ".test.ts",
    path = prefix + "x".repeat(64 - prefix.length - suffix.length) + suffix;
  const data = {
    status: "available",
    stage: "complete",
    elapsedMs: 5000,
    roles: [
      {
        role: "proxy",
        userTicks: 1000000,
        systemTicks: 1000000,
        majorFaults: 1000000,
        wait: ["unavailable", "unavailable"],
      },
      {
        role: "user",
        userTicks: 1000000,
        systemTicks: 1000000,
        majorFaults: 1000000,
        wait: ["writeback", "writeback"],
      },
    ],
  };
  const record = {
    diagnostic: "source-recovery-kernel",
    sourcePath: path,
    harnessOrdinal: 999999,
    invocation: 999,
    ...data,
  };
  const encode = (value: unknown) => `# ${JSON.stringify(value)}`,
    available = encode(record);
  assert.ok(Buffer.byteLength(`${available}\n`) <= 512);
  assert.equal(sourceTestDiagnostic(available), true);
  const absent = { ...record, status: "unavailable", stage: "wchan", elapsedMs: null, roles: null };
  const good = [
    available,
    encode(absent),
    encode({ ...absent, sourcePath: null, stage: "unsupported" }),
  ];
  const bad = [
    { ...record, sourcePath: `/${canary}/private.test.ts` },
    { ...record, sourcePath: "apps/worker/test/../private.test.ts" },
    { ...record, harnessOrdinal: 0 },
    { ...record, invocation: 1000 },
    { ...record, elapsedMs: 499 },
    { ...record, roles: [] },
    { ...record, roles: [record.roles[1], record.roles[0]] },
    { ...record, roles: [{ ...record.roles[0], userTicks: -1 }, record.roles[1]] },
    { ...record, roles: [{ ...record.roles[0], systemTicks: 1000001 }, record.roles[1]] },
    { ...record, roles: [{ ...record.roles[0], majorFaults: 1.5 }, record.roles[1]] },
    { ...record, roles: [{ ...record.roles[0], wait: [canary, "io"] }, record.roles[1]] },
    { ...record, roles: [{ ...record.roles[0], pid: 123 }, record.roles[1]] },
    { ...absent, roles: record.roles },
    { ...absent, elapsedMs: 500 },
    { ...absent, stage: "complete" },
    { ...record, error: canary },
    { ...record, stack: canary },
    { ...record, port: 12345 },
    { ...record, profile: canary },
  ].map(encode);
  bad.push(
    available.replace('"invocation":999', `"invocation":"${canary}","invocation":999`),
    `${available} `,
    `${available}${" ".repeat(512)}`,
  );
  assert.ok(bad.every((line) => !sourceTestDiagnostic(line)));
  const stream = new PassThrough(),
    forwarded: string[] = [];
  observeCandidateDiagnostics(stream, (line) => forwarded.push(line));
  for (const line of [...bad, ...good])
    for (const byte of Buffer.from(`${line}\n`)) stream.write(Buffer.from([byte]));
  const done = once(stream, "end");
  stream.end();
  await done;
  assert.deepEqual(
    forwarded,
    good.map((line) => `${line}\n`),
  );
  assert.ok(!forwarded.join("").includes(canary));
});

test("owned Ready with ping503 preserves the original failure, profiles automatically and closes", {
  timeout: 45000,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "fortipi-profile-failure-"));
  try {
    const runtime = fileURLToPath(
      new URL("../../../apps/worker/test/agent/runtime-worker.ts", import.meta.url),
    );
    const main = join(directory, "worker.ts"),
      childFile = join(directory, "control.mjs");
    await writeFile(
      main,
      `export * from ${JSON.stringify(runtime)};
import worker from ${JSON.stringify(runtime)};
export default { fetch(request, env) {
  if (new URL(request.url).pathname === '/__test/ping') return new Response(null, {status:503});
  return worker.fetch(request, env);
}};
`,
      { flag: "wx", mode: 0o600 },
    );
    const harness = new URL("../../../apps/worker/test/agent/process-harness.ts", import.meta.url);
    await writeFile(
      childFile,
      `import assert from 'node:assert/strict';
import {ChildProcess} from 'node:child_process';
import {subscribe,unsubscribe} from 'node:diagnostics_channel';
import {once} from 'node:events';
import test from 'node:test';
import {processHarness} from ${JSON.stringify(harness.href)};
test('original readiness error and owned child cleanup', {timeout:40000}, async () => {
  const owned=[], closed=[];
  const observe=({process:child}) => {
    if (!(child instanceof ChildProcess)) return;
    child.once('spawn', () => {
      if (child.spawnfile !== process.execPath) return;
      owned.push(child); closed.push(once(child,'close'));
    });
  };
  subscribe('child_process',observe);
  let unexpected;
  try {
    await assert.rejects(async () => { unexpected=await processHarness(${JSON.stringify(main)}); },
      {name:'AssertionError',code:'ERR_ASSERTION',message:'Wrangler not ready'});
    assert.equal(owned.length,1);
    await Promise.all(closed);
    assert.ok(owned[0].exitCode !== null || owned[0].signalCode !== null);
  } finally { unsubscribe('child_process',observe); await unexpected?.close(); }
});
`,
      { flag: "wx", mode: 0o600 },
    );
    const forwarded: string[] = [];
    const pending = promisify(execFile)(
      process.execPath,
      ["--test", "--test-reporter=tap", childFile],
      { env: { PATH: process.env.PATH }, timeout: 42000, maxBuffer: 262144 },
    );
    assert.ok(pending.child.stdout);
    observeCandidateDiagnostics(pending.child.stdout, (line) => forwarded.push(line));
    const output = await pending;
    assert.match(output.stdout, /# pass 1\n# fail 0\n/);
    const records = forwarded.map((line) => JSON.parse(line.trimEnd().slice(2)));
    const endIndex = records.findIndex(
      (r) => r.diagnostic === "source-recovery-start" && r.event === "end",
    );
    const psIndex = records.findIndex((r) => r.diagnostic === "source-recovery-process");
    const profileIndex = records.findIndex(
      (r) => r.diagnostic === "source-recovery-profile" && r.status === "available",
    );
    assert.ok(endIndex >= 0 && psIndex > endIndex && profileIndex > psIndex);
    const end = records[endIndex],
      profile = records[profileIndex];
    assert.equal(end.attempts, 300);
    assert.equal(end.status, 503);
    assert.equal(end.announcedPortMatches, true);
    assert.equal(end.exitCode, null);
    assert.equal(end.signal, null);
    assert.ok(end.elapsedMs >= 15000);
    assert.equal(profile.stage, "complete");
    assert.ok(profile.profile.bytes > 0 && profile.profile.samples > 0);
    assert.ok(profile.methods.every((entry: unknown[]) => entry[1] === "ok"));
    const frames = records.filter(
      (r) => r.diagnostic === "source-recovery-profile" && r.rank !== undefined,
    );
    assert.ok(frames.length > 0 && frames.length <= 5);
    assert.ok(
      [profile, ...frames].every(
        (record) =>
          record.sourcePath === end.sourcePath &&
          record.harnessOrdinal === end.harnessOrdinal &&
          record.invocation === end.invocation,
      ),
    );
    assert.ok(frames.every((frame) => frame.profileSha256 === profile.profile.sha256));
    assert.ok(
      forwarded.every(
        (line) => line.trimEnd().length <= 512 && sourceTestDiagnostic(line.trimEnd()),
      ),
    );
    assert.ok(!forwarded.join("").includes(directory));
    assert.ok(!forwarded.join("").includes("Wrangler not ready"));
    for (const line of forwarded) t.diagnostic(line.slice(2).trimEnd());
    const roleRows = records.filter((record) => record.diagnostic === "source-recovery-role");
    assert.equal(roleRows.length, 1, "Failure-only owned role record must be retained");
    const role = roleRows[0],
      roleIndex = records.indexOf(role);
    assert.ok(roleIndex > psIndex && roleIndex < profileIndex);
    assert.equal(role.sourcePath, profile.sourcePath);
    assert.equal(role.harnessOrdinal, end.harnessOrdinal);
    assert.equal(role.invocation, end.invocation);
    if (process.platform !== "linux") {
      assert.equal(role.status, "unavailable");
      assert.equal(role.stage, "unsupported");
      assert.equal(role.elapsedMs, null);
      assert.equal(role.roles, null);
    }
    const kernels = records.filter((record) => record.diagnostic === "source-recovery-kernel");
    assert.equal(kernels.length, 1, "Failure-only kernel record must be retained");
    const kernel = kernels[0],
      kernelIndex = records.indexOf(kernel);
    assert.ok(kernelIndex > roleIndex && kernelIndex < profileIndex);
    assert.equal(kernel.sourcePath, role.sourcePath);
    assert.equal(kernel.harnessOrdinal, role.harnessOrdinal);
    assert.equal(kernel.invocation, role.invocation);
    if (process.platform !== "linux") {
      assert.equal(kernel.status, "unavailable");
      assert.equal(kernel.stage, "unsupported");
      assert.equal(kernel.roles, null);
      assert.equal(kernel.elapsedMs, null);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
