import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { Parser } from "tar";
import { parseAllDocuments } from "yaml";
import { archive } from "../tools/unstale/review-supply-chain.ts";
import { type DependencyPatch, dependencyPatches } from "./dependency-patches.ts";
import { pnpmExecutable, verifyPnpmExecutable } from "./pnpm-executable.ts";

/** Source data, not authorization to read an unverified candidate archive. */
export interface RuntimeFileRecord {
  path: string;
  size: number;
  mode: number;
  sha256: string;
}
export interface RuntimeArchiveSource {
  id: string;
  name: string;
  version: string;
  integrity: string;
  archiveSha256: string;
  manifestSha256: string;
  externalNative: boolean;
  platform: { os: readonly string[]; cpu: readonly string[]; libc: readonly string[] } | null;
  nativeFiles: readonly string[];
  manifest: Readonly<Record<string, unknown>> | null;
  files: readonly RuntimeFileRecord[];
  sourceAliases: readonly { archivePath: string; path: string }[];
  blockedConveyancePaths: readonly string[];
  patch: DependencyPatch | null;
}
export interface RuntimeContext {
  key: string;
  archiveId: string;
  dependencies: Readonly<Record<string, string>>;
  optionalDependencies: Readonly<Record<string, string>>;
  transitivePeerDependencies: readonly string[];
}
export interface RuntimeOwner {
  sourceName: string;
  roots: Readonly<Record<string, string>>;
  ownDependencies: readonly string[];
  contexts: readonly string[];
}
export interface RuntimeClosure {
  schemaVersion: 1;
  sourceCommit: string;
  inputs: {
    lockSha256: string;
    reviewSha256: string;
    patchReviewSha256: string;
    rootPackageSha256: string;
    licensePolicySha256: string;
    rootLicenseSha256: string;
    embeddedFreezeSha256: string;
    packageManifests: Readonly<Record<string, string>>;
    patches: Readonly<Record<string, string>>;
  };
  owners: readonly RuntimeOwner[];
  contexts: readonly RuntimeContext[];
  archives: readonly RuntimeArchiveSource[];
  externalSubtrees: readonly {
    context: string;
    exactDependencies: Readonly<Record<string, string>>;
    peerBindings: Readonly<Record<string, string>>;
  }[];
}
/** Parent combines these dependency records with independently derived owned outputs. */
export interface RuntimePhysicalPlan {
  schemaVersion: 1;
  /** Source-derived dependency data; legal approval and owned outputs are separate. */
  publicationReady: false;
  sourceName: string;
  sourceCommit: string;
  closureSha256: string;
  files: readonly RuntimeFileRecord[];
  totalBytes: number;
  addresses: readonly { path: string; context: string }[];
  externalNative: Readonly<Record<string, string>>;
  blockedConveyancePaths: readonly string[];
}
export interface RuntimeBundle {
  directory: string;
  bundleDependencies: readonly string[];
  plan: RuntimePhysicalPlan;
  producerPack: { compressedBytes: number; sha256: string };
}
export interface RuntimeVerifiedLayout {
  kind: "verified-pnpm-deploy";
  /** Layout addresses are not final tar addresses and cannot authorize a parse. */
  publicationReady: false;
  sourceName: string;
  closureSha256: string;
  directory: string;
  instances: readonly { context: string; directory: string; verifiedFiles: number }[];
  absentOptional: readonly { parent: string; name: string; context: string }[];
}

interface LockedNode {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  transitivePeerDependencies?: string[];
}
interface Lock {
  importers: Record<string, { dependencies?: Record<string, { version: string }> }>;
  packages: Record<
    string,
    { resolution: { integrity: string }; os?: string[]; cpu?: string[]; libc?: string[] }
  >;
  snapshots: Record<string, LockedNode>;
}
interface Review {
  packages: Record<
    string,
    {
      name: string;
      version: string;
      integrity: string;
      archiveSha256: string;
      manifestSha256: string;
      license: string;
    }
  >;
}
const sources = [
  "fortipi-contract",
  "fortipi-client",
  "fortipi-tui",
  "fortipi-cli",
  "fortipi-executor",
];
const trusted = new WeakMap<RuntimeClosure, { root: string }>();
const layouts = new WeakMap<RuntimeVerifiedLayout, { closure: RuntimeClosure }>();
const plans = new WeakSet<RuntimePhysicalPlan>();
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const sorted = <T>(value: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, "en")));
function freeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.values(value).forEach(freeze);
  Object.freeze(value);
}

export function runtimeClosureDigest(closure: RuntimeClosure): string {
  return hash(Buffer.from(JSON.stringify(closure)));
}
/** A copied JSON manifest cannot become source authority through this port. */
export function assertTrustedRuntimeClosure(closure: RuntimeClosure): void {
  assert.ok(trusted.has(closure), "Runtime closure was not derived from trusted checkout inputs");
}
/** A retained candidate's self-reported plan never passes this source-only port. */
export function assertTrustedRuntimePlan(plan: RuntimePhysicalPlan): void {
  assert.ok(plans.has(plan), "Runtime plan was not derived from authenticated source and producer");
}
export function runtimeFileTotal(files: readonly RuntimeFileRecord[]): number {
  let total = 0;
  for (const file of files) {
    assert.ok(Number.isSafeInteger(file.size) && file.size >= 0, "Invalid runtime file size");
    total += file.size;
    assert.ok(Number.isSafeInteger(total), "Runtime file total overflow");
  }
  return total;
}
function sourcePath(path: string): string {
  assert.ok(
    path.length > 0 && path.length <= 4096 && !path.includes("\\") && !path.startsWith("/"),
  );
  assert.ok(
    path.split("/").every((part) => part && part !== "." && part !== ".."),
    `Noncanonical runtime source path: ${path}`,
  );
  return path;
}
/** Raw archives may contain excluded config; a physical output plan must not. */
export function runtimePathIsConveyable(path: string): boolean {
  sourcePath(path);
  return (
    !/(^|\/)(?:\.env[^/]*|\.npmrc|auth\.json|credentials(?:\.json)?|\.git|\.wrangler)(?:\/|$)/i.test(
      path,
    ) && !/\.(?:node(?:\.wasm)?|dylib|dll|so(?:\.\d+)*|exe)$/i.test(path)
  );
}
function baseId(key: string): string {
  return key.split("(")[0]!;
}

