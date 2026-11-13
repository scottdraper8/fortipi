import assert from "node:assert/strict";
import { lstat, realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { runtimeImports } from "../tests/distribution/consumer-runtime.ts";
import { type Installed, install } from "../tests/distribution/install.ts";
import { repository } from "./build-workspaces.ts";
import { assertTarget, type TargetDescriptor } from "./deploy-smoke.ts";
import {
  childEnvironment,
  execute,
  loadWorkflowCandidate,
  resolveCandidateReadContext,
} from "./prepare-release.ts";
import {
  canonicalJson,
  object,
  readJson,
  regularBytes,
  saveJson,
  sha256,
  string,
} from "./verify-release-gates.ts";

/** Separate credential-free Actions step. Nothing here reads deployment or
 * application credentials. Each host installs from its own exact candidate. */
export async function installLiveDeviceCandidate(input: {
  candidatePath: string;
  targetPath: string;
  out: string;
}): Promise<void> {
  const target = await readJson(input.targetPath);
  assertTarget(target);
  const installed = await install(
    input.candidatePath,
    await resolveCandidateReadContext(input.candidatePath),
  );
  const operator = resolve(installed.directory, "operator.json");
  const prepared = resolve(installed.directory, "target-prepared");
  await saveJson(operator, target.operator);
  const result = await execute(
    process.execPath,
    [
      installed.cliBin,
      "prepare",
      "--config",
      operator,
      "--directory",
      prepared,
      "--non-interactive",
      "--json",
    ],
    installed.consumer,
    childEnvironment(),
    120000,
  );
  assert.ok(result.code === 0 && !result.timedOut, "Installed target preparation failed");
  const receipt = object(JSON.parse(result.stdout));
  assert.equal(receipt.assetManifestSha256, installed.candidate.assetManifestSha256);
  await installed.verifyUnchanged();
  await saveJson(input.out, {
    schemaVersion: 1,
    candidatePath: resolve(input.candidatePath),
    candidateSha256: installed.hash,
    cliBin: installed.cliBin,
    directory: installed.directory,
    consumer: installed.consumer,
    prepared,
    target,
  });
}

/** Re-open only this host's earlier private install. No path or installation
 * descriptor is transferred between jobs. Recheck installed bytes BEFORE
 * importing the modules and BEFORE the caller accesses any role/provider key. */
export async function loadLiveDeviceInstallation(path: string): Promise<{
  installed: Installed;
  target: TargetDescriptor;
  candidatePath: string;
}> {
  const bytes = await regularBytes(path, 65536);
  const value = object(JSON.parse(bytes.toString("utf8")));
  assert.equal(bytes.toString("utf8"), `${canonicalJson(value)}\n`);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(value).sort(), [
    "candidatePath",
    "candidateSha256",
    "cliBin",
    "consumer",
    "directory",
    "prepared",
    "schemaVersion",
    "target",
  ]);
  assert.equal(value.schemaVersion, 1);
  const candidatePath = string(value.candidatePath);
  assert.equal(resolve(candidatePath), candidatePath);
  const loaded = await loadWorkflowCandidate(candidatePath);
  assert.equal(loaded.hash, value.candidateSha256);
  const target = value.target;
  assertTarget(target);
  const directory = string(value.directory),
    consumer = string(value.consumer),
    prepared = string(value.prepared);
  for (const root of [directory, consumer, prepared]) {
    assert.equal(await realpath(root), root);
    assert.ok(root !== repository && !root.startsWith(`${repository}${sep}`));
    const stat = await lstat(root);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    assert.equal(stat.uid, process.getuid?.() ?? stat.uid);
  }
  assert.ok(consumer.startsWith(`${directory}${sep}`) && prepared.startsWith(`${directory}${sep}`));
  const verifyUnchanged = async () => {
    for (const pkg of loaded.candidate.packages) {
      const root = resolve(consumer, "node_modules", pkg.name);
      assert.equal(await realpath(root), root);
      assert.ok(root.startsWith(`${consumer}${sep}node_modules${sep}`));
      for (let parent = root; parent !== consumer; parent = dirname(parent)) {
        const stat = await lstat(parent);
        assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
        assert.equal(stat.mode & 0o222, 0);
      }
      for (const file of pkg.entries) {
        const entry = resolve(root, file.path);
        assert.ok(entry.startsWith(`${root}${sep}`));
        const stat = await lstat(entry);
        assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
        assert.equal(stat.mode & 0o222, 0);
        assert.equal(Boolean(stat.mode & 0o111), Boolean(file.mode & 0o111));
        assert.equal(stat.size, file.size);
        assert.equal(sha256(await regularBytes(entry, file.size)), file.sha256);
      }
    }
  };
  await verifyUnchanged();
  const ports = await runtimeImports(loaded.candidate, consumer);
  assert.equal(string(value.cliBin), resolve(ports.cliRoot, "dist/bin.js"));
  const installed: Installed = {
    ...loaded,
    ...ports,
    directory,
    consumer,
    cliBin: resolve(ports.cliRoot, "dist/bin.js"),
    candidateSha256: loaded.hash,
    manifestPath: candidatePath,
    prepared,
    verifyUnchanged,
    observation: {
      independentInstalls: 5,
      combinedInstall: true,
      outsideCheckout: true,
      strictDeclarations: true,
      publicExports: ports.exports.length,
      prepared: true,
      genuineDryBuild: true,
    },
  };
  return { installed, target, candidatePath };
}
