import assert from "node:assert/strict";
import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Attribution, LicensePolicy } from "../tools/unstale/review-attributions.ts";
import { archiveEntries, hash, licenseEntries } from "../tools/unstale/review-supply-chain.ts";
import { packagePaths, repository } from "./build-workspaces.ts";
import type { Lock, Manifest, Review, SupplyChain } from "./check-pins.ts";
import { json, yaml } from "./check-pins.ts";

interface InventoryPackage {
  id: string;
  license: string;
  integrity: string;
  archiveSha256: string;
  manifestSha256: string;
  licenses: Record<string, string>;
  credits: {
    author: unknown;
    contributors: unknown;
    repository: unknown;
    homepage: unknown;
    changeStatus: string;
  };
  attribution: Attribution | null;
  obligations: LicensePolicy["exceptions"][string] | null;
  distribution: string;
}
interface Text {
  path: string;
  source: string;
  bytes: Buffer;
}
interface Component {
  fact: InventoryPackage;
  texts: Text[];
}
export interface NoticeReceipt {
  package: string;
  directory: string;
  components: string[];
  noticeSha256: string;
  licenseSha256: string;
}

const safe = (path: string) => {
  assert.ok(
    /^[A-Za-z0-9_./+@%~-]+$/.test(path) &&
      path
        .split("/")
        .every(
          (part) =>
            part &&
            part !== "." &&
            part !== ".." &&
            !["node_modules", ".git", ".wrangler"].includes(part),
        ),
    `Unsafe notice path: ${path}`,
  );
  return path;
};
/** Checked facts must be regular files, never links into ambient state. */
async function file(root: string, path: string): Promise<Buffer> {
  safe(path);
  const parts = path.split("/");
  for (let index = 0; index < parts.length; index++) {
    const stat = await lstat(resolve(root, ...parts.slice(0, index + 1)));
    assert.ok(!stat.isSymbolicLink(), `Linked notice input: ${path}`);
    assert.ok(
      index === parts.length - 1 ? stat.isFile() && stat.nlink === 1 : stat.isDirectory(),
      `Nonregular notice input: ${path}`,
    );
  }
  return readFile(resolve(root, path));
}
const text = (bytes: Buffer, path: string) => {
  assert.ok(
    bytes.length > 0 && isUtf8(bytes) && !bytes.includes(0),
    `License is not original nonempty text: ${path}`,
  );
  return bytes;
};

/**
 * Produce only outer publication files. Prerequisite:
 * node scripts/check-licenses.ts --foundation [--root ROOT]
 * Worker notices remain the immutable output of CLI7's asset producer.
 * No package code executes and no network request occurs here.
 */
