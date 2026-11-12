// Distribution fixture only: actual pnpm packs and reviewed cached archives; no upstream proxy.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type Lock, type Review, type SupplyChain, yaml } from "../../../scripts/check-pins.ts";
import { pnpmExecutable, verifyPnpmExecutable } from "../../../scripts/pnpm-executable.ts";
import { archiveEntries } from "../../../tools/unstale/review-supply-chain.ts";
import { verifyAssets } from "../dist/assets.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const execute = promisify(execFile);
interface FixturePackage {
  manifest: Record<string, unknown>;
  bytes: Buffer;
  integrity: string;
  published?: string;
}

function archiveManifest(bytes: Buffer): Record<string, unknown> {
  const entry = [...archiveEntries(bytes)].find(([name]) => /^[^/]+\/package.json$/.test(name));
  assert.ok(entry, "Packed manifest is missing");
  return JSON.parse(entry[1].toString());
}

export async function protectInstall(directory: string): Promise<void> {
  const rootPath = await realpath(directory);
  const walk = async (path: string): Promise<void> => {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      assert.ok(
        (await realpath(path)).startsWith(`${rootPath}${sep}`),
        "Installed link escaped consumer",
      );
      return;
    }
    if (stat.isDirectory()) {
      for (const name of await readdir(path)) await walk(join(path, name));
      await chmod(path, 0o555);
    } else {
      assert.ok(stat.isFile(), "Special installed file");
      await chmod(path, (stat.mode & 0o111) !== 0 ? 0o555 : 0o444);
    }
  };
  await walk(directory);
}

