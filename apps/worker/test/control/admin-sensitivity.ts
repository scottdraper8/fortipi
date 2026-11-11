import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

// Only maintained source/fixture copies; dependencies resolve through explicit build aliases.
const directory = await mkdtemp(join(tmpdir(), "fortipi-admin-fault-")),
  source = resolve("apps/worker/src/control/admin.ts"),
  original = await readFile(source, "utf8"),
  digest = (text: string) => createHash("sha256").update(text).digest("hex");
try {
  await mkdir(join(directory, "apps/worker/src"), { recursive: true });
  await mkdir(join(directory, "apps/worker/test/control/fixtures"), { recursive: true });
  await cp("apps/worker/src/control", join(directory, "apps/worker/src/control"), {
    recursive: true,
  });
  await cp(
    "apps/worker/test/control/fixtures/admin.ts",
    join(directory, "apps/worker/test/control/fixtures/admin.ts"),
  );
  for (const fault of [
    {
      name: "whole SHA",
      find: "size === expectedSize && sha256 === expectedSha256",
      replace: "size === expectedSize",
      test: "actual whole-SHA",
    },
    {
      name: "remaining install bound",
      find: "totals.reserved + totals.consumed + physical + growth",
      replace: "physical + growth",
      test: "near-full reserved install",
    },
    {
      name: "current authority after await",
      find: "this.#authorize(ctx, job.action, job.resources);",
      replace: "",
      test: "current revocation after a delayed peer",
    },
    {
      name: "structured receiver quota details",
      file: "admin.ts",
      testFile: "admin-quota.test.ts",
      find: 'throw new ControlError(result.code, "Admin source unavailable", result.details)',
      replace: 'throw new ControlError(result.code, "Admin source unavailable")',
      test: "admin copy retains known receiver",
      oracle: "admin copy must retain receiver quota timing instead of a short retry",
    },
    {
      name: "held copy expiry wake",
      file: "control-plane.ts",
      testFile: "admin-quota.test.ts",
      find: 'else if (task.kind === "admin_request") this.#admin.expire(task.key);',
      replace: 'else if (task.kind === "admin_request") {}',
      test: "held admin copy expiry",
      oracle: "cleanup wake must retire a held copy when its retained lifetime expires",
    },
    {
      name: "bounded peer error body",
      file: "admin.ts",
      testFile: "admin-quota.test.ts",
      find: "size <= 65536",
      replace: "true",
      test: "oversized peer error bytes",
      oracle: "oversized admin error must not establish receiver authority or a hold",
    },
  ]) {
    const path = join(directory, "apps/worker/src/control", fault.file ?? "admin.ts");
    const restoredSource = await readFile(path, "utf8");
    assert.equal(
      restoredSource.split(fault.find).length,
      2,
      `Exact unique source fault: ${fault.name}`,
    );
    await writeFile(path, restoredSource.replace(fault.find, fault.replace));
    const run = () =>
      spawnSync(
        process.execPath,
        [
          "--test",
          `--test-name-pattern=${fault.test}`,
          resolve("apps/worker/test/control", fault.testFile ?? "admin.test.ts"),
        ],
        {
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
    assert.equal(
      failed.status,
      1,
      `${fault.name} must fail its actual behavioral oracle\n${failed.stdout}\n${failed.stderr}`,
    );
    assert.match(failed.stdout, /AssertionError/);
    if (fault.oracle)
      assert.ok(
        (failed.stdout + failed.stderr).includes(fault.oracle),
        `Named source-fault oracle: ${fault.name}`,
      );
    assert.equal(failed.signal, null);
    await writeFile(path, restoredSource);
    const restored = run();
    assert.equal(
      restored.status,
      0,
      `${fault.name} restored behavior\n${restored.stdout}\n${restored.stderr}`,
    );
    assert.equal(digest(await readFile(path, "utf8")), digest(restoredSource));
    process.stdout.write(`Actual fault rejected and exact source restored: ${fault.name}\n`);
  }
  assert.equal(
    digest(await readFile(source, "utf8")),
    digest(original),
    "Owned source never mutated by fault run",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
