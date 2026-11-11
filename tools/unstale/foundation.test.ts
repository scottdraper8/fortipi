import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { stringify } from "yaml";
import { repository } from "../../scripts/build-workspaces.ts";
import { checkLicenses } from "../../scripts/check-licenses.ts";
import type { Manifest, SupplyChain } from "../../scripts/check-pins.ts";
import { checkPins, json, manifestPaths, yaml } from "../../scripts/check-pins.ts";
import { rejectedZodAdvisory, validateRejectedZodAuthorities } from "../../scripts/run-unstale.ts";

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

test("reject manager resolution drift in the first pnpm lock document", async () => {
  await fixture(async (root) => {
    const path = resolve(root, "pnpm-lock.yaml");
    const text = await readFile(path, "utf8");
    assert.ok(text.includes("version: 12.18.0"));
    await writeFile(path, text.replace("version: 12.18.0", "version: 12.17.0"));
  }, /12\.17\.0/);
});

test("reject a permissions.build override of denied dependency scripts", async () => {
  await fixture(async (root) => {
    const policy = await yaml<Record<string, unknown>>(root, "pnpm-workspace.yaml");
    policy.permissions = { "workerd@1.20261110.1": { build: true } };
    await writeFile(resolve(root, "pnpm-workspace.yaml"), stringify(policy));
  }, /Forbidden policy override: permissions/);
});

test("reject stale graph advisory evidence", async () => {
  await fixture(async (root) => {
    const state = await json<SupplyChain>(root, "tools/unstale/supply-chain.json");
    state.advisory.checkedAt = new Date(Date.now() - 86_400_001).toISOString();
    await writeFile(resolve(root, "tools/unstale/supply-chain.json"), JSON.stringify(state));
  }, /Advisory graph review is stale\/invalid/);
});

test("reject fresh advisory evidence rebound to changed lock bytes", async () => {
  await fixture(async (root) => {
    await mkdir(resolve(root, "dist/supply-chain"), { recursive: true });
    const digest = async (path: string): Promise<string> =>
      createHash("sha256")
        .update(await readFile(resolve(root, path)))
        .digest("hex");
    const state = await json<SupplyChain>(root, "tools/unstale/supply-chain.json");
    await writeFile(
      resolve(root, "dist/supply-chain/advisory-review.json"),
      JSON.stringify({
        format: 1,
        reviewSha256: await digest("tools/unstale/supply-chain.json"),
        locks: {
          "pnpm-lock.yaml": await digest("pnpm-lock.yaml"),
          "tools/unstale/pnpm-lock.yaml": await digest("tools/unstale/pnpm-lock.yaml"),
        },
        advisory: state.advisory,
      }),
    );
    await checkPins(root);
    const path = resolve(root, "pnpm-lock.yaml");
    await writeFile(path, `${await readFile(path, "utf8")}\n# changed since advisory review\n`);
  }, /Fresh advisory review input changed: pnpm-lock.yaml/);
});

test("reject absent verified registry signature evidence", async () => {
  await fixture(async (root) => {
    const state = await json<SupplyChain>(root, "tools/unstale/supply-chain.json");
    const record = state.packages["ajv@8.20.0"];
    assert.ok(record);
    record.signature = "not published";
    await writeFile(resolve(root, "tools/unstale/supply-chain.json"), JSON.stringify(state));
  }, /Missing verified registry signature/);
});

test("reject a workspace link redirected to a different owned package", async () => {
  await fixture(async (root) => {
    const path = resolve(root, "pnpm-lock.yaml");
    const text = await readFile(path, "utf8");
    assert.ok(text.includes("link:../fortipi-contract"));
    await writeFile(path, text.replace("link:../fortipi-contract", "link:../fortipi-executor"));
  }, /workspace link points to wrong package/);
});

test("reject literal harden-runner endpoints that reproduced blocked bootstrap", async () => {
  await fixture(async (root) => {
    const path = resolve(root, ".github/workflows/ci.yml");
    const text = await readFile(path, "utf8");
    assert.ok(text.includes("allowed-endpoints: >-"));
    await writeFile(path, text.replace("allowed-endpoints: >-", "allowed-endpoints: |"));
  }, /allowed-endpoints contains an internal newline/);
});

test("keep ordinary YAML single-document when relaxing only pnpm lock validation", async () => {
  await fixture(async (root) => {
    const path = resolve(root, ".pre-commit-config.yaml");
    const text = await readFile(path, "utf8");
    await writeFile(
      path,
      text.replace("exclude: '(^|/)pnpm-lock\\.yaml$'", "args: [--allow-multiple-documents]"),
    );
  }, /pnpm-lock/);
});

test("changed or ambiguous GHSA assessments never inherit the exact Zod disposition", () => {
  const cve = { cveMetadata: { cveId: "CVE-2023-54404", state: "REJECTED" } };
  const github = {
    ghsa_id: "GHSA-mrhx-c7xc-m3w5",
    cve_id: "CVE-2023-54404",
    withdrawn_at: null,
    vulnerabilities: [
      {
        package: { ecosystem: "npm", name: "zod" },
        vulnerable_version_range: "< 4.6.6",
        first_patched_version: "4.6.6",
      },
    ],
  };
  validateRejectedZodAuthorities(cve, github);
  assert.throws(
    () =>
      validateRejectedZodAuthorities(
        { cveMetadata: { ...cve.cveMetadata, state: "PUBLISHED" } },
        github,
      ),
    /CVE status changed/,
  );
  assert.throws(
    () =>
      validateRejectedZodAuthorities(cve, {
        ...github,
        vulnerabilities: [
          ...github.vulnerabilities,
          { ...github.vulnerabilities[0], vulnerable_version_range: "<= 4.6.7" },
        ],
      }),
    /GHSA affected-version assessment changed/,
  );
  assert.throws(
    () => validateRejectedZodAuthorities(cve, { ...github, ghsa_id: "GHSA-xxxx-xxxx-xxxx" }),
    /GHSA/,
  );
  assert.throws(() => validateRejectedZodAuthorities(cve, {}));
});

test("changed Zod versions and unrelated actionable findings are not suppressed", async () => {
  for (const output of [
    "Lockfile advisories: 1 of 1 advisory on 381 locked package versions call for action\n  zod 4.6.6 (direct):\n  CVE-2023-54404",
    "Lockfile advisories: 1 of 1 advisory on 381 locked package versions call for action\n  zod 4.6.7 (direct):\n  GHSA-xxxx-xxxx-xxxx",
    "Lockfile advisories: 2 of 2 advisories on 381 locked package versions call for action\n  zod 4.6.7 (direct):\n  CVE-2023-54404\n  CVE-2026-1234",
    "Lockfile advisories: 1 of 1 advisory on 381 locked package versions call for action\n  zod 4.6.7 (direct):\n  CVE-2023-54404\n  zod 4.6.5 (transitive):\n  CVE-2023-54404",
  ])
    assert.equal(await rejectedZodAdvisory(output), false);
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
