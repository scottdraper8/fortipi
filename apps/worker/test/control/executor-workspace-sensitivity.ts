import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const directory = await mkdtemp(join(tmpdir(), "fortipi-executor-http-fault-"));
const source = resolve("apps/worker/src/control/executor-workspace.ts");
const original = await readFile(source, "utf8");
const digest = (data: string) => createHash("sha256").update(data).digest("hex");
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
  const target = join(directory, "apps/worker/src/control/executor-workspace.ts");
  for (const fault of [
    {
      name: "configured assigned concurrency",
      find: "this.#active.size < limit",
      replacement: "true",
      occurrences: 1,
      pattern: "configured four assigned",
      oracle: "Fifth assigned blob stream must be refused while four are held",
    },
    {
      name: "cancel rejected awaited response",
      find: "await response.body?.cancel().catch(() => {});",
      replacement: "",
      occurrences: 1,
      pattern: "upload admission rechecks",
      oracle: "Rejected awaited blob headers must cancel the actual upstream reader",
    },
    {
      name: "explicit current epoch",
      find: "executor.epoch === query.connectionEpoch",
      replacement: "true",
      occurrences: 1,
      pattern: "closed selectors",
    },
    {
      name: "persist before uncertain upload allocation",
      find: "this.#save(current, old ?? { digest, body });",
      replacement: "",
      occurrences: 1,
      pattern: "streams exact base",
      oracle: "Persist-before-RPC upload association survives a lost accepted reply",
    },
    {
      name: "whole blob SHA",
      find: 'digest.digest("hex") === route.sha256',
      replacement: "true",
      occurrences: 2,
      pattern: "whole SHA, length",
      oracle: "Missing expected rejection: corrupt",
    },
  ]) {
    assert.equal(
      original.split(fault.find).length - 1,
      fault.occurrences,
      `Exact source fault: ${fault.name}`,
    );
    const run = () =>
      spawnSync(
        process.execPath,
        [
          "--test",
          "--test-reporter=tap",
          `--test-name-pattern=${fault.pattern}`,
          resolve("apps/worker/test/control/executor-workspace.test.ts"),
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
    await writeFile(target, original.replaceAll(fault.find, fault.replacement));
    const failed = run();
    assert.equal(failed.signal, null, `${fault.name}: bounded behavioral failure`);
    assert.equal(
      failed.status,
      1,
      `${fault.name} must fail its actual oracle\n${failed.stdout}\n${failed.stderr}`,
    );
    assert.match(failed.stdout, /AssertionError/);
    if (fault.oracle)
      assert.ok(
        (failed.stdout + failed.stderr).includes(fault.oracle),
        `${fault.name}: intended oracle\n${failed.stdout}`,
      );
    await writeFile(target, original);
    const restored = run();
    assert.equal(
      restored.status,
      0,
      `${fault.name} restored behavior\n${restored.stdout}\n${restored.stderr}`,
    );
    assert.equal(digest(await readFile(target, "utf8")), digest(original));
    process.stdout.write(`Actual fault rejected and exact source restored: ${fault.name}\n`);
  }
  assert.equal(
    digest(await readFile(source, "utf8")),
    digest(original),
    "Owned source remains unchanged",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
