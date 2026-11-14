import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, posix, resolve } from "node:path";
import type { Attribution, LicensePolicy } from "../tools/unstale/review-attributions.ts";
import {
  archive,
  archiveEntries,
  hash,
  licenseEntries,
} from "../tools/unstale/review-supply-chain.ts";
import { packagePaths, repository } from "./build-workspaces.ts";
import type { Lock, Manifest, SupplyChain } from "./check-pins.ts";
import { json, rootArgument, yaml } from "./check-pins.ts";
import { type DependencyPatch, dependencyPatches, patchStatus } from "./dependency-patches.ts";
import {
  assertTrustedRuntimeClosure,
  assertTrustedRuntimePlan,
  type RuntimeClosure,
  type RuntimeFileRecord,
  type RuntimePhysicalPlan,
  runtimeClosureDigest,
  runtimeFileTotal,
  runtimePathIsConveyable,
} from "./runtime-closure.ts";

const allowed = new Set([
  "MIT",
  "Apache-2.0",
  "MIT OR Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "BlueOak-1.0.0",
  "Unlicense",
  "CC0-1.0",
]);

const exactExceptions: Record<string, string> = {
  "argparse@2.0.1": "Python-2.0",
  "argparse@3.0.4": "PSF-2.0",
  "postal-mime@2.7.6": "MIT-0",
  "caniuse-lite@1.0.30001823": "CC-BY-4.0",
};
const externalNative = new Map([
  ...[
    "darwin-arm64",
    "darwin-x64",
    "linux-arm",
    "linux-arm64",
    "linux-ppc64",
    "linux-riscv64",
    "linux-s390x",
    "linux-x64",
    "linuxmusl-arm64",
    "linuxmusl-x64",
  ].map((p): [string, string] => [`@img/sharp-libvips-${p}@1.3.4`, "LGPL-3.0-or-later"]),
  ...["win32-arm64", "win32-ia32", "win32-x64"].map((p): [string, string] => [
    `@img/sharp-${p}@0.35.5`,
    "Apache-2.0 AND LGPL-3.0-or-later",
  ]),
  ["@img/sharp-wasm32@0.35.5", "Apache-2.0 AND LGPL-3.0-or-later AND MIT"] as [string, string],
]);

export interface RuntimeConveyanceMember extends RuntimeFileRecord {
  context: string;
  archivePath: string;
}
export interface RuntimeConveyanceComponent {
  archiveId: string;
  license: string;
  integrity: string;
  archiveSha256: string;
  manifestSha256: string;
  licenses: Record<string, string>;
  attribution: Attribution | null;
  obligations: LicensePolicy["exceptions"][string] | null;
  changeStatus: string;
  patch: DependencyPatch | null;
  addresses: { path: string; context: string }[];
  files: RuntimeConveyanceMember[];
}
/** Data for notices/SBOM, never authority to parse an unauthenticated candidate. */
export interface RuntimeConveyanceReceipt {
  schemaVersion: 1;
  sourceName: string;
  sourceCommit: string;
  closureSha256: string;
  planSha256: string;
  licensePolicySha256: string;
  rootLicenseSha256: string;
  components: RuntimeConveyanceComponent[];
  external: {
    context: string;
    archiveId: string;
    reason: "native" | "outside-bundled-reachability";
  }[];
  /** Exact source-bound files only; this does not waive the generic secret-path rule. */
  permittedBlockedFiles: RuntimeFileRecord[];
}

async function runtimeFact(root: string, path: string): Promise<Buffer> {
  assert.ok(
    path.split("/").every((part) => part && part !== "." && part !== ".." && !part.includes("\\")),
  );
  const parts = path.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const stat = await lstat(resolve(root, ...parts.slice(0, i)));
    assert.ok(!stat.isSymbolicLink());
    assert.ok(i === parts.length ? stat.isFile() && stat.nlink === 1 : stat.isDirectory());
  }
  return readFile(resolve(root, path));
}
function freezeReceipt(value: unknown): void {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freezeReceipt(item);
    Object.freeze(value);
  }
}

