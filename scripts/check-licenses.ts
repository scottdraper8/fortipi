import assert from "node:assert/strict";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { LicensePolicy } from "../tools/unstale/review-attributions.ts";
import {
  archive,
  archiveEntries,
  hash,
  licenseEntries,
} from "../tools/unstale/review-supply-chain.ts";
import { packagePaths, repository } from "./build-workspaces.ts";
import type { Lock, Manifest, SupplyChain } from "./check-pins.ts";
import { json, rootArgument, yaml } from "./check-pins.ts";

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
    if (!Object.keys(parent.licenses).length)
      await attribution(root, source.inheritedFrom, policy, review, seen);
  } else assert.ok(source.files.length, `${id}: empty attribution`);
}

/** License expressions remain exact; do not accept arbitrary OR/AND expressions. */
export async function checkLicenses(root = repository, foundation = false): Promise<void> {
  const review = await json<SupplyChain>(root, "tools/unstale/supply-chain.json");
  const policy = await json<LicensePolicy>(root, "tools/unstale/license-policy.json");
  const lock = await yaml<Lock>(root, "pnpm-lock.yaml");
  assert.equal(policy.format, 1);
  assert.deepEqual(policy.externalToolChain, [
    "wrangler@4.160.0",
    "miniflare@5.20261110.0-beta",
    "sharp@0.35.5",
  ]);
  for (const [from, name, version] of [
    ["wrangler@4.160.0", "miniflare", "5.20261110.0-beta"],
    ["miniflare@5.20261110.0-beta", "sharp", "0.35.5"],
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
    const manifestBytes = [...entries].find(([path]) => /^[^/]+\/package.json$/.test(path))?.[1];
    assert.ok(manifestBytes, `Missing archive manifest ${id}`);
    const upstream = JSON.parse(manifestBytes.toString()) as Record<string, unknown>;
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
      ["wrangler@4.160.0", "miniflare@5.20261110.0-beta", "sharp@0.35.5"].includes(id)
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
        changeStatus: "unmodified upstream archive",
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
