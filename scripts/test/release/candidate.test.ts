import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { c as createTar } from "tar";
import { repository } from "../../build-workspaces.ts";
import { releaseChecksums } from "../../collect-release-assets.ts";
import type { NoticeReceipt } from "../../generate-notices.ts";
import { archiveInventory, generateSbom, stageAndPack } from "../../prepare-release.ts";
import {
  inventory,
  object,
  readJson,
  regularBytes,
  sha256,
  sha512,
} from "../../verify-release-gates.ts";

test("actual five scoped pnpm packs retain staged bytes, executable bins, legal closure and a runtime/image SBOM", {
  timeout: 180000,
}, async () => {
  const directory = await mkdtemp(resolve(await realpath(tmpdir()), "fortipi-packs-"));
  try {
    const packed = await stageAndPack(
      repository,
      resolve(directory, "packs"),
      "fortipi-ci-test",
      "0.1.0",
    );
    assert.equal(packed.packages.length, 5);
    const notices: NoticeReceipt[] = [];
    for (const p of packed.packages) {
      const path = resolve(directory, p.tarball);
      const data = await regularBytes(path);
      assert.equal(sha256(data), p.sha256);
      assert.equal(sha512(data), p.integrity);
      const actual = await archiveInventory(path);
      assert.deepEqual(actual.entries, p.entries);
      assert.equal(actual.manifest.name, p.name);
      assert.equal(actual.manifest.version, "0.1.0");
      const original = await readFile(
        resolve(repository, "packages", p.sourceName, "THIRD_PARTY_NOTICES.md"),
        "utf8",
      );
      const components = [...original.matchAll(/^## (.+@[^\s]+)$/gm)].map((m) => String(m[1]));
      notices.push({
        package: p.sourceName,
        directory: `packages/${p.sourceName}`,
        components,
        noticeSha256: sha256(original),
        licenseSha256: sha256(await regularBytes(resolve(repository, "LICENSE"))),
      });
      assert.ok(p.entries.some((e) => e.path === "THIRD_PARTY_NOTICES.md"));
      assert.equal(
        p.entries.some(
          (e) =>
            e.path.startsWith("src/") ||
            (e.path.endsWith(".map") && !e.path.startsWith("worker-assets/")),
        ),
        false,
      );
    }
    await generateSbom(repository, directory, "fortipi-ci-test", "0.1.0", notices);
    const releaseFiles = packed.packages.map((pkg) => ({
      name: pkg.tarball.replaceAll("/", "__"),
      sha256: pkg.sha256,
    }));
    const sums = releaseChecksums(releaseFiles).toString("utf8").trim().split("\n");
    for (const line of sums) {
      const [hash, name] = line.split("  ");
      const pkg = packed.packages.find((pkg) => pkg.tarball.replaceAll("/", "__") === name);
      assert.ok(pkg, "Checksum must address an actual exported asset name");
      assert.equal(
        createHash("sha256")
          .update(await regularBytes(resolve(directory, pkg.tarball)))
          .digest("hex"),
        hash,
      );
      assert.ok(!name?.includes("/"));
    }
    const bom = object(await readJson(resolve(directory, "sbom.json")));
    assert.equal(bom.bomFormat, "CycloneDX");
    assert.equal(bom.specVersion, "1.7");
    assert.ok(Array.isArray(bom.components));
    const components = bom.components.map(object);
    for (const p of packed.packages)
      assert.ok(
        components.some((c) => c.name === p.name && c.version === p.version),
        "Final scoped component missing",
      );
    assert.ok(components.some((c) => c.name === "Node.js"));
    assert.ok(components.some((c) => c.name === "fuse-napi"));
    assert.ok(components.some((c) => c.name === "libc6" || c.name === "glibc"));
    assert.ok(components.some((c) => String(c.name).startsWith("embedded-worker/")));
    assert.equal(
      components.some((c) => ["typescript", "@biomejs/biome", "node-gyp"].includes(String(c.name))),
      false,
      "Unrelated dev tool bloat",
    );
    const manifest = object(
      await readJson(resolve(repository, "packages/fortipi-cli/worker-assets/asset-manifest.json")),
    );
    assert.equal(manifest.packageVersion, "0.1.0");
    assert.ok((await inventory(directory)).some((f) => f.path === "sbom.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("actual tar reader rejects links and namespace traversal rather than accepting a pack marker", async () => {
  const directory = await mkdtemp(resolve(await realpath(tmpdir()), "fortipi-bad-pack-"));
  try {
    await mkdir(resolve(directory, "package"));
    await writeFile(resolve(directory, "package/package.json"), "{}");
    await symlink("../../outside", resolve(directory, "package/link"));
    const file = resolve(directory, "linked.tgz");
    await createTar({ cwd: directory, file, gzip: true }, ["package"]);
    await assert.rejects(archiveInventory(file), /prefix\/link rejected/);
    await rm(resolve(directory, "package/link"));
    await createTar(
      { cwd: directory, prefix: "../escape", file: resolve(directory, "prefix.tgz"), gzip: true },
      ["package/package.json"],
    );
    await assert.rejects(
      archiveInventory(resolve(directory, "prefix.tgz")),
      /prefix\/link rejected/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