/** Exact third-party dependency members, never permission for owned output conveyance. */
export function assertRuntimeWasmMember(
  archiveId: string,
  archiveSha256: string,
  member: Pick<RuntimeFileRecord, "path" | "size" | "sha256">,
  license: string,
  attribution?: Attribution,
): void {
  assert.equal(license, "MIT");
  if (archiveId === "blake3-wasm@2.1.5") {
    assert.match(member.path, /^dist\/wasm\/(?:browser|nodejs|web)\/blake3_js_bg\.wasm$/);
    return;
  }
  assert.equal(archiveId, "miniflare@5.20261113.0-beta");
  assert.equal(archiveSha256, "4777f56bb9e822fd249b05929dec2a82e1c9b9fc4cf5a757f7ef15cb9bd34785");
  assert.equal(member.path, "dist/src/mdream_edge_bg.wasm");
  assert.equal(member.size, 239214);
  assert.equal(member.sha256, "db48fb63ec419083fdcd2100171bb5f40c5086164a9fe939286927727c91256b");
  assert.equal(
    attribution?.source,
    "https://github.com/cloudflare/workers-sdk/tree/79b890ab89a62823198a0c551c44ff647c80de4d",
  );
  assert.ok(attribution);
  for (const [name, digest] of [
    ["LICENSE.md", "b5a7e0557d37c8ccf1b1cbcda1842b8c4535d217f81f97c1cbad579042269cad"],
    ["CORE-LICENSE", "d06451530138de11ec5cee38b458f1aa4259ada5587dc5317c225196d26914d6"],
    ["RUST-NOTICES.md", "786b5b98e134b6d2c038e1156647096a502c2732b56184c88d4af021429c5846"],
    ["component.json", "7aa18c9e3bf3fd5cff72e87911d8d7c64f23851ef1cec84b0879a8b9ae7e6012"],
  ]) {
    const records: Attribution["files"] = attribution.files.filter(
      (file) => file.path === `tools/unstale/licenses/npm/mdream/2.0.3/${name}`,
    );
    assert.equal(records.length, 1, "Missing exact mdream component attribution");
    assert.equal(records[0]?.sha256, digest);
  }
}

