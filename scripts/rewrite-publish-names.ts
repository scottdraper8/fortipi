import assert from "node:assert/strict";
import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { parse } from "@babel/parser";
import { type Node, VISITOR_KEYS } from "@babel/types";
import { assetPath } from "../packages/fortipi-cli/src/asset-manifest.ts";
import { packagePaths, repository } from "./build-workspaces.ts";

type Names = Readonly<Record<string, string>>;
type Json = Record<string, unknown>;
export interface RewriteOptions {
  root?: string;
  destination: string;
  scope: string;
  version: string;
}
export interface StageReceipt {
  schemaVersion: 1;
  scope: string;
  version: string;
  packages: { name: string; directory: string; files: { path: string; sha256: string }[] }[];
  assetManifestSha256: string;
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const sources = packagePaths.map((path) => path.slice("packages/".length));
const moduleFile = /\.(?:[cm]?js|d\.[cm]?ts)$/;
const exactVersion =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*))*)?(?:\+[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?$/;
const inside = (parent: string, path: string) =>
  path === parent || path.startsWith(`${parent}${sep}`);
function safe(path: string): string {
  assert.ok(
    assetPath(path) &&
      !/(^|\/)(?:node_modules|\.git|\.wrangler|\.env[^/]*|auth\.json)(?:\/|$)/i.test(path),
    `Unsafe publication path: ${path}`,
  );
  return path;
}
async function parents(path: string): Promise<void> {
  if (dirname(path) !== path) await parents(dirname(path));
  const stat = await lstat(path);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), `Linked/non-directory parent: ${path}`);
}
async function files(root: string, prefix = ""): Promise<string[]> {
  await parents(root);
  const result: string[] = [];
  for (const name of (await readdir(root)).sort()) {
    const local = safe(prefix ? `${prefix}/${name}` : name);
    const path = resolve(root, name);
    const stat = await lstat(path);
    assert.ok(!stat.isSymbolicLink(), `Linked publication input: ${local}`);
    if (stat.isDirectory()) result.push(...(await files(path, local)));
    else {
      assert.ok(stat.isFile() && stat.nlink === 1, `Nonregular publication input: ${local}`);
      result.push(local);
    }
  }
  assert.equal(
    new Set(result.map((p) => p.toLowerCase())).size,
    result.length,
    "Path case collision",
  );
  return result;
}
async function bytes(path: string): Promise<Buffer> {
  await parents(dirname(path));
  const stat = await lstat(path);
  assert.ok(
    stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1,
    `Nonregular file: ${path}`,
  );
  return readFile(path);
}
async function json(path: string): Promise<Json> {
  const value: unknown = JSON.parse((await bytes(path)).toString("utf8"));
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "Expected JSON object");
  return value as Json;
}
function visit(node: Node, fn: (node: Node) => void): void {
  fn(node);
  for (const key of VISITOR_KEYS[node.type] ?? []) {
    const value: unknown = (node as unknown as Json)[key];
    for (const child of Array.isArray(value) ? value : [value])
      if (child && typeof child === "object" && "type" in child) visit(child as Node, fn);
  }
}
function ast(source: string, path: string) {
  return parse(source, {
    sourceType: "unambiguous",
    createImportExpressions: true,
    plugins: /\.d\.[cm]?ts$/.test(path) ? [["typescript", { dts: true }]] : [],
  });
}
function method(node: Node): boolean {
  if (node.type === "Identifier") return node.name === "require";
  if (node.type !== "MemberExpression" && node.type !== "OptionalMemberExpression") return false;
  const object = node.object;
  const loader =
    (object.type === "Identifier" && ["require", "module"].includes(object.name)) ||
    (object.type === "MetaProperty" &&
      object.meta.name === "import" &&
      object.property.name === "meta") ||
    (object.type === "CallExpression" &&
      object.callee.type === "Identifier" &&
      object.callee.name === "createRequire");
  if (!loader) return false;
  const property =
    !node.computed && node.property.type === "Identifier"
      ? node.property.name
      : node.property.type === "StringLiteral"
        ? node.property.value
        : undefined;
  assert.ok(property && ["resolve", "require"].includes(property), "Unsupported module resolver");
  return true;
}
function positions(tree: Node, embedded: boolean): Node[] {
  const result: Node[] = [];
  const add = (node: Node | null | undefined) => {
    assert.ok(node, "Missing module specifier");
    if (node.type !== "StringLiteral") {
      assert.ok(embedded, "Computed module reference in outer package");
      return; // Existing immutable Worker runtime loaders are the producer's responsibility.
    }
    result.push(node);
  };
  visit(tree, (node) => {
    if (node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration") add(node.source);
    if (node.type === "ExportNamedDeclaration" && node.source) add(node.source);
    if (node.type === "ImportExpression") add(node.source);
    if (
      (node.type === "CallExpression" || node.type === "OptionalCallExpression") &&
      method(node.callee)
    ) {
      assert.ok(node.arguments.length === 1, "Unsupported module resolver arguments");
      add(node.arguments[0]);
    }
    if (node.type === "TSImportType") add(node.source);
    if (node.type === "TSExternalModuleReference") add(node.expression);
    if (node.type === "TSModuleDeclaration" && node.id.type === "StringLiteral") add(node.id);
  });
  return result;
}
function mapped(value: string, names: Names): string {
  assert.ok(
    !/^(?:workspace|file|link|catalog|npm):/.test(value),
    `Linked/aliased module reference: ${value}`,
  );
  for (const [name, target] of Object.entries(names)) {
    if (value === name || value.startsWith(`${name}/`)) return target + value.slice(name.length);
    assert.ok(
      !(
        value.startsWith(`npm:${name}@`) ||
        value.endsWith(`/${name}`) ||
        value.includes(`/${name}/`)
      ) ||
        value === target ||
        value.startsWith(`${target}/`),
      `Unsupported internal module alias: ${value}`,
    );
  }
  return value;
}
/** A second enumeration of literal module fields, independent of the edit-span collector. */
export function assertNoSourceReferences(source: string, path: string, names: Names): void {
  const tree = ast(source, path);
  visit(tree, (node) => {
    for (const [field, value] of Object.entries(node)) {
      if (!value || typeof value !== "object" || value.type !== "StringLiteral") continue;
      const module =
        (field === "source" &&
          [
            "ImportDeclaration",
            "ExportAllDeclaration",
            "ExportNamedDeclaration",
            "ImportExpression",
            "TSImportType",
          ].includes(node.type)) ||
        (field === "expression" && node.type === "TSExternalModuleReference") ||
        (field === "id" && node.type === "TSModuleDeclaration");
      if (module)
        assert.equal(mapped(value.value, names), value.value, `Residual source module in ${path}`);
    }
    if (
      (node.type === "CallExpression" || node.type === "OptionalCallExpression") &&
      method(node.callee)
    )
      for (const argument of node.arguments)
        if (argument.type === "StringLiteral")
          assert.equal(
            mapped(argument.value, names),
            argument.value,
            `Residual resolver module in ${path}`,
          );
  });
}
/** Rewrite syntax-owned module literals only; ordinary data and comments retain their bytes. */
export function rewriteModuleSource(
  source: string,
  path: string,
  names: Names,
  embedded = false,
): string {
  const tree = ast(source, path);
  const edits: { start: number; end: number; text: string }[] = [];
  for (const node of positions(tree, embedded)) {
    assert.ok(
      node.type === "StringLiteral" &&
        typeof node.start === "number" &&
        typeof node.end === "number",
    );
    const target = mapped(node.value, names);
    if (embedded) assert.equal(target, node.value, `Unbundled internal Worker module: ${path}`);
    else if (target !== node.value)
      edits.push({ start: node.start, end: node.end, text: JSON.stringify(target) });
  }
  for (const comment of tree.comments ?? []) {
    if (/^\s*\/\s*<reference\b/.test(comment.value))
      assert.ok(
        !sources.some((name) => comment.value.includes(name)),
        `Unsupported internal reference directive: ${path}`,
      );
    if (!embedded && /^\s*[#@]\s*sourceMappingURL\s*=/.test(comment.value)) {
      assert.ok(typeof comment.start === "number" && typeof comment.end === "number");
      edits.push({ start: comment.start, end: comment.end, text: "" });
    }
  }
  edits.sort((a, b) => b.start - a.start);
  let end = source.length;
  for (const edit of edits) {
    assert.ok(edit.end <= end, "Overlapping module edits");
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
    end = edit.start;
  }
  assertNoSourceReferences(source, path, names);
  return source;
}
function manifest(source: Json, names: Names, version: string): Json {
  assert.ok(
    typeof source.name === "string" && names[source.name],
    "Unexpected source package name",
  );
  assert.equal(source.version, version, "Candidate/source version disagreement");
  assert.equal(source.type, "module");
  assert.equal(source.license, "SEE LICENSE IN LICENSE");
  const publish = source.publishConfig as Json | undefined;
  assert.ok(
    publish?.access === "public" && !Object.hasOwn(publish, "directory"),
    "Public publication config required",
  );
  const result = structuredClone(source);
  result.name = names[source.name];
  result.version = version;
  delete result.scripts;
  delete result.devDependencies;
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    if (!source[field]) continue;
    const dependencies = source[field];
    assert.ok(typeof dependencies === "object" && !Array.isArray(dependencies));
    const output: Json = {};
    for (const [name, spec] of Object.entries(dependencies)) {
      const target = mapped(name, names);
      assert.ok(!Object.hasOwn(output, target), "Dependency namespace collision");
      assert.ok(typeof spec === "string", "Invalid dependency version");
      if (names[name]) {
        assert.ok(
          spec === "workspace:*" || spec === version,
          "Unexpected internal dependency version",
        );
        output[target] = version;
      } else {
        assert.ok(exactVersion.test(spec), `Nonexact dependency: ${name}`);
        output[target] = spec;
      }
    }
    result[field] = output;
  }
  if (source.peerDependenciesMeta) {
    assert.ok(
      typeof source.peerDependenciesMeta === "object" &&
        !Array.isArray(source.peerDependenciesMeta),
    );
    result.peerDependenciesMeta = Object.fromEntries(
      Object.entries(source.peerDependenciesMeta).map(([key, value]) => [
        mapped(key, names),
        value,
      ]),
    );
  }
  const metadata = (value: unknown): unknown => {
    if (typeof value === "string") {
      assert.ok(
        !/^(?:workspace|file|link|catalog|npm):/.test(value),
        "Linked/aliased module metadata",
      );
      return mapped(value, names);
    }
    if (Array.isArray(value)) return value.map(metadata);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [mapped(key, names), metadata(item)]),
      );
    return value;
  };
  for (const field of [
    "imports",
    "exports",
    "main",
    "module",
    "types",
    "typings",
    "typesVersions",
    "browser",
  ])
    if (source[field]) result[field] = metadata(source[field]);
  assert.ok(
    !source.bundledDependencies && !source.bundleDependencies,
    "Unsupported outer dependency bundle",
  );
  return result;
}
/** Data-only staging. The caller must build and verify final source/assets before invoking this port. */
export async function rewritePublishNames(options: RewriteOptions): Promise<StageReceipt> {
  const root = resolve(options.root ?? repository);
  await parents(root);
  assert.ok(
    /^[a-z0-9][a-z0-9._-]*$/.test(options.scope) && options.scope.length <= 214,
    "Invalid personal scope",
  );
  assert.ok(exactVersion.test(options.version), "Invalid exact candidate version");
  const foundation = await json(resolve(root, "package.json"));
  assert.equal(foundation.version, options.version, "Candidate/root version disagreement");
  const names = (foundation.fortipi as Json | undefined)?.publishNames;
  assert.deepEqual(
    names,
    Object.fromEntries(sources.map((name) => [name, `@{scope}/${name}`])),
    "Foundation publication map drift",
  );
  const resolved = Object.fromEntries(sources.map((name) => [name, `@${options.scope}/${name}`]));
  assert.ok(
    Object.values(resolved).every((name) => name.length <= 214),
    "Publication name too long",
  );
  const destination = resolve(options.destination);
  assert.ok(isAbsolute(options.destination), "Absolute staging destination required");
  assert.ok(
    !inside(destination, root) &&
      (!inside(root, destination) || inside(resolve(root, ".agent-docs/tmp/release"), destination)),
    "Stage overlaps source tree",
  );
  await parents(dirname(destination));
  await mkdir(destination, { mode: 0o700 }); // Exclusive: never replace or reuse an existing candidate.
  try {
    const { verifyAssets } = await import("../packages/fortipi-cli/dist/assets.js");
    const assetRoot = resolve(root, "packages/fortipi-cli/worker-assets");
    const assets = await verifyAssets(assetRoot);
    assert.equal(
      assets.manifest.packageVersion,
      options.version,
      "Candidate/embedded version disagreement",
    );
    const rootLicense = await bytes(resolve(root, "LICENSE"));
    const receipt: StageReceipt = {
      schemaVersion: 1,
      scope: options.scope,
      version: options.version,
      packages: [],
      assetManifestSha256: assets.manifestSha256,
    };
    for (const path of packagePaths) {
      const source = resolve(root, path);
      const input = await json(resolve(source, "package.json"));
      assert.equal(input.name, path.slice("packages/".length));
      const output = manifest(input, resolved, options.version);
      assert.ok(
        Array.isArray(input.files) && input.files.every((p) => typeof p === "string"),
        "Explicit publication files required",
      );
      const allowed = input.files as string[];
      const expected = [
        "dist",
        "README.md",
        "LICENSE",
        "THIRD_PARTY_NOTICES.md",
        "licenses",
        ...(path.endsWith("-contract") ? ["schemas", "openapi.yaml"] : []),
        ...(path.endsWith("-cli") ? ["templates", "worker-assets"] : []),
      ];
      assert.deepEqual([...allowed].sort(), expected.sort(), "Publication allowlist drift");
      assert.deepEqual(
        await bytes(resolve(source, "LICENSE")),
        rootLicense,
        "Root SUL bytes required",
      );
      const stage = resolve(destination, path.slice("packages/".length));
      await mkdir(stage);
      for (const entry of allowed) {
        safe(entry);
        const stat = await lstat(resolve(source, entry));
        assert.ok(!stat.isSymbolicLink(), "Linked publication root");
        const list = stat.isDirectory() ? await files(resolve(source, entry), entry) : [entry];
        assert.ok(list.length > 0 || entry === "licenses", `Empty publication input: ${entry}`);
        if (entry === "licenses") await mkdir(resolve(stage, entry));
        for (const local of list) {
          const embedded = local.startsWith("worker-assets/");
          if (!embedded && local.endsWith(".map")) continue;
          const original = await bytes(resolve(source, local));
          let transformed = original;
          if (moduleFile.test(local) && (!embedded || local.startsWith("worker-assets/worker/"))) {
            assert.ok(isUtf8(original), "Non-UTF8 emitted module");
            transformed = Buffer.from(
              rewriteModuleSource(original.toString("utf8"), local, resolved, embedded),
            );
          }
          const target = resolve(stage, local);
          await mkdir(dirname(target), { recursive: true });
          await copyFile(resolve(source, local), target, constants.COPYFILE_EXCL);
          if (!transformed.equals(original)) await writeFile(target, transformed);
        }
      }
      await writeFile(resolve(stage, "package.json"), `${JSON.stringify(output, null, 2)}\n`, {
        flag: "wx",
      });
      const inventory = await files(stage);
      // Every concrete public entry must exist after removing outer maps.
      const entries = (value: unknown): string[] =>
        typeof value === "string"
          ? [value]
          : value && typeof value === "object"
            ? Object.values(value).flatMap(entries)
            : [];
      for (const field of ["exports", "bin", "main", "module", "types", "typings"])
        for (const entry of entries(output[field])) {
          if (entry.startsWith("./")) {
            const local = entry.slice(2);
            safe(local.replace("*", "wildcard"));
            const [prefix, suffix] = local.split("*");
            assert.ok(
              local.includes("*")
                ? inventory.some(
                    (file) => file.startsWith(prefix ?? "") && file.endsWith(suffix ?? ""),
                  )
                : inventory.includes(local),
              `Missing public entry: ${entry}`,
            );
          }
        }
      receipt.packages.push({
        name: String(output.name),
        directory: stage,
        files: await Promise.all(
          inventory.map(async (local) => ({
            path: local,
            sha256: hash(await bytes(resolve(stage, local))),
          })),
        ),
      });
    }
    const stagedAssets = resolve(destination, "fortipi-cli/worker-assets");
    assert.equal((await verifyAssets(stagedAssets)).manifestSha256, assets.manifestSha256);
    for (const path of ["asset-manifest.json", ...assets.manifest.files.map((entry) => entry.path)])
      assert.deepEqual(
        await bytes(resolve(stagedAssets, path)),
        await bytes(resolve(assetRoot, path)),
        "Embedded bytes changed",
      );
    return receipt;
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  assert.ok(
    args.length === 8 &&
      args.filter((_, i) => i % 2 === 0).join() === "--root,--destination,--scope,--version",
    "Usage: rewrite-publish-names.ts --root ROOT --destination FRESH_ABSOLUTE_DIRECTORY --scope SCOPE --version VERSION",
  );
  console.log(
    JSON.stringify(
      await rewritePublishNames({
        root: args[1] ?? "",
        destination: args[3] ?? "",
        scope: args[5] ?? "",
        version: args[7] ?? "",
      }),
    ),
  );
}
