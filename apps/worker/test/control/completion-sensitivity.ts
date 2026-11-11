import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const directory = await mkdtemp(join(tmpdir(), "fortipi-completion-mutants-"));
try {
  await mkdir(join(directory, "apps/worker/src"), { recursive: true });
  await mkdir(join(directory, "apps/worker/test/control"), { recursive: true });
  await cp("apps/worker/src/control", join(directory, "apps/worker/src/control"), {
    recursive: true,
  });
  await cp(
    "apps/worker/test/control/fixtures",
    join(directory, "apps/worker/test/control/fixtures"),
    { recursive: true },
  );
  await symlink(
    resolve("apps/worker/src/workspace"),
    join(directory, "apps/worker/src/workspace"),
    "dir",
  );
  for (const mutation of [
    {
      file: "local-workspace.ts",
      pattern:
        /if \(privateObservation && input.kind === "receipt"\) this\.#jobReceipt\(ctx, input\);/,
      replacement: "// Deliberate fault: no receipt-specific current authority recheck.",
      testFile: "local-authority.test.ts",
      testPattern: "with grant expiry in flight",
      oracle: "receipt closure must recheck grant after native acknowledgment",
    },
    {
      file: "dispatch.ts",
      pattern: /registration\.registrationId === reservation\.registrationIds\.agent &&/,
      replacement: "false &&",
      testFile: "completion.test.ts",
      testPattern: "registered execution recovery checks",
      oracle:
        "the exact retained reservation registration derives its tool from the dispatch and current grant",
    },
    {
      file: "local-workspace.ts",
      pattern: /registration\.registrationId === reservation\.registrationIds\.agent &&/,
      replacement: "false &&",
      testFile: "local-authority.test.ts",
      testPattern: "registered native job observation uses",
      oracle:
        "the actual reservation Agent registration preserves the retained tool and one-grant authority",
    },
    {
      file: "control-plane.ts",
      pattern: /if \(this\.dispatch\.completion\(ctx, input\)\) this\.capacity\.admitRepair\(\);/,
      replacement: "if (false) this.capacity.admitRepair();",
      testFile: "completion.test.ts",
      testPattern: "current registered queries use only",
      oracle: "retained current query must survive new application pressure",
    },
    {
      file: "control-plane.ts",
      pattern: /if \(this\.dispatch\.completion\(ctx, input\)\) this\.capacity\.admitRepair\(\);/,
      replacement: "if (true) this.capacity.admitRepair();",
      testFile: "completion.test.ts",
      testPattern: "current registered queries use only",
      oracle: "unvalidated queries must stay on ordinary admission",
    },
    {
      file: "dispatch.ts",
      pattern: /\} catch \{\}\n {4}current\(\);\n {4}if \(frame\?\.type === "job.query_result"/,
      replacement: '} catch {}\n    if (frame?.type === "job.query_result"',
      testFile: "completion.test.ts",
      testPattern: "registered query revalidates",
      oracle: "awaited query must not return retained evidence under stale owner authority",
    },
    {
      file: "dispatch.ts",
      pattern:
        /\.toArray\(\)\.length === 0,\n {6}"conflict",\n {6}"Execution already has durable terminal proof"/,
      replacement:
        '.toArray().length >= 0,\n      "conflict",\n      "Execution already has durable terminal proof"',
      testFile: "completion.test.ts",
      testPattern: "current registered queries use only",
      oracle:
        "actual retained durable terminal proof closes private recovery eligibility even without transport ACK",
    },
    {
      file: "local-workspace.ts",
      pattern: /if \(!privateObservation\)\n {6}requireGrant/,
      replacement: "if (true)\n      requireGrant",
      testFile: "local-authority.test.ts",
      testPattern: "registered native job observation uses",
      oracle:
        "registered retained native observation needs no hidden workspace.read even after effect expiry",
    },
    {
      file: "local-workspace.ts",
      pattern:
        /const currentObservation = \(\) => \{\n {6}if \(privateObservation && input.kind === "observe"\) this\.#jobObservation\(ctx, input\);\n {6}if \(privateObservation && input.kind === "receipt"\) this\.#jobReceipt\(ctx, input\);\n {4}\};/,
      replacement:
        'let checkedObservation = false; const currentObservation = () => { if (checkedObservation) return; if (privateObservation && input.kind === "observe") this.#jobObservation(ctx, input); checkedObservation = true; };',
      testFile: "local-authority.test.ts",
      testPattern: "registered native observation rechecks",
      oracle: "awaited observation must not return evidence after owner authority changes",
    },
  ]) {
    const path = join(directory, "apps/worker/src/control", mutation.file);
    const original = await readFile(path, "utf8");
    assert.match(original, mutation.pattern);
    await writeFile(path, original.replace(mutation.pattern, mutation.replacement));
    const run = () =>
      spawnSync(
        process.execPath,
        [
          "--test",
          `--test-name-pattern=${mutation.testPattern}`,
          resolve("apps/worker/test/control", mutation.testFile),
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: 30000,
          env: {
            PATH: process.env.PATH ?? "",
            FORTIPI_CONTROL_TEST_SOURCE: directory,
            WRANGLER_SEND_METRICS: "false",
          },
        },
      );
    const failed = run();
    if (!(failed.stdout + failed.stderr).includes(mutation.oracle))
      process.stdout.write(
        `${JSON.stringify({ probe: "fault-subprocess", pattern: mutation.testPattern, status: failed.status, signal: failed.signal, error: failed.error?.name, errorCode: failed.error && "code" in failed.error ? failed.error.code : undefined, stdoutBytes: failed.stdout?.length, stderrBytes: failed.stderr?.length })}\n`,
      );
    assert.equal(failed.status, 1, `Fault must fail behavior: ${failed.stdout}\n${failed.stderr}`);
    assert.ok(
      (failed.stdout + failed.stderr).includes(mutation.oracle),
      `Named oracle must fail: ${failed.stdout}\n${failed.stderr}`,
    );
    await writeFile(path, original);
    const restored = run();
    assert.equal(
      restored.status,
      0,
      `Restored source must pass: ${restored.stdout}\n${restored.stderr}`,
    );
    process.stdout.write(
      `Observed behavioral failure and restored pass: ${mutation.file} / ${mutation.oracle}\n`,
    );
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