export async function installConsumer(directory: string): Promise<Record<string, unknown>> {
  assert.ok(isAbsolute(directory));
  assert.equal(process.versions.node, "26.13.1");
  const assets = await verifyAssets();
  await mkdir(directory, { mode: 0o700 });
  const packs = join(directory, "packs");
  await mkdir(packs, { mode: 0o700 });
  const emptyConfig = join(directory, "empty-package-manager-config");
  await writeFile(emptyConfig, "", { flag: "wx", mode: 0o600 });
  const pnpm = await pnpmExecutable();
  await verifyPnpmExecutable(pnpm);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    LANG: "C",
    CI: "true",
    npm_config_userconfig: emptyConfig,
    npm_config_globalconfig: emptyConfig,
  };
  const internal = new Map<string, FixturePackage>();
  const rootManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  // These are genuine Sustainable Use License bytes from the normal build's source,
  // never a substitute for missing release9 third-party publication notices.
  for (const name of ["fortipi-contract", "fortipi-cli"]) {
    const packageRoot = join(root, "packages", name);
    await copyFile(join(root, "LICENSE"), join(packageRoot, "LICENSE"));
    await execute(pnpm, ["pack", "--pack-destination", packs], {
      cwd: packageRoot,
      env,
      timeout: 120000,
      maxBuffer: 1048576,
    });
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    const bytes = await readFile(join(packs, `${name}-${manifest.version}.tgz`));
    const packed = archiveManifest(bytes);
    assert.equal(packed.name, name);
    assert.equal(packed.version, manifest.version);
    for (const value of Object.values(packed.dependencies ?? {}))
      assert.ok(
        typeof value === "string" && !value.startsWith("workspace:"),
        "Unpublished workspace alias in actual pack",
      );
    internal.set(`${name}@${manifest.version}`, {
      manifest: packed,
      bytes,
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    });
  }
  const review = JSON.parse(
    await readFile(join(root, "tools/unstale/supply-chain.json"), "utf8"),
  ) as SupplyChain;
  const lock = await yaml<Lock>(root, "pnpm-lock.yaml");
  // Historical review facts can outlive their cache; serve only this frozen graph.
  const retained: SupplyChain["packages"] = {};
  for (const id of Object.keys(lock.packages)) {
    const record = review.packages[id];
    assert.ok(record, "Locked distribution archive lacks reviewed inputs");
    retained[id] = record;
  }
  const cache = new Map<string, Promise<FixturePackage>>();
  const load = (record: Review): Promise<FixturePackage> => {
    const id = `${record.name}@${record.version}`;
    if (!cache.has(id))
      cache.set(
        id,
        (async () => {
          const bytes = await readFile(join(root, "dist/supply-chain/archives", `${hash(id)}.tgz`));
          assert.equal(hash(bytes), record.archiveSha256, "Cached archive identity changed");
          assert.equal(
            `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
            record.integrity,
            "Cached archive integrity changed",
          );
          const manifest = archiveManifest(bytes);
          assert.equal(manifest.name, record.name);
          assert.equal(manifest.version, record.version);
          return { manifest, bytes, integrity: record.integrity, published: record.published };
        })(),
      );
    const pending = cache.get(id);
    assert.ok(pending);
    return pending;
  };
  const identities = new Set<string>();
  let requests = 0;
  let failed = false;
  let origin = "";
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.method, "GET");
      assert.ok(++requests <= 2048, "Fixture request bound exceeded");
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      assert.ok(path.length <= 512);
      if (path.startsWith("/archive/")) {
        const id = decodeURIComponent(path.slice("/archive/".length).replace(/\.tgz$/, ""));
        const pkg = internal.get(id) ?? (retained[id] ? await load(retained[id]) : undefined);
        assert.ok(pkg, "Unreviewed fixture archive request");
        identities.add(id);
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(pkg.bytes);
        return;
      }
      const name = decodeURIComponent(path.slice(1));
      assert.match(name, /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i);
      const packages = [...internal.values()].filter((p) => p.manifest.name === name);
      for (const record of Object.values(retained).filter((p) => p.name === name))
        packages.push(await load(record));
      assert.ok(packages.length > 0, "Unreviewed fixture metadata request");
      const versions: Record<string, unknown> = {};
      const time: Record<string, string> = {};
      for (const pkg of packages) {
        const version = String(pkg.manifest.version);
        const id = `${name}@${version}`;
        versions[version] = {
          ...pkg.manifest,
          dist: {
            integrity: pkg.integrity,
            shasum: createHash("sha1").update(pkg.bytes).digest("hex"),
            tarball: `${origin}/archive/${encodeURIComponent(id)}.tgz`,
          },
        };
        if (pkg.published) time[version] = pkg.published;
      }
      // This fixture exposes only reviewed exact versions, not an upstream latest claim.
      const body = JSON.stringify({ name, versions, time, "dist-tags": {} });
      assert.ok(Buffer.byteLength(body) <= 512 * 1024);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(body);
    })().catch(() => {
      failed = true;
      response.writeHead(503);
      response.end("Reviewed distribution fixture unavailable");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
  const consumer = join(directory, "consumer");
  await mkdir(consumer, { mode: 0o700 });
  try {
    await writeFile(
      join(consumer, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        dependencies: {
          "fortipi-cli": rootManifest.version,
          "fortipi-contract": rootManifest.version,
        },
        devDependencies: {
          typescript: rootManifest.devDependencies.typescript,
          "@types/node": rootManifest.devDependencies["@types/node"],
        },
      }),
      { flag: "wx" },
    );
    await execute(
      pnpm,
      [
        "install",
        "--ignore-scripts",
        "--no-frozen-lockfile",
        "--registry",
        origin,
        "--config.node-linker=hoisted",
        "--config.package-import-method=copy",
        `--config.store-dir=${join(directory, "store")}`,
        "--config.auto-install-peers=false",
        "--config.fetch-retries=0",
      ],
      { cwd: consumer, env, timeout: 300000, maxBuffer: 2 * 1024 * 1024 },
    );
    assert.equal(failed, false, "Consumer requested inputs outside reviewed fixture");
    const resolved = await execute(
      process.execPath,
      ["--input-type=module", "-e", "console.log(import.meta.resolve('fortipi-cli'))"],
      { cwd: consumer, env, timeout: 15000, maxBuffer: 4096 },
    );
    const installedRoot = dirname(dirname(fileURLToPath(resolved.stdout.trim())));
    assert.ok(
      (await realpath(installedRoot)).startsWith(`${join(consumer, "node_modules")}${sep}`),
      "Workspace CLI resolution is forbidden",
    );
    const installed = await verifyAssets(join(installedRoot, "worker-assets"));
    assert.equal(installed.manifestSha256, assets.manifestSha256);
    await copyFile(
      join(root, "packages/fortipi-cli/test/public-api.ts"),
      join(consumer, "public-api.ts"),
    );
    await execute(
      process.execPath,
      [
        join(consumer, "node_modules/typescript/bin/tsc"),
        "--ignoreConfig",
        "--strict",
        "--skipLibCheck",
        "false",
        "--types",
        "node",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--target",
        "ES2024",
        "--lib",
        "ES2024,DOM,DOM.Iterable",
        "--noEmit",
        "public-api.ts",
      ],
      { cwd: consumer, env, timeout: 120000, maxBuffer: 1024 * 1024 },
    );
    await protectInstall(join(consumer, "node_modules"));
    const cliBin = join(installedRoot, "dist/bin.js");
    const prepared = join(directory, "local-prepared");
    const output = await execute(
      process.execPath,
      [
        cliBin,
        "prepare",
        "--config",
        join(installedRoot, "templates/operator-config.example.json"),
        "--directory",
        prepared,
        "--non-interactive",
        "--json",
      ],
      {
        cwd: consumer,
        env: { PATH: process.env.PATH, LANG: "C" },
        timeout: 120000,
        maxBuffer: 1024 * 1024,
      },
    );
    const receipt = JSON.parse(output.stdout);
    assert.equal(receipt.assetManifestSha256, assets.manifestSha256);
    await copyFile(
      join(root, "packages/fortipi-cli/test/offline-consumer.ts"),
      join(consumer, "offline-consumer.ts"),
    );
    const publicationNotices: Record<string, boolean> = {};
    for (const name of ["fortipi-cli", "fortipi-contract"]) {
      try {
        await access(join(root, "packages", name, "THIRD_PARTY_NOTICES.md"));
        publicationNotices[name] = true;
      } catch {
        publicationNotices[name] = false;
      }
    }
    const result = {
      schemaVersion: 1,
      consumer,
      checkout: root,
      checkoutUid: (await lstat(root)).uid,
      sourceCommit: assets.manifest.sourceCommit,
      assetManifestSha256: assets.manifestSha256,
      publicReviewedArchives: identities.size - internal.size,
      fixtureRequests: requests,
      strictInstalledConsumer: true,
      readOnlyInstall: true,
      installedPrepare: true,
      publicationNotices,
      parentNetworkNamespace:
        process.platform === "linux"
          ? await (await import("node:fs/promises")).readlink("/proc/self/ns/net")
          : null,
      offlineDryBuild: "not-executed; dedicated Linux identity/network namespace required",
    };
    await writeFile(join(directory, "distribution.json"), `${JSON.stringify(result, null, 2)}\n`, {
      flag: "wx",
    });
    return result;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
  }
}

if (import.meta.main) {
  const directory = process.argv[2];
  assert.ok(
    directory && isAbsolute(directory),
    "Explicit fresh absolute distribution directory required",
  );
  console.log(JSON.stringify(await installConsumer(directory)));
}