/** Source-only vendor surface. Existing dist/Worker/worker-assets guards stay unchanged. */
export async function reviewRuntimeConveyance(
  root: string,
  closure: RuntimeClosure,
  plan: RuntimePhysicalPlan,
): Promise<RuntimeConveyanceReceipt> {
  assertTrustedRuntimeClosure(closure);
  assertTrustedRuntimePlan(plan);
  root = await realpath(root);
  assert.equal(plan.closureSha256, runtimeClosureDigest(closure));
  assert.equal(plan.sourceCommit, closure.sourceCommit);
  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.publicationReady, false);
  const inputBytes = new Map<string, Buffer>();
  for (const [field, path] of [
    ["lockSha256", "pnpm-lock.yaml"],
    ["reviewSha256", "tools/unstale/supply-chain.json"],
    ["patchReviewSha256", "patches/review.json"],
    ["rootPackageSha256", "package.json"],
    ["licensePolicySha256", "tools/unstale/license-policy.json"],
    ["rootLicenseSha256", "LICENSE"],
    ["embeddedFreezeSha256", "apps/worker/container/embedded-freeze.json"],
  ] as const) {
    const bytes = await runtimeFact(root, path);
    assert.equal(hash(bytes), closure.inputs[field], `Stale runtime legal input: ${path}`);
    inputBytes.set(path, bytes);
  }
  for (const [name, digest] of Object.entries(closure.inputs.packageManifests))
    assert.equal(hash(await runtimeFact(root, `packages/${name}/package.json`)), digest);
  const patches = await dependencyPatches(root);
  assert.deepEqual(
    Object.fromEntries(Object.entries(patches).map(([id, patch]) => [id, patch.sha256])),
    closure.inputs.patches,
  );
  const supplyBytes = inputBytes.get("tools/unstale/supply-chain.json");
  const policyBytes = inputBytes.get("tools/unstale/license-policy.json");
  assert.ok(supplyBytes && policyBytes);
  const supply: SupplyChain = JSON.parse(supplyBytes.toString("utf8"));
  const policy: LicensePolicy = JSON.parse(policyBytes.toString("utf8"));
  const inventory = await json<{ format: number; packages: Record<string, unknown>[] }>(
    root,
    "dist/supply-chain/inventory.json",
  );
  assert.equal(inventory.format, 1);
  assert.ok(Array.isArray(inventory.packages));
  const facts = new Map(inventory.packages.map((item) => [item.id, item]));
  assert.equal(facts.size, inventory.packages.length);
  const owner = closure.owners.find((item) => item.sourceName === plan.sourceName);
  assert.ok(owner);
  const contexts = new Map(closure.contexts.map((item) => [item.key, item]));
  const archives = new Map(closure.archives.map((item) => [item.id, item]));
  const sourceFor = (key: string) => {
    const context = contexts.get(key);
    assert.ok(context);
    const source = archives.get(context.archiveId);
    assert.ok(source);
    return source;
  };
  const bundled = new Set<string>();
  const visit = (key: string) => {
    const context = contexts.get(key);
    assert.ok(context && owner.contexts.includes(key));
    const source = archives.get(context.archiveId);
    assert.ok(source);
    if (source.externalNative || bundled.has(key)) return;
    assert.ok(!externalNative.has(source.id), `Prohibited native identity: ${source.id}`);
    bundled.add(key);
    for (const [name, ref] of Object.entries({
      ...context.dependencies,
      ...context.optionalDependencies,
    }))
      visit(`${name}@${ref}`);
  };
  for (const key of Object.values(owner.roots)) visit(key);
  const actualContexts = new Set(plan.addresses.map((item) => item.context));
  const external = owner.contexts
    .filter((key) => !actualContexts.has(key))
    .map((context) => {
      const source = sourceFor(context);
      return {
        context,
        archiveId: source.id,
        reason: source.externalNative
          ? ("native" as const)
          : ("outside-bundled-reachability" as const),
      };
    });
  const native = Object.fromEntries(
    owner.contexts
      .map(sourceFor)
      .filter((item) => item.externalNative)
      .map((item): [string, string] => [item.name, item.version])
      .sort(([a], [b]) => a.localeCompare(b, "en")),
  );
  assert.deepEqual(plan.externalNative, native);
  const represented = new Set<string>();
  const addresses = [...plan.addresses].sort((a, b) => b.path.length - a.path.length);
  assert.equal(new Set(addresses.map((item) => item.path)).size, addresses.length);
  const components = new Map<string, RuntimeConveyanceComponent>();
  for (const address of addresses) {
    // Supported hoisted pack may anchor pure-JS children of an external native
    // subtree. Every address must still be in this owner's frozen runtime graph.
    assert.ok(
      owner.contexts.includes(address.context),
      `Unreachable bundled context: ${address.context}`,
    );
    const source = sourceFor(address.context);
    assert.ok(
      (address.path.startsWith("node_modules/") &&
        address.path.endsWith(`/node_modules/${source.name}`)) ||
        address.path === `node_modules/${source.name}`,
    );
    assert.ok(
      address.path
        .split("/")
        .every(
          (part) =>
            part && part !== "." && part !== ".." && part !== ".pnpm" && !part.includes("\\"),
        ),
    );
    assert.ok(
      !source.externalNative && !externalNative.has(source.id) && source.nativeFiles.length === 0,
    );
    represented.add(address.context);
    let component = components.get(source.id);
    if (!component) {
      const review = supply.packages[source.id],
        fact = facts.get(source.id);
      assert.ok(review && fact && source.manifest);
      assert.ok(
        allowed.has(review.license) ||
          (exactExceptions[source.id] === review.license &&
            policy.exceptions[source.id]?.license === review.license),
      );
      for (const key of ["integrity", "archiveSha256", "manifestSha256"] as const)
        assert.equal(source[key], review[key]);
      for (const key of [
        "license",
        "integrity",
        "archiveSha256",
        "manifestSha256",
        "licenses",
      ] as const)
        assert.deepEqual(fact[key], review[key]);
      assert.equal(source.manifest.license, review.license);
      assert.deepEqual(fact.attribution, policy.attributions[source.id] ?? null);
      assert.deepEqual(fact.obligations, policy.exceptions[source.id] ?? null);
      assert.deepEqual(source.patch, patches[source.id] ?? null);
      const raw = await runtimeFact(
        root,
        `dist/supply-chain/archives/${hash(Buffer.from(source.id))}.tgz`,
      );
      assert.equal(hash(raw), source.archiveSha256);
      assert.equal(`sha512-${createHash("sha512").update(raw).digest("base64")}`, source.integrity);
      const entries = archiveEntries(raw);
      assert.deepEqual(licenseEntries(entries), review.licenses);
      for (const [path, digest] of Object.entries(review.licenses)) {
        const bytes = await runtimeFact(
          root,
          `dist/supply-chain/licenses/${source.id.replaceAll("/", "__")}/${path}`,
        );
        assert.equal(hash(bytes), digest);
        assert.deepEqual(bytes, entries.get(path));
      }
      const manifest = [...entries].find(([path]) => /^[^/]+\/package.json$/.test(path))?.[1];
      assert.ok(manifest && hash(manifest) === source.manifestSha256);
      component = {
        archiveId: source.id,
        license: review.license,
        integrity: source.integrity,
        archiveSha256: source.archiveSha256,
        manifestSha256: source.manifestSha256,
        licenses: review.licenses,
        attribution: policy.attributions[source.id] ?? null,
        obligations: policy.exceptions[source.id] ?? null,
        changeStatus: patchStatus(source.patch ?? undefined),
        patch: source.patch,
        addresses: [],
        files: [],
      };
      components.set(source.id, component);
    }
    component.addresses.push({ ...address });
  }
  for (const context of bundled)
    assert.ok(represented.has(context), `Missing bundled context: ${context}`);
  const permittedBlockedFiles: RuntimeFileRecord[] = [];
  const sourceFiles = new Map(
    closure.archives.map((item) => [item.id, new Map(item.files.map((file) => [file.path, file]))]),
  );
  const seen = new Set<string>();
  for (const file of plan.files) {
    assert.ok(!seen.has(file.path));
    seen.add(file.path);
    const address = addresses.find((item) => file.path.startsWith(`${item.path}/`));
    assert.ok(address, `Unmapped bundled file: ${file.path}`);
    const source = sourceFor(address.context);
    const local = file.path.slice(address.path.length + 1);
    const original = sourceFiles.get(source.id)?.get(local);
    assert.ok(original, `Unknown archive member: ${source.id}/${local}`);
    assert.equal(file.size, original.size);
    assert.equal(file.sha256, original.sha256);
    assert.ok(source.manifest);
    const bin = source.manifest.bin;
    const bins =
      typeof bin === "string" ? [bin] : bin && typeof bin === "object" ? Object.values(bin) : [];
    assert.equal(
      file.mode,
      original.mode & 0o111 ||
        bins.some((path) => typeof path === "string" && posix.normalize(path) === local)
        ? 0o755
        : 0o644,
    );
    assert.ok(
      !/\.(?:node(?:\.wasm)?|dylib|dll|so(?:\.\d+)*|exe)$/i.test(local),
      `Native bundle member: ${file.path}`,
    );
    if (local.endsWith(".wasm")) {
      const review = supply.packages[source.id];
      assert.ok(review);
      assertRuntimeWasmMember(
        source.id,
        source.archiveSha256,
        { ...file, path: local },
        review.license,
        policy.attributions[source.id],
      );
    }
    if (!runtimePathIsConveyable(file.path)) {
      assert.equal(source.id, "@anthropic-ai/sdk@0.129.0", `Blocked runtime path: ${file.path}`);
      assert.equal(
        source.archiveSha256,
        "dafba131471d2fe98faddbaed7fb8d590efa334dff881fdee6a0d8a6e1e2dfb2",
      );
      assert.match(
        local,
        /^(?:src\/)?lib\/credentials\/(?:credential-chain|identity-token|oidc-federation|token-cache|types|user-oauth)\.(?:js|mjs|d\.ts|d\.mts|ts)(?:\.map)?$/,
      );
      permittedBlockedFiles.push({ ...file });
    }
    const component = components.get(source.id);
    assert.ok(component);
    component.files.push({ ...file, context: address.context, archivePath: local });
  }
  assert.deepEqual(
    [...plan.blockedConveyancePaths].sort(),
    permittedBlockedFiles.map((file) => file.path).sort(),
  );
  assert.equal(runtimeFileTotal(plan.files), plan.totalBytes);
  const result: RuntimeConveyanceReceipt = {
    schemaVersion: 1,
    sourceName: plan.sourceName,
    sourceCommit: closure.sourceCommit,
    closureSha256: runtimeClosureDigest(closure),
    planSha256: hash(Buffer.from(JSON.stringify(plan))),
    licensePolicySha256: closure.inputs.licensePolicySha256,
    rootLicenseSha256: closure.inputs.rootLicenseSha256,
    components: [...components.values()].sort((a, b) =>
      a.archiveId.localeCompare(b.archiveId, "en"),
    ),
    external,
    permittedBlockedFiles,
  };
  freezeReceipt(result);
  return result;
}

