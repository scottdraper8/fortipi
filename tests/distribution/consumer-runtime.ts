import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { CandidateManifest, FileRecord } from "../../scripts/verify-release-gates.ts";

type RuntimeCandidate = Pick<CandidateManifest, "scope" | "version"> & {
  packages: readonly { name: string; version: string }[];
};
export async function runtimeImports(candidate: RuntimeCandidate, consumer: string) {
  const exports = candidate.packages.map((p) => p.name);
  exports.push(
    `@${candidate.scope}/fortipi-client/browser`,
    `@${candidate.scope}/fortipi-client/node`,
  );
  const resolution = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(exports)}.map(name=>[name,import.meta.resolve(name)]))))`,
    ],
    {
      cwd: consumer,
      env: {
        PATH: process.env.PATH,
        LANG: "C.UTF-8",
        ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}),
      },
      timeout: 15000,
      maxBuffer: 32768,
      windowsHide: true,
    },
  );
  const resolved = JSON.parse(resolution.stdout) as Record<string, string>;
  const resolveExport = (name: string) => {
    assert.ok(exports.includes(name) && resolved[name]);
    return fileURLToPath(resolved[name]!);
  };
  for (const name of exports) {
    const path = resolveExport(name);
    assert.ok((await realpath(path)).startsWith(`${consumer}${sep}node_modules${sep}`));
    const loaded = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
    assert.ok(Object.keys(loaded).length > 0, "Installed public module must have real exports");
  }
  const bins: Record<string, string> = {};
  for (const pkg of candidate.packages) {
    const manifest = JSON.parse(
      await readFile(resolve(consumer, "node_modules", pkg.name, "package.json"), "utf8"),
    );
    assert.equal(manifest.name, pkg.name);
    assert.equal(manifest.version, pkg.version);
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      assert.ok(
        !name.startsWith("fortipi-"),
        "No unscoped own imports/dependencies in installed distribution",
      );
      if (name.startsWith(`@${candidate.scope}/fortipi-`)) assert.equal(version, candidate.version);
    }
    for (const [name, path] of Object.entries(manifest.bin ?? {}) as [string, string][]) {
      const bin = resolve(consumer, "node_modules", pkg.name, path);
      assert.ok(bin.startsWith(`${resolve(consumer, "node_modules", pkg.name)}${sep}`));
      assert.ok((await readFile(bin, "utf8")).startsWith("#!/usr/bin/env node\n"));
      assert.ok(!bins[name], "Candidate bin collision");
      bins[name] = bin;
    }
  }
  const cliRoot = resolve(consumer, "node_modules", `@${candidate.scope}/fortipi-cli`);
  const tools = createRequire(resolve(cliRoot, "package.json"));
  const wranglerManifest = tools.resolve("wrangler/package.json");
  const wrangler = JSON.parse(await readFile(wranglerManifest, "utf8"));
  assert.equal(
    wrangler.version,
    JSON.parse(await readFile(resolve(cliRoot, "package.json"), "utf8")).dependencies.wrangler,
  );
  return {
    resolveExport,
    bins,
    cliRoot,
    wranglerBin: resolve(dirname(wranglerManifest), wrangler.bin.wrangler),
    exports,
  };
}

/** Data for one already installed browser consumer. This is deliberately NOT a
 * CandidateManifest, artifact reference, reader context or archive authority. */
export interface InstalledClientSnapshot {
  schemaVersion: 1;
  candidateSha256: string;
  candidate: Pick<CandidateManifest, "scope" | "version" | "sourceCommit" | "assetManifestSha256">;
  consumer: string;
  browserEntry: string;
  wranglerBin: string;
  files: FileRecord[];
}
const snapshotBytes = 1024 * 1024;
const snapshotFiles = 4096;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const checkout = resolve(import.meta.dirname, "../..");
function below(root: string, path: string) {
  const rel = relative(root, path);
  return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}
function installedPath(root: string, path: string) {
  assert.ok(
    typeof path === "string" &&
      path.length <= 1024 &&
      !path.includes("\\") &&
      !path.includes("\0") &&
      path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "Invalid installed snapshot path",
  );
  const absolute = resolve(root, path);
  assert.ok(below(root, absolute), "Installed snapshot escaped its known consumer");
  return absolute;
}
async function installedFile(root: string, file: FileRecord) {
  const path = installedPath(root, file.path);
  assert.equal(
    await realpath(path),
    path,
    "Snapshot file must be an actual unlinked installed path",
  );
  const stat = await lstat(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
  assert.equal(stat.size, file.size);
  assert.equal(stat.mode & 0o777, file.mode);
  assert.equal(stat.mode & 0o222, 0, "Installed client bytes must stay read-only");
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  assert.equal(hash.digest("hex"), file.sha256, "Installed client bytes changed");
}

/** Called in trusted setup AFTER full archive authentication/install. Hashes
 * selected installed files only; it cannot authenticate or read any archive. */
export async function installedClientSnapshot(
  candidate: CandidateManifest,
  candidateSha256: string,
  consumer: string,
  ports: Awaited<ReturnType<typeof runtimeImports>>,
): Promise<InstalledClientSnapshot> {
  assert.equal(await realpath(consumer), consumer);
  assert.ok(!below(checkout, consumer) && consumer !== checkout);
  const files = new Map<string, FileRecord>();
  async function add(path: string, expected?: FileRecord) {
    const actual = await realpath(path);
    assert.ok(below(consumer, actual));
    const stat = await lstat(actual);
    const bytes = await readFile(actual);
    const file = {
      path: relative(consumer, actual).split(sep).join("/"),
      size: stat.size,
      mode: stat.mode & 0o777,
      sha256: digest(bytes),
    };
    if (expected) {
      assert.equal(file.size, expected.size);
      assert.equal(file.sha256, expected.sha256);
    }
    await installedFile(consumer, file);
    const prior = files.get(file.path);
    if (prior) assert.deepEqual(prior, file);
    files.set(file.path, file);
    assert.ok(
      files.size <= snapshotFiles,
      "Installed browser snapshot exceeds its bounded file set",
    );
    return file.path;
  }
  for (const pkg of candidate.packages.filter((pkg) =>
    ["fortipi-client", "fortipi-contract"].includes(pkg.sourceName),
  ))
    for (const file of pkg.entries)
      await add(resolve(consumer, "node_modules", pkg.name, file.path), file);
  const browserEntry = await add(ports.resolveExport(`@${candidate.scope}/fortipi-client/browser`));
  const wranglerBin = await add(ports.wranglerBin);
  const snapshot: InstalledClientSnapshot = {
    schemaVersion: 1,
    candidateSha256,
    candidate: {
      scope: candidate.scope,
      version: candidate.version,
      sourceCommit: candidate.sourceCommit,
      assetManifestSha256: candidate.assetManifestSha256,
    },
    consumer,
    browserEntry,
    wranglerBin,
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
  };
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= snapshotBytes);
  return snapshot;
}

/** Expected digest/path arrive via the trusted parent's existing private
 * channel. This returns client paths/data only; no archive reader is imported. */
export async function readInstalledClientSnapshot(path: string, expectedSha256: string) {
  assert.match(expectedSha256, /^[0-9a-f]{64}$/);
  assert.ok(isAbsolute(path) && !below(checkout, path) && path !== checkout);
  assert.equal(await realpath(path), path);
  const handle = await open(path, "r");
  let bytes: Buffer;
  try {
    const stat = await handle.stat();
    assert.ok(stat.isFile() && stat.nlink === 1 && stat.size > 0 && stat.size <= snapshotBytes);
    const bounded = Buffer.alloc(snapshotBytes + 1);
    const read = await handle.read(bounded, 0, bounded.length, 0);
    assert.ok(read.bytesRead <= snapshotBytes);
    bytes = bounded.subarray(0, read.bytesRead);
  } finally {
    await handle.close();
  }
  assert.equal(digest(bytes), expectedSha256, "Installed metadata changed in transit");
  const snapshot = JSON.parse(bytes.toString("utf8")) as InstalledClientSnapshot;
  const closed = (value: object, keys: string[]) =>
    assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
  closed(snapshot, [
    "schemaVersion",
    "candidateSha256",
    "candidate",
    "consumer",
    "browserEntry",
    "wranglerBin",
    "files",
  ]);
  assert.equal(snapshot.schemaVersion, 1);
  assert.match(snapshot.candidateSha256, /^[0-9a-f]{64}$/);
  closed(snapshot.candidate, ["scope", "version", "sourceCommit", "assetManifestSha256"]);
  assert.match(snapshot.candidate.scope, /^[a-z0-9][a-z0-9-]{0,99}$/);
  assert.match(snapshot.candidate.version, /^\d+\.\d+\.\d+$/);
  assert.match(snapshot.candidate.sourceCommit, /^[0-9a-f]{40}$/);
  assert.match(snapshot.candidate.assetManifestSha256, /^[0-9a-f]{64}$/);
  assert.ok(
    isAbsolute(snapshot.consumer) &&
      snapshot.consumer !== checkout &&
      !below(checkout, snapshot.consumer),
  );
  assert.equal(await realpath(snapshot.consumer), snapshot.consumer);
  assert.ok(
    Array.isArray(snapshot.files) &&
      snapshot.files.length > 0 &&
      snapshot.files.length <= snapshotFiles,
  );
  const paths = new Set<string>();
  for (const file of snapshot.files) {
    closed(file, ["path", "size", "mode", "sha256"]);
    assert.ok(!paths.has(file.path));
    paths.add(file.path);
    assert.ok(Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= 1024 ** 3);
    assert.ok(Number.isSafeInteger(file.mode) && file.mode >= 0 && file.mode <= 0o777);
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
  }
  assert.ok(paths.has(snapshot.browserEntry) && paths.has(snapshot.wranglerBin));
  const verifyUnchanged = async () => {
    for (const file of snapshot.files) await installedFile(snapshot.consumer, file);
  };
  await verifyUnchanged();
  return {
    candidate: snapshot.candidate,
    candidateSha256: snapshot.candidateSha256,
    consumer: snapshot.consumer,
    wranglerBin: installedPath(snapshot.consumer, snapshot.wranglerBin),
    resolveExport(name: string) {
      assert.equal(name, `@${snapshot.candidate.scope}/fortipi-client/browser`);
      return installedPath(snapshot.consumer, snapshot.browserEntry);
    },
    verifyUnchanged,
  };
}
