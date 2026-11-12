// Artifact checks only. Delivery/retention and Linux execution are separate claims.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { posix, resolve } from "node:path";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { x as extractTar } from "tar";
import { paragraphs } from "../apps/worker/container/debian.ts";
import {
  run,
  sha256,
  verifySigned,
  verifyUpstream,
} from "../apps/worker/container/fuse-security.ts";
import { inspectImageArchive } from "../apps/worker/container/image-archive.ts";
import {
  assertRuntimeConfig,
  filePolicy,
  type PrunePolicy,
} from "../apps/worker/container/image-prune.ts";
import { imageInputs } from "../apps/worker/container/inputs.ts";
import { type FsEntry, rootPath, scanRootfs } from "../apps/worker/container/rootfs.ts";

const repository = resolve(import.meta.dirname, "..");
const hex = /^[a-f0-9]{64}$/;
export async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
interface Payload {
  name: string;
  sha256: string;
  size: number;
}
interface NamedSource {
  name: string;
  version: string;
  descriptor: string;
  files: Payload[];
}
interface Package {
  name: string;
  version: string;
  source: string;
  sourceVersion: string;
  builtUsing: { name: string; version: string }[];
  staticBuiltUsing: { name: string; version: string }[];
}
interface Freeze {
  installed: Package[];
  pruning: PrunePolicy;
  sources: { name: string; version: string; files: { sha256: string; size: number }[] }[];
  releaseSha256: string;
  packagesIndexSha256: string;
  sourcesIndexSha256: string;
  fuseReleaseSha256: string;
  fusePackagesIndexSha256: string;
  fuseSourcesIndexSha256: string;
}
interface Embedded {
  binarySha256: string;
  assets: Record<string, { sha256: string; size: number }>;
  vendorSourceFiles: Record<string, string>;
  components: {
    name: string;
    version: string;
    sha256: string;
    integrity: string;
    notices: Record<string, string>;
  }[];
}
export interface KitOptions {
  kit: string;
  kitSha256: string;
  commit: string;
  repository?: string;
}
export interface VerifiedKit {
  directory: string;
  sourceCommit: string;
  sourceKitSha256: string;
  freeze: Freeze;
  embedded: Embedded;
  notices: Record<string, string>;
  sourceCount: number;
  payloadCount: number;
}
function json<T>(bytes: Uint8Array): T {
  return JSON.parse(Buffer.from(bytes).toString("utf8")) as T;
}
async function load<T>(directory: string, path: string): Promise<T> {
  return json<T>(await readFile(resolve(directory, path)));
}
function sourceId(source: { name: string; version: string }): string {
  return `${source.name}=${source.version}`;
}
function safeName(name: string): void {
  assert.match(name, /^[A-Za-z0-9][A-Za-z0-9_.+~-]*$/);
  assert.ok(!name.includes(".."), "Unsafe source filename");
}
function file(entries: Map<string, FsEntry>, path: string): FsEntry {
  const entry = entries.get(path);
  assert.equal(entry?.type, "File", `Missing regular file: ${path}`);
  assert.ok(entry?.sha256);
  return entry;
}
/** Exact member hashes, including the separately aggregated notices; never a file-count oracle. */
export function verifyKitInventory(
  entries: Map<string, FsEntry>,
  inventory: Record<string, string>,
): void {
  const expected = new Set(Object.keys(inventory).filter((name) => name !== "context/notices"));
  for (const path of expected)
    assert.equal(file(entries, path).sha256, inventory[path], `Kit payload changed: ${path}`);
  const notices = [...entries].filter(
    ([name, entry]) => name.startsWith("context/notices/") && entry.type === "File",
  );
  // Match producer fileHashes(): default-sort each directory, depth first.
  const ordered = notices.sort(([a], [b]) => {
    const left = a.split("/");
    const right = b.split("/");
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
      const l = left[i] ?? "";
      const r = right[i] ?? "";
      if (l !== r) return l < r ? -1 : 1;
    }
    return left.length - right.length;
  });
  assert.ok(ordered.length, "Source-kit notices missing");
  const noticeHashes = Object.fromEntries(
    ordered.map(([path, entry]) => [path.slice("context/notices/".length), entry.sha256]),
  );
  assert.equal(
    sha256(JSON.stringify(noticeHashes)),
    inventory["context/notices"],
    "Notice aggregate changed",
  );
  for (const [path, entry] of entries) {
    assert.ok(
      entry.type === "File" || entry.type === "Directory",
      "Source kit contains a link or special member",
    );
    if (entry.type === "Directory") {
      assert.ok(
        [...expected, ...ordered.map(([name]) => name), "source-kit-inventory.json"].some((name) =>
          name.startsWith(`${path}/`),
        ),
        `Unexpected kit directory: ${path}`,
      );
    } else
      assert.ok(
        path === "source-kit-inventory.json" ||
          expected.has(path) ||
          notices.some(([name]) => name === path),
        `Uninventoried kit payload: ${path}`,
      );
  }
}
export function verifySourceClosure(freeze: Freeze, sources: NamedSource[]): void {
  const needed = new Set(
    freeze.installed.flatMap((p) => [
      `${p.source}=${p.sourceVersion}`,
      ...p.builtUsing.map(sourceId),
      ...p.staticBuiltUsing.map(sourceId),
    ]),
  );
  assert.deepEqual(
    [...needed].sort(),
    freeze.sources.map(sourceId).sort(),
    "Final package source closure differs",
  );
  assert.deepEqual(
    sources.map(sourceId).sort(),
    [...needed].sort(),
    "Source-name map differs from final closure",
  );
  for (const source of sources) {
    const frozen = freeze.sources.find((pin) => sourceId(pin) === sourceId(source));
    assert.ok(frozen);
    const identity = (p: { sha256: string; size: number }) => `${p.sha256}:${p.size}`;
    assert.deepEqual(
      source.files.map(identity).sort(),
      frozen.files.map(identity).sort(),
      "Named source payload closure differs",
    );
    assert.equal(
      new Set(source.files.map((p) => p.name)).size,
      source.files.length,
      "Duplicate source filename",
    );
    assert.ok(
      source.files.some((p) => p.name === source.descriptor),
      "Missing source descriptor",
    );
  }
}
export async function verifyKitSignatures(directory: string, freeze: Freeze): Promise<void> {
  const home = await mkdtemp(resolve(directory, "gpgv-"));
  try {
    const archiveKeyring = resolve(directory, "security/archive-keyring.pgp");
    assert.equal(
      await hashFile(archiveKeyring),
      "506b815cbb32d9b6066b4a2aa524071e071761e7e7f68c3ac74f3061ba852017",
    );
    for (const [suite, releaseHash, packagesHash, sourcesHash] of [
      ["trixie", freeze.releaseSha256, freeze.packagesIndexSha256, freeze.sourcesIndexSha256],
      [
        "sid",
        freeze.fuseReleaseSha256,
        freeze.fusePackagesIndexSha256,
        freeze.fuseSourcesIndexSha256,
      ],
    ]) {
      assert.ok(suite && releaseHash && packagesHash && sourcesHash);
      const release = await verifySigned(
        resolve(directory, `security/${suite}.InRelease`),
        archiveKeyring,
        home,
        "04B54C3CDCA79751B16BC6B5225629DF75B188BD",
      );
      assert.equal(sha256(release), releaseHash, "Authenticated release drift");
      for (const [path, expected] of [
        ["main/binary-amd64/Packages.xz", packagesHash],
        ["main/source/Sources.xz", sourcesHash],
      ]) {
        assert.ok(path && expected);
        const index = resolve(directory, `security/${suite}-${path.replaceAll("/", "-")}`);
        const bytes = await readFile(index);
        assert.equal(sha256(bytes), expected, "Signed index changed");
        const row = (paragraphs(release)[0]?.get("SHA256") ?? "")
          .split("\n")
          .map((line) => line.trim().split(/\s+/))
          .find((row) => row[2] === path);
        assert.deepEqual(
          row,
          [expected, String(bytes.length), path],
          "Index not bound by signed release",
        );
      }
    }
    const keyring = resolve(directory, "security/debian-source-signer.pgp");
    assert.equal(
      await hashFile(keyring),
      "38ead01d85cc57fd75a07c1ea4ffcad736be6fb4c006f0cf7f029dda1472041f",
    );
    const descriptor = await verifySigned(
      resolve(directory, "sources/fuse3_3.18.3-1.dsc"),
      keyring,
      home,
      "A0DF7E0D3851E0EE45C00BC8ACE1F33CB933BBBB",
      "7D887DC8BA7BBBA7B835E3BADCE310E7864CC8BF",
    );
    assert.equal(paragraphs(descriptor)[0]?.get("Version"), "3.18.3-1");
    const key = await readFile(resolve(directory, "security/fuse-3.18.pub"));
    assert.equal(sha256(key), "68e9eab3bbb84a63cec0ca59eb82abb9cd1dee7059bce5bf92ca777f4186c7e0");
    verifyUpstream(
      await readFile(resolve(directory, "sources/fuse3_3.18.3.orig.tar.gz")),
      await readFile(resolve(directory, "sources/fuse3_3.18.3.orig.tar.gz.asc"), "utf8"),
      key.toString("utf8"),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
/** Caller owns directory cleanup. No artifact-carried program is executed. */
export async function verifySourceKit(
  options: KitOptions,
  directory: string,
): Promise<VerifiedKit> {
  assert.match(options.kitSha256, hex);
  assert.match(options.commit, /^[a-f0-9]{40}$/);
  assert.equal(
    await hashFile(options.kit),
    options.kitSha256,
    "Source-kit transport digest differs",
  );
  const entries = await scanRootfs(
    createReadStream(options.kit),
    undefined,
    new Set(["source-kit-inventory.json"]),
  );
  const inventoryBytes = file(entries, "source-kit-inventory.json").data;
  assert.ok(inventoryBytes);
  verifyKitInventory(entries, json<Record<string, string>>(inventoryBytes));
  // Scan first: extractTar never sees unvalidated paths, duplicates, links or special entries.
  await mkdir(directory, { recursive: true });
  assert.ok(
    (await lstat(directory)).isDirectory() && !(await lstat(directory)).isSymbolicLink(),
    "Extraction directory must be a real directory",
  );
  assert.deepEqual(await readdir(directory), [], "Kit extraction requires an empty directory");
  await extractTar({ cwd: directory, file: options.kit, strict: true, noChmod: true });
  const revision = await load<{
    sourceCommit: string;
    sourceArchiveSha256: string;
    recipeMatchesCommit: boolean;
    packageJsonSha256: string;
    lockSha256: string;
    platformMetadataSha256: string;
    node: string;
    pnpm: string;
    tar: string;
  }>(directory, "source-revision.json");
  assert.equal(revision.sourceCommit, options.commit, "Kit source commit differs");
  assert.equal(revision.recipeMatchesCommit, true, "Construction-only kit is not distributable");
  const git = (args: string[]) => run("git", ["-C", options.repository ?? repository, ...args]);
  assert.equal(
    sha256(await git(["archive", "--format=tar", options.commit])),
    revision.sourceArchiveSha256,
    "Git commit/archive binding differs",
  );
  assert.equal(file(entries, "fortipi-source.tar").sha256, revision.sourceArchiveSha256);
  const ownSource = await scanRootfs(
    createReadStream(resolve(directory, "fortipi-source.tar")),
    undefined,
    new Set(["package.json", "pnpm-lock.yaml", "tools/unstale/platform-tools.json"]),
  );
  for (const [path, digest] of [
    ["package.json", revision.packageJsonSha256],
    ["pnpm-lock.yaml", revision.lockSha256],
    ["tools/unstale/platform-tools.json", revision.platformMetadataSha256],
  ]) {
    assert.ok(path && digest);
    assert.equal(file(ownSource, path).sha256, digest, "Source revision metadata differs");
  }
  assert.deepEqual([revision.node, revision.pnpm, revision.tar], ["26.13.0", "12.18.0", "7.5.22"]);
  for (const [path, entry] of entries)
    if (path.startsWith("source-kit-recipe/") && entry.type === "File") {
      const name = posix.basename(path);
      const source =
        name === "platform-tools.json"
          ? "tools/unstale/platform-tools.json"
          : `apps/worker/container/${name}`;
      assert.equal(
        entry.sha256,
        file(ownSource, source).sha256,
        `Recipe differs from committed source: ${name}`,
      );
    }
  const freeze = await load<Freeze>(directory, "source-kit-recipe/debian-freeze.json");
  await scanRootfs(createReadStream(options.kit), {
    paths: new Set(),
    hashes: filePolicy(freeze.pruning).hashes,
  });
  await scanRootfs(createReadStream(resolve(directory, "fortipi-source.tar")), {
    paths: new Set(),
    hashes: filePolicy(freeze.pruning).hashes,
  });
  const sources = await load<NamedSource[]>(directory, "source-names.json");
  verifySourceClosure(freeze, sources);
  const payloads = new Set<string>();
  for (const source of sources) {
    for (const payload of source.files) {
      safeName(payload.name);
      const entry = file(entries, `sources/${payload.name}`);
      assert.equal(entry.sha256, payload.sha256, "Source payload digest differs");
      assert.equal(entry.size, payload.size, "Source payload length differs");
      payloads.add(`sources/${payload.name}`);
    }
    const descriptor = paragraphs(
      await readFile(resolve(directory, "sources", source.descriptor), "utf8"),
    ).find((row) => row.has("Source"));
    assert.ok(descriptor);
    assert.equal(descriptor.get("Source"), source.name);
    assert.equal(descriptor.get("Version"), source.version);
    const siblings = (descriptor.get("Checksums-Sha256") ?? "")
      .trim()
      .split("\n")
      .map((line) => {
        const [sha256, size, name] = line.trim().split(/\s+/);
        assert.ok(name && sha256);
        safeName(name);
        return `${name}:${sha256}:${Number(size)}`;
      });
    assert.deepEqual(
      siblings.sort(),
      source.files
        .filter((p) => p.name !== source.descriptor)
        .map((p) => `${p.name}:${p.sha256}:${p.size}`)
        .sort(),
      "DSC sibling closure differs",
    );
  }
  assert.deepEqual(
    [...entries.keys()]
      .filter((path) => path.startsWith("sources/") && entries.get(path)?.type === "File")
      .sort(),
    [...payloads].sort(),
    "Extra or missing source payload",
  );
  const licenses = await load<Record<string, Record<string, string>>>(
    directory,
    "source-kit-recipe/debian-licenses.json",
  );
  assert.deepEqual(
    Object.keys(licenses).sort(),
    sources.map(sourceId).sort(),
    "Source license closure differs",
  );
  assert.deepEqual(
    await load(directory, "context/notices/debian-sources/source-license-inventory.json"),
    licenses,
  );
  for (const [identity, notices] of Object.entries(licenses)) {
    assert.ok(Object.keys(notices).length, "Source has no notices");
    for (const [origin, digest] of Object.entries(notices)) {
      const name = `context/notices/debian-sources/${identity.replace(/[^a-zA-Z0-9_.+-]/g, "_")}/${digest}-${posix.basename(origin.slice(origin.indexOf(":") + 1))}`;
      assert.equal(file(entries, name).sha256, digest, "Source notice differs");
    }
  }
  const embedded = await load<Embedded>(directory, "source-kit-recipe/embedded-freeze.json");
  assert.deepEqual(
    await load(directory, "context/notices/embedded/embedded-inventory.json"),
    embedded,
  );
  assert.equal(file(entries, "computer-source.tgz").sha256, imageInputs.sourceArchiveSha256);
  const computer = resolve(directory, "computer-source.tgz");
  for (const [path, expected] of Object.entries(embedded.vendorSourceFiles)) {
    assert.equal(
      sha256(await run("tar", ["-xOf", computer, `computer-${imageInputs.source}/${path}`])),
      expected,
      "Vendored native source differs",
    );
    if (/(?:LICENSE|PATCHES.md|UPSTREAM.md)$/.test(path))
      assert.equal(
        file(entries, `context/notices/embedded/modified-fuse-napi/${posix.basename(path)}`).sha256,
        expected,
      );
  }
  for (const component of embedded.components) {
    const name = `${component.name.replaceAll("/", "_")}-${component.version}`;
    const archive = resolve(directory, `embedded-${name}.tgz`);
    const bytes = await readFile(archive);
    assert.equal(sha256(bytes), component.sha256);
    assert.equal(
      `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      component.integrity,
    );
    for (const [path, expected] of Object.entries(component.notices)) {
      assert.equal(sha256(await run("tar", ["-xOf", archive, path])), expected);
      assert.equal(
        file(entries, `context/notices/embedded/${name}/${path.replaceAll("/", "_")}`).sha256,
        expected,
      );
    }
  }
  assert.equal(
    file(entries, "context/notices/Node-LICENSE").sha256,
    imageInputs.embeddedNodeLicenseSha256,
  );
  assert.equal(
    file(entries, "context/notices/Computer-LICENSE").sha256,
    sha256(await run("tar", ["-xOf", computer, `computer-${imageInputs.source}/LICENSE`])),
  );
  await verifyKitSignatures(directory, freeze);
  assert.equal(await hashFile(options.kit), options.kitSha256, "Kit changed during verification");
  const notices: Record<string, string> = {};
  for (const [path, entry] of entries) {
    if (path.startsWith("context/notices/") && entry.type === "File") {
      assert.ok(entry.sha256);
      notices[path.slice("context/notices/".length)] = entry.sha256;
    }
  }
  return {
    directory,
    sourceCommit: options.commit,
    sourceKitSha256: options.kitSha256,
    freeze,
    embedded,
    notices,
    sourceCount: sources.length,
    payloadCount: payloads.size,
  };
}

export interface ImageOptions extends KitOptions {
  image: string;
  metadata: string;
  metadataSha256: string;
  records: string;
}
export interface VerifiedImage {
  imageId: string;
  imageArchiveSha256: string;
  metadataSha256: string;
  builtManifestDigest: string;
}
export async function verifyImageSourceDistribution(
  options: ImageOptions,
  kit: VerifiedKit,
): Promise<VerifiedImage> {
  assert.match(options.metadataSha256, hex);
  assert.equal(
    await hashFile(options.metadata),
    options.metadataSha256,
    "Metadata transport digest differs",
  );
  const metadata = json<Record<string, unknown>>(await readFile(options.metadata));
  assert.equal(metadata.schemaVersion, 1);
  assert.equal(metadata.computerSource, imageInputs.source);
  assert.equal(metadata.computerSourceArchiveSha256, imageInputs.sourceArchiveSha256);
  assert.equal(metadata.embeddedNodeVersion, imageInputs.embeddedNodeVersion);
  assert.equal(metadata.computerVersion, imageInputs.computerVersion);
  assert.equal(metadata.sourceCommit, kit.sourceCommit);
  assert.equal(metadata.sourceKitSha256, kit.sourceKitSha256, "Image/source kit mismatch");
  assert.equal(metadata.platform, "linux/amd64");
  assert.equal(
    metadata.freezeSha256,
    await hashFile(resolve(kit.directory, "source-kit-recipe/debian-freeze.json")),
  );
  assert.equal(
    metadata.embeddedInventorySha256,
    await hashFile(resolve(kit.directory, "source-kit-recipe/embedded-freeze.json")),
  );
  const imageArchiveSha256 = await hashFile(options.image);
  assert.equal(metadata.archiveSha256, imageArchiveSha256, "Saved image transport differs");
  assert.equal(typeof metadata.imageId, "string");
  const imageId = String(metadata.imageId);
  const inspected = await inspectImageArchive(options.image, imageId, {
    filesystem: true,
    pruning: kit.freeze.pruning,
  });
  assertRuntimeConfig(inspected.configuration);
  assert.deepEqual(inspected.saved, metadata.savedImage);
  assert.equal(inspected.saved.manifest.digest, metadata.builtManifestDigest);
  assert.equal(sha256(JSON.stringify(inspected.configuration)), metadata.runtimeImageConfigSha256);
  assert.equal(
    file(inspected.filesystem, "usr/local/bin/computerd").sha256,
    kit.embedded.binarySha256,
  );
  const native = await load<{ inputs: Record<string, string> }>(
    kit.directory,
    "native-compatibility.json",
  );
  assert.equal(native.inputs["fuse.node"], kit.embedded.assets["fuse.node"]?.sha256);
  for (const [name, path] of [
    ["computerd", "usr/local/bin/computerd"],
    ["libc.so.6", "usr/lib/x86_64-linux-gnu/libc.so.6"],
    ["libfuse3.so.4", "usr/lib/x86_64-linux-gnu/libfuse3.so.3.18.3"],
    ["fusermount3", "usr/bin/fusermount3"],
  ]) {
    assert.ok(name && path);
    assert.equal(
      file(inspected.filesystem, path).sha256,
      native.inputs[name],
      "Final conveyed ELF/native record differs",
    );
  }
  // Re-read status/notices from the actual conveyed layers, independently of docker cp records.
  const capture = new Set(["var/lib/dpkg/status"]);
  const actual = new Map<string, FsEntry>();
  for (const layer of inspected.saved.layers) {
    const bytes = await run("tar", [
      "-xOf",
      options.image,
      `blobs/sha256/${layer.digest.slice(7)}`,
    ]);
    const stream = layer.mediaType.endsWith("+gzip")
      ? Readable.from([bytes]).pipe(createGunzip())
      : Readable.from([bytes]);
    const entries = await scanRootfs(stream, undefined, capture);
    for (const [name, entry] of entries) if (capture.has(name)) actual.set(name, entry);
  }
  const status = file(actual, "var/lib/dpkg/status").data;
  assert.ok(status);
  assert.equal(
    file(actual, "var/lib/dpkg/status").sha256,
    file(inspected.filesystem, "var/lib/dpkg/status").sha256,
    "Captured status is not the final conveyed file",
  );
  const normalized = paragraphs(status.toString("utf8"))
    .filter((p) => p.get("Status") === "install ok installed")
    .map((p) => {
      const name = p.get("Package");
      const version = p.get("Version");
      assert.ok(name && version);
      const source = /^(\S+)(?: \(([^)]+)\))?$/.exec(p.get("Source") ?? name);
      assert.ok(source?.[1]);
      const relation = (field: string) =>
        (p.get(field) ?? "")
          .split(",")
          .filter((s) => s.trim())
          .map((s) => {
            const match = /^\s*(\S+) \(= ([^)]+)\)\s*$/.exec(s);
            assert.ok(match?.[1] && match[2]);
            return { name: match[1], version: match[2] };
          });
      return {
        name,
        version,
        source: source[1],
        sourceVersion: source[2] ?? version,
        builtUsing: relation("Built-Using"),
        staticBuiltUsing: relation("Static-Built-Using"),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const frozen = kit.freeze.installed
    .map(({ name, version, source, sourceVersion, builtUsing, staticBuiltUsing }) => ({
      name,
      version,
      source,
      sourceVersion,
      builtUsing,
      staticBuiltUsing,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(normalized, frozen, "Conveyed installed source inventory differs");
  for (const [record, field] of [
    ["installed-source-inventory.json", "installedSourceInventorySha256"],
    ["license-inventory.json", "licenseInventorySha256"],
  ]) {
    assert.ok(record && field);
    assert.equal(await hashFile(resolve(options.records, record)), metadata[field]);
  }
  assert.deepEqual(await load(options.records, "installed-source-inventory.json"), normalized);
  const licenses = await load<Record<string, string>>(options.records, "license-inventory.json");
  assert.ok(Object.keys(licenses).length);
  const actualLicenseInventory: Record<string, string> = {};
  const regularHash = (path: string, seen = new Set<string>()): string => {
    assert.ok(!seen.has(path), "Hardlink cycle in final notices");
    seen.add(path);
    const entry = inspected.filesystem.get(path);
    assert.ok(entry, `Missing final notice: ${path}`);
    if (entry.type === "Link") return regularHash(rootPath(entry.link), seen);
    assert.equal(entry.type, "File", `Final notice is not a regular file: ${path}`);
    assert.ok(entry.sha256);
    return entry.sha256;
  };
  // The committed Dockerfile copies this exact kit directory. Producer metadata
  // and its own inventory cannot waive or redefine any of these required bytes.
  for (const [path, expected] of Object.entries(kit.notices))
    assert.equal(
      regularHash(`usr/share/doc/fortipi-computerd/${path}`),
      expected,
      `Kit notice changed in final image: ${path}`,
    );
  for (const [path, entry] of inspected.filesystem) {
    const name = path.startsWith("usr/share/doc/")
      ? path.slice("usr/share/doc/".length)
      : path.startsWith("usr/share/common-licenses/")
        ? `common/${path.slice("usr/share/common-licenses/".length)}`
        : undefined;
    if (name && entry.type !== "Directory")
      actualLicenseInventory[name] =
        entry.type === "SymbolicLink" ? `symlink:${entry.link}` : regularHash(path);
  }
  assert.deepEqual(
    licenses,
    actualLicenseInventory,
    "Final notice inventory is incomplete or changed",
  );
  for (const [path, expected] of Object.entries(licenses)) {
    const imagePath = path.startsWith("common/")
      ? `usr/share/common-licenses/${path.slice(7)}`
      : `usr/share/doc/${path}`;
    const entry = inspected.filesystem.get(imagePath);
    assert.ok(entry, `Missing image license: ${path}`);
    assert.equal(
      entry.type === "SymbolicLink" ? `symlink:${entry.link}` : regularHash(imagePath),
      expected,
      `Image license differs: ${path}`,
    );
  }
  assert.equal(await hashFile(options.image), imageArchiveSha256);
  return {
    imageId,
    imageArchiveSha256,
    metadataSha256: options.metadataSha256,
    builtManifestDigest: inspected.saved.manifest.digest,
  };
}
/** A hashed result from the trusted Linux producer is required, never a source-only receipt. */
export function verifyReplacementRecord(
  record: Record<string, unknown>,
  image: VerifiedImage,
  kit: Pick<VerifiedKit, "sourceCommit" | "sourceKitSha256">,
): void {
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.claim, "linux-fuse-library-replacement");
  assert.equal(record.platform, "linux/amd64");
  for (const [key, expected] of Object.entries({
    ...image,
    sourceCommit: kit.sourceCommit,
    sourceKitSha256: kit.sourceKitSha256,
  }))
    assert.equal(record[key], expected, `Replacement identity differs: ${key}`);
  for (const field of [
    "originalLibrarySha256",
    "modifiedLibrarySha256",
    "addonSha256",
    "helperSha256",
    "originalHelperSha256",
    "modificationSha256",
  ])
    assert.match(String(record[field]), hex);
  assert.notEqual(
    record.originalLibrarySha256,
    record.modifiedLibrarySha256,
    "Replacement is the unmodified library",
  );
  assert.equal(record.replacementVerified, true);
  assert.equal(record.realFuse, true);
  assert.equal(record.missingExportRejected, true);
  assert.equal(record.staticHelperRelinkVerified, true);
  assert.equal(record.helperBaselineNoWitness, true);
  assert.notEqual(record.helperSha256, record.originalHelperSha256, "Helper was not relinked");
  for (const name of ["baseline", "replacement"]) {
    const observation = record[name] as Record<string, unknown> | undefined;
    assert.ok(observation && typeof observation === "object");
    for (const [key, expected] of Object.entries({
      status: "completed",
      exitCode: 0,
      content: "fortipi-result",
      canary: true,
      sync: "complete",
      skipped: 0,
      fuse: true,
      modifiedImplementationCalled: name === "replacement",
    }))
      assert.equal(
        observation[key],
        expected,
        `Replacement runtime evidence missing: ${name}/${key}`,
      );
    assert.match(String(observation.computerdSha256), hex);
  }
  const baseline = record.baseline as Record<string, unknown>;
  const replacement = record.replacement as Record<string, unknown>;
  assert.equal(baseline.imageId, image.imageId);
  assert.match(String(replacement.imageId), /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(replacement.imageId, baseline.imageId);
  assert.equal(baseline.computerdSha256, replacement.computerdSha256, "Computerd was replaced");
  assert.equal(replacement.mappedLibrary, "/opt/fortipi-replacement/libfuse3.so.4");
}
export function commandOptions(args: string[]): Record<string, string> {
  assert.equal(args.length % 2, 0, "Expected --name value pairs");
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    const value = args[i + 1];
    assert.ok(name);
    assert.ok(
      name.startsWith("--") && value && !options[name.slice(2)],
      "Missing/duplicate option",
    );
    options[name.slice(2)] = value;
  }
  return options;
}
if (import.meta.main) {
  const directory = await mkdtemp(resolve(tmpdir(), "fortipi-source-check-"));
  try {
    const args = commandOptions(process.argv.slice(2));
    const required = (name: string) => {
      const value = args[name];
      assert.ok(value, `Required --${name}`);
      return value;
    };
    const kit = await verifySourceKit(
      { kit: required("kit"), kitSha256: required("kit-sha256"), commit: required("commit") },
      directory,
    );
    const image = await verifyImageSourceDistribution(
      {
        kit: required("kit"),
        kitSha256: required("kit-sha256"),
        commit: required("commit"),
        image: required("image"),
        metadata: required("metadata"),
        metadataSha256: required("metadata-sha256"),
        records: required("records"),
      },
      kit,
    );
    let replacementVerified = false;
    if (args.replacement || args["replacement-sha256"]) {
      assert.equal(
        await hashFile(required("replacement")),
        required("replacement-sha256"),
        "Replacement receipt transport differs",
      );
      const record = json<Record<string, unknown>>(await readFile(required("replacement")));
      verifyReplacementRecord(record, image, kit);
      assert.equal(record.addonSha256, kit.embedded.assets["fuse.node"]?.sha256);
      const native = await load<{ inputs: Record<string, string> }>(
        kit.directory,
        "native-compatibility.json",
      );
      assert.equal(record.originalLibrarySha256, native.inputs["libfuse3.so.4"]);
      assert.equal(record.originalHelperSha256, native.inputs.fusermount3);
      assert.equal(
        (record.baseline as Record<string, unknown>).computerdSha256,
        kit.embedded.binarySha256,
      );
      replacementVerified = true;
    }
    const receipt = {
      schemaVersion: 1,
      ...image,
      sourceCommit: kit.sourceCommit,
      sourceKitSha256: kit.sourceKitSha256,
      sourceCount: kit.sourceCount,
      payloadCount: kit.payloadCount,
      artifactVerified: true,
      replacementVerified,
      deliveryVerified: false,
    };
    await writeFile(required("out"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Source distribution verification failed"}\n`,
    );
    process.exitCode = 1;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
