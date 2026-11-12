// Copy into the installed consumer. Must run under a DIFFERENT dedicated Linux OS identity.
// No application module loads, home inspection or Wrangler invocation before eligibility checks.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  writeFile,
} from "node:fs/promises";
import { homedir, networkInterfaces, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export async function offlineConsumer(receiptPath: string): Promise<void> {
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(
    process.platform,
    "linux",
    "Genuine offline consumer requires a disposable Linux identity",
  );
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
  const cli = dirname(dirname(fileURLToPath(import.meta.resolve("fortipi-cli"))));
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