/** Parses only the exact compressed bytes already authenticated against source review. */
async function reviewedFiles(raw: Buffer): Promise<{
  records: RuntimeFileRecord[];
  bytes: Map<string, Buffer>;
  aliases: { archivePath: string; path: string }[];
}> {
  const records: RuntimeFileRecord[] = [];
  const byPath = new Map<string, RuntimeFileRecord>();
  const bytes = new Map<string, Buffer>();
  const seen = new Map<string, string>();
  const rawSeen = new Set<string>();
  const aliases: { archivePath: string; path: string }[] = [];
  let prefix: string | undefined;
  let total = 0;
  await new Promise<void>((accept, reject) => {
    let stopped = false;
    const fail = (error: unknown) => {
      if (stopped) return;
      stopped = true;
      const reason = error instanceof Error ? error : new Error(String(error));
      reject(reason);
      parser.abort(reason);
    };
    const parser = new Parser({
      strict: true,
      maxMetaEntrySize: 1024 * 1024,
      maxDecompressionRatio: 1000,
      filter(path, entry) {
        try {
          assert.ok("type" in entry, "Expected reviewed tar header");
          assert.ok(
            !entry.linkpath && ["File", "Directory"].includes(entry.type),
            "Reviewed archive link/special member",
          );
          assert.ok(
            !path.includes("\\") && !path.startsWith("/") && !path.split("/").includes(".."),
          );
          // Some authenticated upstream tarballs use ./ root markers. This
          // normalization is source-only; retained readers keep strict headers.
          const clean = posix.normalize(path).replace(/\/$/, "");
          if (entry.type === "Directory" && clean === ".") return true;
          sourcePath(clean);
          const parts = clean.split("/");
          prefix ??= parts[0];
          assert.equal(parts[0], prefix, "Multiple reviewed archive roots");
          if (entry.type === "Directory") return true;
          const local = sourcePath(parts.slice(1).join("/"));
          assert.ok(!rawSeen.has(path), `Duplicate original archive header: ${path}`);
          rawSeen.add(path);
          const prior = seen.get(local.toLowerCase());
          assert.ok(!prior || prior === local, `Case-colliding reviewed archive member: ${local}`);
          seen.set(local.toLowerCase(), local);
          assert.ok(
            Number.isSafeInteger(entry.size) && entry.size >= 0 && entry.size <= 256 * 1024 * 1024,
          );
          total += entry.size;
          assert.ok(
            total <= 768 * 1024 * 1024 && rawSeen.size <= 50_000,
            "Reviewed archive work bound",
          );
          return true;
        } catch (error) {
          fail(error);
          return false;
        }
      },
      onReadEntry(entry) {
        if (stopped) return;
        if (entry.type === "Directory") {
          entry.resume();
          return;
        }
        const local = posix.normalize(entry.path).split("/").slice(1).join("/");
        const chunks: Buffer[] = [];
        let size = 0;
        entry.on("data", (chunk: Buffer) => {
          size += chunk.length;
          chunks.push(chunk);
        });
        entry.on("end", () => {
          if (stopped) return;
          try {
            assert.equal(size, entry.size);
            const body = Buffer.concat(chunks);
            const record = {
              path: local,
              size,
              mode: (entry.mode ?? 0o644) & 0o777,
              sha256: hash(body),
            };
            const prior = byPath.get(local);
            if (prior) {
              // Exact reviewed raw archives sometimes repeat ./ aliases. Only
              // identical authenticated source records may share a physical file.
              assert.deepEqual(record, prior, `Conflicting reviewed source alias: ${local}`);
              aliases.push({ archivePath: entry.path, path: local });
            } else {
              records.push(record);
              byPath.set(local, record);
              bytes.set(local, body);
            }
          } catch (error) {
            fail(error);
          }
        });
      },
    });
    parser.on("error", reject);
    parser.on("end", () => {
      if (!stopped) accept();
    });
    parser.end(raw);
  });
  return { records: records.sort((a, b) => a.path.localeCompare(b.path, "en")), bytes, aliases };
}

