import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { imageInputs } from "./inputs.ts";

const here = dirname(fileURLToPath(import.meta.url));
const output = resolve(here, "../dist/container");
type Download = (url: string, expected?: string) => Promise<Uint8Array>;
interface Component {
  name: string;
  version: string;
  lockPath: string;
  url: string;
  integrity: string;
  sha256: string;
  notices: Record<string, string>;
}
interface Inventory {
  binarySha256: string;
  bootstrapSha256: string;
  assets: Record<string, { size: number; sha256: string }>;
  components: Component[];
  vendorSourceFiles: Record<string, string>;
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function tar(archive: string, path: string): Buffer {
  return execFileSync("tar", ["-xOf", archive, path], { maxBuffer: 256 * 1024 * 1024 });
}
function list(archive: string): string[] {
  return execFileSync("tar", ["-tf", archive], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
    .trim()
    .split("\n");
}
/** Parse the actual Node22 SEA serialization, never execute the Linux binary on the build host. */
function sea(binary: Buffer): { bootstrap: Buffer; assets: Map<string, Buffer> } {
  let offset = -1;
  for (;;) {
    offset = binary.indexOf(Buffer.from([0x20, 0xda, 0x43, 0x01]), offset + 1);
    if (offset < 0) break;
    try {
      const flags = binary.readUInt32LE(offset + 4);
      let cursor = offset + 9;
      const string = () => {
        const size = Number(binary.readBigUInt64LE(cursor));
        cursor += 8;
        check(Number.isSafeInteger(size) && size <= binary.length - cursor, "Invalid SEA field");
        const value = binary.subarray(cursor, cursor + size);
        cursor += size;
        return value;
      };
      const path = string().toString("utf8");
      if (!path.endsWith("/computerd/scripts/sea/bootstrap.cjs")) continue;
      check((flags & 2) === 0 && (flags & 8) !== 0, "Unexpected SEA snapshot/assets mode");
      const bootstrap = string();
      if (flags & 4) string();
      const count = Number(binary.readBigUInt64LE(cursor));
      cursor += 8;
      check(count <= 8, "Unexpected SEA asset count");
      const assets = new Map<string, Buffer>();
      for (let index = 0; index < count; index++) {
        const name = string().toString("utf8");
        check(!assets.has(name), "Duplicate SEA asset");
        assets.set(name, string());
      }
      check(assets.has("bundle.mjs") && assets.has("fuse.node"), "Missing SEA runtime assets");
      return { bootstrap, assets };
    } catch {}
  }
  throw new Error("Source-matched computerd SEA resource not found");
}
async function inputs(download: Download) {
  await mkdir(output, { recursive: true });
  const archive = resolve(output, "computer-source.tgz");
  await writeFile(
    archive,
    await download(
      `https://codeload.github.com/cloudflare/computer/tar.gz/${imageInputs.source}`,
      imageInputs.sourceArchiveSha256,
    ),
  );
  const layer = resolve(
    output,
    "9f4637c57d28d94e19eb448f66cbcf4dcca06761ae890ec1d75081c642e7cb3d.tgz",
  );
  check(
    hash(await readFile(layer)) ===
      "9f4637c57d28d94e19eb448f66cbcf4dcca06761ae890ec1d75081c642e7cb3d",
    "Computerd layer drift",
  );
  const binary = tar(layer, "usr/local/bin/computerd");
  const extracted = sea(binary);
  const top = `computer-${imageInputs.source}/`;
  check(
    extracted.bootstrap.equals(tar(archive, `${top}packages/computerd/scripts/sea/bootstrap.cjs`)),
    "SEA bootstrap/source mismatch",
  );
  return { archive, binary, extracted, top };
}
async function component(
  download: Download,
  name: string,
  version: string,
  lockPath: string,
  url: string,
  integrity: string,
): Promise<Component> {
  check(
    url.startsWith("https://registry.npmjs.org/") && integrity.startsWith("sha512-"),
    "Unpinned embedded package",
  );
  const bytes = await download(url);
  check(
    createHash("sha512").update(bytes).digest("base64") === integrity.slice(7),
    "Embedded package SRI mismatch",
  );
  const archive = resolve(output, `embedded-${name.replaceAll("/", "_")}-${version}.tgz`);
  await writeFile(archive, bytes);
  const notices: Record<string, string> = {};
  for (const path of list(archive))
    if (/(?:^|\/)(?:licen[cs]e|copying|notice|authors)(?:[._-][^/]*)?$/i.test(path))
      notices[path] = hash(tar(archive, path));
  check(
    Object.keys(notices).length > 0,
    `Embedded package has no distributable notices: ${name}@${version}`,
  );
  return { name, version, lockPath, url, integrity, sha256: hash(bytes), notices };
}
export async function freezeEmbedded(download: Download): Promise<void> {
  const { archive, binary, extracted, top } = await inputs(download);
  const lock = JSON.parse(tar(archive, `${top}package-lock.json`).toString()) as {
    packages: Record<string, { version: string; resolved?: string; integrity?: string }>;
  };
  const code = extracted.assets.get("bundle.mjs");
  check(code, "Missing actual embedded JavaScript");
  const paths = [
    ...new Set(
      [
        ...code
          .toString("utf8")
          .matchAll(/^\/\/ ([^\n]*node_modules\/((?:@[^/]+\/)?[^/\n]+))\/[^\n]+$/gm),
      ].map((match) => posix.normalize(`packages/computerd/${match[1]}`)),
    ),
  ];
  const components: Component[] = [];
  for (const path of paths) {
    const pin = lock.packages[path];
    check(pin?.resolved && pin.integrity, `Embedded source has no exact lock identity: ${path}`);
    const name = path.slice(path.lastIndexOf("node_modules/") + 13);
    components.push(
      await component(download, name, pin.version, path, pin.resolved, pin.integrity),
    );
  }
  const macros = lock.packages["node_modules/napi-macros"];
  check(macros?.resolved && macros.integrity, "Missing inline native header identity");
  components.push(
    await component(
      download,
      "napi-macros",
      macros.version,
      "node_modules/napi-macros",
      macros.resolved,
      macros.integrity,
    ),
  );
  // The shipped addon uses Cloudflare's modified vendored source. Preserve both its complete source
  // identity and the exact upstream author notice, never relabel it as unmodified npm code.
  const vendor = `${top}packages/computerd/vendor/fuse-napi/`;
  const vendorPackage = JSON.parse(tar(archive, `${vendor}package.json`).toString()) as {
    version: string;
  };
  const metadata = await fetch(`https://registry.npmjs.org/fuse-napi/${vendorPackage.version}`, {
    signal: AbortSignal.timeout(30_000),
  });
  check(metadata.ok, "Upstream native author notice unavailable");
  const published = (await metadata.json()) as { dist: { tarball: string; integrity: string } };
  components.push(
    await component(
      download,
      "fuse-napi",
      vendorPackage.version,
      "modified-vendor-source",
      published.dist.tarball,
      published.dist.integrity,
    ),
  );
  const vendorSourceFiles: Record<string, string> = {};
  for (const path of list(archive))
    if (path.startsWith(vendor) && !path.endsWith("/"))
      vendorSourceFiles[path.slice(top.length)] = hash(tar(archive, path));
  const inventory: Inventory = {
    binarySha256: hash(binary),
    bootstrapSha256: hash(extracted.bootstrap),
    assets: Object.fromEntries(
      [...extracted.assets].map(([name, bytes]) => [
        name,
        { size: bytes.length, sha256: hash(bytes) },
      ]),
    ),
    components: components.sort((a, b) => a.lockPath.localeCompare(b.lockPath)),
    vendorSourceFiles,
  };
  await writeFile(resolve(here, "embedded-freeze.json"), `${JSON.stringify(inventory, null, 2)}\n`);
}
export async function prepareEmbedded(download: Download): Promise<void> {
  const frozen = JSON.parse(
    await readFile(resolve(here, "embedded-freeze.json"), "utf8"),
  ) as Inventory;
  const { binary, extracted } = await inputs(download);
  check(
    hash(binary) === frozen.binarySha256 && hash(extracted.bootstrap) === frozen.bootstrapSha256,
    "Embedded executable drift",
  );
  for (const [name, bytes] of extracted.assets)
    check(
      frozen.assets[name]?.sha256 === hash(bytes) && frozen.assets[name]?.size === bytes.length,
      "Embedded runtime asset drift",
    );
  const notices = resolve(output, "context/notices/embedded");
  await mkdir(notices, { recursive: true });
  for (const pin of frozen.components) {
    const bytes = await download(pin.url, pin.sha256);
    check(
      createHash("sha512").update(bytes).digest("base64") === pin.integrity.slice(7),
      "Embedded SRI drift",
    );
    const archive = resolve(output, `embedded-${pin.name.replaceAll("/", "_")}-${pin.version}.tgz`);
    await writeFile(archive, bytes);
    const directory = resolve(notices, `${pin.name.replaceAll("/", "_")}-${pin.version}`);
    await mkdir(directory, { recursive: true });
    for (const [path, expected] of Object.entries(pin.notices)) {
      const bytes = tar(archive, path);
      check(hash(bytes) === expected, "Embedded license drift");
      await writeFile(resolve(directory, path.replaceAll("/", "_")), bytes);
    }
  }
  await writeFile(resolve(notices, "embedded-inventory.json"), JSON.stringify(frozen, null, 2));
}
