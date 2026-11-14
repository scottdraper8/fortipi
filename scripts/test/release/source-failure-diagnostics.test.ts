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
import { sourceTestDiagnostic } from "../../source-test-processes.ts";

const reviewedName =
  "SIGKILL/reopen preserves canary, allocation provenance and stable accepted input";
const canary = "synthetic-private-diagnostic-canary";
const helper = new URL("../../build-workspaces.ts", import.meta.url);

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
  assert.ok(!output.join("").includes(canary));
});
