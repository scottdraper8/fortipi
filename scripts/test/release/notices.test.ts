import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after, before } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { parseAllDocuments, stringify } from "yaml";
import { archiveEntries, hash } from "../../../tools/unstale/review-supply-chain.ts";
import { packagePaths, repository } from "../../build-workspaces.ts";
import type { Lock, Manifest, SupplyChain } from "../../check-pins.ts";
import { generateNotices, type NoticeReceipt } from "../../generate-notices.ts";

let root: string;
let baseline: NoticeReceipt[];
async function copy(path: string) {
  const destination = resolve(root, path);
  await mkdir(dirname(destination), { recursive: true });
  await cp(resolve(repository, path), destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
    mode: constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
  });
}
async function files(path: string, prefix = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    assert.equal(entry.isSymbolicLink(), false);
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...(await files(join(path, entry.name), name)));
    else {
      assert.equal(entry.isFile(), true);
      found.push(name);
    }
  }
  return found.sort();
}
async function outputs() {
  const inventory: Record<string, string> = {};
  for (const directory of packagePaths) {
    for (const path of [
      "LICENSE",
      "THIRD_PARTY_NOTICES.md",
      ...(await files(resolve(root, directory, "licenses"))).map((path) => `licenses/${path}`),
    ])
      inventory[`${directory}/${path}`] = hash(await readFile(resolve(root, directory, path)));
  }
  return inventory;
}
before(async () => {
  root = await mkdtemp(join(tmpdir(), "fortipi-real-notices-"));
  // Exact reviewed public facts and SRI archives, never invented tarballs/licenses.
  for (const path of [
    "LICENSE",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "patches",
    "tools/unstale/supply-chain.json",
    "tools/unstale/license-policy.json",
    "tools/unstale/licenses",
    "dist/supply-chain/inventory.json",
    "dist/supply-chain/licenses",
    "dist/supply-chain/archives",
    ...packagePaths.map((path) => `${path}/package.json`),
  ])
    await copy(path);
});
after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

