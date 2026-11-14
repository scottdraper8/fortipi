import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { parse, parseAllDocuments } from "yaml";
import { filesBelow, projects, repository } from "./build-workspaces.ts";
import { dependencyPatches } from "./dependency-patches.ts";

export interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  packageManager?: string;
  type: string;
  license: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  engines?: Record<string, string>;
  pnpm?: unknown;
  fortipi?: {
    actions: Record<string, { sha: string; version: string }>;
    toolchain: Record<string, string>;
    publishNames: Record<string, string>;
  };
}
export interface Review {
  name: string;
  version: string;
  integrity: string;
  published: string;
  reviewedAt: string;
  license: string;
  archiveSha256: string;
  manifestSha256: string;
  engines: Record<string, string>;
  peers: Record<string, string>;
  lifecycle: Record<string, string>;
  scriptFiles: Record<string, string>;
  licenses: Record<string, string>;
  signature: string;
  provenance: string;
}
export interface SupplyChain {
  format: 1;
  packages: Record<string, Review>;
  exemptions: Record<string, { reason: string; expires: string; integrity: string }>;
  advisory: { checkedAt: string; identities: number; findings: string[] };
}
export interface Lock {
  lockfileVersion: string;
  importers: Record<string, Record<string, Record<string, { specifier: string; version: string }>>>;
  packages: Record<string, { resolution: { integrity: string }; hasBin?: boolean }>;
  snapshots?: Record<
    string,
    { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }
  >;
}
export const manifestPaths = [
  "package.json",
  ...projects.map((p) => `${p}/package.json`),
  "tools/unstale/package.json",
];
export async function json<T>(root: string, path: string): Promise<T> {
  return JSON.parse(await readFile(resolve(root, path), "utf8")) as T;
}
export async function yaml<T>(root: string, path: string): Promise<T> {
  const text = await readFile(resolve(root, path), "utf8");
  if (!path.endsWith("pnpm-lock.yaml")) return parse(text) as T;
  const documents = parseAllDocuments(text).map((doc) => {
    assert.equal(doc.errors.length, 0, `Malformed lock document: ${path}`);
    return doc.toJSON() as Lock;
  });
  assert.equal(
    documents.length,
    2,
    `pnpm 12 requires manager and application lock documents: ${path}`,
  );
  assert.equal(
    documents[0]?.importers["."]?.packageManagerDependencies?.pnpm?.specifier,
    "12.18.0",
  );
  assert.equal(documents[0]?.importers["."]?.packageManagerDependencies?.pnpm?.version, "12.18.0");
  assert.deepEqual(Object.keys(documents[0]?.importers ?? {}), ["."]);
  assert.deepEqual(Object.keys(documents[0]?.importers["."] ?? {}), [
    "configDependencies",
    "packageManagerDependencies",
  ]);
  assert.deepEqual(documents[0]?.importers["."]?.configDependencies, {});
  for (const importer of Object.values(documents[1]?.importers ?? {}))
    assert.equal(
      importer.packageManagerDependencies,
      undefined,
      "Manager importer in application lock",
    );
  // pnpm 12 separately locks its own native package-manager distribution.
  const result: Lock = { lockfileVersion: "9.0", importers: {}, packages: {} };
  for (const doc of documents) {
    assert.equal(String(doc.lockfileVersion), "9.0");
    result.snapshots = { ...result.snapshots, ...doc.snapshots };
    for (const [id, value] of Object.entries(doc.packages)) {
      if (result.packages[id])
        assert.deepEqual(result.packages[id], value, `Conflicting archive ${id}`);
      result.packages[id] = value;
    }
    for (const [id, value] of Object.entries(doc.importers))
      result.importers[id] = { ...result.importers[id], ...value };
  }
  return result as T;
}
export function rootArgument(): string {
  const index = process.argv.indexOf("--root");
  if (index < 0) return repository;
  const path = process.argv[index + 1];
  assert.ok(path && !path.startsWith("--"), "--root needs an explicit fixture path");
  return resolve(path);
}

const exact = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const groups = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;
const requiredHooks = [
  "check-added-large-files",
  "check-merge-conflict",
  "check-yaml",
  "check-json",
  "check-symlinks",
  "check-case-conflict",
  "detect-private-key",
  "gitleaks",
  "fortipi-source-integrity",
  "fortipi-biome",
  "fortipi-typecheck",
  "fortipi-schema-drift",
  "fortipi-license-bundles",
  "fortipi-foundation",
  "fortipi-pins",
  "fortipi-unstale",
];

/** Data validation only. The caller supplies actual current source/lock hashes;
 * no receipt field can suppress the remaining full policy/graph checks. */
