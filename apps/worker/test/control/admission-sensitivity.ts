import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const directory = await mkdtemp(join(tmpdir(), "fortipi-admission-mutants-"));
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
      file: "control-plane.ts",
      pattern: /case "listAgents":\s*return this\.listAgentsValue\(ctx, request\);/,
      replacement:
        'case "listAgents": { const nested = await this.listAgents(ctx, request); check(nested.ok, "rate_limited", "Nested admission failed"); return nested.value; }',
      testPattern: "one physical nested-route",
      oracle:
        "one actual handleApi invocation must use the last slot without a second internal-method charge",
    },
    {
      file: "capacity.ts",
      pattern:
        /completion = row\.workspaceId !== undefined \|\| row\.agentAuthority !== undefined;/,
      replacement: "completion = false;",
      testPattern: "registered completion survives",
      oracle: "registered completion must use retained headroom after application exhaustion",
    },
    {
      file: "capacity.ts",
      pattern: /expectedOwner !== ownerId \|\| /,
      replacement: "",
      testPattern: "ordinary registered Agent",
      oracle: "registration cannot select another owner",
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
          resolve("apps/worker/test/control/admission.test.ts"),
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