async function attribution(
  root: string,
  id: string,
  policy: LicensePolicy,
  review: SupplyChain,
  seen = new Set<string>(),
): Promise<void> {
  assert.ok(!seen.has(id), `Attribution cycle ${id}`);
  seen.add(id);
  const source = policy.attributions[id];
  assert.ok(
    source?.evidence && source.source,
    `${id}: missing explicit upstream attribution review`,
  );
  for (const file of source.files) {
    assert.ok(
      file.path.startsWith("tools/unstale/licenses/") && !file.path.split("/").includes(".."),
    );
    const bytes = await readFile(resolve(root, file.path));
    assert.equal(hash(bytes), file.sha256, `Attribution text changed: ${id}`);
    const target = resolve(root, "dist/supply-chain/licenses", id.replaceAll("/", "__"), file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  if (source.inheritedFrom) {
    const parent = review.packages[source.inheritedFrom];
    assert.ok(parent, `${id}: missing attribution parent`);
    assert.equal(
      parent.license,
      review.packages[id]?.license,
      `${id}: attribution license mismatch`,
    );
    if (!Object.keys(parent.licenses).length)
      await attribution(root, source.inheritedFrom, policy, review, seen);
  } else assert.ok(source.files.length, `${id}: empty attribution`);
}

/** License expressions remain exact; do not accept arbitrary OR/AND expressions. */
export async function checkLicenses(root = repository, foundation = false): Promise<void> {
  const patches = await dependencyPatches(root);
  const review = await json<SupplyChain>(root, "tools/unstale/supply-chain.json");
  const policy = await json<LicensePolicy>(root, "tools/unstale/license-policy.json");
  const lock = await yaml<Lock>(root, "pnpm-lock.yaml");
  assert.equal(policy.format, 1);
  assert.deepEqual(policy.externalToolChain, [
    "wrangler@4.162.0",
    "miniflare@5.20261113.0-beta",
    "sharp@0.35.5",
  ]);
  for (const [from, name, version] of [
    ["wrangler@4.162.0", "miniflare", "5.20261113.0-beta"],
    ["miniflare@5.20261113.0-beta", "sharp", "0.35.5"],
  ]) {
    assert.ok(from && name && version);
    const nodes = Object.entries(lock.snapshots ?? {}).filter(([id]) => id.split("(")[0] === from);
    assert.ok(
      nodes.length &&
        nodes.every(([, node]) => node.dependencies?.[name]?.split("(")[0] === version),
      `External-tool chain changed at ${from}`,
    );
  }
  if (!foundation)
    for (const path of packagePaths) {
      const manifest = await json<Manifest>(root, `${path}/package.json`);
      for (const name of Object.keys(manifest.dependencies ?? {})) {
        if (name === "wrangler")
          assert.equal(
            path,
            "packages/fortipi-cli",
            "Wrangler may only be a separately spawned CLI tool",
          );
        assert.ok(
          !/^(?:sharp|@img\/sharp-|miniflare)/.test(name),
          `Native tool dependency entered own runtime: ${path}`,
        );
      }
    }
  for (const [id, rule] of Object.entries(policy.exceptions)) {
    assert.equal(
      rule.license,
      exactExceptions[id] ?? externalNative.get(id),
      `Unapproved license exception ${id}`,
    );
    assert.ok(rule.reason && rule.obligations.length >= 2, `Incomplete exact obligation ${id}`);
  }
  const inventory: unknown[] = [];
  const prohibitedBytes = new Map<string, string>();
  await mkdir(resolve(root, "dist/supply-chain/licenses"), { recursive: true });
  for (const id of Object.keys(lock.packages).sort()) {
    const record = review.packages[id];
    assert.ok(record, `Missing archive/license review ${id}`);
    assert.ok(
      allowed.has(record.license) ||
        (policy.exceptions[id]?.license === record.license &&
          (exactExceptions[id] === record.license || externalNative.get(id) === record.license)),
      `Disallowed or unknown license: ${id}: ${record.license}`,
    );
    const raw = await archive(record.name, record.version, record.integrity, root);
    assert.equal(hash(raw), record.archiveSha256);
    const entries = archiveEntries(raw);
    const patch = patches[id];
    if (patch) {
      for (const [path, identities] of Object.entries(patch.files)) {
        const original = entries.get(`package/${path}`);
        assert.ok(original, `Patched file absent from authenticated archive: ${id}/${path}`);
        assert.equal(
          hash(original),
          identities.originalSha256,
          `Patch base changed: ${id}/${path}`,
        );
      }
      const target = resolve(
        root,
        "dist/supply-chain/licenses",
        id.replaceAll("/", "__"),
        patch.path,
      );
      await mkdir(dirname(target), { recursive: true });
      await copyFile(resolve(root, patch.path), target);
    }
    const manifestBytes = [...entries].find(([path]) => /^[^/]+\/package.json$/.test(path))?.[1];
    assert.ok(manifestBytes, `Missing archive manifest ${id}`);
    assert.equal(hash(manifestBytes), record.manifestSha256, `Archive manifest changed ${id}`);
    const upstream = JSON.parse(manifestBytes.toString()) as Record<string, unknown>;
    assert.equal(upstream.name, record.name, `Archive name mismatch ${id}`);
    assert.equal(upstream.version, record.version, `Archive version mismatch ${id}`);
    assert.equal(upstream.license, record.license, `Archive license grant mismatch ${id}`);
    const componentInventory: Record<string, string> = {};
    if (externalNative.has(id))
      for (const path of ["package/README.md", "package/versions.json"]) {
        const bytes = entries.get(path);
        assert.ok(bytes, `Missing external-tool component evidence ${id}/${path}`);
        componentInventory[path] = hash(bytes);
        const target = resolve(
          root,
          "dist/supply-chain/external-tool-review",
          id.replaceAll("/", "__"),
          path,
        );
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes);
      }
    if (
      externalNative.has(id) ||
      ["wrangler@4.162.0", "miniflare@5.20261113.0-beta", "sharp@0.35.5"].includes(id)
    ) {
      for (const [path, bytes] of entries)
        if (
          /\.(?:node|dll|dylib|so(?:\.\d+)*|wasm|node\.js)$/.test(path) ||
          /(?:wrangler-dist|dist)\/.*\.js$/.test(path)
        )
          prohibitedBytes.set(hash(bytes), `${id}/${path}`);
    }
    const licenses = licenseEntries(entries);
    assert.deepEqual(licenses, record.licenses, `${id}: license/NOTICE archive inventory mismatch`);
    if (!Object.keys(licenses).length || externalNative.has(id))
      await attribution(root, id, policy, review);
    for (const [path, bytes] of entries)
      if (licenses[path]) {
        const target = resolve(root, "dist/supply-chain/licenses", id.replaceAll("/", "__"), path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes);
      }
    inventory.push({
      id,
      license: record.license,
      integrity: record.integrity,
      archiveSha256: record.archiveSha256,
      manifestSha256: record.manifestSha256,
      credits: {
        author: upstream.author ?? null,
        contributors: upstream.contributors ?? null,
        repository: upstream.repository ?? null,
        homepage: upstream.homepage ?? null,
        changeStatus: patchStatus(patch),
      },
      componentInventory,
      licenses,
      attribution: policy.attributions[id] ?? null,
      obligations: policy.exceptions[id] ?? null,
      distribution: externalNative.has(id)
        ? "external deployment tool only; native conveyance prohibited"
        : "review exact archive and preserve texts",
    });
  }
  await writeFile(
    resolve(root, "dist/supply-chain/inventory.json"),
    `${JSON.stringify({ format: 1, packages: inventory }, null, 2)}\n`,
  );
  if (foundation) {
    console.log(
      "License archives: full resolved development/runtime graph checked. Worker/CLI/image/candidate bundle evidence remains required.",
    );
    return;
  }
  const inspectOutputs = async (directory: string): Promise<void> => {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      assert.ok(
        !item.isSymbolicLink() && item.name !== "node_modules",
        `Vendor/link conveyance in own outputs: ${directory}/${item.name}`,
      );
      const path = resolve(directory, item.name);
      if (item.isDirectory()) await inspectOutputs(path);
      else {
        const bytes = await readFile(path);
        assert.ok(
          !prohibitedBytes.has(hash(bytes)),
          `External tool/native bytes copied into own output: ${path}`,
        );
        assert.ok(
          !/(?:libvips|sharp)[^/]*\.(?:node|dll|dylib|so|wasm)/i.test(item.name),
          `External native artifact: ${path}`,
        );
      }
    }
  };
  for (const path of packagePaths) await inspectOutputs(resolve(root, path, "dist"));
  await inspectOutputs(resolve(root, "apps/worker/dist/worker"));
  await inspectOutputs(resolve(root, "packages/fortipi-cli/worker-assets"));
  const metadata = await json<{ inputs: Record<string, unknown> }>(
    root,
    "apps/worker/dist/worker/metafile.json",
  );
  assert.ok(
    metadata.inputs && Object.keys(metadata.inputs).length,
    "Missing actual Worker bundle input inventory",
  );
  for (const path of Object.keys(metadata.inputs))
    assert.ok(
      !/(?:^|[\\/])(?:sharp|@img[\\/]sharp-[^/]*|miniflare|wrangler)(?:[\\/@]|$)/.test(path),
      `External tool imported into Worker: ${path}`,
    );
  const rootLicense = await readFile(resolve(root, "LICENSE"));
  for (const path of packagePaths) {
    assert.deepEqual(
      await readFile(resolve(root, path, "LICENSE")),
      rootLicense,
      `${path}: missing/exact root LICENSE`,
    );
    const notices = await readFile(resolve(root, path, "THIRD_PARTY_NOTICES.md"), "utf8");
    assert.ok(notices.trim().length > 0, `${path}: empty third-party notices`);
    const manifest = await json<Manifest>(root, `${path}/package.json`);
    assert.equal(manifest.license, "SEE LICENSE IN LICENSE");
  }
  // These byte inventories are produced by the actual packager, never metadata substitutes.
  const bundle = await json<{ files: { path: string; sha256: string }[] }>(
    root,
    "packages/fortipi-cli/worker-assets/asset-manifest.json",
  );
  assert.ok(bundle.files.length, "Missing Worker asset inventory");
  for (const file of bundle.files) {
    assert.ok(!file.path.startsWith("/") && !file.path.split(/[\\/]/).includes(".."));
    assert.equal(
      hash(await readFile(resolve(root, "packages/fortipi-cli/worker-assets", file.path))),
      file.sha256,
      `Bundled asset mismatch: ${file.path}`,
    );
  }
  // Preserve original text in the release inventory, not only SPDX names.
  await copyFile(resolve(root, "LICENSE"), resolve(root, "dist/supply-chain/LICENSE"));
  console.log(
    "License archives, publication notices and embedded Worker asset hashes verified; OS image inventory is a separate release gate",
  );
}

if (import.meta.main) await checkLicenses(rootArgument(), process.argv.includes("--foundation"));