export function reviewedAdvisory(
  review: SupplyChain,
  retained: unknown,
  inputs: { reviewSha256: string; locks: Record<string, string> },
  now = Date.now(),
): SupplyChain["advisory"] {
  assert.equal(review.format, 1);
  assert.deepEqual(review.advisory.findings, [], "Unresolved security advisories");
  let advisory = review.advisory;
  if (retained !== undefined) {
    assert.ok(
      retained && typeof retained === "object" && !Array.isArray(retained),
      "Invalid retained advisory review",
    );
    const fresh = retained as {
      format: unknown;
      reviewSha256: unknown;
      locks: Record<string, unknown>;
      advisory: SupplyChain["advisory"];
    };
    assert.equal(fresh.format, 1);
    assert.equal(
      fresh.reviewSha256,
      inputs.reviewSha256,
      "Fresh advisory review input changed: tools/unstale/supply-chain.json",
    );
    for (const [path, expected] of Object.entries(inputs.locks))
      assert.equal(fresh.locks?.[path], expected, `Fresh advisory review input changed: ${path}`);
    advisory = fresh.advisory;
  }
  assert.deepEqual(advisory.findings, [], "Unresolved security advisories");
  const age = now - Date.parse(advisory.checkedAt);
  assert.ok(
    age >= -60_000 && age <= 86_400_000,
    "Advisory graph review is stale/invalid; rerun review-supply-chain.ts --locks --check",
  );
  return advisory;
}
export async function checkPins(root = repository, retainedReview?: unknown): Promise<void> {
  await dependencyPatches(root, true);
  const review = await json<SupplyChain>(root, "tools/unstale/supply-chain.json");
  let fresh = retainedReview;
  if (fresh === undefined) {
    try {
      fresh = await json(root, "dist/supply-chain/advisory-review.json");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const hash = async (path: string) =>
    createHash("sha256")
      .update(await readFile(resolve(root, path)))
      .digest("hex");
  const advisory = reviewedAdvisory(review, fresh, {
    reviewSha256: await hash("tools/unstale/supply-chain.json"),
    locks: {
      "pnpm-lock.yaml": await hash("pnpm-lock.yaml"),
      "tools/unstale/pnpm-lock.yaml": await hash("tools/unstale/pnpm-lock.yaml"),
    },
  });
  const manifests = new Map<string, Manifest>();
  for (const path of manifestPaths) {
    const manifest = await json<Manifest>(root, path);
    manifests.set(path, manifest);
    assert.equal(manifest.pnpm, undefined, `${path}: pnpm overrides are forbidden`);
    for (const group of groups)
      for (const [name, version] of Object.entries(manifest[group] ?? {})) {
        if (version === "workspace:*") {
          assert.match(name, /^fortipi-(contract|client|tui|cli|executor)$/);
        } else {
          assert.match(version, exact, `${path}: ${name} must be an exact registry pin`);
          assert.ok(
            review.packages[`${name}@${version}`],
            `Unreviewed dependency ${name}@${version}`,
          );
        }
      }
  }
  const top = manifests.get("package.json");
  assert.equal(top?.packageManager, "pnpm@12.18.0");
  assert.equal(manifests.get("tools/unstale/package.json")?.packageManager, top?.packageManager);
  assert.equal(top?.fortipi?.toolchain.node, "26.13.1");
  const reviewedIdentities = new Set<string>();
  for (const prefix of ["", "tools/unstale/"]) {
    const policy = await yaml<Record<string, unknown>>(root, `${prefix}pnpm-workspace.yaml`);
    for (const [key, value] of Object.entries({
      saveExact: true,
      minimumReleaseAge: 1440,
      minimumReleaseAgeStrict: true,
      trustPolicy: "no-downgrade",
      trustLockfile: false,
      verifyDepsBeforeRun: "error",
      strictDepBuilds: true,
      dangerouslyAllowAllBuilds: false,
      autoInstallPeers: false,
      strictPeerDependencies: true,
      engineStrict: true,
      sideEffectsCache: false,
    }))
      assert.equal(policy[key], value, `${prefix}${key}`);
    assert.deepEqual(policy.skills, { dirs: [] });
    for (const key of [
      "permissions",
      "ignoreScripts",
      "onlyBuiltDependencies",
      "onlyBuiltDependenciesFile",
      "ignoredBuiltDependencies",
      "ignoreDepScripts",
      "neverBuiltDependencies",
      "pnpmfile",
      "overrides",
      "packageExtensions",
    ])
      assert.equal(policy[key], undefined, `Forbidden policy override: ${key}`);
    const approvals = policy.allowBuilds as Record<string, boolean>;
    assert.ok(approvals && typeof approvals === "object");
    for (const [id, allowed] of Object.entries(approvals)) {
      const record = review.packages[id];
      assert.ok(record, `Unreviewed lifecycle identity ${id}`);
      assert.ok(Object.keys(record.lifecycle).length > 0, `Unused build approval ${id}`);
      assert.equal(typeof allowed, "boolean", `Unresolved lifecycle approval ${id}`);
      if (allowed)
        assert.ok(
          ["esbuild@0.28.2", "node-pty@1.1.0"].includes(id),
          `Unapproved script execution: ${id}`,
        );
    }
    const lock = await yaml<Lock>(root, `${prefix}pnpm-lock.yaml`);
    assert.equal(String(lock.lockfileVersion), "9.0");
    const ids = new Set(Object.keys(lock.packages));
    for (const [id, node] of Object.entries(lock.snapshots ?? {})) {
      assert.ok(ids.has(id.split("(")[0] ?? ""), `Snapshot has no locked archive ${id}`);
      for (const [name, version] of Object.entries({
        ...node.dependencies,
        ...node.optionalDependencies,
      }))
        assert.ok(
          ids.has(`${name}@${version.split("(")[0]}`),
          `Unresolved locked dependency ${id} -> ${name}@${version}`,
        );
    }
    const exclusions = policy.minimumReleaseAgeExclude as string[];
    assert.ok(Array.isArray(exclusions));
    assert.equal(exclusions.length, new Set(exclusions).size);
    for (const id of exclusions) {
      assert.ok(ids.has(id), `Unmatched release-age exemption ${id}`);
      const exemption = review.exemptions[id];
      const record = review.packages[id];
      assert.ok(exemption && record && exemption.reason, `Missing age review ${id}`);
      assert.equal(exemption.integrity, record.integrity);
      assert.equal(Date.parse(exemption.expires), Date.parse(record.published) + 86_400_000);
      assert.ok(Date.parse(exemption.expires) > Date.now(), `Expired release-age exemption ${id}`);
    }
    for (const [id, item] of Object.entries(lock.packages)) {
      reviewedIdentities.add(id);
      const record = review.packages[id];
      assert.ok(record, `Unreviewed locked archive ${id}`);
      assert.equal(`${record.name}@${record.version}`, id, `Review identity mismatch ${id}`);
      assert.match(
        record.signature,
        /^verified SHA256:[A-Za-z0-9+/]{43}$/,
        `Missing verified registry signature ${id}`,
      );
      assert.match(record.archiveSha256, /^[a-f0-9]{64}$/);
      assert.match(record.manifestSha256, /^[a-f0-9]{64}$/);
      assert.ok(Number.isFinite(Date.parse(record.published)), `Invalid publication date ${id}`);
      assert.match(item.resolution.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
      assert.equal(item.resolution.integrity, record.integrity, `Lock archive corruption: ${id}`);
      if (Object.keys(record.lifecycle).length)
        assert.equal(typeof approvals[id], "boolean", `Unreviewed lifecycle script ${id}`);
      if (Date.now() - Date.parse(record.published) < 86_400_000)
        assert.ok(exclusions.includes(id), `Missing exact release-age exemption ${id}`);
    }
    for (const [path, manifest] of manifests) {
      if (prefix ? path !== `${prefix}package.json` : path.startsWith("tools/")) continue;
      const importerPath =
        path === `${prefix}package.json` ? "." : path.replace(/\/package.json$/, "");
      const importer = lock.importers[importerPath];
      assert.ok(importer, `Missing lock importer ${importerPath}`);
      for (const group of groups.filter((g) => g !== "peerDependencies")) {
        assert.deepEqual(
          Object.keys(importer[group] ?? {}).sort(),
          Object.keys(manifest[group] ?? {}).sort(),
          `${path}: lock manifest mismatch`,
        );
        for (const [name, pin] of Object.entries(manifest[group] ?? {})) {
          const locked: { specifier: string; version: string } | undefined =
            importer[group]?.[name];
          assert.equal(locked?.specifier, pin, `${name}: stale lock specifier`);
          if (pin === "workspace:*") {
            assert.ok(locked?.version.startsWith("link:"), `${name}: not a workspace link`);
            const target = [...manifests].find(([, m]) => m.name === name)?.[0];
            assert.ok(target, `Missing workspace manifest ${name}`);
            assert.equal(
              resolve(root, importerPath, locked.version.slice(5)),
              resolve(root, target, ".."),
              `${name}: workspace link points to wrong package`,
            );
          } else {
            assert.equal(locked?.version.split("(")[0], pin, `${name}: wrong resolution`);
            assert.ok(ids.has(`${name}@${pin}`));
          }
        }
      }
    }
  }
  assert.equal(
    advisory.identities,
    reviewedIdentities.size,
    "Advisory review omits locked identities",
  );
  const hooks = await yaml<{
    repos: {
      repo: string;
      rev?: string;
      hooks: {
        id: string;
        entry?: string;
        always_run?: boolean;
        language?: string;
        pass_filenames?: boolean;
        alias?: string;
        files?: string;
        exclude?: string;
        args?: string[];
      }[];
    }[];
  }>(root, ".pre-commit-config.yaml");
  const allHooks = hooks.repos.flatMap((repo) => repo.hooks);
  for (const id of requiredHooks)
    assert.equal(
      allHooks.filter((h) => h.id === id).length,
      id === "check-yaml" ? 2 : 1,
      `Missing/duplicate protected hook ${id}`,
    );
  const ordinaryYaml = allHooks.find((h) => h.id === "check-yaml" && !h.alias);
  assert.equal(ordinaryYaml?.exclude, "(^|/)pnpm-lock\\.yaml$");
  assert.equal(ordinaryYaml?.args, undefined, "Ordinary YAML must remain single-document");
  const lockYaml = allHooks.find((h) => h.alias === "fortipi-lock-yaml");
  assert.equal(lockYaml?.id, "check-yaml");
  assert.equal(lockYaml?.files, "(^|/)pnpm-lock\\.yaml$");
  assert.deepEqual(lockYaml?.args, ["--allow-multiple-documents"]);
  const integrity = allHooks.find((h) => h.id === "fortipi-source-integrity");
  assert.deepEqual(integrity, {
    id: "fortipi-source-integrity",
    name: "Preserve the original FortiPi requirements",
    entry: "node scripts/check-source-integrity.ts",
    language: "system",
    pass_filenames: false,
    always_run: true,
  });
  for (const repo of hooks.repos)
    if (repo.repo !== "local") {
      const expected =
        repo.repo === "https://github.com/pre-commit/pre-commit-hooks"
          ? "3e8a8703264a2f4a69428a0aa4dcb512790b2c8c"
          : repo.repo === "https://github.com/gitleaks/gitleaks"
            ? "83d9cd684c87d95d656c1458ef04895a7f1cbd8e"
            : undefined;
      assert.equal(repo.rev, expected, `Unreviewed hook ${repo.repo}`);
      assert.ok(expected);
    }
  for (const path of await filesBelow(resolve(root, ".github/workflows"))) {
    const workflow = await yaml<{
      jobs: Record<
        string,
        {
          steps: {
            uses?: string;
            with?: Record<string, unknown>;
            run?: string;
            if?: string;
            shell?: string;
            "timeout-minutes"?: number;
          }[];
        }
      >;
    }>(root, relative(root, path));
    for (const [job, config] of Object.entries(workflow.jobs)) {
      const hardening = config.steps[0];
      assert.ok(hardening, `${job}: missing hardened job steps`);
      assert.ok(
        hardening?.uses?.startsWith("step-security/harden-runner@"),
        `${job}: harden-runner must be first`,
      );
      assert.equal(hardening.with?.["egress-policy"], "block", `${job}: block egress is required`);
      const health = config.steps[1];
      assert.ok(
        health?.run === "/usr/bin/systemctl is-active --quiet agent.service" &&
          health.if === "runner.os == 'Linux'" &&
          health.shell === "bash" &&
          health["timeout-minutes"] === 1,
        `${job}: Linux hardener health gate must precede checkout and network steps`,
      );
      const endpoints = hardening.with?.["allowed-endpoints"];
      assert.equal(typeof endpoints, "string", `${job}: explicit endpoints are required`);
      assert.ok(
        !(endpoints as string).trim().match(/[\r\n]/),
        `${job}: harden-runner allowed-endpoints contains an internal newline; use a folded YAML scalar`,
      );
    }
    const text = await readFile(path, "utf8");
    for (const match of text.matchAll(/\buses:\s*([^\s#]+)@([^\s#]+)/g)) {
      const [, name, sha] = match;
      assert.ok(name && sha);
      assert.match(sha, /^[a-f0-9]{40}$/);
      assert.equal(sha, top?.fortipi?.actions[name]?.sha, `Unreviewed Action ${name}`);
    }
  }
  console.log(
    "Pins: exact manifests, both locked archive graphs, lifecycle/age policy and protected hooks verified",
  );
}

if (import.meta.main) await checkPins(rootArgument());