test("portable notice CLI preserves actual SRI/source texts, runtime scope and all five root licenses without producing Worker assets", async () => {
  const runner = promisify(execFile);
  await runner(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(pathToFileURL(resolve(repository, "scripts/generate-notices.ts")).href)})`,
    ],
    { cwd: root, timeout: 10000 },
  );
  await assert.rejects(
    readFile(resolve(root, "packages/fortipi-contract/THIRD_PARTY_NOTICES.md")),
    { code: "ENOENT" },
  );
  const result = await runner(
    process.execPath,
    [resolve(repository, "scripts/generate-notices.ts"), "--root", root],
    { cwd: tmpdir(), timeout: 120000, maxBuffer: 1048576 },
  );
  assert.equal(result.stderr, "");
  const receipt = JSON.parse(result.stdout) as { schemaVersion: number; packages: NoticeReceipt[] };
  assert.equal(receipt.schemaVersion, 1);
  baseline = receipt.packages;
  assert.deepEqual(
    baseline.map((item) => item.directory),
    packagePaths,
  );
  const byName = new Map(baseline.map((item) => [item.package, item]));
  assert.deepEqual(byName.get("fortipi-contract")?.components, []);
  const client = [
    "ajv@8.20.0",
    "fast-deep-equal@3.1.3",
    "fast-uri@3.1.9",
    "json-schema-traverse@1.0.0",
    "require-from-string@2.0.2",
  ];
  assert.deepEqual(byName.get("fortipi-client")?.components, client);
  assert.deepEqual(byName.get("fortipi-executor")?.components, client);
  assert.ok(byName.get("fortipi-tui")?.components.includes("@earendil-works/pi-tui@1.5.2"));
  for (const id of client)
    assert.ok(
      byName.get("fortipi-tui")?.components.includes(id),
      "Owned runtime dependency closure must carry client terms into TUI notices",
    );
  const rootLicense = await readFile(resolve(root, "LICENSE"));
  for (const item of baseline) {
    assert.deepEqual(await readFile(resolve(root, item.directory, "LICENSE")), rootLicense);
    assert.equal(item.licenseSha256, hash(rootLicense));
    const notices = await readFile(resolve(root, item.directory, "THIRD_PARTY_NOTICES.md"));
    assert.equal(hash(notices), item.noticeSha256);
    assert.equal(
      notices.includes(Buffer.from(root)),
      false,
      "Publication notices must be portable",
    );
    for (const id of item.components)
      assert.doesNotMatch(id, /^(?:@biomejs\/|typescript@|@pnpm\/|node-gyp@|@xterm\/)/);
    const names = await files(resolve(root, item.directory, "licenses"));
    assert.ok(
      names.every((name) => !/(?:\.node|\.wasm|\.dll|\.tgz|\.so|\.dylib|\.js)$/.test(name)),
      "Only original text is conveyed",
    );
  }
  const review = JSON.parse(
    await readFile(resolve(root, "tools/unstale/supply-chain.json"), "utf8"),
  ) as SupplyChain;
  const ajv = review.packages["ajv@8.20.0"];
  assert.ok(ajv);
  const archive = await readFile(
    resolve(root, `dist/supply-chain/archives/${hash(Buffer.from("ajv@8.20.0"))}.tgz`),
  );
  assert.deepEqual(
    await readFile(
      resolve(root, "packages/fortipi-client/licenses/ajv%408.20.0/archive/package/LICENSE"),
    ),
    archiveEntries(archive).get("package/LICENSE"),
  );
  const cli = await readFile(resolve(root, "packages/fortipi-cli/THIRD_PARTY_NOTICES.md"), "utf8");
  assert.ok(cli.includes("worker-assets/licenses/THIRD_PARTY_NOTICES.md"));
  assert.ok(cli.includes("wrangler@4.160.1"));
  assert.ok(cli.includes("@aws-sdk/credential-provider-http@3.972.86"));
  assert.ok(cli.includes('"inheritedFrom": "@aws-sdk/core@3.981.0"'));
  assert.ok(cli.includes("AWS SDK for JavaScript Team"));
  assert.ok(cli.includes("Apache-2.0 AND LGPL-3.0-or-later AND MIT"));
  assert.ok(cli.includes("not permission for native redistribution"));
  await assert.rejects(
    readFile(resolve(root, "packages/fortipi-cli/worker-assets/asset-manifest.json")),
    { code: "ENOENT" },
  );
  const before = await outputs();
  assert.deepEqual(await generateNotices(root), baseline);
  assert.deepEqual(
    await outputs(),
    before,
    "Identical checked inputs produce identical notices and text bytes",
  );
});

test("tampered archive, extracted text and inventory facts cannot replace any previously earned publication output", async () => {
  const before = await outputs();
  const cases = [
    {
      path: `dist/supply-chain/archives/${hash(Buffer.from("ajv@8.20.0"))}.tgz`,
      error: /Archive SRI mismatch/,
    },
    {
      path: "dist/supply-chain/licenses/ajv@8.20.0/package/LICENSE",
      error: /Checked license text changed/,
    },
    { path: "dist/supply-chain/inventory.json", error: /Checked inventory changed/ },
  ];
  for (const fault of cases) {
    const path = resolve(root, fault.path);
    const original = await readFile(path);
    try {
      if (fault.path.endsWith("inventory.json")) {
        const inventory = JSON.parse(original.toString()) as {
          packages: { id: string; license: string }[];
        };
        const component = inventory.packages.find((item) => item.id === "ajv@8.20.0");
        assert.ok(component);
        component.license = "Unreviewed pretend grant";
        await writeFile(path, JSON.stringify(inventory));
      } else await writeFile(path, Buffer.concat([original, Buffer.from("tampered")]));
      await assert.rejects(generateNotices(root), fault.error);
      assert.deepEqual(await outputs(), before);
    } finally {
      await writeFile(path, original);
    }
  }
});

test("missing original and inherited license facts fail closed instead of using SPDX labels or placeholder notices", async () => {
  const before = await outputs();
  for (const path of [
    "dist/supply-chain/licenses/ajv@8.20.0/package/LICENSE",
    "dist/supply-chain/licenses/@aws-sdk__core@3.981.0/package/LICENSE",
  ]) {
    const absolute = resolve(root, path);
    const original = await readFile(absolute);
    try {
      await rm(absolute);
      await assert.rejects(generateNotices(root), { code: "ENOENT" });
      assert.deepEqual(await outputs(), before);
    } finally {
      await writeFile(absolute, original);
    }
  }
});

test("a real modified component retains its original source MIT text alongside the patch", async () => {
  // Select the already-locked private Worker component in a disposable public
  // notice closure; actual public manifests and dependencies remain untouched.
  const name = "@earendil-works/pi-durable";
  const id = `${name}@1.5.2`;
  const manifestPath = resolve(root, "packages/fortipi-cli/package.json");
  const lockPath = resolve(root, "pnpm-lock.yaml");
  const manifestBytes = await readFile(manifestPath);
  const lockBytes = await readFile(lockPath);
  try {
    const manifest = JSON.parse(manifestBytes.toString()) as Manifest;
    manifest.dependencies ??= {};
    manifest.dependencies[name] = "1.5.2";
    const documents = parseAllDocuments(lockBytes.toString()).map(
      (document) => document.toJSON() as Lock,
    );
    const lock = documents[1];
    assert.ok(lock);
    const importer = lock.importers["packages/fortipi-cli"];
    const existing = lock.importers["apps/worker"]?.dependencies?.[name];
    assert.ok(importer && existing);
    importer.dependencies ??= {};
    importer.dependencies[name] = existing;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(lockPath, documents.map((document) => stringify(document)).join("---\n"));
    const receipts = await generateNotices(root);
    assert.ok(
      receipts.find((receipt) => receipt.package === "fortipi-cli")?.components.includes(id),
    );
    const directory = resolve(root, "packages/fortipi-cli/licenses", encodeURIComponent(id));
    const names = await files(directory);
    assert.ok(names.includes("patches/@earendil-works__pi-durable@1.5.2.patch"));
    const hashes = await Promise.all(
      names.map(async (name) => hash(await readFile(resolve(directory, name)))),
    );
    assert.ok(
      hashes.includes("0457f5bcec3b3b211605dfb5d1a49042fd638f3686a410fe099c24a25af13c48"),
      "Modification text cannot replace the independently authenticated original MIT text",
    );
  } finally {
    await writeFile(manifestPath, manifestBytes);
    await writeFile(lockPath, lockBytes);
    assert.deepEqual(await generateNotices(root), baseline);
  }
});
