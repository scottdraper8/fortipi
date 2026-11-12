// Build-time producer only; never execute a Worker, contact an account or collect credentials.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse } from "@babel/parser";
import { type Node, VISITOR_KEYS } from "@babel/types";
import { canonicalJson } from "fortipi-contract";
import { version as compilerVersion } from "typescript";
import { scanRootfs } from "../../../apps/worker/container/rootfs.ts";
import { dependencyPatches, patchStatus } from "../../../scripts/dependency-patches.ts";
import { hashFile, verifyKitInventory } from "../../../scripts/image-source-distribution.ts";
import type { AssetManifest } from "../src/asset-manifest.ts";
import { assetPath } from "../src/asset-manifest.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const git = async (...args: string[]) =>
  (await promisify(execFile)("git", args, { cwd: root, timeout: 15_000 })).stdout.trim();
const inside = (parent: string, path: string) => path.startsWith(`${parent}${sep}`);
const safe = assetPath;

export async function regularFiles(directory: string, prefix = ""): Promise<string[]> {
  const stat = await lstat(directory);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "Asset directory must be real");
  const result: string[] = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = resolve(directory, name);
    const local = prefix ? `${prefix}/${name}` : name;
    assert.ok(safe(local), "Unsafe asset path");
    const child = await lstat(path);
    assert.ok(!child.isSymbolicLink(), "Linked asset input");
    if (child.isDirectory()) result.push(...(await regularFiles(path, local)));
    else {
      assert.ok(child.isFile() && child.nlink === 1, "Special or hard-linked asset input");
      result.push(local);
    }
  }
  return result;
}

/** Inspect real emitted syntax, independently of the producer's module inventory. */
export async function workerClosure(directory: string, entry: string): Promise<string[]> {
  assert.ok(safe(entry), "Unsafe Worker entry");
  const all = new Set(await regularFiles(directory));
  const reached = new Set<string>();
  const required = [entry];
  const exports = new Set<string>();
  while (required.length) {
    const name = required.pop();
    assert.ok(name && all.has(name), "Missing emitted Worker dependency");
    if (reached.has(name)) continue;
    reached.add(name);
    if (!/\.(?:m?js)$/.test(name)) continue;
    const bytes = await readFile(resolve(directory, name), "utf8");
    const source = parse(bytes, { sourceType: "module", createImportExpressions: true });
    const dependency = (value: unknown) => {
      assert.ok(value && typeof value === "object", "Unbounded Worker module import");
      const literal = value as { type?: string; value?: unknown };
      assert.ok(
        literal.type === "StringLiteral" && typeof literal.value === "string",
        "Unbounded Worker module import",
      );
      const specifier = literal.value;
      if (/^(?:node:|cloudflare:|cloudflare-internal:)/.test(specifier)) return;
      assert.ok(
        specifier.startsWith("./") || specifier.startsWith("../"),
        "Bare or remote Worker import",
      );
      const path = resolve(directory, dirname(name), specifier);
      assert.ok(inside(directory, path), "Worker import escapes bundle");
      required.push(relative(directory, path).split(sep).join("/"));
    };
    const visit = (node: Node) => {
      if (node.type === "ImportDeclaration") dependency(node.source);
      if (node.type === "ExportNamedDeclaration") {
        if (node.source) dependency(node.source);
        if (name === entry)
          for (const item of node.specifiers) {
            if (item.type === "ExportSpecifier")
              exports.add(
                item.exported.type === "Identifier" ? item.exported.name : item.exported.value,
              );
          }
      }
      if (node.type === "ExportDefaultDeclaration" && name === entry) exports.add("default");
      // Runtime-selected loaders are service/runtime behavior, not statically emitted
      // dependencies. This does not certify lazy-loader reachability.
      if (node.type === "ImportExpression" && node.source.type === "StringLiteral")
        dependency(node.source);
      const record = node as unknown as Record<string, unknown>;
      for (const key of VISITOR_KEYS[node.type] ?? []) {
        const value = record[key];
        if (Array.isArray(value))
          for (const child of value) {
            if (child) visit(child as Node);
          }
        else if (value && typeof value === "object") visit(value as Node);
      }
    };
    visit(source);
  }
  for (const name of [
    "default",
    "ControlPlane",
    "AgentSession",
    "WorkspaceObject",
    "WorkspaceProxy",
    "LinuxContainerHost",
  ])
    assert.ok(exports.has(name), `Missing actual Worker export: ${name}`);
  for (const name of all)
    assert.ok(
      reached.has(name) ||
        name === "metafile.json" ||
        name === "README.md" ||
        name.endsWith(".map"),
      "Unexpected Worker output",
    );
  return [...reached].sort();
}

