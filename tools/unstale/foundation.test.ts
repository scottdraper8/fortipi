import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { stringify } from "yaml";
import { repository } from "../../scripts/build-workspaces.ts";
import { checkLicenses } from "../../scripts/check-licenses.ts";
import type { Manifest, SupplyChain } from "../../scripts/check-pins.ts";
import { checkPins, json, manifestPaths, yaml } from "../../scripts/check-pins.ts";

async function fixture(change: (root: string) => Promise<void>, rejection: RegExp): Promise<void> {
  await mkdir(resolve(repository, "dist/foundation-fixtures"), { recursive: true });
  const root = await mkdtemp(resolve(repository, "dist/foundation-fixtures/case-"));
  try {
    const files = [
      ...manifestPaths,
      "pnpm-workspace.yaml",
      "pnpm-lock.yaml",
      "tools/unstale/pnpm-workspace.yaml",
      "tools/unstale/pnpm-lock.yaml",
      "tools/unstale/supply-chain.json",
      "tools/unstale/license-policy.json",
      ".pre-commit-config.yaml",
      ".github/workflows/access-preflight.yml",
      ".github/workflows/ci.yml",
    ];
    for (const path of files) {
      await mkdir(dirname(resolve(root, path)), { recursive: true });
      await copyFile(resolve(repository, path), resolve(root, path));
    }
    await checkPins(root);
    await change(root);
    await assert.rejects(() => checkPins(root), rejection);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("reject direct version range while the real root remains exact", async () => {
  await fixture(async (root) => {
    const m = await json<Manifest>(root, "package.json");
    assert.ok(m.devDependencies);
    m.devDependencies.ajv = "^8.20.0";
    await writeFile(resolve(root, "package.json"), JSON.stringify(m));
  }, /must be an exact registry pin/);
});

test("reject a corrupt archive identity in either lock document", async () => {
  await fixture(async (root) => {
    const path = resolve(root, "pnpm-lock.yaml");
    const text = await readFile(path, "utf8");
    await writeFile(path, text.replace(/sha512-[A-Za-z0-9+/]+==/, `sha512-${"A".repeat(86)}==`));
  }, /Lock archive corruption/);
});

test("reject a newly introduced dependency install script", async () => {
  await fixture(async (root) => {
    const s = await json<SupplyChain>(root, "tools/unstale/supply-chain.json");
    const record = s.packages["ajv@8.20.0"];
    assert.ok(record);
    record.lifecycle.postinstall = "node surprise.js";
    await writeFile(resolve(root, "tools/unstale/supply-chain.json"), JSON.stringify(s));
  }, /Unreviewed lifecycle script ajv/);
});

test("reject expired exact release-age exemption", async () => {
  await fixture(async (root) => {
    const s = await json<SupplyChain>(root, "tools/unstale/supply-chain.json");
    const id = "ajv@8.20.0";
    const r = s.packages[id];
    assert.ok(r);
    r.published = new Date(Date.now() - 172_800_000).toISOString();
    s.exemptions[id] = {
      reason: "Disposable expired-exemption negative",
      integrity: r.integrity,
      expires: new Date(Date.parse(r.published) + 86_400_000).toISOString(),
    };
    const policy = await yaml<{ minimumReleaseAgeExclude: string[] }>(root, "pnpm-workspace.yaml");
    policy.minimumReleaseAgeExclude.push(id);
    await writeFile(resolve(root, "pnpm-workspace.yaml"), stringify(policy));
    await writeFile(resolve(root, "tools/unstale/supply-chain.json"), JSON.stringify(s));
  }, /Expired release-age exemption/);
});

test("reject removed protected integrity hook", async () => {
  await fixture(async (root) => {
    const h = await yaml<{ repos: { hooks: { id: string }[] }[] }>(root, ".pre-commit-config.yaml");
    for (const repo of h.repos)
      repo.hooks = repo.hooks.filter((x) => x.id !== "fortipi-source-integrity");
    await writeFile(resolve(root, ".pre-commit-config.yaml"), stringify(h));
  }, /Missing\/duplicate protected hook fortipi-source-integrity/);
});

test("reject disallowed license before copying any archive", async () => {
  // License checker has its own CLI --root fixture interface; no real policy mutation.
  await mkdir(resolve(repository, "dist/foundation-fixtures"), { recursive: true });
  const root = await mkdtemp(resolve(repository, "dist/foundation-fixtures/license-"));
  try {
    for (const path of [
      "pnpm-lock.yaml",
      "tools/unstale/supply-chain.json",
      "tools/unstale/license-policy.json",
    ]) {
      await mkdir(dirname(resolve(root, path)), { recursive: true });
      await copyFile(resolve(repository, path), resolve(root, path));
    }
    const state = await json<SupplyChain>(root, "tools/unstale/supply-chain.json");
    for (const r of Object.values(state.packages)) r.license = "GPL-3.0-only";
    await writeFile(resolve(root, "tools/unstale/supply-chain.json"), JSON.stringify(state));
    await assert.rejects(() => checkLicenses(root, true), /Disallowed or unknown license/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  await checkPins();
});
