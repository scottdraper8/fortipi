// Bounded adapter for the pinned upstream SEA recipe. Build tools stay outside the image.
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { check, run, sha256 } from "./fuse-security.ts";
import { imageInputs } from "./inputs.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const output = resolve(here, "../dist/container");
type Download = (url: string, expected?: string) => Promise<Uint8Array>;
export const daemonTools = {
  node: "22.23.5",
  nodeArchive: "cdeb8670a0c81f51b4dc4ac61919f9b1ad917b304bf8221eb939570663d240f8",
  nodeSource: "6cce7c58bf058700c643944903d60a325e8c9ceede1f5c2c088b435f2ada091a",
  publicSigningSha256: "5115095e2f8010c75da052ecb1cfb3af630e084f0f8daa93a863557b01b0f90a",
  releaseKeyUrl:
    "https://raw.githubusercontent.com/nodejs/release-keys/481637f813e912c4aa3622d7964ab426c97b8e8d/keys/5BE8A3F6C8A5C01D106C0AD820B1A390B168D356.asc",
  signer: "5BE8A3F6C8A5C01D106C0AD820B1A390B168D356",
  addon: "a5fd00b6405de13b6a9da07f390d507865ffe2c9dd4081e2c61024032437d9ef",
  esbuild: "0.28.2",
  postject: "postject@1.0.0-alpha.6",
  commander: "commander@9.5.0",
} as const;

export function checkRootStore(binary: Uint8Array): number {
  const blocks =
    Buffer.from(binary)
      .toString("latin1")
      .match(/-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n]+?-----END CERTIFICATE-----/g) ?? [];
  const subjects = blocks.flatMap((pem) => {
    try {
      return [new X509Certificate(pem).subject.split("\n")];
    } catch {
      return [];
    }
  });
  check(subjects.length >= 100, "Bundled Node root store was not found");
  for (const subject of ["CN=emSign ECC Root CA - G3", "CN=AAA Certificate Services"])
    check(!subjects.some((names) => names.includes(subject)), "Distrusted Node root remains");
  return subjects.length;
}

async function extract(archive: string, destination: string) {
  await mkdir(destination, { recursive: true });
  execFileSync("tar", ["-xf", archive, "--strip-components=1", "-C", destination]);
}

