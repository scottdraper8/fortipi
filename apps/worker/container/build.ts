import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, readlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { x as extractTar } from "tar";
import { freezeEmbedded, prepareEmbedded } from "./embedded.ts";
import { imageInputs } from "./inputs.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const output = resolve(root, "apps/worker/dist/container");
const context = resolve(output, "context");
const here = dirname(fileURLToPath(import.meta.url));
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
interface PackagePin {
  name: string;
  version: string;
  filename: string;
  sha256: string;
  source: string;
  sourceVersion: string;
  builtUsing: { name: string; version: string }[];
  staticBuiltUsing: { name: string; version: string }[];
}
interface SourcePin {
  name: string;
  version: string;
  files: { filename: string; sha256: string; size: number }[];
}
interface Freeze {
  snapshot: string;
  releaseSha256: string;
  packagesIndexSha256: string;
  sourcesIndexSha256: string;
  packages: PackagePin[];
  installed: PackagePin[];
  sources: SourcePin[];
  layers: { digest: string; size: number }[];
}
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function command(
  name: string,
  args: string[],
  options: { input?: string; cwd?: string } = {},
): string {
  return execFileSync(name, args, {
    ...options,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
}
async function download(
  url: string,
  expected?: string,
  headers?: Record<string, string>,
): Promise<Uint8Array> {
  const hash = expected?.replace(/^sha256:/, "");
  const cache = resolve(output, "downloads");
  await mkdir(cache, { recursive: true });
  if (hash) {
    try {
      const cached = await readFile(resolve(cache, hash));
      check(digest(cached) === hash, "Cached public input hash mismatch");
      return cached;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const response = await fetch(url, {
    ...(headers ? { headers } : {}),
    signal: AbortSignal.timeout(120_000),
  });
  check(response.ok, `Public input unavailable (${response.status}): ${new URL(url).hostname}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  check(bytes.length <= 256 * 1024 * 1024, "Input exceeds archive bound");
  if (expected)
    check(digest(bytes) === expected.replace(/^sha256:/, ""), "Public input hash mismatch");
  await writeFile(resolve(cache, digest(bytes)), bytes);
  return bytes;
}
async function parallel<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        const item = items[index];
        if (item !== undefined) await work(item);
      }
    }),
  );
}
function paragraphs(text: string): Map<string, string>[] {
  return text
    .trim()
    .split(/\n\n+/)
    .map((paragraph) => {
      const fields = new Map<string, string>();
      let key = "";
      for (const line of paragraph.split("\n")) {
        if (/^\s/.test(line)) fields.set(key, `${fields.get(key) ?? ""}\n${line.trim()}`);
        else {
          const colon = line.indexOf(":");
          key = line.slice(0, colon);
          fields.set(key, line.slice(colon + 1).trim());
        }
      }
      return fields;
    });
}
async function oci(
  repository: string,
  expected: string,
  config: string,
  layers: { digest: string; size: number }[],
): Promise<void> {
  const ghcr = repository.startsWith("ghcr.io/");
  const host = ghcr ? "ghcr.io" : "registry-1.docker.io";
  const name = ghcr ? repository.slice(8) : "library/debian";
  const tokenUrl = ghcr
    ? `https://ghcr.io/token?service=ghcr.io&scope=repository:${name}:pull`
    : `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${name}:pull`;
  const tokenResponse = await fetch(tokenUrl, { signal: AbortSignal.timeout(30_000) });
  check(tokenResponse.ok, "Anonymous OCI pull authorization unavailable");
  const auth = (await tokenResponse.json()) as { token: string };
  const headers = {
    Authorization: `Bearer ${auth.token}`,
    Accept:
      "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
  };
  const manifest = JSON.parse(
    new TextDecoder().decode(
      await download(`https://${host}/v2/${name}/manifests/${expected}`, expected, headers),
    ),
  ) as { config: { digest: string }; layers: { digest: string; size: number }[] };
  check(
    manifest.config.digest === config &&
      JSON.stringify(
        manifest.layers.map((layer) => ({ digest: layer.digest, size: layer.size })),
      ) === JSON.stringify(layers.map((layer) => ({ digest: layer.digest, size: layer.size }))),
    "OCI descriptor drift",
  );
  const configuration = JSON.parse(
    new TextDecoder().decode(
      await download(`https://${host}/v2/${name}/blobs/${config}`, config, headers),
    ),
  ) as { architecture: string; os: string };
  check(
    configuration.architecture === "amd64" && configuration.os === "linux",
    "Wrong OCI platform",
  );
  for (const layer of layers) {
    const bytes = await download(
      `https://${host}/v2/${name}/blobs/${layer.digest}`,
      layer.digest,
      headers,
    );
    check(bytes.length === layer.size, "OCI layer length mismatch");
    await writeFile(resolve(output, `${layer.digest.slice(7)}.tgz`), bytes);
  }
}
async function verifyOCI(): Promise<{ digest: string; size: number }[]> {
  const metadata = JSON.parse(
    await readFile(resolve(root, "tools/unstale/platform-tools.json"), "utf8"),
  ) as {
    images: {
      repository: string;
      digest: string;
      config: string;
      layers: { digest: string; size: number }[];
    }[];
  };
  await parallel(metadata.images, async (pin) => {
    await oci(pin.repository, pin.digest, pin.config, pin.layers);
  });
  return metadata.images.flatMap((pin) => pin.layers);
}
function toPin(fields: Map<string, string>): PackagePin {
  const name = fields.get("Package") ?? "";
  const version = fields.get("Version") ?? "";
  const source = /^(\S+)(?: \(([^)]+)\))?$/.exec(fields.get("Source") ?? name);
  check(source?.[1], "Missing Debian source identity");
  return {
    name,
    version,
    filename: fields.get("Filename") ?? "",
    sha256: fields.get("SHA256") ?? "",
    source: source[1],
    sourceVersion: source[2] ?? version,
    builtUsing: builtUsing(fields.get("Built-Using")),
    staticBuiltUsing: builtUsing(fields.get("Static-Built-Using")),
  };
}
function builtUsing(value: string | undefined): { name: string; version: string }[] {
  if (!value) return [];
  return value.split(",").map((part) => {
    const match = /^\s*(\S+)\s*\(=\s*([^)]+)\)\s*$/.exec(part);
    check(match?.[1] && match[2], "Invalid exact Debian Built-Using identity");
    return { name: match[1], version: match[2] };
  });
}
async function freeze(): Promise<Freeze> {
  const layers = await verifyOCI();
  const base = `https://snapshot.debian.org/archive/debian/${imageInputs.snapshot}/`;
  const release = await download(`${base}dists/trixie/Release`);
  const releaseText =
    new TextDecoder().decode(release).split("SHA256:\n")[1]?.split("SHA512:")[0] ?? "";
  async function index(path: string): Promise<{ text: string; sha256: string }> {
    const hash = releaseText
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .find((line) => line[2] === path)?.[0];
    check(
      hash && /^[a-f0-9]{64}$/.test(hash),
      "Snapshot index is absent from Release SHA256 section",
    );
    const bytes = await download(`${base}dists/trixie/${path}`, hash);
    const filename = resolve(output, path.replaceAll("/", "-"));
    await writeFile(filename, bytes);
    return { text: command("xz", ["--decompress", "--stdout", filename]), sha256: hash };
  }
  const binaries = await index("main/binary-amd64/Packages.xz");
  const sources = await index("main/source/Sources.xz");
  const packages = paragraphs(binaries.text).map(toPin);
  const layer = layers[1];
  check(layer, "Missing Debian layer");
  // Select exactly the dpkg status file from the hash-verified official layer.
  const status = command("tar", [
    "-xOf",
    resolve(output, `${layer.digest.slice(7)}.tgz`),
    "var/lib/dpkg/status",
  ]);
  const installed: PackagePin[] = [];
  for (const entry of paragraphs(status).filter(
    (item) => item.get("Status") === "install ok installed",
  )) {
    let pin = packages.find(
      (candidate) =>
        candidate.name === entry.get("Package") && candidate.version === entry.get("Version"),
    );
    if (!pin) {
      pin = toPin(entry);
      const response = await fetch(
        `https://snapshot.debian.org/mr/binary/${encodeURIComponent(pin.name)}/${encodeURIComponent(pin.version)}/binfiles`,
        { signal: AbortSignal.timeout(30_000) },
      );
      check(response.ok, `Exact base package missing: ${pin.name}`);
      const result = (await response.json()) as {
        result: { architecture: string; hash: string }[];
      };
      const file = result.result.find(
        (candidate) => candidate.architecture === "amd64" || candidate.architecture === "all",
      );
      check(file, `Wrong base architecture: ${pin.name}`);
      pin.filename = `https://snapshot.debian.org/file/${file.hash}`;
      const bytes = await download(pin.filename);
      check(
        createHash("sha1").update(bytes).digest("hex") === file.hash,
        "Snapshot content identity mismatch",
      );
      pin.sha256 = digest(bytes);
    }
    installed.push(pin);
  }
  const additions = Object.entries(imageInputs.packages).map(([name, version]) => {
    const pin = packages.find((entry) => entry.name === name && entry.version === version);
    check(pin, `Snapshot missing ${name}=${version}`);
    return pin;
  });
  // dpkg's offline dependency check is an additional build gate; no network solver changes these inputs.
  const all = [
    ...installed.filter((pin) => !additions.some((item) => item.name === pin.name)),
    ...additions,
  ].sort((a, b) => a.name.localeCompare(b.name));
  const sourceFields = paragraphs(sources.text);
  const sourcePins: SourcePin[] = [];
  const identities = [
    ...new Map(
      all
        .flatMap((pin) => [
          { name: pin.source, version: pin.sourceVersion },
          ...pin.builtUsing,
          ...pin.staticBuiltUsing,
        ])
        .map((item) => [`${item.name}=${item.version}`, item]),
    ).values(),
  ];
  await parallel(identities, async (identity) => {
    const pin = { source: identity.name, sourceVersion: identity.version };
    const fields = sourceFields.find(
      (entry) => entry.get("Package") === pin.source && entry.get("Version") === pin.sourceVersion,
    );
    if (!fields) {
      const response = await fetch(
        `https://snapshot.debian.org/mr/package/${encodeURIComponent(pin.source)}/${encodeURIComponent(pin.sourceVersion)}/srcfiles`,
        { signal: AbortSignal.timeout(30_000) },
      );
      check(response.ok, `Exact base source missing: ${pin.source}`);
      const result = (await response.json()) as { result: { hash: string }[] };
      const files: SourcePin["files"] = [];
      for (const file of result.result) {
        const filename = `https://snapshot.debian.org/file/${file.hash}`;
        const bytes = await download(filename);
        check(
          createHash("sha1").update(bytes).digest("hex") === file.hash,
          "Snapshot source identity mismatch",
        );
        files.push({ filename, sha256: digest(bytes), size: bytes.length });
        await writeFile(resolve(output, `source-${file.hash}`), bytes);
      }
      sourcePins.push({ name: pin.source, version: pin.sourceVersion, files });
      return;
    }
    const files = (fields.get("Checksums-Sha256") ?? "")
      .trim()
      .split("\n")
      .map((line) => {
        const [sha256, size, name] = line.trim().split(/\s+/);
        check(sha256 && name && /^[a-f0-9]{64}$/.test(sha256), "Invalid source checksum");
        return { filename: `${fields.get("Directory")}/${name}`, sha256, size: Number(size) };
      });
    sourcePins.push({ name: pin.source, version: pin.sourceVersion, files });
  });
  sourcePins.sort((a, b) => `${a.name}=${a.version}`.localeCompare(`${b.name}=${b.version}`));
  return {
    snapshot: imageInputs.snapshot,
    releaseSha256: digest(release),
    packagesIndexSha256: binaries.sha256,
    sourcesIndexSha256: sources.sha256,
    packages: additions,
    installed: all,
    sources: sourcePins,
    layers,
  };
}
async function prepare(pin: Freeze): Promise<void> {
  check(pin.snapshot === imageInputs.snapshot, "Wrong frozen snapshot");
  await mkdir(resolve(context, "packages"), { recursive: true });
  await mkdir(resolve(output, "sources"), { recursive: true });
  await copyFile(resolve(here, "Dockerfile"), resolve(context, "Dockerfile"));
  await mkdir(resolve(context, "notices"), { recursive: true });
  const computerSource = await download(
    `https://codeload.github.com/cloudflare/computer/tar.gz/${imageInputs.source}`,
    imageInputs.sourceArchiveSha256,
  );
  await writeFile(resolve(output, "computer-source.tgz"), computerSource);
  const license = command("tar", [
    "-xOf",
    resolve(output, "computer-source.tgz"),
    `computer-${imageInputs.source}/LICENSE`,
  ]);
  await writeFile(resolve(context, "notices", "Computer-LICENSE"), license);
  await writeFile(
    resolve(context, "notices", "Node-LICENSE"),
    await download(
      `https://raw.githubusercontent.com/nodejs/node/v${imageInputs.embeddedNodeVersion}/LICENSE`,
      imageInputs.embeddedNodeLicenseSha256,
    ),
  );
  const base = `https://snapshot.debian.org/archive/debian/${pin.snapshot}/`;
  await parallel(pin.packages, async (entry) => {
    await writeFile(
      resolve(context, "packages", `${entry.name}.deb`),
      await download(
        entry.filename.startsWith("https:") ? entry.filename : `${base}${entry.filename}`,
        entry.sha256,
      ),
    );
  });
  await parallel(
    pin.sources.flatMap((source) => source.files),
    async (entry) => {
      const bytes = await download(
        entry.filename.startsWith("https:") ? entry.filename : `${base}${entry.filename}`,
        entry.sha256,
      );
      check(bytes.length === entry.size, "Source archive size mismatch");
      await writeFile(resolve(output, "sources", entry.filename.split("/").at(-1) ?? ""), bytes);
    },
  );
  await sourceNotices(pin);
}
async function sourceNotices(pin: Freeze): Promise<void> {
  const inventory: Record<string, Record<string, string>> = {};
  const destination = resolve(context, "notices/debian-sources");
  await mkdir(destination, { recursive: true });
  for (const source of pin.sources) {
    const identity = `${source.name}=${source.version}`;
    const notices: Record<string, string> = {};
    const directory = resolve(destination, identity.replace(/[^a-zA-Z0-9_.+-]/g, "_"));
    await mkdir(directory, { recursive: true });
    for (const archive of source.files) {
      const path = resolve(output, "sources", archive.filename.split("/").at(-1) ?? "");
      const header = (await readFile(path)).subarray(0, 6);
      if (
        !((header[0] === 0xfd && header[1] === 0x37) || (header[0] === 0x1f && header[1] === 0x8b))
      )
        continue;
      try {
        command("tar", ["-tf", path]);
      } catch {
        continue;
      }
      const extracted = resolve(output, "source-notice-files", archive.sha256);
      await mkdir(extracted, { recursive: true });
      const files: string[] = [];
      const destination = extractTar({
        cwd: extracted,
        filter: (name, entry) => {
          const selected =
            "type" in entry &&
            entry.type === "File" &&
            /(?:^|\/)(?:copyright|licen[cs]e|copying|notice)(?:[._-][^/]*)?$/i.test(name);
          if (selected) {
            check(
              !name.startsWith("/") &&
                !name.split("/").includes("..") &&
                entry.size <= 16 * 1024 * 1024,
              "Unsafe source notice entry",
            );
            files.push(name);
          }
          return selected;
        },
      });
      if (header[0] === 0xfd && header[1] === 0x37) {
        const unpack = spawn("xz", ["--decompress", "--stdout", path], {
          stdio: ["ignore", "pipe", "ignore"],
        });
        unpack.stdout.pipe(destination);
        await Promise.all([
          new Promise<void>((resolve, reject) => {
            destination.on("finish", resolve);
            destination.on("error", reject);
          }),
          new Promise<void>((resolve, reject) => {
            unpack.on("error", reject);
            unpack.on("exit", (code) =>
              code === 0 ? resolve() : reject(new Error("Source notice decompression failed")),
            );
          }),
        ]);
      } else {
        const input = createReadStream(path);
        input.pipe(destination);
        await new Promise<void>((resolve, reject) => {
          destination.on("finish", resolve);
          destination.on("error", reject);
          input.on("error", reject);
        });
      } // .dsc/diff sources remain in the complete matching source kit.
      for (const name of files.sort()) {
        const bytes = await readFile(resolve(extracted, name));
        const sha256 = digest(bytes);
        notices[`${archive.sha256}:${name}`] = sha256;
        await writeFile(
          resolve(directory, `${sha256}-${name.split("/").at(-1) ?? "notice"}`),
          bytes,
        );
      }
    }
    check(
      Object.keys(notices).length > 0,
      `Matching source has no license/copyright evidence: ${identity}`,
    );
    inventory[identity] = notices;
  }
  const bytes = `${JSON.stringify(inventory, null, 2)}\n`;
  if (process.argv.includes("--freeze-licenses"))
    await writeFile(resolve(here, "debian-licenses.json"), bytes);
  else
    check(
      bytes === (await readFile(resolve(here, "debian-licenses.json"), "utf8")),
      "Debian source/license hash drift",
    );
  await writeFile(resolve(destination, "source-license-inventory.json"), bytes);
}
async function build(pin: Freeze): Promise<void> {
  const version = JSON.parse(command("docker", ["version", "--format", "{{json .}}"])) as {
    Client: { Version: string };
    Server: { Version: string };
  };
  check(
    version.Client.Version === imageInputs.docker && version.Server.Version === imageInputs.docker,
    "Use the reviewed Docker CLI and Engine",
  );
  const buildkit = command("docker", ["buildx", "inspect", "--bootstrap"]);
  check(buildkit.includes(`v${imageInputs.buildkit}`), "Use reviewed BuildKit");
  command("docker", [
    "buildx",
    "build",
    "--platform",
    "linux/amd64",
    "--network=none",
    "--provenance=false",
    "--load",
    "--tag",
    "fortipi-computerd:verified",
    context,
  ]);
  const imageId = command("docker", [
    "image",
    "inspect",
    "fortipi-computerd:verified",
    "--format",
    "{{.Id}}",
  ]).trim();
  check(/^sha256:[a-f0-9]{64}$/.test(imageId), "Missing actual built image ID");
  const archive = resolve(output, "image.tar");
  command("docker", ["save", "--output", archive, imageId]);
  const inventory = command("docker", [
    "run",
    "--rm",
    "--network=none",
    "--entrypoint",
    "dpkg-query",
    imageId,
    "-W",
    `-f=${dpkgField("Package")}\t${dpkgField("Version")}\n`,
  ]);
  const actual = inventory.trim().split("\n").sort();
  check(
    JSON.stringify(actual) ===
      JSON.stringify(pin.installed.map((entry) => `${entry.name}\t${entry.version}`).sort()),
    "Installed transitive inventory drift",
  );
  const container = command("docker", ["create", imageId]).trim();
  const licenses = resolve(output, "licenses");
  await mkdir(licenses, { recursive: true });
  try {
    command("docker", ["cp", `${container}:/usr/share/doc/.`, licenses]);
    await mkdir(resolve(licenses, "common"), { recursive: true });
    command("docker", [
      "cp",
      `${container}:/usr/share/common-licenses/.`,
      resolve(licenses, "common"),
    ]);
  } finally {
    command("docker", ["rm", container]);
  }
  const sourceCommit = command("git", ["rev-parse", "HEAD"], { cwd: root }).trim();
  const licenseInventory = await fileHashes(licenses);
  await writeFile(
    resolve(output, "license-inventory.json"),
    `${JSON.stringify(licenseInventory, null, 2)}\n`,
  );
  await writeFile(resolve(output, "installed-packages.txt"), inventory);
  await writeFile(
    resolve(output, "image-metadata.json"),
    `${JSON.stringify({ schemaVersion: 1, sourceCommit, computerSource: imageInputs.source, computerSourceArchiveSha256: imageInputs.sourceArchiveSha256, embeddedNodeVersion: imageInputs.embeddedNodeVersion, licenseInventorySha256: digest(JSON.stringify(licenseInventory)), computerVersion: imageInputs.computerVersion, platform: "linux/amd64", inputDigests: [imageInputs.computerd, imageInputs.debian], imageId, archiveSha256: digest(await readFile(archive)), inventorySha256: digest(inventory), freezeSha256: digest(await readFile(resolve(here, "debian-freeze.json"))), registryDigest: null, runtimeVerified: false, licenseReviewRequired: true }, null, 2)}\n`,
  );
}
async function main(): Promise<void> {
  await mkdir(output, { recursive: true });
  if (process.argv.includes("--freeze-embedded")) {
    await verifyOCI();
    await freezeEmbedded(download);
    return;
  }
  if (process.argv.includes("--freeze")) {
    await writeFile(
      resolve(here, "debian-freeze.json"),
      `${JSON.stringify(await freeze(), null, 2)}\n`,
    );
    return;
  }
  const pin = JSON.parse(await readFile(resolve(here, "debian-freeze.json"), "utf8")) as Freeze;
  await verifyOCI();
  await prepare(pin);
  await prepareEmbedded(download);
  if (process.argv.includes("--prepare") || process.argv.includes("--freeze-licenses")) return;
  await build(pin);
  if (process.argv.includes("--verify")) {
    const fixture = resolve(root, "apps/worker/test/backends/linux-image.ts");
    command(process.execPath, [fixture, "--image", "fortipi-computerd:verified"]);
  }
}
function dpkgField(name: string): string {
  return `${String.fromCharCode(36)}{${name}}`;
}
async function fileHashes(directory: string, prefix = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of (await readdir(resolve(directory, prefix))).sort()) {
    const path = prefix ? `${prefix}/${name}` : name;
    const full = resolve(directory, path);
    const stat = await lstat(full);
    if (stat.isDirectory()) Object.assign(result, await fileHashes(directory, path));
    else if (stat.isSymbolicLink()) result[path] = `symlink:${await readlink(full)}`;
    else if (stat.isFile()) result[path] = digest(await readFile(full));
  }
  return result;
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Image verification failed"}\n`,
    );
    process.exitCode = 1;
  });
