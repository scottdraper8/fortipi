import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const directory = await mkdtemp(join(tmpdir(), "fortipi-epoch-mutants-"));
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
      file: "delivery.ts",
      pattern: /input\.connectionEpoch === undefined \? target\.epoch : input\.connectionEpoch/,
      replacement: "input.connectionEpoch || target.epoch",
      testPattern: "dispatch-only outbound omission",
      oracle: "provided noncurrent or malformed epoch cannot be treated as omitted",
    },
    {
      file: "delivery.ts",
      pattern: /executor\.epoch === connectionEpoch/,
      replacement: "executor.epoch === (input.connectionEpoch ?? executor.epoch)",
      testPattern: "reconnect during actual hash",
      oracle: "reconnect after capture must reject before command persistence",
    },
    {
      file: "delivery.ts",
      pattern: /executor\.epoch !== command\.delivery\.connectionEpoch/,
      replacement: "false",
      testPattern: "reconnect during actual hash",
      oracle: "deferred command must never be sent on a replacement epoch",
    },
    {
      file: "delivery.ts",
      pattern: /const e = this\.store\.get<ExecutorState>\("executor", input\.executorId\);/,
      replacement: "$& input = { ...input, connectionEpoch: input.connectionEpoch ?? e?.epoch };",
      testPattern: "dispatch-only outbound omission",
      oracle: "executor ingress still requires an explicit current epoch",
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
          resolve("apps/worker/test/control/delivery-epoch.test.ts"),
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
