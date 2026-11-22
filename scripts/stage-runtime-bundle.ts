import assert from "node:assert/strict";
import { chmod, copyFile, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import {
  assertTrustedRuntimeClosure,
  assertTrustedRuntimePlan,
  type RuntimeClosure,
  type RuntimePhysicalPlan,
} from "./runtime-closure.ts";
import { object, regularBytes, sha256, string, versionPattern } from "./verify-release-gates.ts";

/** Derive our scoped package metadata from the authenticated ordinary Node layout. */
export function bundledManifest(
  closure: RuntimeClosure,
  plan: RuntimePhysicalPlan,
  scopedManifest: Record<string, unknown>,
): Record<string, unknown> {
  assertTrustedRuntimeClosure(closure);
  assertTrustedRuntimePlan(plan);
  assert.equal(plan.sourceCommit, closure.sourceCommit);
  const owner = closure.owners.find((item) => item.sourceName === plan.sourceName);
  assert.ok(owner);
  const ownedContexts = new Set(owner.contexts);
  assert.match(
    string(scopedManifest.name),
    new RegExp(`^@[a-z0-9][a-z0-9._-]*/${owner.sourceName}$`),
  );
  assert.match(string(scopedManifest.version), versionPattern);
  const contexts = new Map(closure.contexts.map((item) => [item.key, item]));
  const archives = new Map(closure.archives.map((item) => [item.id, item]));
  const archiveFor = (key: string) => {
    const context = contexts.get(key);
    assert.ok(context && ownedContexts.has(key));
    const archive = archives.get(context.archiveId);
    assert.ok(archive);
    return archive;
  };
  const required = new Set<string>();
  const visit = (key: string): void => {
    if (required.has(key)) return;
    required.add(key);
    const context = contexts.get(key);
    assert.ok(context);
    for (const [name, reference] of Object.entries(context.dependencies))
      visit(`${name}@${reference}`);
  };
  Object.values(owner.roots).forEach(visit);
  const manifest = structuredClone(scopedManifest);
  const dependencies = object(manifest.dependencies ?? {});
  const optional = object(manifest.optionalDependencies ?? {});
  for (const key of owner.contexts) {
    const archive = archiveFor(key);
    if (!archive.externalNative) continue;
    assert.equal(plan.externalNative[archive.name], archive.version);
    (required.has(key) ? dependencies : optional)[archive.name] = archive.version;
  }
  const roots = new Map<string, string>();
  for (const address of plan.addresses) {
    const archive = archiveFor(address.context);
    assert.ok(!archive.externalNative);
    if (address.path === `node_modules/${archive.name}`) roots.set(archive.name, archive.version);
  }
  for (const [name, version] of [...roots].sort(([a], [b]) => a.localeCompare(b, "en")))
    dependencies[name] = version;
  manifest.dependencies = dependencies;
  manifest.optionalDependencies = Object.fromEntries(
    Object.entries(optional).sort(([a], [b]) => a.localeCompare(b, "en")),
  );
  manifest.bundleDependencies = [...roots.keys()].sort();
  return manifest;
}

/** Only a newly authenticated producer layout is used; no ambient modules are copied. */
export async function copyRuntimeMembers(
  closure: RuntimeClosure,
  plan: RuntimePhysicalPlan,
  producerDirectory: string,
  stagedDirectory: string,
): Promise<void> {
  assertTrustedRuntimeClosure(closure);
  assertTrustedRuntimePlan(plan);
  assert.equal(plan.sourceCommit, closure.sourceCommit);
  const sourceRoot = await realpath(producerDirectory);
  const targetRoot = await realpath(stagedDirectory);
  assert.ok(
    sourceRoot !== targetRoot &&
      !sourceRoot.startsWith(`${targetRoot}${sep}`) &&
      !targetRoot.startsWith(`${sourceRoot}${sep}`),
    "Runtime stage overlaps producer",
  );
  // Plan bytes remain data until Foundation approves conveyance and the parent
  // combines them with independently verified owned and legal outputs.
  const pending = plan.files[Symbol.iterator]();
  let failed = false;
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(8, plan.files.length) }, async () => {
      try {
        for (let next = pending.next(); !failed && !next.done; next = pending.next()) {
          const file = next.value;
          assert.ok(file.path.startsWith("node_modules/"));
          const source = resolve(sourceRoot, file.path);
          const info = await lstat(source);
          assert.ok(info.isFile() && !info.isSymbolicLink());
          const bytes = await regularBytes(source);
          assert.equal(bytes.length, file.size);
          assert.equal(sha256(bytes), file.sha256, "Controlled producer member changed");
          const destination = resolve(targetRoot, file.path);
          await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
          await copyFile(source, destination, 1);
          await chmod(destination, file.mode);
          assert.equal(sha256(await readFile(destination)), file.sha256);
        }
      } catch (error) {
        failed = true;
        throw error;
      }
    }),
  );
  for (const result of results) if (result.status === "rejected") throw result.reason;
}
