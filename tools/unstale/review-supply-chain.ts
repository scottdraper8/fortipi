import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import type { Manifest, Review, SupplyChain } from "../../scripts/check-pins.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const file = resolve(root, "tools/unstale/supply-chain.json");
export const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export function licenseEntries(entries: Map<string, Buffer>): Record<string, string> {
  return Object.fromEntries(
    [...entries]
      .filter(
        ([path, bytes]) =>
          /(?:^|\/)(?:licen[sc]e[^/]*|copying[^/]*|notice[^/]*|copyright[^/]*)$/i.test(path) ||
          (/readme/i.test(path) &&
            /Permission is hereby granted/i.test(bytes.toString()) &&
            /THE SOFTWARE IS PROVIDED/i.test(bytes.toString())),
      )
      .map(([path, bytes]) => [path, hash(bytes)]),
  );
}

async function publicFetch(url: string): Promise<Response> {
  const parsed = new URL(url);
  assert.ok(["registry.npmjs.org", "api.osv.dev"].includes(parsed.hostname));
  const response = await fetch(parsed, { signal: AbortSignal.timeout(60_000), redirect: "error" });
  assert.ok(response.ok, `${parsed.hostname}: HTTP ${response.status}`);
  return response;
}

/** Read archive entries without extracting paths or executing package code. */
export function archiveEntries(raw: Buffer): Map<string, Buffer> {
  const tar = gunzipSync(raw, { maxOutputLength: 768 * 1024 * 1024 });
  const entries = new Map<string, Buffer>();
  for (let at = 0; at + 512 <= tar.length; ) {
    const head = tar.subarray(at, at + 512);
    const name = head.subarray(0, 100).toString().replace(/\0.*$/s, "");
    if (!name) break;
    const prefix = head.subarray(345, 500).toString().replace(/\0.*$/s, "");
    const path = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(
      head.subarray(124, 136).toString().replace(/\0.*$/s, "").trim() || "0",
      8,
    );
    assert.ok(
      Number.isSafeInteger(size) && size >= 0 && at + 512 + size <= tar.length,
      "Malformed tar size",
    );
    assert.ok(!path.startsWith("/") && !path.split("/").includes(".."), "Unsafe archive path");
    if ([0, 48].includes(head[156] ?? 0)) {
      assert.ok(!entries.has(path), `Duplicate archive member ${path}`);
      entries.set(path, tar.subarray(at + 512, at + 512 + size));
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

export async function archive(
  name: string,
  version: string,
  integrity: string,
  destination = root,
): Promise<Buffer> {
  const cache = resolve(
    destination,
    "dist/supply-chain/archives",
    `${hash(Buffer.from(`${name}@${version}`))}.tgz`,
  );
  let raw: Buffer;
  try {
    raw = await readFile(cache);
  } catch {
    const metadata = (await (
      await publicFetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`)
    ).json()) as { dist: { tarball: string } };
    raw = Buffer.from(await (await publicFetch(metadata.dist.tarball)).arrayBuffer());
    assert.ok(raw.byteLength <= 256 * 1024 * 1024, "Oversized npm archive");
    await mkdir(dirname(cache), { recursive: true });
    await writeFile(cache, raw);
  }
  assert.equal(
    `sha512-${createHash("sha512").update(raw).digest("base64")}`,
    integrity,
    `${name}@${version}: archive SRI mismatch`,
  );
  return raw;
}

async function review(
  name: string,
  version: string,
  keys: { keyid: string; key: string }[],
): Promise<Review> {
  const all = (await (
    await publicFetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`)
  ).json()) as {
    time: Record<string, string>;
    versions: Record<
      string,
      {
        name: string;
        version: string;
        license?: string;
        engines?: Record<string, string>;
        peerDependencies?: Record<string, string>;
        scripts?: Record<string, string>;
        dist: {
          integrity: string;
          signatures?: { keyid: string; sig: string }[];
          attestations?: { url: string };
        };
      }
    >;
  };
  const metadata = all.versions[version];
  assert.ok(metadata, `No published ${name}@${version}`);
  const { integrity } = metadata.dist;
  const raw = await archive(name, version, integrity);
  const entries = archiveEntries(raw);
  const manifestBytes = [...entries].find(([path]) => /^[^/]+\/package.json$/.test(path))?.[1];
  assert.ok(manifestBytes, `Missing archive manifest ${name}@${version}`);
  const manifest = JSON.parse(manifestBytes.toString()) as Manifest;
  assert.equal(manifest.name, name);
  assert.equal(manifest.version, version);
  assert.equal(manifest.license, metadata.license);
  let signature = "not published";
  for (const sig of metadata.dist.signatures ?? []) {
    const key = keys.find((k) => k.keyid === sig.keyid);
    assert.ok(key, `Unknown registry signing key ${sig.keyid}`);
    assert.ok(
      verify(
        "sha256",
        Buffer.from(`${name}@${version}:${integrity}`),
        createPublicKey({ key: Buffer.from(key.key, "base64"), format: "der", type: "spki" }),
        Buffer.from(sig.sig, "base64"),
      ),
      `Bad registry signature ${name}@${version}`,
    );
    signature = `verified ${sig.keyid}`;
  }
  const licenses = licenseEntries(entries);
  const scriptFiles: Record<string, string> = {};
  for (const [path, bytes] of entries) {
    if (/(?:^|\/)(?:install\.js|scripts\/(?:prebuild|post-install)\.js|binding\.gyp)$/.test(path))
      scriptFiles[path] = hash(bytes);
  }
  const lifecycle: Record<string, string> = {};
  for (const key of ["preinstall", "install", "postinstall"])
    if (manifest.scripts?.[key]) lifecycle[key] = manifest.scripts[key];
  if (entries.has("package/binding.gyp") && !lifecycle.install)
    lifecycle.install = "node-gyp rebuild (implicit binding.gyp)";
  const published = all.time[version];
  assert.ok(published);
  return {
    name,
    version,
    integrity,
    published,
    reviewedAt: new Date().toISOString(),
    license: manifest.license ?? "UNKNOWN",
    archiveSha256: hash(raw),
    manifestSha256: hash(manifestBytes),
    engines: metadata.engines ?? {},
    peers: metadata.peerDependencies ?? {},
    lifecycle,
    scriptFiles,
    licenses,
    signature,
    provenance: metadata.dist.attestations
      ? `published ${metadata.dist.attestations.url}; Sigstore transparency verification required at release`
      : "not published",
  };
}

function lockIdentities(text: string): string[] {
  const sections = [...text.matchAll(/\npackages:\n([\s\S]*?)(?=\nsnapshots:\n)/g)];
  assert.ok(sections.length, "Missing lock packages section");
  return sections.flatMap((section) =>
    [...(section[1] ?? "").matchAll(/^ {2}(?:'([^']+)'|([^\s]+)):\s*$/gm)].map(
      (m) => m[1] ?? m[2] ?? "",
    ),
  );
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes("--check");
  const identities = new Set<string>();
  for (const path of [
    "package.json",
    ...["contract", "client", "tui", "cli", "executor"].map(
      (n) => `packages/fortipi-${n}/package.json`,
    ),
    "apps/worker/package.json",
    "tools/unstale/package.json",
  ]) {
    const manifest = JSON.parse(await readFile(resolve(root, path), "utf8")) as Manifest;
    for (const group of [manifest.dependencies, manifest.devDependencies])
      for (const [name, version] of Object.entries(group ?? {}))
        if (!version.startsWith("workspace:")) identities.add(`${name}@${version}`);
  }
  if (process.argv.includes("--locks"))
    for (const path of ["pnpm-lock.yaml", "tools/unstale/pnpm-lock.yaml"])
      for (const id of lockIdentities(await readFile(resolve(root, path), "utf8")))
        identities.add(id);
  for (const arg of process.argv.slice(2))
    if (arg.startsWith("--extra=")) identities.add(arg.slice(8));
  if (!process.argv.includes("--locks"))
    for (const id of identities) {
      const split = id.lastIndexOf("@");
      const metadata = (await (
        await publicFetch(
          `https://registry.npmjs.org/${encodeURIComponent(id.slice(0, split))}/${id.slice(split + 1)}`,
        )
      ).json()) as { optionalDependencies?: Record<string, string> };
      for (const [name, version] of Object.entries(metadata.optionalDependencies ?? {}))
        if (/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) identities.add(`${name}@${version}`);
    }
  let state: SupplyChain;
  try {
    state = JSON.parse(await readFile(file, "utf8")) as SupplyChain;
  } catch {
    state = {
      format: 1,
      packages: {},
      exemptions: {},
      advisory: { checkedAt: "", identities: 0, findings: [] },
    };
  }
  const keys = (
    (await (await publicFetch("https://registry.npmjs.org/-/npm/v1/keys")).json()) as {
      keys: { keyid: string; key: string }[];
    }
  ).keys;
  const pending = [...identities].sort().filter((id) => !state.packages[id]);
  if (checkOnly)
    assert.equal(
      pending.length,
      0,
      "Unreviewed archives require a serialized source-policy update",
    );
  let at = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (at < pending.length) {
        const id = pending[at++];
        assert.ok(id);
        const split = id.lastIndexOf("@");
        state.packages[id] = await review(id.slice(0, split), id.slice(split + 1), keys);
        console.log(`Reviewed ${id}`);
      }
    }),
  );
  const findings: string[] = [];
  const all = [...identities].sort();
  for (let i = 0; i < all.length; i += 100) {
    const batch = all.slice(i, i + 100);
    const response = await fetch("https://api.osv.dev/v1/querybatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        queries: batch.map((id) => {
          const r = state.packages[id];
          assert.ok(r);
          return { package: { name: r.name, ecosystem: "npm" }, version: r.version };
        }),
      }),
      signal: AbortSignal.timeout(60_000),
      redirect: "error",
    });
    assert.ok(response.ok, `OSV: HTTP ${response.status}`);
    const result = (await response.json()) as { results: { vulns?: { id: string }[] }[] };
    assert.equal(result.results.length, batch.length);
    result.results.forEach((r, index) => {
      for (const v of r.vulns ?? []) findings.push(`${batch[index]}: ${v.id}`);
    });
  }
  state.advisory = { checkedAt: new Date().toISOString(), identities: all.length, findings };
  if (checkOnly) {
    assert.ok(process.argv.includes("--locks"), "Check mode requires both complete lock graphs");
    const locks: Record<string, string> = {};
    for (const path of ["pnpm-lock.yaml", "tools/unstale/pnpm-lock.yaml"])
      locks[path] = hash(await readFile(resolve(root, path)));
    await mkdir(resolve(root, "dist/supply-chain"), { recursive: true });
    await writeFile(
      resolve(root, "dist/supply-chain/advisory-review.json"),
      `${JSON.stringify({ format: 1, reviewSha256: hash(await readFile(file)), locks, advisory: state.advisory }, null, 2)}\n`,
    );
    assert.deepEqual(findings, [], "Unresolved OSV advisories");
    console.log(
      `Fresh OSV check: ${all.length} locked identities; source policy and locks unchanged`,
    );
    return;
  }
  for (const id of all) {
    const r = state.packages[id];
    assert.ok(r);
    const expires = Date.parse(r.published) + 86_400_000;
    if (expires > Date.now())
      state.exemptions[id] = {
        reason:
          "Exact approved current release; archive SRI, registry signature, lifecycle, license and exact-version OSV reviewed for foundation",
        expires: new Date(expires).toISOString(),
        integrity: r.integrity,
      };
    else delete state.exemptions[id];
  }
  state.packages = Object.fromEntries(
    Object.entries(state.packages).sort(([a], [b]) => a.localeCompare(b, "en")),
  );
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`);
  assert.deepEqual(findings, [], "Unresolved OSV advisories");
  console.log(
    `Archive/security review: ${all.length} exact identities; no listed OSV matches. Review lifecycle source before approval. This does not certify future bundles.`,
  );
}

if (import.meta.main) await main();
