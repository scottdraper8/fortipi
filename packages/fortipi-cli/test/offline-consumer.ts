// Copy into the installed consumer. Must run under a DIFFERENT dedicated Linux OS identity.
// No application module loads, home inspection or Wrangler invocation before eligibility checks.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdtemp,
  open,
  readdir,
  readlink,
  realpath,
  writeFile,
} from "node:fs/promises";
import { homedir, networkInterfaces, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export interface DistributionReceipt {
  schemaVersion: 1;
  componentOnly: true;
  publishable: false;
  scope: "fortipi-ci-test";
  packageName: "@fortipi-ci-test/fortipi-cli";
  consumer: string;
  checkout: string;
  checkoutUid: number;
  sourceCommit: string;
  assetManifestSha256: string;
  publicReviewedArchives: number;
  strictInstalledConsumer: true;
  readOnlyInstall: true;
  installedPrepare: true;
  parentNetworkNamespace: string;
  offlineDryBuild: string;
}

/** Shared by trusted setup and the copied consumer; no application import/home lookup. */
export async function readDistributionReceipt(path: string): Promise<DistributionReceipt> {
  const stat = await lstat(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
  assert.ok(stat.size > 0 && stat.size <= 65536, "Distribution receipt exceeds bound");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let receipt: DistributionReceipt;
  try {
    const actual = await handle.stat();
    assert.equal(actual.dev, stat.dev);
    assert.equal(actual.ino, stat.ino);
    const bytes = Buffer.alloc(65537);
    let size = 0;
    while (size < bytes.length) {
      const next = await handle.read(bytes, size, bytes.length - size, null);
      if (next.bytesRead === 0) break;
      size += next.bytesRead;
    }
    assert.ok(size > 0 && size <= 65536, "Distribution receipt exceeds bound");
    receipt = JSON.parse(bytes.subarray(0, size).toString("utf8"));
  } finally {
    await handle.close();
  }
  assert.ok(receipt && typeof receipt === "object" && !Array.isArray(receipt));
  assert.deepEqual(
    Object.keys(receipt).sort(),
    [
      "schemaVersion",
      "componentOnly",
      "publishable",
      "scope",
      "packageName",
      "consumer",
      "checkout",
      "checkoutUid",
      "sourceCommit",
      "assetManifestSha256",
      "publicReviewedArchives",
      "strictInstalledConsumer",
      "readOnlyInstall",
      "installedPrepare",
      "parentNetworkNamespace",
      "offlineDryBuild",
    ].sort(),
  );
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.componentOnly, true);
  assert.equal(receipt.publishable, false);
  assert.equal(receipt.scope, "fortipi-ci-test");
  assert.equal(receipt.packageName, "@fortipi-ci-test/fortipi-cli");
  for (const key of ["consumer", "checkout"] as const) {
    assert.equal(typeof receipt[key], "string");
    assert.ok(receipt[key].length <= 4096 && resolve(receipt[key]) === receipt[key]);
  }
  assert.ok(Number.isSafeInteger(receipt.checkoutUid) && receipt.checkoutUid >= 0);
  assert.match(receipt.sourceCommit, /^[a-f0-9]{40}$/);
  assert.match(receipt.assetManifestSha256, /^[a-f0-9]{64}$/);
  assert.ok(
    Number.isSafeInteger(receipt.publicReviewedArchives) && receipt.publicReviewedArchives > 0,
  );
  for (const key of ["strictInstalledConsumer", "readOnlyInstall", "installedPrepare"] as const)
    assert.equal(receipt[key], true);
  assert.match(receipt.parentNetworkNamespace, /^net:\[[0-9]+\]$/);
  assert.equal(
    receipt.offlineDryBuild,
    "not-executed; dedicated Linux identity/network namespace required",
  );
  return receipt;
}

export async function offlineConsumer(receiptPath: string): Promise<void> {
  assert.equal(
    process.platform,
    "linux",
    "Genuine offline consumer requires a disposable Linux identity",
  );
  const receipt = await readDistributionReceipt(receiptPath);
  const uid = process.getuid?.();
  assert.ok(
    uid !== undefined && uid !== 0 && uid !== receipt.checkoutUid,
    "Dedicated OS identity required before inspecting any home",
  );
  let checkoutAccessible = false;
  try {
    await access(receipt.checkout, constants.R_OK | constants.X_OK);
    checkoutAccessible = true;
  } catch (error) {
    assert.ok(["ENOENT", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? ""));
  }
  assert.equal(checkoutAccessible, false, "Checkout must be absent or inaccessible");
  assert.ok(
    typeof receipt.parentNetworkNamespace === "string",
    "Install stage must run on qualified Linux",
  );
  assert.notEqual(
    await readlink("/proc/self/ns/net"),
    receipt.parentNetworkNamespace,
    "A separate offline network namespace is required",
  );
  assert.ok(
    Object.values(networkInterfaces())
      .flat()
      .every((item) => item?.internal),
    "Offline namespace must have no external network interface",
  );
  // UID differs from checkout owner and the checkout cannot be read: this is the dedicated home only.
  const home = homedir();
  assert.equal((await lstat(home)).uid, uid);
  assert.deepEqual(await readdir(home), [], "Dedicated OS home must be genuinely empty");
  const consumer = await realpath(receipt.consumer);
  const cli = dirname(dirname(fileURLToPath(import.meta.resolve(receipt.packageName))));
  assert.ok(cli.startsWith(`${consumer}/node_modules/`));
  const modules = join(consumer, "node_modules");
  const readOnly = async (path: string): Promise<void> => {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      assert.ok((await realpath(path)).startsWith(`${modules}/`));
      return;
    }
    assert.equal(stat.mode & 0o222, 0, "Installed bytes must be read-only");
    if (stat.isDirectory())
      for (const name of await readdir(path)) await readOnly(join(path, name));
  };
  await readOnly(modules);
  const scratch = await mkdtemp(join(await realpath(tmpdir()), "fortipi-offline-installed-"));
  const prepared = join(scratch, "prepared");
  const env = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    LANG: "C",
    WRANGLER_SEND_METRICS: "false",
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
  };
  const execute = promisify(execFile);
  const command = async (args: string[]) =>
    JSON.parse(
      (
        await execute(process.execPath, [join(cli, "dist/bin.js"), ...args], {
          cwd: consumer,
          env,
          timeout: 120000,
          maxBuffer: 1024 * 1024,
        })
      ).stdout,
    );
  const first = await command([
    "prepare",
    "--config",
    join(cli, "templates/operator-config.example.json"),
    "--directory",
    prepared,
    "--non-interactive",
    "--json",
  ]);
  assert.equal(first.assetManifestSha256, receipt.assetManifestSha256);
  const result = await command([
    "deploy",
    "--directory",
    prepared,
    "--dry-run",
    "--non-interactive",
    "--json",
  ]);
  assert.equal(result.state, "dry-build-completed");
  assert.equal(result.assetManifestSha256, receipt.assetManifestSha256);
  assert.equal(result.workerBytesVerified, true);
  const proof = {
    passed: true,
    emptyOsHomeInitially: true,
    dedicatedIdentity: true,
    checkoutInaccessible: true,
    networkNamespaceIsolated: true,
    readOnlyInstall: true,
    actualPinnedWranglerDryBuild: true,
    sourceCommit: receipt.sourceCommit,
    assetManifestSha256: receipt.assetManifestSha256,
  };
  await writeFile(join(scratch, "offline-proof.json"), `${JSON.stringify(proof, null, 2)}\n`, {
    flag: "wx",
  });
  console.log(JSON.stringify(proof));
}
if (import.meta.main) {
  const receipt = process.argv[2];
  assert.ok(receipt);
  await offlineConsumer(resolve(receipt));
}