async function nodeInputs(download: Download, directory: string) {
  await mkdir(directory, { recursive: true });
  const base = `https://nodejs.org/dist/v${daemonTools.node}/`;
  const [sums, signature, key] = await Promise.all([
    download(`${base}SHASUMS256.txt`),
    download(`${base}SHASUMS256.txt.sig`),
    download(daemonTools.releaseKeyUrl, daemonTools.publicSigningSha256),
  ]);
  const sumsPath = resolve(directory, "SHASUMS256.txt"),
    sigPath = `${sumsPath}.sig`;
  await writeFile(sumsPath, sums);
  await writeFile(sigPath, signature);
  const armored = Buffer.from(key).toString().replaceAll("\r\n", "\n");
  const payload =
    /-----BEGIN PGP PUBLIC KEY BLOCK-----\n(?:[^\n]+\n)*?\n([A-Za-z0-9+/=\n]+)\n=[^\n]+\n-----END PGP PUBLIC KEY BLOCK-----/.exec(
      armored,
    )?.[1];
  check(payload, "Malformed pinned public Node key");
  const keyring = resolve(directory, "node-release-key.pgp");
  await writeFile(keyring, Buffer.from(payload.replaceAll("\n", ""), "base64"));
  const home = await mkdtemp(resolve(directory, "gpgv-"));
  let status: string;
  try {
    status = (
      await run("gpgv", [
        "--homedir",
        home,
        "--keyring",
        keyring,
        "--status-fd",
        "1",
        sigPath,
        sumsPath,
      ])
    ).toString();
    check(status.includes(`[GNUPG:] VALIDSIG ${daemonTools.signer} `), "Node archive signer drift");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
  for (const [filename, hash, target] of [
    [`node-v${daemonTools.node}-linux-x64.tar.xz`, daemonTools.nodeArchive, "node-runtime.tar.xz"],
    [`node-v${daemonTools.node}.tar.xz`, daemonTools.nodeSource, "node-source.tar.xz"],
  ]) {
    check(
      filename &&
        hash &&
        target &&
        Buffer.from(sums)
          .toString()
          .split("\n")
          .some((line) => line === `${hash}  ${filename}`),
      "Node input not authenticated by signed SHASUMS",
    );
    await writeFile(resolve(output, target), await download(`${base}${filename}`, hash));
  }
  const node = resolve(directory, "node");
  await extract(resolve(output, "node-runtime.tar.xz"), node);
  const binary = await readFile(resolve(node, "bin/node"));
  const roots = checkRootStore(binary);
  const license = await readFile(resolve(node, "LICENSE"));
  check(
    sha256(license) === imageInputs.embeddedNodeLicenseSha256,
    "Node distribution legal terms drift",
  );
  await writeFile(
    resolve(directory, "node-authentication.json"),
    `${JSON.stringify({ version: daemonTools.node, signer: daemonTools.signer, signatureStatus: status, roots, archiveSha256: daemonTools.nodeArchive, sourceSha256: daemonTools.nodeSource, executableSha256: sha256(binary), licenseSha256: sha256(license) }, null, 2)}\n`,
  );
  return resolve(node, "bin/node");
}

async function injectorInputs(download: Download, directory: string, source: string) {
  const reviews = JSON.parse(
    await readFile(resolve(root, "tools/unstale/supply-chain.json"), "utf8"),
  );
  const tools: { id: string; integrity: string; archiveSha256: string }[] = [];
  for (const [id, destination] of [
    [daemonTools.postject, "postject"],
    [daemonTools.commander, "postject/node_modules/commander"],
  ]) {
    check(id && destination, "Missing exact injector dependency");
    const pin = reviews.packages[id];
    check(
      pin &&
        `${pin.name}@${pin.version}` === id &&
        Object.keys(pin.lifecycle).length === 0 &&
        pin.license === "MIT" &&
        pin.signature.startsWith("verified SHA256:"),
      "Unreviewed injector tool",
    );
    tools.push({ id, integrity: pin.integrity, archiveSha256: pin.archiveSha256 });
    const bytes = await download(
      `https://registry.npmjs.org/${pin.name}/-/${pin.name}-${pin.version}.tgz`,
      pin.archiveSha256,
    );
    check(
      `sha512-${createHash("sha512").update(bytes).digest("base64")}` === pin.integrity,
      "Injector SRI mismatch",
    );
    const archive = resolve(directory, `${pin.name}.tgz`);
    await writeFile(archive, bytes);
    const installed = resolve(source, "node_modules", destination);
    await extract(archive, installed);
    check(
      sha256(await readFile(resolve(installed, "package.json"))) === pin.manifestSha256,
      "Injector manifest drift",
    );
    for (const [path, hash] of Object.entries(pin.licenses) as [string, string][])
      check(
        sha256(await readFile(resolve(installed, path.replace(/^package\//, "")))) === hash,
        "Injector legal terms drift",
      );
  }
  return tools;
}

/** Prepare actual new-source JS and authenticated inputs on any host; never claim a SEA exists. */
export async function prepareDaemon(download: Download, addon: Buffer) {
  check(sha256(addon) === daemonTools.addon, "Unreviewed FUSE addon input");
  const directory = resolve(output, "daemon-build");
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const source = resolve(directory, "source");
  await extract(resolve(output, "computer-source.tgz"), source);
  const node = await nodeInputs(download, directory);
  const freeze = JSON.parse(await readFile(resolve(here, "embedded-freeze.json"), "utf8")) as {
    components: {
      name: string;
      version: string;
      lockPath: string;
      url: string;
      sha256: string;
      integrity: string;
    }[];
    vendorSourceFiles: Record<string, string>;
  };
  const sourceLock = JSON.parse(await readFile(resolve(source, "package-lock.json"), "utf8"));
  for (const [path, hash] of Object.entries(freeze.vendorSourceFiles))
    check(
      sha256(await readFile(resolve(source, path))) === hash,
      "Changed vendored addon source requires review",
    );
  const modules = resolve(source, "node_modules");
  await mkdir(modules, { recursive: true });
  for (const pin of freeze.components.filter((pin) => pin.name !== "fuse-napi")) {
    const locked = sourceLock.packages[pin.lockPath];
    check(
      locked?.version === pin.version &&
        locked.resolved === pin.url &&
        locked.integrity === pin.integrity,
      `Reviewed daemon dependency differs from upstream source lock: ${pin.name}`,
    );
    const bytes = await download(pin.url, pin.sha256);
    check(
      `sha512-${createHash("sha512").update(bytes).digest("base64")}` === pin.integrity,
      "Builder runtime dependency SRI drift",
    );
    const path = resolve(directory, `${pin.name.replaceAll("/", "_")}.tgz`);
    await writeFile(path, bytes);
    await extract(path, resolve(modules, pin.name));
  }
  // Upstream tsdown exports map one-to-one to these source entries. Compile them in the
  // final upstream esbuild pass instead of installing an unrelated monorepo dev graph.
  const workspaceAdapters: { name: string; originalSha256: string; adaptedSha256: string }[] = [];
  for (const [name, path] of [
    ["dofs", "dofs"],
    ["computer-rpc", "rpc"],
  ]) {
    check(name && path, "Missing workspace build input");
    const packageRoot = resolve(source, "packages", path);
    const manifestPath = resolve(packageRoot, "package.json");
    const originalManifest = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(originalManifest);
    for (const entry of Object.values(manifest.exports) as { default: string }[])
      entry.default = entry.default.replace("./dist/", "./src/").replace(/\.js$/, ".ts");
    const adaptedManifest = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(manifestPath, adaptedManifest);
    workspaceAdapters.push({
      name,
      originalSha256: sha256(originalManifest),
      adaptedSha256: sha256(adaptedManifest),
    });
    await mkdir(resolve(modules, "@cloudflare"), { recursive: true });
    await symlink(packageRoot, resolve(modules, "@cloudflare", name), "dir");
  }
  await symlink(
    resolve(source, "packages/computerd/vendor/fuse-napi"),
    resolve(modules, "fuse-napi"),
    "dir",
  );
  const require = createRequire(import.meta.url);
  await symlink(
    dirname(require.resolve("esbuild/package.json")),
    resolve(modules, "esbuild"),
    "dir",
  );
  const esbuild = await import("esbuild");
  check(esbuild.version === daemonTools.esbuild, "Wrong SEA bundler");
  const upstreamPath = resolve(source, "packages/computerd/scripts/sea/bundle.mjs");
  const original = await readFile(upstreamPath, "utf8");
  const patches = [
    [
      'resolve(computerdRoot, "dist/cli/computerd.js")',
      'resolve(computerdRoot, "src/cli/computerd.ts")',
    ],
    ["await build({", "return await build({"],
    ['platform: "node",', 'absWorkingDir: repoRoot, metafile: true, platform: "node",'],
  ];
  let adapted = original;
  for (const [from, to] of patches) {
    check(
      from && to && adapted.split(from).length === 2,
      "Upstream bundler adapter no longer applies exactly",
    );
    adapted = adapted.replace(from, to);
  }
  const adaptedPath = resolve(dirname(upstreamPath), "fortipi-bundle.mjs");
  await writeFile(adaptedPath, adapted);
  check(
    !process.env.COMPUTERD_DEFAULT_PORT,
    "Frozen daemon build requires the unmodified upstream default port",
  );
  const bundler = (await import(pathToFileURL(adaptedPath).href)) as {
    bundleComputerd(options: { outfile: string }): Promise<{ metafile: unknown }>;
  };
  const work = resolve(source, ".fortipi-sea");
  await mkdir(work, { recursive: true });
  const bundle = resolve(work, "bundle.mjs");
  const built = await bundler.bundleComputerd({ outfile: bundle });
  const actualInputs = Object.keys((built.metafile as { inputs: Record<string, unknown> }).inputs);
  const allowed = new Set(freeze.components.map((pin) => pin.name));
  for (const path of actualInputs) {
    check(
      path.startsWith("packages/") ||
        path.startsWith("node_modules/") ||
        path === "computerd-shim:node-gyp-build",
      "Daemon bundle escaped its pinned source graph",
    );
    const dependency = /^node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(path)?.[1];
    if (dependency)
      check(allowed.has(dependency), `Unreviewed daemon runtime dependency ${dependency}`);
  }
  check(
    actualInputs.includes("packages/computerd/src/exec/runner.ts"),
    "Actual new process-group runner source was not compiled",
  );
  await writeFile(
    resolve(directory, "metafile.json"),
    `${JSON.stringify(built.metafile, null, 2)}\n`,
  );
  await writeFile(resolve(work, "fuse.node"), addon);
  const tools = await injectorInputs(download, directory, source);
  const inputs = {
    schemaVersion: 1,
    producerSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
    computerSource: imageInputs.source,
    computerSourceArchiveSha256: imageInputs.sourceArchiveSha256,
    nodeVersion: daemonTools.node,
    nodeArchiveSha256: daemonTools.nodeArchive,
    esbuild: daemonTools.esbuild,
    tools,
    workspaceAdapters,
    addonSha256: sha256(addon),
    bootstrapSha256: sha256(
      await readFile(resolve(source, "packages/computerd/scripts/sea/bootstrap.cjs")),
    ),
    bundleSha256: sha256(await readFile(bundle)),
    upstreamBundleRecipeSha256: sha256(original),
    adaptedBundleRecipeSha256: sha256(adapted),
    patches,
  };
  await writeFile(resolve(directory, "build-inputs.json"), `${JSON.stringify(inputs, null, 2)}\n`);
  return { directory, source, node, inputs };
}

/** Only a real Linux x64 generator can freeze the new SEA identity. */
export async function buildDaemon(download: Download, addon: Buffer): Promise<void> {
  check(
    process.platform === "linux" && process.arch === "x64",
    "Actual Linux x64 Node22.23.5 SEA build required; run --prepare-inputs on other hosts",
  );
  const { source, node, inputs } = await prepareDaemon(download, addon);
  const buildEnv = { PATH: process.env.PATH, LANG: "C", TZ: "UTC" };
  check(
    execFileSync(node, ["--version"], { env: buildEnv, encoding: "utf8" }).trim() === "v22.23.5",
    "SEA blob generator is not actual patched Node",
  );
  const config = {
    main: "packages/computerd/scripts/sea/bootstrap.cjs",
    output: ".fortipi-sea/blob",
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    assets: { "bundle.mjs": ".fortipi-sea/bundle.mjs", "fuse.node": ".fortipi-sea/fuse.node" },
  };
  await writeFile(resolve(source, ".fortipi-sea/config.json"), JSON.stringify(config));
  execFileSync(node, ["--experimental-sea-config", ".fortipi-sea/config.json"], {
    cwd: source,
    stdio: "pipe",
    timeout: 120000,
    env: buildEnv,
  });
  const binary = resolve(output, "computerd-built");
  await copyFile(node, binary);
  await chmod(binary, 0o755);
  execFileSync(
    node,
    [
      resolve(source, "node_modules/postject/dist/cli.js"),
      binary,
      "NODE_SEA_BLOB",
      resolve(source, ".fortipi-sea/blob"),
      "--sentinel-fuse",
      "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
      "--overwrite",
    ],
    { cwd: source, stdio: "pipe", timeout: 120000, env: buildEnv },
  );
  await writeFile(
    resolve(output, "computerd-build.json"),
    `${JSON.stringify({ ...inputs, blobSha256: sha256(await readFile(resolve(source, ".fortipi-sea/blob"))), binarySha256: sha256(await readFile(binary)), generatorVersion: "22.23.5", nodeExecutableSha256: sha256(await readFile(node)) }, null, 2)}\n`,
  );
}
