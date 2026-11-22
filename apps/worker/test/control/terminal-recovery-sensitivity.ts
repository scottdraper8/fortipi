import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

// Same source-override boundary as the existing CP sensitivity tools. Only
// disposable owned source changes; the real test/storage/socket paths remain.
const directory = await mkdtemp(join(tmpdir(), "fortipi-terminal-faults-"));
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
  const path = join(directory, "apps/worker/src/control/delivery.ts");
  const original = await readFile(path, "utf8");
  for (const fault of [
    {
      name: "historical-census",
      needle: 'delivery.frame.type === "job.committed" && !command.peerApplied',
      replacement: 'delivery.frame.type === "job.committed"',
      pattern: "six applied historical receipts",
      oracle: "Only the newest unconfirmed receipt belongs to recovery selection",
    },
    {
      name: "stale-confirmation",
      needle:
        "const digest = await hash(json(proof));\n    return this.store.tx(() => {\n      current();",
      replacement: "const digest = await hash(json(proof));\n    return this.store.tx(() => {",
      pattern: "terminal ACK revalidates current peer authority",
      oracle: "Awaited terminal ACK cannot retire recovery after current epoch authority changes",
    },
  ]) {
    assert.equal(
      original.split(fault.needle).length,
      2,
      "Fault must change exactly its intended boundary",
    );
    const run = () =>
      spawnSync(
        process.execPath,
        [
          "--test",
          "--test-reporter=tap",
          `--test-name-pattern=${fault.pattern}`,
          resolve("apps/worker/test/control/terminal-recovery.test.ts"),
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
    const complete = (result: ReturnType<typeof run>, expected: 0 | 1) => {
      assert.equal(result.error, undefined, "Timeout/spawn failure is not behavioral detection");
      assert.equal(result.signal, null);
      assert.equal(result.status, expected, result.stdout + result.stderr);
      assert.match(result.stdout, /# tests 1\r?\n/);
      assert.match(result.stdout, /# cancelled 0\r?\n/);
      assert.match(result.stdout, /# skipped 0\r?\n/);
    };
    complete(run(), 0);
    try {
      await writeFile(path, original.replace(fault.needle, fault.replacement));
      const red = run();
      complete(red, 1);
      assert.match(red.stdout, /name: 'AssertionError'/);
      assert.ok((red.stdout + red.stderr).includes(fault.oracle), red.stdout + red.stderr);
    } finally {
      await writeFile(path, original);
    }
    complete(run(), 0);
    process.stdout.write(`Detected ${fault.name}; restored source passes the same oracle.\n`);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
