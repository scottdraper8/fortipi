import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const directory = await mkdtemp(join(tmpdir(), "fortipi-artifact-mutants-"));
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
      file: "artifact-index.ts",
      pattern: /artifactEndpointMatches\(\s*reference,\s*(`[^`]+`),?\s*\)/,
      replacement: "reference.endpoint === $1",
      test: "native-artifacts.test.ts",
      testPattern: "native artifact index is atomic",
      oracle: "artifact endpoint must accept its single matching original revision query",
    },
    {
      file: "relay.ts",
      pattern: /if \(producer\)(\s+check\()/,
      replacement: 'if (producer || request.method === "GET")$1',
      test: "local-write.test.ts",
      oracle: "canonical executor input GET requires only attemptId",
    },
    {
      file: "delivery.ts",
      pattern:
        /if \(identity\.target\.generation === input\.generation\)\s*indexArtifacts\(this\.store, this\.directory, frame\.payload\);/,
      replacement: "indexArtifacts(this.store, this.directory, frame.payload);",
      test: "native-artifacts.test.ts",
      testPattern: "current publisher retains historical-generation",
      oracle:
        "current publisher must retain bounded historical-generation evidence without public indexing",
    },
    {
      file: "artifacts.ts",
      pattern: /grant\.expiresAt \?\? Number\.MAX_SAFE_INTEGER,/,
      replacement:
        "...ctx.grants.filter(g => g.expiresAt !== undefined && contains(g.resources, artifactScope(row))).map(g => g.expiresAt ?? Number.MAX_SAFE_INTEGER),",
      test: "native-artifacts.test.ts",
      testPattern: "native artifact index is atomic",
      oracle: "an expired redundant grant cannot disable another current artifact-read grant",
    },
    {
      file: "relay.ts",
      pattern: /check\(\s*this\.producerWaiters\.size < 16,/,
      replacement:
        "if(d.size===0){this.executors.send(d.executorId,d.executorGeneration,frame);return;} check(this.producerWaiters.size < 16,",
      test: "native-artifacts.test.ts",
      oracle: "zero-byte output remains waiting without the producer's actual proof",
    },
    {
      file: "artifact-index.ts",
      pattern:
        /check\(!old \|\| same\(old, row\), "conflict", "Artifact identity or metadata changed"\);/,
      replacement: "",
      test: "native-artifacts.test.ts",
      oracle: "artifact IDs cannot be reused by a different job",
    },
    {
      file: "delivery.ts",
      pattern: /\) && same\(proof, frame\.payload\),/,
      replacement: "),",
      test: "terminal-proof.test.ts",
      oracle:
        "CP must compare exact authoritative reply coordinates before acknowledging terminal delivery",
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
          ...("testPattern" in mutation ? [`--test-name-pattern=${mutation.testPattern}`] : []),
          resolve("apps/worker/test/control", mutation.test),
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: 35000,
          env: {
            PATH: process.env.PATH ?? "",
            FORTIPI_CONTROL_TEST_SOURCE: directory,
            WRANGLER_SEND_METRICS: "false",
          },
        },
      );
    const failed = run();
    assert.equal(failed.status, 1, `Mutant must fail behavior: ${failed.stdout}\n${failed.stderr}`);
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
