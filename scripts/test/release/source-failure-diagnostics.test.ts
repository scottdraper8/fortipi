import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { observeCandidateDiagnostics, observeSourceTestFailures } from "../../build-workspaces.ts";
import { sourceRecoveryPath, sourceTestDiagnostic } from "../../source-test-processes.ts";

const reviewedName =
  "SIGKILL/reopen preserves canary, allocation provenance and stable accepted input";
const reviewedAdmissionName =
  "integrated persistent runtime retains actual Pi input and repairs the same admission across both acknowledged SIGKILL boundaries";
const canary = "synthetic-private-diagnostic-canary";
const helper = new URL("../../build-workspaces.ts", import.meta.url);

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
