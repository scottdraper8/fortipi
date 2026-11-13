// API fixtures are synthetic. actualCapsule separately retains real compiled/package/image bytes.

import { execFile } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { repository } from "../../build-workspaces.ts";
import { generateSbom, stageAndPack } from "../../prepare-release.ts";
import {
  type CandidateManifest,
  canonicalJson,
  type FileRecord,
  inventory,
  object,
  packageOrder,
  REPOSITORY,
  REPOSITORY_ID,
  readJson,
  regularBytes,
  saveJson,
  sha256,
  sha512,
} from "../../verify-release-gates.ts";

export const source = "a".repeat(40);
export const workflow = "fixture workflow source\n";
export const deviceProducerJobs = [
  "initial-installed-deployment",
  "live-device-a",
  "live-device-b",
  "live-device-cleanup",
  "operate",
];
export function fact(path = "result.json", bytes: Uint8Array = Buffer.from("{}")): FileRecord {
  return { path, size: bytes.length, mode: 0o600, sha256: sha256(bytes) };
}
export function candidate(): CandidateManifest {
  const files = packageOrder.map((p) =>
    fact(`packs/${p}.tgz`, Buffer.from(`registry fixture ${p}`)),
  );
  return {
    schemaVersion: 1,
    repository: REPOSITORY,
    repositoryId: REPOSITORY_ID,
    branch: "main",
    sourceCommit: source,
    version: "0.1.0",
    tag: "v0.1.0",
    scope: "release-fixture",
    publishable: true,
    createdAt: new Date().toISOString(),
    producer: {
      workflowPath: ".github/workflows/release.yml",
      workflowSha256: sha256(workflow),
      workflowId: 1,
      runId: 10,
      runAttempt: 2,
    },
    hashes: {
      lock: sha256("lock"),
      publishNames: sha256("names"),
      toolchainPolicy: sha256("policy"),
    },
    assetManifestSha256: sha256("assets"),
    image: {
      sourceCommit: source,
      metadataSha256: sha256("image"),
      imageId: `sha256:${sha256("imageId")}`,
      builtManifestDigest: `sha256:${sha256("built")}`,
      sourceKitSha256: sha256("sourcekit"),
    },
    packages: packageOrder.map((p, i) => ({
      name: `@release-fixture/fortipi-${p}`,
      sourceName: `fortipi-${p}`,
      version: "0.1.0",
      tarball: `packs/${p}.tgz`,
      sha256: files[i]?.sha256 ?? "",
      integrity: sha512(Buffer.from(`registry fixture ${p}`)),
      entries: [fact("package.json")],
    })),
    files: [...files, fact("sbom.json"), fact("image/sources-and-notices.tar")],
  };
}
export async function temporary(prefix: string): Promise<string> {
  return mkdtemp(resolve(await realpath(tmpdir()), prefix));
}
export async function fixtureFiles(root: string, _c: CandidateManifest): Promise<void> {
  await mkdir(resolve(root, "packs"));
  for (const p of packageOrder)
    await writeFile(resolve(root, "packs", `${p}.tgz`), Buffer.from(`registry fixture ${p}`));
}
export async function metadataArchive(
  c: CandidateManifest,
): Promise<{ bytes: Buffer; metadataSha256: string; close: () => Promise<void> }> {
  const directory = await temporary("fortipi-api-zip-");
  const payload = resolve(directory, "payload");
  await mkdir(payload);
  for (const entry of c.files) {
    await mkdir(dirname(resolve(payload, entry.path)), { recursive: true });
    await writeFile(
      resolve(payload, entry.path),
      entry.path.startsWith("packs/")
        ? Buffer.from(`registry fixture ${entry.path.slice(6, -4)}`)
        : Buffer.from("{}"),
    );
  }
  const metadata = `${canonicalJson(c)}\n`;
  await writeFile(resolve(payload, "candidate.json"), metadata);
  await promisify(execFile)("/usr/bin/zip", ["-q", "-r", resolve(directory, "archive.zip"), "."], {
    cwd: payload,
    timeout: 10000,
  });
  return {
    bytes: await readFile(resolve(directory, "archive.zip")),
    metadataSha256: sha256(metadata),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}
export async function httpFixture(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void,
): Promise<{ origin: string; transport: typeof fetch; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(() => {
      response.statusCode = 500;
      response.end("fixture error");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const origin = `http://127.0.0.1:${address.port}`;
  const transport: typeof fetch = (input, options) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return fetch(`${origin}${url.pathname}${url.search}`, options);
  };
  return {
    origin,
    transport,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((accept, reject) =>
        server.close((error) => (error ? reject(error) : accept())),
      );
    },
  };
}
export async function directoryArchive(
  directory: string,
): Promise<{ bytes: Buffer; close: () => Promise<void> }> {
  const scratch = await temporary("fortipi-directory-zip-");
  await promisify(execFile)("/usr/bin/zip", ["-q", "-r", resolve(scratch, "archive.zip"), "."], {
    cwd: directory,
    timeout: 10000,
  });
  return {
    bytes: await readFile(resolve(scratch, "archive.zip")),
    close: () => rm(scratch, { recursive: true, force: true }),
  };
}
export async function jsonArchive(
  value: unknown,
  member: string,
): Promise<{ bytes: Buffer; close: () => Promise<void> }> {
  const directory = await temporary("fortipi-json-zip-");
  await writeFile(resolve(directory, member), `${canonicalJson(value)}\n`);
  await promisify(execFile)("/usr/bin/zip", ["-q", resolve(directory, "archive.zip"), member], {
    cwd: directory,
    timeout: 10000,
  });
  return {
    bytes: await readFile(resolve(directory, "archive.zip")),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

/** Real retained bytes for staging/install checks; no source-build or release authorization claim. */
export async function actualCapsule(directory: string): Promise<string> {
  await mkdir(directory);
  const scope = "fortipi-ci-test";
  const packed = await stageAndPack(repository, resolve(directory, "packs"), scope, "0.1.0");
  await generateSbom(repository, directory, scope, "0.1.0", packed.runtimeNotices);
  await mkdir(resolve(directory, "image"));
  for (const file of ["image-metadata.json", "sources-and-notices.tar"])
    await copyFile(
      resolve(repository, "apps/worker/dist/container", file),
      resolve(directory, "image", file),
      1,
    );
  await mkdir(resolve(directory, "supply-chain"), { recursive: true });
  await copyFile(
    resolve(repository, "dist/supply-chain/inventory.json"),
    resolve(directory, "supply-chain/inventory.json"),
    1,
  );
  const image = object(await readJson(resolve(directory, "image/image-metadata.json")));
  const assets = object(
    await readJson(resolve(repository, "packages/fortipi-cli/worker-assets/asset-manifest.json")),
  );
  const c = candidate();
  c.scope = scope;
  c.publishable = false;
  c.sourceCommit = String(assets.sourceCommit);
  c.producer = {
    ...c.producer,
    workflowSha256: sha256(
      await regularBytes(resolve(repository, ".github/workflows/release.yml")),
    ),
    workflowId: 0,
    runId: 0,
    runAttempt: 0,
  };
  c.hashes = {
    lock: sha256(await regularBytes(resolve(repository, "pnpm-lock.yaml"))),
    publishNames: sha256(
      canonicalJson(
        object(object(await readJson(resolve(repository, "package.json"))).fortipi).publishNames,
      ),
    ),
    toolchainPolicy: sha256(
      await regularBytes(resolve(repository, "tools/unstale/supply-chain.json")),
    ),
  };
  c.assetManifestSha256 = packed.assetManifestSha256;
  c.image = {
    sourceCommit: String(image.sourceCommit),
    metadataSha256: sha256(await regularBytes(resolve(directory, "image/image-metadata.json"))),
    imageId: String(image.imageId),
    builtManifestDigest: String(image.builtManifestDigest),
    sourceKitSha256: String(image.sourceKitSha256),
  };
  c.packages = packed.packages;
  c.files = await inventory(directory);
  await saveJson(resolve(directory, "candidate.json"), c);
  return resolve(directory, "candidate.json");
}
export async function discard(directory: string): Promise<void> {
  try {
    const stat = await lstat(directory);
    if (stat.isSymbolicLink()) {
      await rm(directory);
      return;
    }
    if (stat.isDirectory()) {
      await chmod(directory, 0o700);
      for (const name of await readdir(directory)) await discard(resolve(directory, name));
      await rm(directory, { recursive: true, force: true });
    } else {
      await chmod(directory, 0o600);
      await rm(directory);
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}
