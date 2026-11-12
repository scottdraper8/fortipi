import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  childEnvironment,
  execute,
  installCandidate,
  loadCandidate,
  runEvidence,
} from "../../prepare-release.ts";
import { actualCapsule, discard, temporary } from "./fixtures.ts";

test("actual five retained scoped archives install outside checkout and resolve strict types, JS and installed prepare/dry-build", {
  timeout: 600000,
}, async () => {
  const root = await temporary("fortipi-scoped-install-");
  try {
    const path = await actualCapsule(resolve(root, "candidate"));
    const before = await loadCandidate(path);
    const installed = await installCandidate(path, resolve(root, "installation"), undefined, true);
    const consumer = installed.consumer;
    const prefix = "@fortipi-ci-test/fortipi-";
    await writeFile(
      resolve(consumer, "consumer.ts"),
      `import type { Protocol } from "${prefix}contract";
import { FortiPiClient } from "${prefix}client";
import { FortiPiClient as NodeClient } from "${prefix}client/node";
import { Controller } from "${prefix}tui";
import { ExecutorRuntime } from "${prefix}executor";
import { runCommand } from "${prefix}cli";
const api: [typeof FortiPiClient, typeof NodeClient, typeof Controller, typeof ExecutorRuntime, typeof runCommand] = [FortiPiClient, NodeClient, Controller, ExecutorRuntime, runCommand];
export type Public = Protocol; void api;
`,
    );
    const strict = await execute(
      process.execPath,
      [
        resolve(consumer, "node_modules/typescript/bin/tsc"),
        "--ignoreConfig",
        "--strict",
        "--skipLibCheck",
        "false",
        "--types",
        "node",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--target",
        "ES2024",
        "--lib",
        "ES2024,DOM,DOM.Iterable",
        "--noEmit",
        "consumer.ts",
      ],
      consumer,
      childEnvironment(),
      120000,
    );
    assert.equal(strict.code, 0, strict.stdout);
    const imports = await execute(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `for (const name of ${JSON.stringify(before.candidate.packages.map((p) => p.name))}) { const m=await import(name); if(Object.keys(m).length===0)throw Error('Empty real module'); } console.log('actual-scoped-imports');`,
      ],
      consumer,
      childEnvironment(),
      30000,
    );
    assert.equal(imports.code, 0);
    assert.equal(imports.stdout.trim(), "actual-scoped-imports");
    const cliRoot = resolve(consumer, "node_modules", `${prefix}cli`);
    const prepared = resolve(root, "prepared");
    const preparation = await execute(
      process.execPath,
      [
        installed.cliBin,
        "prepare",
        "--config",
        resolve(cliRoot, "templates/operator-config.example.json"),
        "--directory",
        prepared,
        "--non-interactive",
        "--json",
      ],
      consumer,
      childEnvironment(),
      120000,
    );
    assert.equal(preparation.code, 0);
    const receipt = JSON.parse(preparation.stdout);
    assert.equal(receipt.assetManifestSha256, before.candidate.assetManifestSha256);
    const dry = await execute(
      process.execPath,
      [
        installed.cliBin,
        "deploy",
        "--directory",
        prepared,
        "--dry-run",
        "--non-interactive",
        "--json",
      ],
      consumer,
      childEnvironment(),
      180000,
    );
    assert.equal(dry.code, 0);
    const result = JSON.parse(dry.stdout);
    assert.equal(result.state, "dry-build-completed");
    assert.equal(result.workerBytesVerified, true);
    assert.equal(result.assetManifestSha256, before.candidate.assetManifestSha256);
    assert.equal(
      (await loadCandidate(path)).hash,
      before.hash,
      "Consumer checks must not change retained bytes",
    );
    await assert.rejects(
      runEvidence(
        "local",
        path,
        resolve(root, "missing-fixture.json"),
        resolve(root, "not-evidence"),
      ),
      /ENOENT|fixture/,
    );
  } finally {
    await discard(root);
  }
});
