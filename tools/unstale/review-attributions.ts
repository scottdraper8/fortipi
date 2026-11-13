import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { repository } from "../../scripts/build-workspaces.ts";
import type { SupplyChain } from "../../scripts/check-pins.ts";
import { json } from "../../scripts/check-pins.ts";
import { archive, archiveEntries, hash } from "./review-supply-chain.ts";

export interface Attribution {
  source: string;
  evidence: string;
  files: { path: string; sha256: string; url: string }[];
  inheritedFrom?: string;
}
export interface LicensePolicy {
  format: 1;
  exceptions: Record<string, { license: string; reason: string; obligations: string[] }>;
  attributions: Record<string, Attribution>;
  externalToolChain?: string[];
}

async function main(): Promise<void> {
  const supply = await json<SupplyChain>(repository, "tools/unstale/supply-chain.json");
  let policy: LicensePolicy;
  try {
    policy = await json<LicensePolicy>(repository, "tools/unstale/license-policy.json");
  } catch {
    policy = { format: 1, exceptions: {}, attributions: {} };
  }
  const explicit = [
    ["argparse@2.0.1", "Python-2.0"],
    ["argparse@3.0.4", "PSF-2.0"],
    ["postal-mime@2.7.6", "MIT-0"],
    ["caniuse-lite@1.0.30001823", "CC-BY-4.0"],
  ];
  for (const [id, license] of explicit) {
    assert.ok(id && license);
    policy.exceptions[id] = {
      license,
      reason:
        "Exact identity approved by parent under original attribution authorization, 2026-11-10",
      obligations: [
        "Preserve full upstream license/copyright and source attribution",
        "Unmodified third-party archive; retain change status if modified",
        ...(license === "CC-BY-4.0"
          ? [
              "Credit caniuse database authors, source and CC-BY-4.0; no SUL restriction on the data",
            ]
          : []),
      ],
    };
  }
  const work = Object.entries(supply.packages).filter(
    ([id, r]) =>
      Object.keys(r.licenses).length === 0 &&
      !id.startsWith("@img/sharp-libvips-") &&
      !policy.attributions[id],
  );
  for (const [id, record] of work) {
    let parent: string | undefined;
    if (id.startsWith("@esbuild/")) parent = "esbuild@0.28.2";
    else if (id.startsWith("@biomejs/cli-")) parent = "@biomejs/biome@2.6.6";
    else if (id.startsWith("@rolldown/binding-")) parent = "rolldown@1.3.1";
    else if (id.startsWith("@cloudflare/workerd-")) parent = "workerd@1.20261113.1";
    if (parent) {
      const source = supply.packages[parent];
      assert.ok(source);
      const entries = archiveEntries(await archive(source.name, source.version, source.integrity));
      const manifest = JSON.parse(entries.get("package/package.json")?.toString() ?? "null") as {
        optionalDependencies: Record<string, string>;
      };
      assert.equal(
        manifest.optionalDependencies[record.name],
        record.version,
        `No exact platform-parent relationship ${id}`,
      );
      policy.attributions[id] = {
        source: parent,
        inheritedFrom: parent,
        evidence:
          "Exact optional platform artifact declared by the reviewed parent archive; retain its upstream license/NOTICE",
        files: [],
      };
      await writeFile(
        resolve(repository, "tools/unstale/license-policy.json"),
        `${JSON.stringify(policy, null, 2)}\n`,
      );
      continue;
    }
    const metadata = (await (
      await fetch(
        `https://registry.npmjs.org/${encodeURIComponent(record.name)}/${record.version}`,
        { signal: AbortSignal.timeout(30_000) },
      )
    ).json()) as {
      gitHead?: string;
      repository: string | { url: string; directory?: string };
      dist: { attestations?: { url: string } };
    };
    const repo =
      typeof metadata.repository === "string" ? metadata.repository : metadata.repository.url;
    const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(repo);
    assert.ok(match?.[1], `Source repository not recognized: ${id}`);
    const repositoryName = match[1];
    let commit = metadata.gitHead;
    let evidence = "Exact npm metadata gitHead";
    if (!commit && metadata.dist.attestations) {
      const result = (await (
        await fetch(metadata.dist.attestations.url, { signal: AbortSignal.timeout(30_000) })
      ).json()) as {
        attestations: { predicateType: string; bundle: { dsseEnvelope: { payload: string } } }[];
      };
      for (const item of result.attestations)
        if (item.predicateType.includes("slsa")) {
          const statement = JSON.parse(
            Buffer.from(item.bundle.dsseEnvelope.payload, "base64").toString(),
          ) as {
            predicate: {
              buildDefinition: {
                resolvedDependencies: { uri: string; digest: { gitCommit?: string } }[];
              };
            };
          };
          commit = statement.predicate.buildDefinition.resolvedDependencies.find((d) =>
            d.uri.includes(repositoryName),
          )?.digest.gitCommit;
          evidence =
            "Published exact-version SLSA source claim; archive registry signature/SRI separately verified; transparency proof remains release verification";
        }
    }
    if (!commit) {
      const tags = [record.version, `v${record.version}`, `${record.name}@${record.version}`];
      const result = await promisify(execFile)(
        "git",
        [
          "ls-remote",
          `https://github.com/${repositoryName}.git`,
          ...tags.flatMap((tag) => [`refs/tags/${tag}`, `refs/tags/${tag}^{}`]),
        ],
        { timeout: 60_000 },
      );
      const rows = result.stdout.trim().split("\n").filter(Boolean);
      commit = (rows.find((line) => line.endsWith("^{}")) ?? rows[0])?.split(/\s/)[0];
      evidence = "Exact version release tag resolved via git ls-remote, annotated tags peeled";
    }
    if (!commit) {
      console.error(`Missing immutable source correspondence: ${id}`);
      continue;
    }
    assert.match(commit, /^[a-f0-9]{40}$/);
    const directory =
      typeof metadata.repository === "string" ? "" : (metadata.repository.directory ?? "");
    const candidates = [...new Set([...(directory ? [directory] : []), ""])].flatMap((p) =>
      ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENSE-MIT", "LICENSE-APACHE", "NOTICE"].map(
        (n) => (p ? `${p}/${n}` : n),
      ),
    );
    const files: Attribution["files"] = [];
    for (const path of candidates) {
      const url: string = `https://raw.githubusercontent.com/${repositoryName}/${commit}/${path}`;
      const response: Response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (response.status === 404) continue;
      assert.ok(response.ok, `Source attribution HTTP ${response.status}: ${url}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const target = `tools/unstale/licenses/${repositoryName}/${commit}/${path}`;
      await mkdir(dirname(resolve(repository, target)), { recursive: true });
      await writeFile(resolve(repository, target), bytes);
      files.push({ path: target, sha256: hash(bytes), url });
    }
    if (!files.length) {
      console.error(`No exact-source license found for ${id}`);
      continue;
    }
    policy.attributions[id] = {
      source: `https://github.com/${repositoryName}/tree/${commit}`,
      evidence,
      files,
    };
    await writeFile(
      resolve(repository, "tools/unstale/license-policy.json"),
      `${JSON.stringify(policy, null, 2)}\n`,
    );
    console.log(`Attribution ${id}: ${files.length} exact-source texts`);
  }
  await writeFile(
    resolve(repository, "tools/unstale/license-policy.json"),
    `${JSON.stringify(policy, null, 2)}\n`,
  );
}

if (import.meta.main) await main();
