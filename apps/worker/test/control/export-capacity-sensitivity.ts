import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const directory = await mkdtemp(join(tmpdir(), "fortipi-export-capacity-faults-"));
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
  for (const fault of [
    {
      before: "resources.workspaceIds.length !== 0 ||",
      after: "false ||",
      name: "export capacity rejects",
      oracle: "Export scope rejects workspace peer",
    },
    {
      before: "modelActions.has(authority.action) &&",
      after: "",
      name: "exact registered admin exports",
      oracle: "Export storage authority must never resolve a model",
    },
  ]) {
    const file = join(directory, "apps/worker/src/control/directory.ts");
    const original = await readFile(file, "utf8");
    assert.equal(original.split(fault.before).length, 2, "Fault anchor must occur exactly once");
    const run = () =>
      spawnSync(
        process.execPath,
        [
          "--test",
          `--test-name-pattern=${fault.name}`,
          resolve("apps/worker/test/control/export-capacity.test.ts"),
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
    await writeFile(file, original.replace(fault.before, fault.after));
    const failed = run();
    assert.equal(failed.status, 1, `${failed.stdout}\n${failed.stderr}`);
    assert.ok(
      (failed.stdout + failed.stderr).includes(fault.oracle),
      `${failed.stdout}\n${failed.stderr}`,
    );
    await writeFile(file, original);
    const restored = run();
    assert.equal(restored.status, 0, `${restored.stdout}\n${restored.stderr}`);
    process.stdout.write(`Compiled fault rejected; restoration passed: ${fault.oracle}\n`);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
