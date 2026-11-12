import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  childEnvironment,
  execute,
  installCandidate,
  loadCandidate,
} from "../../scripts/prepare-release.ts";
import { inventory, regularBytes, sha256 } from "../../scripts/verify-release-gates.ts";
import { runtimeImports } from "./consumer-runtime.ts";
import { consumerTypes } from "./consumer-types.ts";

export async function install(path: string) {
  const loaded = await loadCandidate(path);
  const directory = await realpath(await mkdtemp(resolve(tmpdir(), "fortipi-evidence-installed-")));
  const home = resolve(directory, "home");
  await mkdir(home, { mode: 0o700 });
  const environment = childEnvironment({
    HOME: home,
    USERPROFILE: home,
    APPDATA: resolve(home, "roaming"),
    LOCALAPPDATA: resolve(home, "local"),
    XDG_CONFIG_HOME: resolve(home, "config"),
    XDG_CACHE_HOME: resolve(home, "cache"),
  });
  // Five independent fresh installs, then all five together. Owner9 supplies
  // the exact retained-scope registry, ordinary third-party SRI and copy-only,
  // protected install. Never duplicate/loosen that boundary here.
  for (const pkg of loaded.candidate.packages)
    await installCandidate(path, resolve(directory, pkg.sourceName), [pkg.sourceName]);
  const together = await installCandidate(path, resolve(directory, "together"), undefined, true);
  assert.equal(together.candidateSha256, loaded.hash);
  const ownedInventory = () =>
    Promise.all(
      loaded.candidate.packages.map((p) =>
        inventory(resolve(together.consumer, "node_modules", p.name)),
      ),
    );
  const modulesBefore = await ownedInventory();
  const ports = await runtimeImports(loaded.candidate, together.consumer);
  await writeFile(
    resolve(together.consumer, "consumer.ts"),
    consumerTypes(loaded.candidate.scope),
    { flag: "wx" },
  );
  const compiler = await execute(
    process.execPath,
    [
      resolve(together.consumer, "node_modules/typescript/bin/tsc"),
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
    together.consumer,
    environment,
    120000,
  );
  assert.ok(
    compiler.code === 0 && !compiler.timedOut,
    "Installed strict public declaration consumer failed",
  );
  const prepared = resolve(directory, "prepared");
  const preparation = await execute(
    process.execPath,
    [
      together.cliBin,
      "prepare",
      "--config",
      resolve(ports.cliRoot, "templates/operator-config.example.json"),
      "--directory",
      prepared,
      "--non-interactive",
      "--json",
    ],
    together.consumer,
    environment,
    120000,
  );
  assert.ok(
    preparation.code === 0 && !preparation.timedOut,
    "Installed candidate preparation failed",
  );
  const receipt = JSON.parse(preparation.stdout) as { assetManifestSha256: string };
  assert.equal(receipt.assetManifestSha256, loaded.candidate.assetManifestSha256);
  const dry = await execute(
    process.execPath,
    [
      together.cliBin,
      "deploy",
      "--directory",
      prepared,
      "--dry-run",
      "--non-interactive",
      "--json",
    ],
    together.consumer,
    environment,
    180000,
  );
  assert.ok(dry.code === 0 && !dry.timedOut, "Installed actual Wrangler dry-build failed");
  const dryResult = JSON.parse(dry.stdout) as {
    state: string;
    workerBytesVerified: boolean;
    assetManifestSha256: string;
  };
  assert.equal(dryResult.state, "dry-build-completed");
  assert.equal(dryResult.workerBytesVerified, true);
  assert.equal(dryResult.assetManifestSha256, loaded.candidate.assetManifestSha256);
  const verifyUnchanged = async () => {
    assert.deepEqual(
      await ownedInventory(),
      modulesBefore,
      "Evidence must preserve all read-only installed candidate bytes",
    );
    assert.equal((await loadCandidate(path)).hash, loaded.hash);
    for (const pkg of loaded.candidate.packages)
      for (const file of pkg.entries)
        assert.equal(
          sha256(
            await regularBytes(resolve(together.consumer, "node_modules", pkg.name, file.path)),
          ),
          file.sha256,
          "Installed candidate bytes changed during actual consumer execution",
        );
    const manifest = JSON.parse(
      await readFile(resolve(ports.cliRoot, "worker-assets/asset-manifest.json"), "utf8"),
    );
    assert.equal(manifest.sourceCommit, loaded.candidate.sourceCommit);
  };
  await verifyUnchanged();
  return {
    ...loaded,
    ...ports,
    ...together,
    directory,
    manifestPath: resolve(path),
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
}
export type Installed = Awaited<ReturnType<typeof install>>;
