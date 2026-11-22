import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const directory = await mkdtemp(join(tmpdir(), "fortipi-budget-faults-"));
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
      file: "directory.ts",
      before: '      this.budget.allocate("agent", agent.agentId);',
      after: "",
      name: "allocation floors",
      oracle: "A refused allocation must roll back the directory row",
    },
    {
      file: "capacity.ts",
      before:
        /row &&\s+row\.allocationKey === key &&\s+row\.settlement\?\.disposition === "consumed" &&\s+row\.settledAt !== undefined &&\s+row\.settledAt <= input\.observedAt/,
      after: "row && row.allocationKey === key",
      name: "sample identities",
      oracle: "A live growth claim cannot be covered before its completed settlement",
    },
    {
      file: "storage-budget.ts",
      before:
        "sum(max(json_extract(value,'$.estimate'),json_extract(value,'$.measured')+json_extract(value,'$.pending')))",
      after:
        "sum(CASE WHEN json_extract(value,'$.observedAt')<unixepoch()*1000-30000 THEN json_extract(value,'$.estimate') ELSE max(json_extract(value,'$.estimate'),json_extract(value,'$.measured')+json_extract(value,'$.pending')) END)",
      name: "sample identities",
      oracle: "Expired observation retains overrun as an estimate",
    },
    {
      file: "admin.ts",
      before: "      this.admitGrowth(bytes.length);",
      after: "",
      name: "actual physical overrun",
      test: "storage-budget-admin.test.ts",
      oracle: "An admitted copy must recheck the allocation ledger before writing each new chunk",
    },
    {
      file: "storage-budget.ts",
      before: "const chunk = await read();",
      after: "const chunk = await reader.read();",
      name: "sample body reader",
      oracle:
        "Stalled sample body must finish at abort/deadline, not when its producer eventually closes",
    },
    {
      file: "control-plane.ts",
      before: "if (storageSample) {\n        this.capacity.admitRequest(auth.principalId);",
      after: "if (storageSample) {\n        this.capacity.admitRepair();",
      name: "freshness samples",
      oracle: "Freshness sampling cannot exhaust retained completion's repair allowance",
    },
  ]) {
    const path = join(directory, "apps/worker/src/control", fault.file);
    const original = await readFile(path, "utf8");
    if (typeof fault.before === "string") assert.ok(original.includes(fault.before));
    else assert.match(original, fault.before);
    const run = () =>
      spawnSync(
        process.execPath,
        [
          "--test",
          `--test-name-pattern=${fault.name}`,
          resolve("apps/worker/test/control", fault.test ?? "storage-budget.test.ts"),
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
    await writeFile(path, original.replace(fault.before, fault.after));
    const failed = run();
    assert.equal(failed.status, 1, `${failed.stdout}\n${failed.stderr}`);
    assert.ok(
      (failed.stdout + failed.stderr).includes(fault.oracle),
      `${failed.stdout}\n${failed.stderr}`,
    );
    await writeFile(path, original);
    const restored = run();
    assert.equal(restored.status, 0, `${restored.stdout}\n${restored.stderr}`);
    process.stdout.write(`Actual compiled fault failed and restoration passed: ${fault.oracle}\n`);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
