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
import { REPOSITORY, REPOSITORY_ID } from "../../verify-release-gates.ts";
import { actualCapsule, discard, fixtureEnvironment, httpFixture, temporary } from "./fixtures.ts";

test("actual five retained scoped archives install outside checkout and resolve strict types, JS and installed prepare/dry-build", {
  timeout: 600000,
}, async (t) => {
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
    // Reach the descriptor gate with a controlled Actions producer, even when CI hosts this test.
    fixtureEnvironment(t, {
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: REPOSITORY,
      GITHUB_REPOSITORY_ID: String(REPOSITORY_ID),
      GITHUB_SHA: before.candidate.sourceCommit,
      GITHUB_REF: "refs/heads/main",
      GITHUB_RUN_ID: "10",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/ci.yml@refs/heads/main`,
      GITHUB_EVENT_NAME: "push",
      GITHUB_JOB: "policy-and-integration",
    });
    const server = await httpFixture((request, response) => {
      assert.equal(request.method, "GET");
      assert.equal(request.headers.authorization, undefined);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: 1, path: ".github/workflows/ci.yml", state: "active" }));
    });
    const nativeFetch = globalThis.fetch;
    const fetchMetadata: typeof fetch = (input, options) => {
      assert.equal(
        String(input),
        `https://api.github.com/repos/${REPOSITORY}/actions/workflows/ci.yml`,
      );
      return nativeFetch(server.origin, options);
    };
    const metadata = t.mock.method(globalThis, "fetch", fetchMetadata);
    try {
      await assert.rejects(
        runEvidence(
          "local",
          path,
          resolve(root, "missing-fixture.json"),
          resolve(root, "not-evidence"),
        ),
        /Evidence fixture must be a trusted source descriptor/,
      );
      assert.equal(metadata.mock.callCount(), 1);
    } finally {
      metadata.mock.restore();
      await server.close();
    }
  } finally {
    await discard(root);
  }
});
