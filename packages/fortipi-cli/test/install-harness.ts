// Component proof only: the release stager/installer own archive and registry authority.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, lstat, readFile, readlink, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import type { Lock } from "../../../scripts/check-pins.ts";
import {
  childEnvironment,
  installCandidate,
  loadCandidate,
} from "../../../scripts/prepare-release.ts";
import { actualCapsule } from "../../../scripts/test/release/fixtures.ts";
import { SYNTHETIC_SCOPE } from "../../../scripts/verify-release-gates.ts";
import { verifyAssets } from "../dist/assets.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const execute = promisify(execFile);

export async function installConsumer(directory: string): Promise<Record<string, unknown>> {
  // Never run installed prepare/Wrangler on an ineligible local host.
  assert.equal(process.platform, "linux", "Installed CLI proof requires actual Linux");
  assert.ok(isAbsolute(directory));
  assert.equal(process.versions.node, "26.13.1");
  const assets = await verifyAssets();
  // actualCapsule calls stageAndPack for all five bundles. Keep it in THIS process:
  // serialized candidate entries cannot recreate the stager's private authority.
  const path = await actualCapsule(
    join(dirname(directory), `${basename(directory)}-source-component`),
  );
  const { candidate } = await loadCandidate(path);
  assert.equal(candidate.publishable, false);
  assert.equal(candidate.scope, SYNTHETIC_SCOPE);
  const cli = candidate.packages.find((pkg) => pkg.sourceName === "fortipi-cli");
  assert.ok(cli);
  const packageName = `@${SYNTHETIC_SCOPE}/fortipi-cli`;
  assert.equal(cli.name, packageName);
  const installed = await installCandidate(path, directory, undefined, true);
  const consumer = installed.consumer;
  const installedRoot = dirname(dirname(installed.cliBin));
  assert.ok(
    (await realpath(installedRoot)).startsWith(`${join(consumer, "node_modules")}${sep}`),
    "Workspace CLI resolution is forbidden",
  );
  const installedAssets = await verifyAssets(join(installedRoot, "worker-assets"));
  assert.equal(installedAssets.manifestSha256, assets.manifestSha256);
  const env = childEnvironment({ CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" });
  const source = await readFile(join(root, "packages/fortipi-cli/test/public-api.ts"), "utf8");
  await writeFile(
    join(consumer, "public-api.ts"),
    source.replaceAll('"fortipi-cli"', JSON.stringify(packageName)),
    { flag: "wx" },
  );
  await execute(
    process.execPath,
    [
      join(consumer, "node_modules/typescript/bin/tsc"),
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
      "public-api.ts",
    ],
    { cwd: consumer, env, timeout: 120000, maxBuffer: 1024 * 1024 },
  );
  // The common installer has checked every retained member and protected modules read-only.
  const output = await execute(
    process.execPath,
    [
      installed.cliBin,
      "prepare",
      "--config",
      join(installedRoot, "templates/operator-config.example.json"),
      "--directory",
      join(directory, "local-prepared"),
      "--non-interactive",
      "--json",
    ],
    { cwd: consumer, env, timeout: 120000, maxBuffer: 1024 * 1024 },
  );
  assert.equal(JSON.parse(output.stdout).assetManifestSha256, assets.manifestSha256);
  await copyFile(
    join(root, "packages/fortipi-cli/test/offline-consumer.ts"),
    join(consumer, "offline-consumer.ts"),
  );
  // The ordinary consumer has no packageManager field: its pnpm lock has one
  // application document. The repository's two-document manager policy is a
  // separate source-install invariant.
  const lock = parseYaml(await readFile(join(consumer, "pnpm-lock.yaml"), "utf8")) as Lock;
  const names = new Set(candidate.packages.map((pkg) => `${pkg.name}@${pkg.version}`));
  const result = {
    schemaVersion: 1,
    componentOnly: true,
    publishable: false,
    scope: SYNTHETIC_SCOPE,
    packageName,
    consumer,
    checkout: root,
    checkoutUid: (await lstat(root)).uid,
    sourceCommit: assets.manifest.sourceCommit,
    assetManifestSha256: assets.manifestSha256,
    publicReviewedArchives: Object.keys(lock.packages).filter((id) => !names.has(id)).length,
    strictInstalledConsumer: true,
    readOnlyInstall: true,
    installedPrepare: true,
    parentNetworkNamespace: await readlink("/proc/self/ns/net"),
    offlineDryBuild: "not-executed; dedicated Linux identity/network namespace required",
  };
  await writeFile(join(directory, "distribution.json"), `${JSON.stringify(result, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return result;
}

if (import.meta.main) {
  const directory = process.argv[2];
  assert.ok(
    directory && isAbsolute(directory),
    "Explicit fresh absolute distribution directory required",
  );
  console.log(JSON.stringify(await installConsumer(directory)));
}