interface Meta {
  inputs: Record<string, { bytes: number }>;
  outputs: Record<string, { entryPoint?: string; exports: string[] }>;
}
interface Inventory {
  packages: {
    id: string;
    license: string;
    archiveSha256: string;
    manifestSha256: string;
    distribution: string;
  }[];
}

export async function packageWorkerAssets(options: {
  workerBuild: string;
  commit: string;
  version: string;
  /** Private test output only; the stable CLI always emits the canonical package tree. */
  outputDirectory?: string;
}): Promise<AssetManifest> {
  const patches = await dependencyPatches(root, true);
  assert.equal(process.versions.node, "26.13.1", "Pinned Node required");
  assert.match(options.commit, /^[a-f0-9]{40}$/);
  assert.equal(await git("rev-parse", "HEAD"), options.commit, "Checkout commit differs");
  await git(
    "diff",
    "--exit-code",
    "HEAD",
    "--",
    "apps/worker/src",
    "apps/worker/wrangler.jsonc",
    "apps/worker/wrangler.container.template.json",
    "packages/fortipi-contract",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "patches",
  );
  const build = resolve(root, options.workerBuild);
  assert.equal(await realpath(build), build, "Worker build must be canonical");
  assert.equal(
    build,
    resolve(root, "apps/worker/dist/worker"),
    "Canonical Worker producer required",
  );
  const manifest = await json(resolve(root, "package.json"));
  const cli = await json(resolve(root, "packages/fortipi-cli/package.json"));
  const wranglerPackage = await json(
    resolve(root, "apps/worker/node_modules/wrangler/package.json"),
  );
  assert.equal(options.version, manifest.version);
  assert.equal(options.version, cli.version);
  assert.equal(wranglerPackage.version, "4.161.0");
  assert.equal(compilerVersion, manifest.devDependencies.typescript);
  const { verifyPnpmExecutable, pnpmExecutable } = await import(
    "../../../scripts/pnpm-executable.ts"
  );
  await verifyPnpmExecutable(await pnpmExecutable());
  const metadata = (await json(resolve(build, "metafile.json"))) as Meta;
  assert.ok(Object.keys(metadata.inputs).length > 0, "Real Worker metafile required");
  const outputs = Object.entries(metadata.outputs).filter(([, value]) =>
    value.entryPoint?.replaceAll("\\", "/").endsWith("src/index.ts"),
  );
  assert.equal(outputs.length, 1, "Actual Worker entry must be unambiguous");
  const workerRoot = resolve(root, "apps/worker");
  const output = outputs[0];
  assert.ok(output);
  const entryPath = resolve(workerRoot, output[0]);
  assert.ok(inside(build, entryPath));
  const entry = relative(build, entryPath).split(sep).join("/");
  const closure = await workerClosure(build, entry);
  const inventory = (await json(resolve(root, "dist/supply-chain/inventory.json"))) as Inventory;
  const packages = new Set<string>();
  const ownedInputs: string[] = [];
  assert.ok(
    Object.keys(metadata.inputs).some(
      (name) => resolve(workerRoot, name) === resolve(workerRoot, "src/index.ts"),
    ),
    "Actual Worker entry source is missing from producer metadata",
  );
  for (const name of Object.keys(metadata.inputs)) {
    if (
      name.startsWith("\0") ||
      /^(?:node:|cloudflare:|cloudflare-internal:|node-built-in-modules:)/.test(name)
    )
      continue; // Known Wrangler host virtual modules have no package bytes.
    const path = resolve(workerRoot, name);
    assert.ok(inside(root, path), "Worker input escaped repository");
    assert.ok(inside(root, await realpath(path)), "Worker input resolved outside checkout");
    const stat = await lstat(path);
    assert.ok(
      stat.isFile() && !stat.isSymbolicLink() && stat.size === metadata.inputs[name]?.bytes,
      "Worker input differs from producer metadata",
    );
    // The root build compiles contract/dist with the pinned compiler before bundling.
    // Its tracked sources/schemas are covered by the whole-contract clean-tree check.
    if (
      !path.includes(`${sep}node_modules${sep}`) &&
      !inside(resolve(root, "packages/fortipi-contract/dist"), path)
    )
      ownedInputs.push(relative(root, path));
    let parent = dirname(path);
    while (inside(root, parent)) {
      try {
        const pkg = await json(resolve(parent, "package.json"));
        if (!String(pkg.name).startsWith("fortipi") && pkg.name !== "@fortipi/worker") {
          const id = `${pkg.name}@${pkg.version}`;
          const reviewed = inventory.packages.find((p) => p.id === id);
          assert.ok(
            reviewed && !/external deployment tool/.test(reviewed.distribution),
            "Unreviewed or deployment-tool Worker input",
          );
          packages.add(id);
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      parent = dirname(parent);
    }
  }
  assert.ok(ownedInputs.length > 0);
  await git("ls-files", "--error-unmatch", "--", ...ownedInputs);
  await git("diff", "--exit-code", "HEAD", "--", ...ownedInputs);
  const destination = options.outputDirectory
    ? resolve(options.outputDirectory)
    : resolve(root, "packages/fortipi-cli/worker-assets");
  assert.ok(
    !options.outputDirectory || inside(resolve(root, "dist"), destination),
    "Test output must remain in ignored build storage",
  );
  const stage = await mkdtemp(resolve(root, "packages/fortipi-cli/.worker-assets-"));
  const records: AssetManifest["files"] = [];
  let imageRecord: AssetManifest["image"];
  const put = async (
    path: string,
    bytes: Uint8Array | string,
    kind: AssetManifest["files"][number]["kind"],
  ) => {
    assert.ok(safe(path) && !records.some((r) => r.path === path), "Unsafe or duplicate asset");
    assert.ok(
      !/(?:^|\/)(?:\.env|auth\.json|node_modules|\.wrangler)(?:\/|$)/.test(path),
      "Forbidden asset",
    );
    if (typeof bytes === "string") assert.ok(!bytes.includes(root), "Machine path in asset");
    await mkdir(dirname(resolve(stage, path)), { recursive: true, mode: 0o755 });
    await writeFile(resolve(stage, path), bytes, { flag: "wx", mode: 0o644 });
    records.push({ path, kind, size: Buffer.byteLength(bytes), sha256: sha256(bytes) });
  };
  try {
    for (const name of closure) {
      const bytes = await readFile(resolve(build, name));
      await put(
        `worker/${name}`,
        /\.m?js$/.test(name)
          ? bytes.toString().replace(/^\/\/# sourceMappingURL=.*(?:\r?\n|$)/gm, "")
          : bytes,
        "worker",
      );
    }
    const { unstable_readConfig } = await import("wrangler");
    const config = unstable_readConfig(
      { config: resolve(workerRoot, "wrangler.jsonc") },
      { preserveOriginalMain: true },
    );
    const fields = [
      "compatibility_date",
      "compatibility_flags",
      "workers_dev",
      "durable_objects",
      "migrations",
      "ai",
      "rules",
      "find_additional_modules",
      "observability",
      "limits",
    ] as const;
    const base: Record<string, unknown> = {};
    for (const key of fields) if (config[key] !== undefined) base[key] = config[key];
    base.main = `./assets/worker/${entry}`;
    base.no_bundle = true;
    base.find_additional_modules = true;
    await put("templates/wrangler.base.json", `${canonicalJson(base)}\n`, "template");
    const overlay = await json(resolve(workerRoot, "wrangler.container.template.json"));
    assert.ok(
      Object.keys(overlay).every((k) =>
        ["compatibility_flags", "durable_objects", "migrations", "containers"].includes(k),
      ),
      "Unexpected Linux template field",
    );
    for (const container of overlay.containers) {
      assert.equal(container.images.computerd.dockerfile, "./container/Dockerfile");
      assert.equal(container.images.computerd.build_context, "./container");
      container.images.computerd = {
        dockerfile: "./assets/linux/container/Dockerfile",
        build_context: "./assets/linux/container",
      };
    }
    await put("templates/wrangler.container.json", `${canonicalJson(overlay)}\n`, "template");
    const schemas = resolve(root, "packages/fortipi-contract/schemas");
    for (const name of await regularFiles(schemas))
      await put(`contracts/schemas/${name}`, await readFile(resolve(schemas, name)), "contract");
    const openapi = await readFile(resolve(root, "packages/fortipi-contract/openapi.yaml"));
    JSON.parse(openapi.toString());
    await put("contracts/openapi.json", openapi, "contract");
    // Missing canonical image/context blocks a complete package; no substitute is emitted.
    const imagePath = resolve(workerRoot, "dist/container/image-metadata.json");
    try {
      const image = await json(imagePath);
      assert.equal(image.schemaVersion, 1);
      assert.match(image.imageId, /^sha256:[a-f0-9]{64}$/);
      assert.match(image.builtManifestDigest, /^sha256:[a-f0-9]{64}$/);
      assert.equal(image.builtManifestSource, "docker-save-oci");
      assert.equal(image.platform, "linux/amd64");
      assert.equal(image.registryDigest, null, "Registry image handoff needs separate review");
      assert.match(image.sourceCommit, /^[a-f0-9]{40}$/);
      await git("diff", "--exit-code", image.sourceCommit, "HEAD", "--", "apps/worker/container");
      assert.equal(
        image.freezeSha256,
        sha256(await readFile(resolve(workerRoot, "container/debian-freeze.json"))),
      );
      const context = resolve(workerRoot, "dist/container/context");
      // A fresh asset inventory cannot bind changed inputs to an already-built
      // image. Use the exact source kit recorded by that image, not today's kit.
      const kit = resolve(workerRoot, "dist/container/sources-and-notices.tar");
      assert.match(image.sourceKitSha256, /^[a-f0-9]{64}$/);
      assert.equal(await hashFile(kit), image.sourceKitSha256, "Image source-kit changed");
      const conveyed = await scanRootfs(
        createReadStream(kit),
        undefined,
        new Set(["source-kit-inventory.json", "source-revision.json"]),
      );
      const inventoryBytes = conveyed.get("source-kit-inventory.json")?.data;
      const revisionBytes = conveyed.get("source-revision.json")?.data;
      assert.ok(inventoryBytes && revisionBytes, "Image source-kit records missing");
      verifyKitInventory(conveyed, JSON.parse(inventoryBytes.toString()));
      const revision = JSON.parse(revisionBytes.toString());
      assert.equal(revision.sourceCommit, image.sourceCommit, "Image source-kit revision differs");
      assert.equal(revision.recipeMatchesCommit, true, "Image source-kit is construction-only");
      assert.equal(
        conveyed.get("fortipi-source.tar")?.sha256,
        revision.sourceArchiveSha256,
        "Image source-kit source archive changed",
      );
      assert.equal(
        conveyed.get("source-kit-recipe/debian-freeze.json")?.sha256,
        image.freezeSha256,
        "Image source-kit package freeze differs",
      );
      assert.deepEqual(
        await readFile(resolve(context, "Dockerfile")),
        await readFile(resolve(workerRoot, "container/Dockerfile")),
        "Image context recipe changed",
      );
      const freeze = (await json(resolve(workerRoot, "container/debian-freeze.json"))) as {
        packages: { name: string; sha256: string }[];
      };
      const recipeHash = conveyed.get("source-kit-recipe/Dockerfile")?.sha256;
      assert.ok(recipeHash, "Image source-kit recipe missing");
      const expectedContext = new Map<string, string>([
        ["Dockerfile", recipeHash],
        ...freeze.packages.map((p): [string, string] => [`packages/${p.name}.deb`, p.sha256]),
        ...[...conveyed].flatMap(([path, entry]): [string, string][] =>
          path.startsWith("context/notices/") && entry.type === "File" && entry.sha256
            ? [[path.slice("context/".length), entry.sha256]]
            : [],
        ),
      ]);
      const contextFiles = await regularFiles(context);
      assert.deepEqual(
        [...contextFiles].sort(),
        [...expectedContext.keys()].sort(),
        "Image context/source-kit member closure changed",
      );
      for (const name of contextFiles) {
        const bytes = await readFile(resolve(context, name));
        assert.equal(sha256(bytes), expectedContext.get(name), `Image context changed: ${name}`);
        await put(`linux/container/${name}`, bytes, "linux");
      }
      const imageBytes = `${canonicalJson(image)}\n`;
      await put("linux/image-metadata.json", imageBytes, "linux");
      imageRecord = {
        sourceCommit: image.sourceCommit,
        imageId: image.imageId,
        builtManifestDigest: image.builtManifestDigest,
        registryDigest: null,
        platform: "linux/amd64",
        metadataSha256: sha256(imageBytes),
        contextInventorySha256: "",
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new Error("Actual Linux image metadata/context producer handoff required");
      throw error;
    }
    const notices: string[] = [
      "# Bundled Worker notices",
      "",
      "Original license texts accompany the exact inputs listed below.",
      "",
    ];
    for (const id of [...packages].sort()) {
      const reviewed = inventory.packages.find((p) => p.id === id);
      assert.ok(reviewed);
      const source = resolve(root, "dist/supply-chain/licenses", id.replaceAll("/", "__"));
      const texts = await regularFiles(source);
      assert.ok(texts.length, "Missing reviewed bundled license text");
      const component = id.replace(/[^A-Za-z0-9_.-]/g, "_");
      for (const name of texts)
        await put(
          `licenses/${component}/${name}`,
          await readFile(resolve(source, name)),
          "license",
        );
      notices.push(
        `- ${id}: ${reviewed.license}; original archive SHA256 ${reviewed.archiveSha256}; ${patchStatus(patches[id])}`,
      );
    }
    await put("licenses/THIRD_PARTY_NOTICES.md", `${notices.join("\n")}\n`, "license");
    await put("licenses/FortiPi-LICENSE", await readFile(resolve(root, "LICENSE")), "license");
    const result: AssetManifest = {
      schemaVersion: 1,
      packageVersion: options.version,
      sourceCommit: options.commit,
      toolchain: {
        node: manifest.fortipi.toolchain.node,
        pnpm: manifest.fortipi.toolchain.pnpm,
        wrangler: wranglerPackage.version,
        compiler: compilerVersion,
      },
      lockSha256: sha256(await readFile(resolve(root, "pnpm-lock.yaml"))),
      entry: `worker/${entry}`,
      ...(imageRecord ? { image: imageRecord } : {}),
      files: records.sort((a, b) => a.path.localeCompare(b.path, "en")),
    };
    // The consumer uses bytewise POSIX ordering rather than locale collation.
    result.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    assert.equal(
      new Set(result.files.map((r) => r.path.toLowerCase())).size,
      result.files.length,
      "Case-colliding asset paths",
    );
    if (result.image)
      result.image.contextInventorySha256 = sha256(
        canonicalJson(result.files.filter((r) => r.path.startsWith("linux/container/"))),
      );
    await writeFile(resolve(stage, "asset-manifest.json"), `${canonicalJson(result)}\n`, {
      flag: "wx",
      mode: 0o644,
    });
    await chmod(stage, 0o755);
    await rm(destination, { recursive: true, force: true });
    await rename(stage, destination);
    return result;
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  assert.equal(args.length, 6);
  assert.deepEqual([args[0], args[2], args[4]], ["--worker-build", "--commit-sha", "--version"]);
  const [workerBuild, commit, version] = [args[1], args[3], args[5]];
  assert.ok(workerBuild && commit && version);
  const manifest = await packageWorkerAssets({ workerBuild, commit, version });
  console.log(
    JSON.stringify({
      entry: manifest.entry,
      files: manifest.files.length,
      sourceCommit: manifest.sourceCommit,
    }),
  );
}