export async function generateNotices(root = repository): Promise<NoticeReceipt[]> {
  root = await realpath(resolve(root));
  const lock = await yaml<Lock>(root, "pnpm-lock.yaml");
  const supply = await json<SupplyChain>(root, "tools/unstale/supply-chain.json");
  const policy = await json<LicensePolicy>(root, "tools/unstale/license-policy.json");
  const inventory = await json<{ format: number; packages: InventoryPackage[] }>(
    root,
    "dist/supply-chain/inventory.json",
  );
  assert.equal(inventory.format, 1);
  assert.equal(supply.format, 1);
  assert.equal(policy.format, 1);
  const facts = new Map(inventory.packages.map((item) => [item.id, item]));
  assert.equal(facts.size, inventory.packages.length, "Duplicate checked license identity");
  const license = text(await file(root, "LICENSE"), "LICENSE");
  assert.match(license.toString(), /Sustainable Use License\r?\nVersion 1\.0/);
  const owned = new Map<string, { directory: string; manifest: Manifest }>();
  const version = (await json<Manifest>(root, "package.json")).version;
  for (const directory of packagePaths) {
    const manifest = await json<Manifest>(root, `${directory}/package.json`);
    assert.equal(manifest.license, "SEE LICENSE IN LICENSE");
    assert.equal(manifest.private, undefined);
    assert.equal(manifest.version, version);
    assert.equal(directory, `packages/${manifest.name}`);
    owned.set(manifest.name, { directory, manifest });
  }

  // A component can occur in several peer contexts. Its SRI/license identity is
  // verified once, while each exact locked snapshot is traversed independently.
  const checked = new Map<string, Component>();
  const component = async (id: string, ancestors = new Set<string>()): Promise<Component> => {
    const known = checked.get(id);
    if (known) return known;
    assert.ok(!ancestors.has(id), `Cyclic attribution: ${id}`);
    const seen = new Set([...ancestors, id]);
    const review: Review | undefined = supply.packages[id];
    const fact = facts.get(id);
    assert.ok(review && fact && lock.packages[id], `Missing checked license identity: ${id}`);
    assert.equal(id, `${review.name}@${review.version}`);
    assert.equal(lock.packages[id].resolution.integrity, review.integrity);
    for (const field of [
      "license",
      "integrity",
      "archiveSha256",
      "manifestSha256",
      "licenses",
    ] as const)
      assert.deepEqual(fact[field], review[field], `Checked inventory changed: ${id}/${field}`);
    assert.deepEqual(
      fact.attribution,
      policy.attributions[id] ?? null,
      `Attribution policy changed: ${id}`,
    );
    assert.deepEqual(
      fact.obligations,
      policy.exceptions[id] ?? null,
      `License obligations changed: ${id}`,
    );
    assert.ok(
      [
        "review exact archive and preserve texts",
        "external deployment tool only; native conveyance prohibited",
      ].includes(fact.distribution),
      `Unknown distribution review: ${id}`,
    );
    const raw = await file(root, `dist/supply-chain/archives/${hash(Buffer.from(id))}.tgz`);
    assert.equal(
      `sha512-${createHash("sha512").update(raw).digest("base64")}`,
      review.integrity,
      `Archive SRI mismatch: ${id}`,
    );
    assert.equal(hash(raw), review.archiveSha256, `Archive SHA256 mismatch: ${id}`);
    const entries = archiveEntries(raw);
    const manifests = [...entries].filter(([path]) => /^[^/]+\/package.json$/.test(path));
    assert.equal(manifests.length, 1, `Ambiguous archive manifest: ${id}`);
    const manifestBytes = manifests[0]?.[1];
    assert.ok(manifestBytes);
    assert.equal(hash(manifestBytes), review.manifestSha256, `Archive manifest changed: ${id}`);
    const upstream = JSON.parse(manifestBytes.toString()) as Record<string, unknown>;
    assert.equal(upstream.name, review.name);
    assert.equal(upstream.version, review.version);
    assert.equal(upstream.license, review.license);
    assert.deepEqual(
      fact.credits,
      {
        author: upstream.author ?? null,
        contributors: upstream.contributors ?? null,
        repository: upstream.repository ?? null,
        homepage: upstream.homepage ?? null,
        changeStatus: "unmodified upstream archive",
      },
      `Archive attribution changed: ${id}`,
    );
    assert.deepEqual(
      licenseEntries(entries),
      review.licenses,
      `Original license inventory changed: ${id}`,
    );
    const texts: Text[] = [];
    for (const [path, digest] of Object.entries(review.licenses).sort()) {
      const bytes = text(
        await file(root, `dist/supply-chain/licenses/${id.replaceAll("/", "__")}/${safe(path)}`),
        path,
      );
      assert.equal(hash(bytes), digest, `Checked license text changed: ${id}/${path}`);
      assert.deepEqual(bytes, entries.get(path), `Archive license text differs: ${id}/${path}`);
      texts.push({ path: `archive/${path}`, source: `${id}/${path}`, bytes });
    }
    const attribution = policy.attributions[id];
    if (!texts.length || fact.distribution.includes("native conveyance prohibited")) {
      assert.ok(
        attribution?.source && attribution.evidence,
        `Missing reviewed license attribution: ${id}`,
      );
      for (const source of attribution.files) {
        assert.ok(source.path.startsWith("tools/unstale/licenses/"));
        const bytes = text(await file(root, source.path), source.path);
        assert.equal(hash(bytes), source.sha256, `Source attribution text changed: ${id}`);
        assert.deepEqual(
          await file(root, `dist/supply-chain/licenses/${id.replaceAll("/", "__")}/${source.path}`),
          bytes,
          `Checked attribution text differs: ${id}`,
        );
        texts.push({ path: `attribution/${source.path}`, source: source.url, bytes });
      }
      if (attribution.inheritedFrom) {
        const parent = await component(attribution.inheritedFrom, seen);
        assert.equal(parent.fact.license, fact.license, `Inherited license differs: ${id}`);
        for (const item of parent.texts)
          texts.push({
            ...item,
            path: `inherited/${encodeURIComponent(parent.fact.id)}/${item.path}`,
          });
      }
    }
    assert.ok(texts.length, `No reviewed license texts: ${id}`);
    const result = { fact, texts };
    checked.set(id, result);
    return result;
  };

  const plans: { directory: string; files: Map<string, Buffer>; receipt: NoticeReceipt }[] = [];
  for (const { directory, manifest } of owned.values()) {
    const ids = new Set<string>();
    const snapshots = new Set<string>();
    const workspaces = new Set<string>();
    const visit = (name: string, reference: string): void => {
      assert.ok(!reference.startsWith("link:"), "Unexpected external workspace reference");
      const key = `${name}@${reference}`;
      if (snapshots.has(key)) return;
      snapshots.add(key);
      const snapshot = lock.snapshots?.[key];
      assert.ok(snapshot, `Missing locked runtime snapshot: ${key}`);
      const id = `${name}@${reference.split("(")[0]}`;
      assert.ok(lock.packages[id], `Unreviewed runtime archive: ${id}`);
      ids.add(id);
      for (const [dependency, version] of Object.entries({
        ...snapshot.dependencies,
        ...snapshot.optionalDependencies,
      }).sort())
        visit(dependency, version);
    };
    const workspace = (name: string): void => {
      if (workspaces.has(name)) return;
      workspaces.add(name);
      const owner = owned.get(name);
      assert.ok(owner, `Unrecognized owned runtime dependency: ${name}`);
      const importer = lock.importers[owner.directory];
      assert.ok(importer, `Missing locked importer: ${owner.directory}`);
      for (const group of ["dependencies", "optionalDependencies", "peerDependencies"] as const)
        for (const [dependency, specifier] of Object.entries<string>(
          owner.manifest[group] ?? {},
        ).sort()) {
          const locked: { specifier: string; version: string } | undefined =
            importer[group]?.[dependency] ?? importer.dependencies?.[dependency];
          assert.ok(
            locked && locked.specifier === specifier,
            `Runtime manifest differs from lock: ${name}/${dependency}`,
          );
          if (owned.has(dependency)) {
            const target = owned.get(dependency);
            assert.ok(
              target &&
                specifier === "workspace:*" &&
                locked.version.startsWith("link:") &&
                resolve(root, owner.directory, locked.version.slice(5)) ===
                  resolve(root, target.directory),
              `Owned runtime link changed: ${dependency}`,
            );
            workspace(dependency);
          } else visit(dependency, locked.version);
        }
    };
    workspace(manifest.name);
    const files = new Map<string, Buffer>([["LICENSE", license]]);
    const lines = [
      "# Third-party notices",
      "",
      `${manifest.name}@${manifest.version}`,
      "",
      "FortiPi's own code is covered by the exact Sustainable Use License 1.0 text in LICENSE. Third-party code, data, and original notices retain their own terms; the FortiPi license does not replace them.",
      "",
      "This inventory follows locked runtime dependencies, including optional platform dependencies and owned runtime package dependencies. Build/test-only dependencies are excluded. No dependency code, executable, native library or WASM is copied by this producer.",
      "",
    ];
    if (!ids.size)
      lines.push("This package has no third-party runtime dependencies in its locked graph.", "");
    if (manifest.name === "fortipi-cli")
      lines.push(
        "The embedded Worker's separately produced dependency notices and original texts are retained at [worker-assets/licenses/THIRD_PARTY_NOTICES.md](worker-assets/licenses/THIRD_PARTY_NOTICES.md). That immutable asset tree and its complete byte inventory are owned by the Worker asset producer and verified by the full distribution gate; this outer notice producer does not rewrite it or certify image/source-delivery obligations.",
        "",
      );
    for (const id of [...ids].sort()) {
      const { fact, texts } = await component(id);
      lines.push(
        `## ${id}`,
        "",
        `License expression: ${fact.license}`,
        "",
        `Archive SHA256: ${fact.archiveSha256}`,
        "",
        `Archive SRI: ${fact.integrity}`,
        "",
        "Original published attribution:",
        "",
        "```json",
        JSON.stringify(fact.credits, null, 2),
        "```",
        "",
      );
      if (fact.attribution)
        lines.push(
          "Reviewed source attribution:",
          "",
          "```json",
          JSON.stringify(fact.attribution, null, 2),
          "```",
          "",
        );
      if (fact.obligations)
        lines.push(
          "Exact reviewed obligations:",
          "",
          ...fact.obligations.obligations.map((item) => `- ${item}`),
          "",
        );
      if (fact.distribution.includes("native conveyance prohibited"))
        lines.push(
          "External deployment-tool dependency metadata only. No native/tool bytes are conveyed in this package. The reviewed text below is attribution evidence, not permission for native redistribution or a claim that all native-component redistribution obligations are met.",
          "",
        );
      for (const item of texts) {
        const path = safe(`licenses/${encodeURIComponent(id)}/${item.path}`);
        assert.ok(!files.has(path), `Duplicate license output: ${path}`);
        files.set(path, item.bytes);
        lines.push(
          `- [${item.path}](${path}) — SHA256 ${hash(item.bytes)}; source: ${item.source}`,
        );
      }
      lines.push("");
    }
    const notices = Buffer.from(`${lines.join("\n")}\n`);
    files.set("THIRD_PARTY_NOTICES.md", notices);
    plans.push({
      directory,
      files,
      receipt: {
        package: manifest.name,
        directory,
        components: [...ids].sort(),
        noticeSha256: hash(notices),
        licenseSha256: hash(license),
      },
    });
  }
  // Validate every package before replacing any previously generated output.
  for (const plan of plans) await file(root, `${plan.directory}/package.json`);
  await mkdir(resolve(root, "dist"), { recursive: true });
  const stage = await mkdtemp(resolve(root, "dist/notices-"));
  try {
    for (const plan of plans) {
      const destination = resolve(root, plan.directory);
      for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md", "licenses"]) {
        try {
          assert.ok(
            !(await lstat(resolve(destination, name))).isSymbolicLink(),
            `Linked notice output: ${name}`,
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      for (const [path, bytes] of plan.files) {
        const target = resolve(stage, plan.directory, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes, { flag: "wx", mode: 0o644 });
      }
      await mkdir(resolve(stage, plan.directory, "licenses"), { recursive: true });
      await rm(resolve(destination, "licenses"), { recursive: true, force: true });
      await rename(resolve(stage, plan.directory, "licenses"), resolve(destination, "licenses"));
      for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md"])
        await rename(resolve(stage, plan.directory, name), resolve(destination, name));
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  return plans.map((plan) => plan.receipt);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  assert.ok(
    args.length === 0 ||
      (args.length === 2 && args[0] === "--root" && args[1] && !args[1].startsWith("--")),
    "Usage: generate-notices.ts [--root ROOT]",
  );
  console.log(
    JSON.stringify({ schemaVersion: 1, packages: await generateNotices(args[1] ?? repository) }),
  );
}
