import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const directory = await mkdtemp(join(tmpdir(), "fortipi-control-mutants-"));
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
      pattern: /used:\s*true/,
      replacement: "used: false",
      test: "tickets.test.ts",
      oracle: "one ticket admits exactly one identity",
    },
    {
      file: "revocation.ts",
      pattern: /rev\.complete\s*=\s*rev\.enumerated\s*&&\s*rev\.pending\s*===\s*0/,
      replacement: "rev.complete = rev.enumerated",
      test: "revocation.test.ts",
      oracle: "revocation stays pending until every persisted floor ack",
    },
    {
      file: "revocation.ts",
      pattern: /if\s*\(!this\.store\.get<Fanout>\("fanout", key\)\)\s*return;/,
      replacement: "",
      test: "revocation.test.ts",
      oracle: "concurrent repair cannot consume a floor acknowledgment twice",
    },
  ]) {
    const path = join(directory, "apps/worker/src/control", mutation.file);
    const original = await readFile(path, "utf8");
    assert.match(original, mutation.pattern);
    await writeFile(path, original.replace(mutation.pattern, mutation.replacement));
    const run = () =>
      spawnSync(process.execPath, ["--test", resolve("apps/worker/test/control", mutation.test)], {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 30000,
        env: {
          PATH: process.env.PATH ?? "",
          FORTIPI_CONTROL_TEST_SOURCE: directory,
          WRANGLER_SEND_METRICS: "false",
        },
      });
    const result = run();
    assert.equal(
      result.status,
      1,
      `Mutant must fail behavior: ${mutation.file}\n${result.stdout}\n${result.stderr}`,
    );
    assert.match(result.stdout + result.stderr, new RegExp(mutation.oracle));
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
