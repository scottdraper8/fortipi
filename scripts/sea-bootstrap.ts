// Metadata-only bridge for a build-derived SEA freeze. This grants no image/runtime acceptance.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const hashPattern = /^[a-f0-9]{64}$/;
const computerSource = "812bce58d2ea3735c12e6f6181c269c4010293df";
const runtimeArchive = "cdeb8670a0c81f51b4dc4ac61919f9b1ad917b304bf8221eb939570663d240f8";
const inputs = {
  "embedded-freeze.json": "apps/worker/container/embedded-freeze.json",
  "computerd-build.json": "apps/worker/dist/container/computerd-build.json",
  "build-inputs.json": "apps/worker/dist/container/daemon-build/build-inputs.json",
  "node-authentication.json": "apps/worker/dist/container/daemon-build/node-authentication.json",
  "metafile.json": "apps/worker/dist/container/daemon-build/metafile.json",
};
function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
async function regular(path: string): Promise<void> {
  let current = dirname(path);
  while (true) {
    const stat = await lstat(current);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "Linked metadata parent");
    if (dirname(current) === current) break;
    current = dirname(current);
  }
  const stat = await lstat(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, "Nonregular metadata");
}
async function git(...args: string[]): Promise<string> {
  return (
    await promisify(execFile)("git", args, { cwd: root, timeout: 15000, maxBuffer: 65536 })
  ).stdout.trim();
}
export async function collectSeaBootstrap(): Promise<void> {
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "x64");
  assert.equal(process.versions.node, "26.13.1");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.GITHUB_REPOSITORY, "scottdraper8/fortipi");
  assert.match(process.env.GITHUB_REF ?? "", /^refs\/heads\/ci\/fortipi-image-sea-[a-zA-Z0-9-]+$/);
  assert.ok(["push", "workflow_dispatch"].includes(process.env.GITHUB_EVENT_NAME ?? ""));
  const source = await git("rev-parse", "HEAD");
  assert.equal(source, process.env.GITHUB_SHA);
  assert.equal(source, process.env.SOURCE_SHA);
  const changed = (await git("diff", "--name-only", "HEAD")).split("\n").filter(Boolean);
  assert.ok(
    changed.every((path) => path === inputs["embedded-freeze.json"]),
    "Producer source drift",
  );
  const payload: Record<string, { bytes: Buffer; value: Record<string, unknown> }> = {};
  for (const [name, relative] of Object.entries(inputs)) {
    const path = resolve(root, relative);
    await regular(path);
    const stat = await lstat(path);
    assert.ok(stat.size > 0 && stat.size <= 8_000_000, "Metadata byte bound");
    const bytes = await readFile(path);
    payload[name] = { bytes, value: object(JSON.parse(bytes.toString("utf8"))) };
  }
  const freeze = payload["embedded-freeze.json"]?.value;
  const built = payload["computerd-build.json"]?.value;
  const prepared = payload["build-inputs.json"]?.value;
  const authenticated = payload["node-authentication.json"]?.value;
  assert.ok(freeze && built && prepared && authenticated);
  assert.equal(built.schemaVersion, 1);
  assert.equal(built.computerSource, computerSource);
  assert.equal(built.nodeVersion, "22.23.5");
  assert.equal(built.generatorVersion, "22.23.5");
  assert.equal(built.nodeArchiveSha256, runtimeArchive);
  assert.equal(authenticated.archiveSha256, runtimeArchive);
  assert.equal(authenticated.version, "22.23.5");
  assert.equal(built.nodeExecutableSha256, authenticated.executableSha256);
  assert.match(String(built.binarySha256), hashPattern);
  assert.match(String(built.blobSha256), hashPattern);
  for (const [key, value] of Object.entries(prepared)) assert.deepEqual(built[key], value);
  const binary = resolve(root, "apps/worker/dist/container/computerd-built");
  await regular(binary);
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(binary)) hash.update(bytes);
  assert.equal(hash.digest("hex"), built.binarySha256, "Actual executable hash mismatch");
  assert.equal(freeze.binarySha256, built.binarySha256);
  assert.equal(freeze.bootstrapSha256, built.bootstrapSha256);
  const assets = object(freeze.assets);
  assert.deepEqual(Object.keys(assets).sort(), ["bundle.mjs", "fuse.node"]);
  assert.equal(object(assets["bundle.mjs"]).sha256, built.bundleSha256);
  assert.equal(object(assets["fuse.node"]).sha256, built.addonSha256);
  const runId = Number(process.env.GITHUB_RUN_ID),
    runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  assert.ok(Number.isSafeInteger(runId) && runId > 0);
  assert.ok(Number.isSafeInteger(runAttempt) && runAttempt > 0);
  const directory = resolve(root, "dist/sea-bootstrap");
  await mkdir(directory, { mode: 0o700 });
  const files = [];
  for (const [name, { bytes }] of Object.entries(payload)) {
    await writeFile(resolve(directory, name), bytes, { flag: "wx", mode: 0o600 });
    files.push({ path: name, size: bytes.length, sha256: digest(bytes) });
  }
  await writeFile(
    resolve(directory, "receipt.json"),
    `${JSON.stringify({ schemaVersion: 1, scope: "embedded-freeze-bootstrap", sourceCommit: source, runId, runAttempt, hostNode: process.versions.node, generatorVersion: built.generatorVersion, binarySha256: built.binarySha256, runtimeVerified: false, imageVerified: false, files }, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    JSON.stringify({ sourceCommit: source, binarySha256: built.binarySha256, metadataOnly: true }),
  );
}
if (import.meta.main) await collectSeaBootstrap();
