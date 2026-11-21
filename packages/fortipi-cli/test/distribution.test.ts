import assert from "node:assert/strict";
import { lstat, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { installConsumer } from "./install-harness.ts";
import { offlineConsumer, readDistributionReceipt } from "./offline-consumer.ts";

test("installed CLI proof requires Linux before staging; an eligible host checks actual packs and rejects an unisolated continuation", {
  timeout: 300000,
}, async (t) => {
  const parent = await mkdtemp(join(await realpath(tmpdir()), "fortipi-cli-distribution-"));
  const writable = async (path: string): Promise<void> => {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    await (await import("node:fs/promises")).chmod(path, 0o700);
    for (const name of await readdir(path)) await writable(join(path, name));
  };
  t.after(async () => {
    await writable(parent);
    await rm(parent, { recursive: true, force: true });
  });
  const directory = join(parent, "proof");
  if (process.platform !== "linux") {
    await assert.rejects(installConsumer(directory), /requires actual Linux/);
    await assert.rejects(
      offlineConsumer(join(directory, "absent.json")),
      /disposable Linux identity/,
    );
    // No installed prepare or Wrangler dry-build executes on a non-Linux host.
    return;
  }
  const result = await installConsumer(directory);
  assert.equal(result.strictInstalledConsumer, true);
  assert.equal(result.readOnlyInstall, true);
  assert.equal(result.installedPrepare, true);
  assert.ok(Number(result.publicReviewedArchives) > 0);
  assert.match(String(result.offlineDryBuild), /^not-executed/);
  // This process owns the checkout, so it must not inspect its real home or run Wrangler.
  await assert.rejects(
    offlineConsumer(join(directory, "distribution.json")),
    process.platform === "linux" ? /Dedicated OS identity required/ : /disposable Linux identity/,
  );
});

test("isolated consumer accepts only a bounded component receipt naming the known scoped CLI", async (t) => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "fortipi-cli-receipt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "distribution.json");
  const receipt = {
    schemaVersion: 1,
    componentOnly: true,
    publishable: false,
    scope: "fortipi-ci-test",
    packageName: "@fortipi-ci-test/fortipi-cli",
    consumer: join(directory, "consumer"),
    checkout: join(directory, "checkout"),
    checkoutUid: 1000,
    sourceCommit: "a".repeat(40),
    assetManifestSha256: "b".repeat(64),
    publicReviewedArchives: 2,
    strictInstalledConsumer: true,
    readOnlyInstall: true,
    installedPrepare: true,
    parentNetworkNamespace: "net:[123]",
    offlineDryBuild: "not-executed; dedicated Linux identity/network namespace required",
  };
  await writeFile(path, JSON.stringify(receipt));
  assert.deepEqual(await readDistributionReceipt(path), receipt);
  for (const change of [
    { packageName: "fortipi-cli" },
    { packageName: "@fortipi-ci-test/fortipi-cli/../../escape" },
    { componentOnly: false },
    { publishable: true },
    { installedPrepare: false },
    { extra: true },
  ]) {
    await writeFile(path, JSON.stringify({ ...receipt, ...change }));
    await assert.rejects(readDistributionReceipt(path));
  }
  await writeFile(path, " ".repeat(65537));
  await assert.rejects(readDistributionReceipt(path), /receipt exceeds bound/);
});

test("CLI workflow image authentication does not deliver GitHub credentials to installation or isolation", async () => {
  const { readFile } = await import("node:fs/promises");
  const workflow = parse(
    await readFile(new URL("../../../.github/workflows/cli-proof.yml", import.meta.url), "utf8"),
  );
  assert.deepEqual(workflow.permissions, { contents: "read", actions: "read" });
  assert.equal(workflow.env.IMAGE_REFERENCE, "$" + "{{ vars.FORTIPI_IMAGE_REFERENCE }}");
  assert.equal(workflow.env.GITHUB_TOKEN, undefined);
  assert.equal(workflow.env.GH_TOKEN, undefined);
  const steps = workflow.jobs["installed-offline"].steps as Record<string, unknown>[];
  const credentialSteps = steps.filter((step) =>
    /github.token/.test(JSON.stringify({ env: step.env, with: step.with })),
  );
  assert.equal(credentialSteps.length, 2);
  assert.ok(
    credentialSteps.some((step) => String(step.uses).startsWith("actions/download-artifact@")),
  );
  assert.ok(credentialSteps.some((step) => step.run === "node scripts/cli-proof.ts image"));
  assert.equal(
    steps.some((step) =>
      /cli-proof.ts context|container\/build|setup-go|docker/.test(String(step.run ?? step.uses)),
    ),
    false,
  );
  for (const phase of ["install", "offline"]) {
    const step = steps.find((step) => step.run === `node scripts/cli-proof.ts ${phase}`);
    assert.ok(step);
    assert.equal(/TOKEN|SECRET|CREDENTIAL/.test(JSON.stringify(step.env)), false);
  }
});