async function applyReviewedPatch(
  patch: DependencyPatch,
  root: string,
  files: Awaited<ReturnType<typeof reviewedFiles>>,
): Promise<void> {
  const directory = await mkdtemp(resolve(await realpath(tmpdir()), "fortipi-reviewed-patch-"));
  try {
    for (const [path, identity] of Object.entries(patch.files)) {
      sourcePath(path);
      const original = files.bytes.get(path);
      assert.ok(original);
      assert.equal(
        hash(original),
        identity.originalSha256,
        `Original patch input differs: ${path}`,
      );
      await mkdir(dirname(resolve(directory, path)), { recursive: true });
      await writeFile(resolve(directory, path), original, { flag: "wx" });
    }
    const emptyConfig = resolve(directory, "git-config");
    await writeFile(emptyConfig, "", { flag: "wx", mode: 0o600 });
    const env = {
      PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: emptyConfig,
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    };
    for (const args of [["apply", "--check"], ["apply"]])
      await promisify(execFile)("git", [...args, resolve(root, patch.path)], {
        cwd: directory,
        env,
        timeout: 30_000,
      });
    for (const [path, identity] of Object.entries(patch.files)) {
      const output = await readFile(resolve(directory, path));
      assert.equal(hash(output), identity.patchedSha256, `Patched output differs: ${path}`);
      const record = files.records.find((file) => file.path === path);
      assert.ok(record);
      record.size = output.length;
      record.sha256 = identity.patchedSha256;
      files.bytes.set(path, output);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Source-root entrypoint. No candidate entries or serialized plan are accepted. */
export async function collectRuntimeClosure(root: string): Promise<RuntimeClosure> {
  root = await realpath(root);
  const lockBytes = await readFile(resolve(root, "pnpm-lock.yaml"));
  const documents = parseAllDocuments(lockBytes.toString("utf8"));
  assert.equal(documents.length, 2);
  for (const document of documents) assert.equal(document.errors.length, 0);
  const lock = documents[1]!.toJSON() as Lock;
  const reviewBytes = await readFile(resolve(root, "tools/unstale/supply-chain.json"));
  const review = JSON.parse(reviewBytes.toString("utf8")) as Review;
  const licensePolicyBytes = await readFile(resolve(root, "tools/unstale/license-policy.json"));
  const licensePolicy = JSON.parse(licensePolicyBytes.toString("utf8")) as {
    exceptions: Record<string, { license: string }>;
  };
  // These exact existing copyleft exceptions are external-only native
  // identities, including Sharp WASM without platform tags. Ordinary MIT WASM
  // is not native merely because its filename ends in .wasm.
  const policyNative = new Map(
    Object.entries(licensePolicy.exceptions)
      .filter(([, exception]) => /\b(?:LGPL|GPL|AGPL)-/.test(exception.license))
      .map(([id, exception]) => [id, exception.license]),
  );
  const patches = await dependencyPatches(root);
  const contexts = new Map<string, RuntimeContext>();
  function visit(key: string): void {
    if (contexts.has(key)) return;
    const node = lock.snapshots[key];
    assert.ok(node, `Missing frozen runtime context: ${key}`);
    const dependencies = sorted(node.dependencies ?? {});
    const optionalDependencies = sorted(node.optionalDependencies ?? {});
    contexts.set(key, {
      key,
      archiveId: baseId(key),
      dependencies,
      optionalDependencies,
      transitivePeerDependencies: [...(node.transitivePeerDependencies ?? [])].sort(),
    });
    for (const [name, reference] of Object.entries({ ...dependencies, ...optionalDependencies }))
      visit(`${name}@${reference}`);
  }
  const owners: RuntimeOwner[] = [];
  const packageManifests: Record<string, string> = {};
  for (const sourceName of sources) {
    const manifestBytes = await readFile(resolve(root, "packages", sourceName, "package.json"));
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as { name: string };
    assert.equal(manifest.name, sourceName);
    packageManifests[sourceName] = hash(manifestBytes);
    const importer = lock.importers[`packages/${sourceName}`];
    assert.ok(importer);
    const roots: Record<string, string> = {};
    const ownDependencies: string[] = [];
    for (const [name, value] of Object.entries(importer.dependencies ?? {})) {
      if (value.version.startsWith("link:")) {
        assert.ok(sources.includes(name));
        ownDependencies.push(name);
      } else {
        roots[name] = `${name}@${value.version}`;
        visit(roots[name]!);
      }
    }
    const reachable = new Set<string>();
    const walk = (key: string) => {
      if (reachable.has(key)) return;
      reachable.add(key);
      const context = contexts.get(key)!;
      for (const [name, ref] of Object.entries({
        ...context.dependencies,
        ...context.optionalDependencies,
      }))
        walk(`${name}@${ref}`);
    };
    Object.values(roots).forEach(walk);
    owners.push({
      sourceName,
      roots: sorted(roots),
      ownDependencies: ownDependencies.sort(),
      contexts: [...reachable].sort(),
    });
  }
  const ids = new Set([...contexts.values()].map((context) => context.archiveId));
  for (const id of Object.keys(patches)) ids.add(id); // Worker-only patches remain authenticated inputs.
  const archives: RuntimeArchiveSource[] = [];
  for (const id of [...ids].sort()) {
    const fact = review.packages[id];
    const locked = lock.packages[id];
    assert.ok(fact && locked, `Unreviewed runtime archive: ${id}`);
    assert.equal(fact.integrity, locked.resolution.integrity);
    if (policyNative.has(id))
      assert.equal(fact.license, policyNative.get(id), `Native policy license differs: ${id}`);
    const externalNative = Boolean(locked.os || locked.cpu || locked.libc);
    if (externalNative) {
      archives.push({
        id,
        name: fact.name,
        version: fact.version,
        integrity: fact.integrity,
        archiveSha256: fact.archiveSha256,
        manifestSha256: fact.manifestSha256,
        externalNative: true,
        platform: { os: locked.os ?? [], cpu: locked.cpu ?? [], libc: locked.libc ?? [] },
        nativeFiles: [],
        manifest: null,
        files: [],
        sourceAliases: [],
        blockedConveyancePaths: [],
        patch: null,
      });
      continue;
    }
    const raw = await archive(fact.name, fact.version, fact.integrity, root);
    assert.equal(hash(raw), fact.archiveSha256, `Reviewed runtime archive changed: ${id}`);
    const files = await reviewedFiles(raw).catch((cause: unknown) => {
      throw new Error(`Runtime source archive rejected: ${id}`, { cause });
    });
    const manifestBytes = files.bytes.get("package.json");
    assert.ok(manifestBytes);
    assert.equal(hash(manifestBytes), fact.manifestSha256);
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as Record<string, unknown>;
    assert.equal(manifest.name, fact.name);
    assert.equal(manifest.version, fact.version);
    const patch = patches[id] ?? null;
    if (patch) await applyReviewedPatch(patch, root, files);
    const nativeFiles = files.records
      .filter((file) => /\.(?:node(?:\.wasm)?|dylib|dll|so(?:\.\d+)*|exe)$/i.test(file.path))
      .map((file) => file.path);
    archives.push({
      id,
      name: fact.name,
      version: fact.version,
      integrity: fact.integrity,
      archiveSha256: fact.archiveSha256,
      manifestSha256: fact.manifestSha256,
      externalNative: policyNative.has(id) || nativeFiles.length > 0,
      platform: null,
      nativeFiles,
      manifest,
      files: files.records,
      sourceAliases: files.aliases,
      blockedConveyancePaths: files.records
        .filter((file) => !runtimePathIsConveyable(file.path))
        .map((file) => file.path),
      patch,
    });
  }
  const commit = await promisify(execFile)("git", ["rev-parse", "HEAD"], {
    cwd: root,
    timeout: 10_000,
  });
  assert.match(commit.stdout.trim(), /^[a-f0-9]{40}$/);
  const closure: RuntimeClosure = {
    schemaVersion: 1,
    sourceCommit: commit.stdout.trim(),
    inputs: {
      lockSha256: hash(lockBytes),
      reviewSha256: hash(reviewBytes),
      patchReviewSha256: hash(await readFile(resolve(root, "patches/review.json"))),
      rootPackageSha256: hash(await readFile(resolve(root, "package.json"))),
      licensePolicySha256: hash(licensePolicyBytes),
      rootLicenseSha256: hash(await readFile(resolve(root, "LICENSE"))),
      embeddedFreezeSha256: hash(
        await readFile(resolve(root, "apps/worker/container/embedded-freeze.json")),
      ),
      packageManifests: sorted(packageManifests),
      patches: sorted(
        Object.fromEntries(Object.entries(patches).map(([id, patch]) => [id, patch.sha256])),
      ),
    },
    owners,
    contexts: [...contexts.values()].sort((a, b) => a.key.localeCompare(b.key, "en")),
    archives,
    externalSubtrees: [],
  };
  const tui = archives.find((item) => item.id === "@earendil-works/pi-tui@1.5.2");
  if (tui) {
    // One reviewed non-leaf exception, not permission to externalize arbitrary
    // native-bearing dependency trees with floating transitive/peer edges.
    const exact = {
      "get-east-asian-width": "1.6.0",
      marked: "18.0.11",
      "marked-cjk-friendly": "0.1.2",
    };
    assert.deepEqual(tui.manifest?.dependencies, exact);
    const context = contexts.get(tui.id)!;
    assert.deepEqual(context.optionalDependencies, {});
    assert.deepEqual(context.dependencies, {
      "get-east-asian-width": "1.6.0",
      marked: "18.0.11",
      "marked-cjk-friendly": "0.1.2(marked@18.0.11)",
    });
    for (const [name, version] of Object.entries(exact)) {
      const item = archives.find((value) => value.id === `${name}@${version}`)!;
      assert.ok(item && Object.keys((item.manifest?.dependencies ?? {}) as object).length === 0);
      assert.equal(Object.keys((item.manifest?.optionalDependencies ?? {}) as object).length, 0);
      if (name !== "marked-cjk-friendly") assert.deepEqual(contexts.get(item.id)?.dependencies, {});
      else {
        assert.deepEqual(item.manifest?.peerDependencies, { marked: ">=15.0.0" });
        assert.deepEqual(
          contexts.get(context.dependencies[name] ? `${name}@${context.dependencies[name]}` : "")
            ?.dependencies,
          { marked: "18.0.11" },
        );
      }
    }
    closure.externalSubtrees = [
      {
        context: tui.id,
        exactDependencies: exact,
        peerBindings: { "marked-cjk-friendly@0.1.2:marked": "marked@18.0.11" },
      },
    ];
  }
  for (const item of archives.filter(
    (item) =>
      item.externalNative && !item.platform && !policyNative.has(item.id) && item.id !== tui?.id,
  )) {
    assert.equal(
      Object.keys((item.manifest?.dependencies ?? {}) as object).length,
      0,
      `Unreviewed non-leaf native externalization: ${item.id}`,
    );
    assert.equal(Object.keys((item.manifest?.optionalDependencies ?? {}) as object).length, 0);
  }
  // Do not expose mutable nested data that could change a later source-derived plan.
  freeze(closure);
  trusted.set(closure, { root });
  return closure;
}

/** Supported producer reification; it never changes vendor metadata or source policy. */
export async function createRuntimeLayout(
  closure: RuntimeClosure,
  sourceName: string,
  destination: string,
): Promise<RuntimeVerifiedLayout> {
  assertTrustedRuntimeClosure(closure);
  const source = trusted.get(closure)!;
  const owner = closure.owners.find((value) => value.sourceName === sourceName);
  assert.ok(owner, "Unknown runtime owner");
  destination = resolve(destination);
  assert.ok(destination !== source.root && !source.root.startsWith(`${destination}${sep}`));
  await mkdir(destination, { mode: 0o700 }); // Exclusive, including for proof runs.
  const control = await mkdtemp(resolve(await realpath(tmpdir()), "fortipi-producer-config-"));
  try {
    const auth = resolve(control, "empty-auth");
    const global = resolve(control, "empty-global");
    await writeFile(auth, "", { flag: "wx", mode: 0o600 });
    await writeFile(global, "", { flag: "wx", mode: 0o600 });
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      LANG: "C.UTF-8",
      NPM_CONFIG_USERCONFIG: auth,
      NPM_CONFIG_GLOBALCONFIG: global,
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    };
    const pnpm = await pnpmExecutable();
    await verifyPnpmExecutable(pnpm, env);
    // Deployment's credential-free environment must use the same content store
    // as the frozen source install. Host pnpm/XDG configuration is not inherited.
    // Store metadata locates cached bytes only; inspectRuntimeLayout still
    // authenticates every deployed member against the reviewed closure.
    const modules = parseAllDocuments(
      await readFile(resolve(source.root, "node_modules/.modules.yaml"), "utf8"),
    );
    assert.equal(modules.length, 1);
    const document = modules[0];
    assert.ok(document);
    assert.equal(document.errors.length, 0);
    const store = (document.toJSON() as { storeDir?: unknown }).storeDir;
    assert.ok(typeof store === "string" && isAbsolute(store));
    assert.ok((await lstat(store)).isDirectory());
    await promisify(execFile)(
      pnpm,
      [
        "--npmrc-auth-file",
        auth,
        "--store-dir",
        store,
        "--filter",
        sourceName,
        "--node-linker",
        "hoisted",
        "--prod",
        "deploy",
        "--ignore-scripts",
        "--offline",
        destination,
      ],
      { cwd: source.root, env, timeout: 120_000, maxBuffer: 1024 * 1024 },
    );
  } finally {
    await rm(control, { recursive: true, force: true });
  }
  return inspectRuntimeLayout(closure, sourceName, destination);
}

/** Re-check only a controlled layout produced by this module. */
export async function reverifyRuntimeLayout(
  layout: RuntimeVerifiedLayout,
): Promise<RuntimeVerifiedLayout> {
  const origin = layouts.get(layout);
  assert.ok(origin, "Layout was not created by the authenticated producer");
  return inspectRuntimeLayout(origin.closure, layout.sourceName, layout.directory);
}

async function inspectRuntimeLayout(
  closure: RuntimeClosure,
  sourceName: string,
  destination: string,
): Promise<RuntimeVerifiedLayout> {
  assertTrustedRuntimeClosure(closure);
  const source = trusted.get(closure)!;
  const owner = closure.owners.find((value) => value.sourceName === sourceName);
  assert.ok(owner);
  const directory = await realpath(destination);
  const contextByKey = new Map(closure.contexts.map((context) => [context.key, context]));
  const archivesById = new Map(closure.archives.map((item) => [item.id, item]));
  const visited = new Map<string, string>();
  const instances: { context: string; directory: string; verifiedFiles: number }[] = [];
  const absentOptional: { parent: string; name: string; context: string }[] = [];
  const nativeRecords = new Map<string, readonly RuntimeFileRecord[]>();
  async function locate(from: string, name: string): Promise<string | undefined> {
    const lookup = createRequire(resolve(from, "package.json"));
    for (const path of lookup.resolve.paths(name) ?? []) {
      const candidate = resolve(path, name);
      if (!candidate.startsWith(`${directory}${sep}`)) continue; // Never consult ambient modules.
      try {
        const actual = await realpath(candidate);
        assert.ok(
          actual.startsWith(`${directory}${sep}`),
          "Producer dependency escapes controlled layout",
        );
        if ((await lstat(resolve(actual, "package.json"))).isFile()) return actual;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return undefined;
  }
  async function verifyFiles(path: string, item: RuntimeArchiveSource): Promise<number> {
    let records = item.files;
    if (!records.length && item.externalNative) {
      records = nativeRecords.get(item.id) ?? [];
      if (!records.length) {
        const raw = await archive(item.name, item.version, item.integrity, source.root);
        assert.equal(hash(raw), item.archiveSha256);
        records = (await reviewedFiles(raw)).records;
        nativeRecords.set(item.id, records);
      }
    }
    const expected = new Map(records.map((record) => [record.path, record]));
    for (const record of records) {
      const actual = resolve(path, record.path);
      const info = await lstat(actual);
      assert.ok(
        info.isFile() && !info.isSymbolicLink(),
        `Nonregular producer file: ${item.id}/${record.path}`,
      );
      assert.equal(
        info.mode & 0o022,
        0,
        `Group/other-writable producer file: ${item.id}/${record.path}`,
      );
      assert.equal(
        info.size,
        record.size,
        `Producer bytes differ (size): ${item.id}/${record.path}`,
      );
      assert.equal(
        hash(await readFile(actual)),
        record.sha256,
        `Producer bytes differ: ${item.id}/${record.path}`,
      );
    }
    async function extras(current: string, prefix = ""): Promise<void> {
      for (const name of await readdir(current)) {
        const local = prefix ? `${prefix}/${name}` : name;
        if (
          local === "node_modules" &&
          !records.some((record) => record.path.startsWith("node_modules/"))
        )
          continue;
        const target = resolve(current, name);
        const info = await lstat(target);
        assert.ok(!info.isSymbolicLink(), `Unexpected producer symlink: ${item.id}/${local}`);
        if (info.isDirectory()) await extras(target, local);
        else
          assert.ok(
            info.isFile() && expected.has(local),
            `Unknown producer member: ${item.id}/${local}`,
          );
      }
    }
    await extras(path);
    return records.length;
  }
  function platformMismatch(item: RuntimeArchiveSource): boolean {
    const matches = (values: readonly string[], value: string) =>
      !values.length ||
      (!values.includes(`!${value}`) &&
        (values.every((part) => part.startsWith("!")) || values.includes(value)));
    return Boolean(
      item.platform &&
        (!matches(item.platform.os, process.platform) || !matches(item.platform.cpu, process.arch)),
    );
  }
  async function walk(key: string, path: string): Promise<void> {
    const prior = visited.get(path);
    if (prior) {
      assert.equal(prior, key, "Producer conflated distinct frozen contexts");
      return;
    }
    visited.set(path, key);
    const context = contextByKey.get(key);
    assert.ok(context, key);
    const item = archivesById.get(context.archiveId)!;
    const manifest = JSON.parse(await readFile(resolve(path, "package.json"), "utf8")) as {
      name: string;
      version: string;
    };
    assert.equal(manifest.name, item.name);
    assert.equal(manifest.version, item.version);
    const count = await verifyFiles(path, item);
    instances.push({
      context: key,
      directory: relative(directory, path).split(sep).join("/"),
      verifiedFiles: count,
    });
    for (const [name, reference] of Object.entries({
      ...context.dependencies,
      ...context.optionalDependencies,
    })) {
      const child = `${name}@${reference}`;
      const actual = await locate(path, name);
      if (!actual) {
        const optional = Object.hasOwn(context.optionalDependencies, name);
        const archive = archivesById.get(baseId(child));
        assert.ok(
          optional &&
            archive?.externalNative &&
            (platformMismatch(archive) || archive.platform?.libc.length),
          `Missing frozen producer edge: ${key} -> ${child}`,
        );
        absentOptional.push({ parent: key, name, context: child });
      } else await walk(child, actual);
    }
  }
  for (const [name, context] of Object.entries(owner.roots)) {
    const actual = await locate(directory, name);
    assert.ok(actual, `Missing producer root: ${name}`);
    await walk(context, actual);
  }
  const layout: RuntimeVerifiedLayout = {
    kind: "verified-pnpm-deploy",
    publicationReady: false,
    sourceName,
    closureSha256: runtimeClosureDigest(closure),
    directory,
    instances: instances.sort((a, b) => a.directory.localeCompare(b.directory, "en")),
    absentOptional,
  };
  layouts.set(layout, { closure });
  freeze(layout);
  return layout;
}

/** Canonical npm nested package address, not a replacement runtime resolver. */
function packageAddress(path: string): { directory: string; name: string; local: string } {
  sourcePath(path);
  const parts = path.split("/");
  const at = parts.lastIndexOf("node_modules");
  assert.ok(at >= 0 && at < parts.length - 2, `Invalid bundled address: ${path}`);
  const scoped = parts[at + 1]!.startsWith("@");
  const end = at + (scoped ? 3 : 2);
  const name = parts.slice(at + 1, end).join("/");
  const local = parts.slice(end).join("/");
  sourcePath(local);
  return { directory: parts.slice(0, end).join("/"), name, local };
}
function packedMode(file: RuntimeFileRecord, manifest: Readonly<Record<string, unknown>>): number {
  const bin = manifest.bin;
  const paths =
    typeof bin === "string" ? [bin] : bin && typeof bin === "object" ? Object.values(bin) : [];
  return file.mode & 0o111 ||
    paths.some((path) => typeof path === "string" && posix.normalize(path) === file.path)
    ? 0o755
    : 0o644;
}

/**
 * Supported ordinary bundling, exclusively from a newly authenticated deploy.
 * The returned plan contains DEPENDENCY files only. No legal approval, owned
 * output authentication, candidate archive or serialized manifest is accepted.
 */
export async function createRuntimeBundle(
  closure: RuntimeClosure,
  sourceName: string,
  destination: string,
): Promise<RuntimeBundle> {
  const layout = await createRuntimeLayout(closure, sourceName, destination);
  const owner = closure.owners.find((value) => value.sourceName === sourceName)!;
  const contexts = new Map(closure.contexts.map((context) => [context.key, context]));
  const archives = new Map(closure.archives.map((item) => [item.id, item]));
  const itemFor = (key: string) => archives.get(contexts.get(key)!.archiveId)!;
  const externalNative: Record<string, string> = {};
  const requiredExternal: Record<string, string> = {};
  const required = new Set<string>();
  const markRequired = (key: string): void => {
    if (required.has(key)) return;
    required.add(key);
    for (const [name, ref] of Object.entries(contexts.get(key)!.dependencies))
      markRequired(`${name}@${ref}`);
  };
  Object.values(owner.roots).forEach(markRequired);
  for (const key of owner.contexts) {
    const item = itemFor(key);
    if (!item.externalNative) continue;
    assert.ok(
      !externalNative[item.name] || externalNative[item.name] === item.version,
      `Conflicting exact external native versions: ${item.name}`,
    );
    externalNative[item.name] = item.version;
    if (required.has(key)) requiredExternal[item.name] = item.version;
  }
  // pnpm's supported hoisted deploy supplies ordinary Node addresses. Anchor
  // its actual frozen top-level peers too: default pack traverses dependencies,
  // but may omit optional peer-only edges such as Anthropic's selected Zod.
  const rootContexts = new Map(
    layout.instances
      .filter((instance) => {
        const item = itemFor(instance.context);
        return !item.externalNative && instance.directory === `node_modules/${item.name}`;
      })
      .map((instance) => {
        const item = itemFor(instance.context);
        return [item.name, instance.context];
      }),
  );
  const bundleDependencies = [...rootContexts.keys()].sort();
  const manifestPath = resolve(layout.directory, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  // Only OUR generated root metadata changes. No third-party manifest changes.
  manifest.bundleDependencies = bundleDependencies;
  const dependencies = (manifest.dependencies ?? {}) as Record<string, string>;
  Object.assign(
    dependencies,
    requiredExternal,
    Object.fromEntries([...rootContexts].map(([name, key]) => [name, itemFor(key).version])),
  );
  manifest.dependencies = dependencies;
  manifest.optionalDependencies = sorted({
    ...(manifest.optionalDependencies as Record<string, string>),
    ...Object.fromEntries(
      Object.entries(externalNative).filter(([name]) => !Object.hasOwn(requiredExternal, name)),
    ),
  });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  for (const instance of layout.instances)
    if (itemFor(instance.context).externalNative)
      await rm(resolve(layout.directory, instance.directory), { recursive: true });

  const control = await mkdtemp(resolve(await realpath(tmpdir()), "fortipi-bundle-control-"));
  try {
    const auth = resolve(control, "empty-auth");
    const global = resolve(control, "empty-global");
    await writeFile(auth, "", { flag: "wx", mode: 0o600 });
    await writeFile(global, "", { flag: "wx", mode: 0o600 });
    const env = {
      PATH: process.env.PATH,
      LANG: "C.UTF-8",
      NPM_CONFIG_USERCONFIG: auth,
      NPM_CONFIG_GLOBALCONFIG: global,
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    };
    const pnpm = await pnpmExecutable();
    await verifyPnpmExecutable(pnpm, env);
    const run = async (args: string[]) =>
      promisify(execFile)(
        pnpm,
        [
          "--ignore-workspace",
          "--ignore-scripts",
          "--npmrc-auth-file",
          auth,
          "pack",
          ...args,
          "--json",
        ],
        { cwd: layout.directory, env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
      );
    const dry = JSON.parse((await run(["--dry-run"])).stdout) as {
      files: { path: string }[];
      filename: string;
    };
    assert.ok(Array.isArray(dry.files) && dry.files.length <= 50_000);
    const expected = new Map<string, readonly RuntimeFileRecord[]>();
    const origin = trusted.get(closure);
    assert.ok(origin);
    const freezeBytes = await readFile(
      resolve(origin.root, "apps/worker/container/embedded-freeze.json"),
    );
    assert.equal(hash(freezeBytes), closure.inputs.embeddedFreezeSha256);
    const frozen = JSON.parse(freezeBytes.toString("utf8")) as { binarySha256: string };
    const seaPath = "worker-assets/linux/container/computerd";
    const byName = new Map<string, RuntimeArchiveSource[]>();
    for (const key of owner.contexts) {
      const item = itemFor(key);
      if (item.externalNative) continue;
      const values = byName.get(item.name) ?? [];
      if (!values.includes(item)) values.push(item);
      byName.set(item.name, values);
    }
    for (const { path } of dry.files) {
      sourcePath(path);
      assert.ok(!expected.has(path), `Duplicate producer pack path: ${path}`);
      if (path.startsWith("node_modules/")) {
        const address = packageAddress(path);
        const files = (byName.get(address.name) ?? []).flatMap((item) =>
          item.files
            .filter((file) => file.path === address.local)
            .map((file) => ({ ...file, mode: packedMode(file, item.manifest!) })),
        );
        assert.ok(files.length, `Unknown producer packed source: ${path}`);
        expected.set(path, files);
      } else {
        const info = await lstat(resolve(layout.directory, path));
        assert.ok(info.isFile() && !info.isSymbolicLink());
        const file = {
          path,
          size: info.size,
          mode: info.mode & 0o777,
          sha256: hash(await readFile(resolve(layout.directory, path))),
        };
        if (file.size > 32_000_000) {
          assert.equal(sourceName, "fortipi-cli");
          assert.equal(path, seaPath, "Unreviewed large owned producer member");
          assert.equal(file.sha256, frozen.binarySha256, "Unreviewed producer SEA identity");
          assert.ok(file.size <= 200_000_000);
        }
        expected.set(
          path,
          path === "package.json"
            ? ["", "\n"].map((end) => {
                const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}${end}`);
                return { path, size: bytes.length, mode: 0o644, sha256: hash(bytes) };
              })
            : [{ ...file, mode: packedMode(file, manifest) }],
        );
      }
    }
    // Bound the fresh producer's parse by authenticated source records BEFORE
    // reading its tar. This is not a retained-candidate parser or allowance.
    const ceiling = runtimeFileTotal(
      [...expected].map(([path, files]) => ({
        path,
        size: Math.max(...files.map((file) => file.size)),
        mode: 0o644,
        sha256: "",
      })),
    );
    const packed = JSON.parse((await run(["--pack-destination", control])).stdout) as {
      filename: string;
    };
    assert.equal(basename(packed.filename), dry.filename);
    const tarball = resolve(control, packed.filename);
    assert.equal(dirname(tarball), control);
    const compressed = await lstat(tarball);
    assert.ok(
      compressed.isFile() && compressed.size <= ceiling + expected.size * 1024 + 1024 * 1024,
    );
    const records: RuntimeFileRecord[] = [];
    const manifests = new Map<string, Buffer>();
    const seen = new Set<string>();
    await new Promise<void>((accept, reject) => {
      let stopped = false;
      let bytes = 0;
      const stream = createReadStream(tarball, { highWaterMark: 64 * 1024 });
      const fail = (error: unknown) => {
        if (stopped) return;
        stopped = true;
        const reason = error instanceof Error ? error : new Error(String(error));
        clearTimeout(timer);
        reject(reason);
        stream.destroy();
        parser.abort(reason);
      };
      const parser = new Parser({
        strict: true,
        maxMetaEntrySize: 1024 * 1024,
        maxDecompressionRatio: 1000,
        filter(path, entry) {
          try {
            assert.ok("type" in entry && entry.type === "File" && !entry.linkpath);
            assert.ok(path.startsWith("package/"));
            const local = sourcePath(path.slice(8));
            assert.ok(!seen.has(local), `Duplicate producer header: ${local}`);
            seen.add(local);
            const allowed = expected.get(local);
            assert.ok(allowed, `Unexpected producer header: ${local}`);
            assert.ok(
              allowed.some(
                (file) =>
                  file.size === entry.size &&
                  (file.mode & 0o111 ? 0o755 : 0o644) === ((entry.mode ?? 0) & 0o777),
              ),
              `Wrong producer header: ${local}`,
            );
            assert.ok(
              entry.size <= 32_000_000 ||
                (local === seaPath &&
                  sourceName === "fortipi-cli" &&
                  allowed.some(
                    (file) => file.size === entry.size && file.sha256 === frozen.binarySha256,
                  )),
              `Dependency producer member too large: ${local}`,
            );
            bytes += entry.size;
            assert.ok(bytes <= ceiling);
            return true;
          } catch (error) {
            fail(error);
            return false;
          }
        },
        onReadEntry(entry) {
          if (stopped) return;
          const path = entry.path.slice(8);
          const digest = createHash("sha256");
          const isManifest =
            path.startsWith("node_modules/") && packageAddress(path).local === "package.json";
          const chunks: Buffer[] = [];
          let length = 0;
          entry.on("data", (chunk: Buffer) => {
            digest.update(chunk);
            length += chunk.length;
            if (isManifest) chunks.push(chunk);
          });
          entry.on("end", () => {
            try {
              if (stopped) return;
              assert.equal(length, entry.size);
              const sha256 = digest.digest("hex");
              assert.ok(
                expected.get(path)!.some((file) => file.sha256 === sha256),
                `Packed source bytes differ: ${path}`,
              );
              if (path.startsWith("node_modules/"))
                records.push({ path, size: length, mode: (entry.mode ?? 0) & 0o777, sha256 });
              if (isManifest) manifests.set(packageAddress(path).directory, Buffer.concat(chunks));
            } catch (error) {
              fail(error);
            }
          });
        },
      });
      const timer = setTimeout(
        () => fail(new Error("Producer pack verification timeout")),
        120_000,
      );
      timer.unref();
      stream.on("error", fail);
      parser.on("error", fail);
      parser.on("end", () => {
        if (!stopped) {
          clearTimeout(timer);
          accept();
        }
      });
      stream.pipe(parser);
    });
    assert.equal(seen.size, expected.size, "Incomplete supported producer pack");
    const addresses = await verifyPackedEdges(
      closure,
      owner,
      rootContexts,
      control,
      manifests,
      records,
    );
    const files = records.sort((a, b) => a.path.localeCompare(b.path, "en"));
    const plan: RuntimePhysicalPlan = {
      schemaVersion: 1,
      publicationReady: false,
      sourceName,
      sourceCommit: closure.sourceCommit,
      closureSha256: runtimeClosureDigest(closure),
      files,
      totalBytes: runtimeFileTotal(files),
      addresses,
      externalNative: sorted(externalNative),
      blockedConveyancePaths: files
        .filter((file) => !runtimePathIsConveyable(file.path))
        .map((file) => file.path),
    };
    freeze(plan);
    plans.add(plan);
    return {
      directory: layout.directory,
      bundleDependencies,
      plan,
      producerPack: { compressedBytes: compressed.size, sha256: hash(await readFile(tarball)) },
    };
  } finally {
    await rm(control, { recursive: true, force: true });
  }
}

async function verifyPackedEdges(
  closure: RuntimeClosure,
  owner: RuntimeOwner,
  rootContexts: ReadonlyMap<string, string>,
  temporary: string,
  manifests: Map<string, Buffer>,
  files: RuntimeFileRecord[],
): Promise<{ path: string; context: string }[]> {
  const root = resolve(temporary, "node-resolution");
  await mkdir(root);
  for (const [path, bytes] of manifests) {
    await mkdir(resolve(root, path), { recursive: true });
    await writeFile(resolve(root, path, "package.json"), bytes, { flag: "wx" });
  }
  const contexts = new Map(closure.contexts.map((context) => [context.key, context]));
  const archives = new Map(closure.archives.map((item) => [item.id, item]));
  const addresses = new Map<string, string>();
  const itemFor = (key: string) => archives.get(contexts.get(key)!.archiveId)!;
  async function locate(from: string, name: string): Promise<string | undefined> {
    for (const path of createRequire(resolve(root, from, "package.json")).resolve.paths(name) ??
      []) {
      const candidate = resolve(path, name);
      if (!candidate.startsWith(`${root}${sep}`)) continue;
      const local = relative(root, candidate).split(sep).join("/");
      if (manifests.has(local)) return local;
    }
    return undefined;
  }
  async function walk(key: string, path: string): Promise<void> {
    if (addresses.has(path)) {
      assert.equal(addresses.get(path), key, "Packed peer contexts conflated");
      return;
    }
    const context = contexts.get(key)!;
    const item = itemFor(key);
    assert.ok(!item.externalNative);
    assert.equal(hash(manifests.get(path)!), item.manifestSha256);
    addresses.set(path, key);
    for (const [name, reference] of Object.entries({
      ...context.dependencies,
      ...context.optionalDependencies,
    })) {
      const child = `${name}@${reference}`;
      if (itemFor(child).externalNative) continue;
      const actual = await locate(path, name);
      assert.ok(actual, `Missing packed edge: ${key} -> ${child}`);
      await walk(child, actual);
    }
  }
  for (const [name, context] of Object.entries({
    ...owner.roots,
    ...Object.fromEntries(rootContexts),
  })) {
    if (itemFor(context).externalNative) continue;
    const actual = await locate("", name);
    assert.ok(actual, `Missing packed root: ${name}`);
    await walk(context, actual);
  }
  assert.equal(addresses.size, manifests.size, "Unknown or unreachable packed dependency");
  const recordMaps = new Map(
    closure.archives.map((item) => [item.id, new Map(item.files.map((file) => [file.path, file]))]),
  );
  for (const file of files) {
    const address = packageAddress(file.path);
    const context = addresses.get(address.directory);
    assert.ok(context);
    const original = recordMaps.get(contexts.get(context)!.archiveId)!.get(address.local);
    assert.ok(original);
    assert.equal(file.size, original.size);
    assert.equal(file.sha256, original.sha256);
    assert.equal(file.mode, packedMode(original, itemFor(context).manifest!));
  }
  return [...addresses]
    .map(([path, context]) => ({ path, context }))
    .sort((a, b) => a.path.localeCompare(b.path, "en"));
}
