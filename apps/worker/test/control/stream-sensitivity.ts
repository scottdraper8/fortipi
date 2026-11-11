import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const directory = await mkdtemp(join(tmpdir(), "fortipi-stream-mutants-"));
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
  for (const mutation of [
    {
      file: "tickets.ts",
      pattern: /used: true/,
      replacement: "used: false",
      testPattern: "opaque client stream routes",
      oracle: "opaque client stream must forward exactly once under a real upgrade race",
    },
    {
      file: "tickets.ts",
      pattern: /resources\.agentIds\.length === 1 &&\s*/,
      replacement: "",
      testPattern: "client stream ticket scope",
      oracle: "client stream mint must require exactly one concrete agent",
    },
    {
      file: "tickets.ts",
      pattern: /(const digest = await hash\(input\.ticket\);\s*)return this\.store\.tx\(\(\) => \{/,
      replacement: "$1return ((apply: () => [D.SocketIdentity, D.AuthContext]) => apply())(() => {",
      testPattern: "failed ticket persistence",
      oracle: "recipient registration must roll back when atomic ticket consumption cannot persist",
    },
    {
      file: "control-plane.ts",
      pattern: /"https:\/\/agent\.internal\/v1\/stream",/,
      replacement: "request.url,",
      testPattern: "opaque client stream routes",
      oracle: "ticket query must never reach the Agent recipient",
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
          resolve("apps/worker/test/control/stream.test.ts"),
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: 25000,
          env: {
            PATH: process.env.PATH ?? "",
            FORTIPI_CONTROL_TEST_SOURCE: directory,
            WRANGLER_SEND_METRICS: "false",
          },
        },
      );
    const failed = run();
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
