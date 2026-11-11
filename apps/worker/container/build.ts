import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { c as createTar, x as extractTar } from "tar";
import { paragraphs, requiredPackages } from "./debian.ts";
import { verifyNativeCompatibility } from "./elf-compatibility.ts";
import { freezeEmbedded, prepareEmbedded } from "./embedded.ts";
import { authenticateIndexes } from "./fuse-security.ts";
import {
  canonicalizeImageArchive,
  inspectImageArchive,
  verifyBuildMetadata,
} from "./image-archive.ts";
import { filePolicy, type PrunePolicy, pruningPolicy } from "./image-prune.ts";
import { imageInputs } from "./inputs.ts";
import { compareRootfs, scanRootfs } from "./rootfs.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const output = resolve(root, "apps/worker/dist/container");
const context = resolve(output, "context");
const here = dirname(fileURLToPath(import.meta.url));
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
async function fileDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}
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
  fuseReleaseSha256: string;
  fusePackagesIndexSha256: string;
  fuseSourcesIndexSha256: string;
  packages: PackagePin[];
  inputInstalled: PackagePin[];
  pruning: PrunePolicy;
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
  const previous = JSON.parse(
    await readFile(resolve(here, "debian-freeze.json"), "utf8"),
  ) as Freeze;
  check(
    previous.snapshot === imageInputs.snapshot,
    "Freeze must retain its approved dated snapshot",
  );
  const layers = await verifyOCI();
  const authenticated = await authenticateIndexes(download, output);
  check(
    authenticated.releaseSha256 === previous.releaseSha256 &&
      authenticated.packagesIndexSha256 === previous.packagesIndexSha256 &&
      authenticated.sourcesIndexSha256 === previous.sourcesIndexSha256,
    "Approved snapshot index drift",
  );
  const packageFields = authenticated.packages;
  const packages = packageFields.map(toPin);
  const layer = layers[1];
  check(layer, "Missing Debian layer");
  const metadata = JSON.parse(
    await readFile(resolve(root, "tools/unstale/platform-tools.json"), "utf8"),
  ) as { images: { digest: string; config: string }[] };
  const baseConfig = metadata.images.find(
    (pin) => pin.digest === imageInputs.debian.split("@")[1],
  )?.config;
  check(baseConfig, "Missing exact Debian public config");
  const pruning = await pruningPolicy(
    resolve(output, `${layer.digest.slice(7)}.tgz`),
    layer.digest,
    resolve(output, "downloads", baseConfig.slice(7)),
    baseConfig,
  );
  // Select exactly the dpkg status file from the hash-verified official layer.
  const status = command("tar", [
    "-xOf",
    resolve(output, `${layer.digest.slice(7)}.tgz`),
    "var/lib/dpkg/status",
  ]);
  const installed: PackagePin[] = [];
  const baseFields = paragraphs(status).filter(
    (item) => item.get("Status") === "install ok installed",
  );
  for (const entry of baseFields) {
    let pin = packages.find(
      (candidate) =>
        candidate.name === entry.get("Package") && candidate.version === entry.get("Version"),
    );
    if (!pin) {
      const recorded = (previous.inputInstalled ?? previous.installed).find(
        (pin) => pin.name === entry.get("Package") && pin.version === entry.get("Version"),
      );
      if (recorded) {
        installed.push(recorded);
        continue;
      }
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
  const roots = Object.entries(imageInputs.packages).map(([name, version]) => {
    const pin = [...authenticated.fusePackages, ...packageFields].find(
      (entry) => entry.get("Package") === name && entry.get("Version") === version,
    );
    check(pin, `Snapshot missing ${name}=${version}`);
    return pin;
  });
  const additions = requiredPackages(baseFields, roots, packageFields).map(toPin);
  // The immutable-index closure is checked independently by the image's offline dpkg install.
  const all = [
    ...installed.filter((pin) => !additions.some((item) => item.name === pin.name)),
    ...additions,
  ]
    .filter((pin) => pin.name !== "apt" && pin.name !== "sqv")
    .sort((a, b) => a.name.localeCompare(b.name));
  check(
    installed.length === 78 && all.length === 79,
    "Unexpected exact input/final package inventory",
  );
  const sourceFields = [...authenticated.sources, authenticated.fuseSource];
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
      const recorded = previous.sources.find(
        (source) => source.name === pin.source && source.version === pin.sourceVersion,
      );
      if (recorded) {
        sourcePins.push(recorded);
        return;
      }
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
    releaseSha256: authenticated.releaseSha256,
    packagesIndexSha256: authenticated.packagesIndexSha256,
    sourcesIndexSha256: authenticated.sourcesIndexSha256,
    fuseReleaseSha256: authenticated.fuseReleaseSha256,
    fusePackagesIndexSha256: authenticated.fusePackagesIndexSha256,
    fuseSourcesIndexSha256: authenticated.fuseSourcesIndexSha256,
    packages: additions,
    inputInstalled: installed.sort((a, b) => a.name.localeCompare(b.name)),
    pruning,
    installed: all,
    sources: sourcePins,
    layers,
  };
}
async function prepare(pin: Freeze): Promise<NamedSource[]> {
  check(pin.snapshot === imageInputs.snapshot, "Wrong frozen snapshot");
  // Regenerate derived build evidence; only verified raw content-addressed inputs are reusable.
  await rm(context, { recursive: true, force: true });
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
  const names = await sourceNames(pin);
  await sourceNotices(pin);
  return names;
}
interface NamedSource {
  name: string;
  version: string;
  descriptor: string;
  files: { name: string; sha256: string; size: number }[];
}
async function sourceNames(pin: Freeze): Promise<NamedSource[]> {
  const result: NamedSource[] = [];
  const assigned = new Map<string, string>();
  for (const source of pin.sources) {
    let descriptor: SourcePin["files"][number] | undefined;
    let fields: Map<string, string> | undefined;
    for (const file of source.files) {
      const path = resolve(output, "sources", file.filename.split("/").at(-1) ?? "");
      const handle = await open(path, "r");
      const prefix = Buffer.alloc(4096);
      try {
        await handle.read(prefix, 0, prefix.length, 0);
      } finally {
        await handle.close();
      }
      if (!/^Format:/m.test(prefix.toString("utf8"))) continue;
      check(file.size <= 1_048_576, "Source descriptor exceeds bound");
      const row = paragraphs(await readFile(path, "utf8")).find((row) => row.has("Source"));
      check(
        !descriptor && row?.get("Source") === source.name && row.get("Version") === source.version,
        "Source descriptor identity drift",
      );
      descriptor = file;
      fields = row;
    }
    check(descriptor && fields, `Source descriptor missing: ${source.name}`);
    const descriptorName = `${source.name}_${source.version.replace(/^\d+:/, "")}.dsc`;
    const names = new Map<string, { name: string; sha256: string; size: number }>();
    names.set(descriptor.sha256, {
      name: descriptorName,
      sha256: descriptor.sha256,
      size: descriptor.size,
    });
    for (const line of (fields.get("Checksums-Sha256") ?? "").trim().split("\n")) {
      const [sha256, length, name] = line.trim().split(/\s+/);
      check(
        sha256 && name && /^[A-Za-z0-9][A-Za-z0-9_.+~-]*$/.test(name) && !name.includes(".."),
        "Unsafe descriptor sibling name",
      );
      const actual = source.files.find(
        (file) => file.sha256 === sha256 && file.size === Number(length),
      );
      check(actual, `Descriptor source/checksum missing: ${source.name}/${name}`);
      names.set(sha256, { name, sha256, size: actual.size });
    }
    check(
      names.size === source.files.length,
      `Descriptor does not name every frozen source: ${source.name}`,
    );
    for (const file of source.files) {
      const named = names.get(file.sha256);
      check(named, "Unnamed frozen source");
      check(
        !assigned.has(named.name) || assigned.get(named.name) === named.sha256,
        "Conflicting source sibling filename",
      );
      assigned.set(named.name, named.sha256);
      const original = resolve(output, "sources", file.filename.split("/").at(-1) ?? "");
      const destination = resolve(output, "sources", named.name);
      if (original !== destination) await copyFile(original, destination);
      check(
        (await fileDigest(destination)) === named.sha256 &&
          (await lstat(destination)).size === named.size,
        "Renamed source identity drift",
      );
    }
    result.push({
      name: source.name,
      version: source.version,
      descriptor: descriptorName,
      files: [...names.values()].sort((a, b) => a.name.localeCompare(b.name)),
    });
  }
  await writeFile(resolve(output, "source-names.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
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
      await rm(extracted, { recursive: true, force: true });
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
  const source = JSON.parse(await readFile(resolve(output, "source-revision.json"), "utf8")) as {
    recipeMatchesCommit: boolean;
    sourceCommit: string;
  };
  check(
    source.recipeMatchesCommit,
    "Commit the reviewed image recipe before building a distributable image",
  );
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
  const cleanedMetadata = resolve(output, "cleaned-buildx-metadata.json");
  command("docker", [
    "buildx",
    "build",
    "--platform",
    "linux/amd64",
    "--network=none",
    "--provenance=false",
    "--load",
    "--target",
    "cleaned",
    "--metadata-file",
    cleanedMetadata,
    "--tag",
    "fortipi-computerd:cleaned",
    context,
  ]);
  const cleanedId = command("docker", [
    "image",
    "inspect",
    "fortipi-computerd:cleaned",
    "--format",
    "{{.Id}}",
  ]).trim();
  check(/^sha256:[a-f0-9]{64}$/.test(cleanedId), "Missing actual cleaned image ID");
  const cleanedArchive = resolve(output, "cleaned-stage.tar");
  command("docker", ["save", "--output", cleanedArchive, cleanedId]);
  const cleaned = await inspectImageArchive(cleanedArchive, cleanedId, { filesystem: true });
  verifyBuildMetadata(JSON.parse(await readFile(cleanedMetadata, "utf8")), cleaned.saved);
  const buildMetadata = resolve(output, "buildx-metadata.json");
  command("docker", [
    "buildx",
    "build",
    "--platform",
    "linux/amd64",
    "--network=none",
    "--provenance=false",
    "--load",
    "--metadata-file",
    buildMetadata,
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
  const temporary = await mkdtemp(resolve(output, ".image-export-"));
  const inspected = await (async () => {
    try {
      const raw = resolve(temporary, "raw.tar");
      const candidate = resolve(temporary, "canonical.tar");
      command("docker", ["save", "--output", raw, imageId]);
      const selected = await canonicalizeImageArchive(raw, candidate, imageId);
      const checked = await inspectImageArchive(candidate, imageId, { pruning: pin.pruning });
      check(
        JSON.stringify(checked.saved) === JSON.stringify(selected),
        "Canonical selected image changed",
      );
      await rename(candidate, archive);
      return checked;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  })();
  const saved = inspected.saved;
  compareRootfs(cleaned.filesystem, inspected.filesystem);
  const statArgs = ["--rm", "--network=none", "--entrypoint", "stat"];
  const metadataArgs = ["-c", "%u:%g:%a", "/", "/tmp", "/usr/bin/fusermount3"];
  const stageModes = command("docker", ["run", ...statArgs, cleanedId, ...metadataArgs]);
  const finalModes = command("docker", ["run", ...statArgs, imageId, ...metadataArgs]);
  check(
    stageModes === finalModes && finalModes.trim().split("\n")[2] === "0:0:4755",
    "Actual root/tmp/helper ownership or permissions changed",
  );
  await writeFile(
    resolve(output, "filesystem-preservation.json"),
    `${JSON.stringify({ schemaVersion: 1, cleanedImageId: cleanedId, finalImageId: imageId, entries: inspected.filesystem.size, bytesLinksOwnersModesRawXattrsCompared: true, fuseHelperMode: "4755", fuseHelperUid: 0, fuseHelperGid: 0, allConveyedLayersAndBlobsAudited: true, removedExecutablePaths: pin.pruning.executables.length, removedElfHashes: pin.pruning.executables.filter((item) => item.elf).length, runtimeConfigChecked: true, runtimeVerified: false }, null, 2)}\n`,
  );
  const exporter = verifyBuildMetadata(JSON.parse(await readFile(buildMetadata, "utf8")), saved);
  const builtManifestDigest = saved.manifest.digest;
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
  await rm(licenses, { recursive: true, force: true });
  await mkdir(licenses, { recursive: true });
  try {
    const status = resolve(output, "installed-status");
    command("docker", ["cp", `${container}:/var/lib/dpkg/status`, status]);
    const actual = paragraphs(await readFile(status, "utf8")).filter(
      (row) => row.get("Status") === "install ok installed",
    );
    const normalized = actual
      .map((row) => {
        const pin = toPin(row);
        return {
          name: pin.name,
          version: pin.version,
          source: pin.source,
          sourceVersion: pin.sourceVersion,
          builtUsing: pin.builtUsing,
          staticBuiltUsing: pin.staticBuiltUsing,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    check(
      JSON.stringify(normalized) ===
        JSON.stringify(
          pin.installed
            .map(({ name, version, source, sourceVersion, builtUsing, staticBuiltUsing }) => ({
              name,
              version,
              source,
              sourceVersion,
              builtUsing,
              staticBuiltUsing,
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        ),
      "Installed source/static dependency inventory drift",
    );
    await writeFile(
      resolve(output, "installed-source-inventory.json"),
      `${JSON.stringify(normalized, null, 2)}\n`,
    );
    const finalBinary = resolve(output, "computerd-final");
    command("docker", ["cp", `${container}:/usr/local/bin/computerd`, finalBinary]);
    const embedded = JSON.parse(await readFile(resolve(here, "embedded-freeze.json"), "utf8")) as {
      binarySha256: string;
    };
    check(
      (await fileDigest(finalBinary)) === embedded.binarySha256,
      "Final embedded executable drift",
    );
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
  const sourceCommit = source.sourceCommit;
  const licenseInventory = await fileHashes(licenses);
  await writeFile(
    resolve(output, "license-inventory.json"),
    `${JSON.stringify(licenseInventory, null, 2)}\n`,
  );
  await writeFile(resolve(output, "installed-packages.txt"), inventory);
  await writeFile(
    resolve(output, "image-metadata.json"),
    `${JSON.stringify({ schemaVersion: 1, sourceCommit, computerSource: imageInputs.source, computerSourceArchiveSha256: imageInputs.sourceArchiveSha256, embeddedNodeVersion: imageInputs.embeddedNodeVersion, embeddedInventorySha256: await fileDigest(resolve(here, "embedded-freeze.json")), licenseInventorySha256: await fileDigest(resolve(output, "license-inventory.json")), sourceKitSha256: await fileDigest(resolve(output, "sources-and-notices.tar")), filesystemPreservationSha256: await fileDigest(resolve(output, "filesystem-preservation.json")), pruningPolicySha256: digest(JSON.stringify(pin.pruning)), inputInventorySha256: digest(JSON.stringify(pin.inputInstalled)), runtimeImageConfigSha256: digest(JSON.stringify(inspected.configuration)), installedSourceInventorySha256: await fileDigest(resolve(output, "installed-source-inventory.json")), computerVersion: imageInputs.computerVersion, platform: "linux/amd64", inputDigests: [imageInputs.computerd, imageInputs.debian], imageId, builtManifestDigest, builtManifestSource: "docker-save-oci", savedImage: saved, ...exporter, buildMetadataSha256: await fileDigest(buildMetadata), archiveSha256: await fileDigest(archive), inventorySha256: digest(inventory), freezeSha256: digest(await readFile(resolve(here, "debian-freeze.json"))), registryDigest: null, runtimeVerified: false, licenseReviewRequired: true }, null, 2)}\n`,
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
  const reconstructed = await freeze();
  check(
    JSON.stringify(reconstructed) === JSON.stringify(pin),
    "Signed image dependency/source closure drift",
  );
  const names = await prepare(pin);
  const embedded = await prepareEmbedded(download);
  // Compare actual .deb controls to authenticated records, then resolve actual addon symbols.
  const signedBinaries = paragraphs(
    command("xz", [
      "--decompress",
      "--stdout",
      resolve(output, "security/sid-main-binary-amd64-Packages.xz"),
    ]),
  );
  await verifyNativeCompatibility(output, embedded.addon, embedded.binary, signedBinaries);
  await sourceKit(names, pin.pruning);
  if (process.argv.includes("--prepare") || process.argv.includes("--freeze-licenses")) return;
  await build(pin);
  if (process.argv.includes("--verify")) {
    const fixture = resolve(root, "apps/worker/test/backends/linux-image.ts");
    command(process.execPath, [fixture, "--image", "fortipi-computerd:verified"]);
  }
}
async function sourceKit(sources: NamedSource[], pruning: PrunePolicy): Promise<void> {
  const recipe = resolve(output, "source-kit-recipe");
  await mkdir(recipe, { recursive: true });
  const recipeFiles = [
    "Dockerfile",
    "build.ts",
    "debian.ts",
    "fuse-security.ts",
    "elf-compatibility.ts",
    "embedded.ts",
    "inputs.ts",
    "image-archive.ts",
    "image-prune.ts",
    "rootfs.ts",
    "debian-freeze.json",
    "debian-licenses.json",
    "embedded-freeze.json",
    "SOURCE-DISTRIBUTION.md",
  ];
  for (const name of recipeFiles) await copyFile(resolve(here, name), resolve(recipe, name));
  await copyFile(
    resolve(root, "tools/unstale/platform-tools.json"),
    resolve(recipe, "platform-tools.json"),
  );
  const sourceCommit = command("git", ["rev-parse", "HEAD"], { cwd: root }).trim();
  const sourceArchive = resolve(output, "fortipi-source.tar");
  command("git", ["archive", "--format=tar", "--output", sourceArchive, sourceCommit], {
    cwd: root,
  });
  const forbidden = filePolicy(pruning).hashes;
  await scanRootfs(createReadStream(sourceArchive), { paths: new Set(), hashes: forbidden });
  let recipeMatchesCommit = true;
  for (const name of recipeFiles) {
    try {
      if (
        digest(
          command("git", ["show", `${sourceCommit}:apps/worker/container/${name}`], { cwd: root }),
        ) !== (await fileDigest(resolve(here, name)))
      )
        recipeMatchesCommit = false;
    } catch {
      recipeMatchesCommit = false;
    }
  }
  for (const name of [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tools/unstale/platform-tools.json",
  ]) {
    if (
      digest(command("git", ["show", `${sourceCommit}:${name}`], { cwd: root })) !==
      (await fileDigest(resolve(root, name)))
    )
      recipeMatchesCommit = false;
  }
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as {
    packageManager: string;
    fortipi: { toolchain: { node: string; pnpm: string } };
    devDependencies: { tar: string };
  };
  await writeFile(
    resolve(output, "source-revision.json"),
    `${JSON.stringify({ sourceCommit, sourceArchiveSha256: await fileDigest(sourceArchive), recipeMatchesCommit, node: manifest.fortipi.toolchain.node, pnpm: manifest.fortipi.toolchain.pnpm, packageManager: manifest.packageManager, tar: manifest.devDependencies.tar, packageJsonSha256: await fileDigest(resolve(root, "package.json")), lockSha256: await fileDigest(resolve(root, "pnpm-lock.yaml")), platformMetadataSha256: await fileDigest(resolve(root, "tools/unstale/platform-tools.json")) }, null, 2)}\n`,
  );
  const embedded = JSON.parse(await readFile(resolve(here, "embedded-freeze.json"), "utf8")) as {
    components: { name: string; version: string }[];
  };
  const files = [
    ...sources.flatMap((source) => source.files.map((entry) => `sources/${entry.name}`)),
    "source-names.json",
    "fortipi-source.tar",
    "source-revision.json",
    "computer-source.tgz",
    "native-compatibility.json",
    ...(await readdir(resolve(output, "security"))).map((name) => `security/${name}`),
    ...embedded.components.map(
      (pin) => `embedded-${pin.name.replaceAll("/", "_")}-${pin.version}.tgz`,
    ),
    ...recipeFiles.map((name) => `source-kit-recipe/${name}`),
    "source-kit-recipe/platform-tools.json",
  ].sort();
  const inventory: Record<string, string> = {};
  await parallel(files, async (path) => {
    inventory[path] = await fileDigest(resolve(output, path));
    check(!forbidden.has(inventory[path]), "Old runtime binary/layer in source kit");
  });
  inventory["context/notices"] = digest(
    JSON.stringify(await fileHashes(resolve(context, "notices"))),
  );
  await writeFile(
    resolve(output, "source-kit-inventory.json"),
    `${JSON.stringify(Object.fromEntries(Object.entries(inventory).sort(([a], [b]) => a.localeCompare(b))), null, 2)}\n`,
  );
  await createTar(
    {
      cwd: output,
      file: resolve(output, "sources-and-notices.tar"),
      portable: true,
      mtime: new Date("2026-11-10T00:00:00Z"),
    },
    [...files, "context/notices", "source-kit-inventory.json"],
  );
  const noticeFiles = Object.keys(await fileHashes(resolve(context, "notices"))).map(
    (path) => `context/notices/${path}`,
  );
  const expected = new Set([...files, ...noticeFiles, "source-kit-inventory.json"]);
  const conveyed = await scanRootfs(createReadStream(resolve(output, "sources-and-notices.tar")), {
    paths: new Set(),
    hashes: forbidden,
  });
  for (const [path, entry] of conveyed)
    if (entry.type !== "Directory")
      check(expected.delete(path), "Unexpected source-kit file or binary archive");
  check(expected.size === 0, "Missing source-kit file");
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
