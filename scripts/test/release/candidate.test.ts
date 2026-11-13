import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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
    const notices: NoticeReceipt[] = packed.runtimeNotices;
    for (const p of packed.packages) {
      const path = resolve(directory, p.tarball);
      const data = await regularBytes(path);
      assert.equal(sha256(data), p.sha256);
      assert.equal(sha512(data), p.integrity);
      const actual = await archiveInventory(path, p);
      assert.deepEqual(actual.entries, p.entries);
      assert.equal(actual.manifest.name, p.name);
      assert.equal(actual.manifest.version, "0.1.0");
      const legal = packed.runtimeNotices.find((notice) => notice.package === p.sourceName);
      assert.ok(legal);
      const entries = new Map(p.entries.map((entry) => [entry.path, entry]));
      for (const file of legal.files) assert.deepEqual(entries.get(file.path), file);
      assert.ok(p.entries.some((e) => e.path === "THIRD_PARTY_NOTICES.md"));
      assert.equal(
        p.entries.some(
          (e) =>
            !e.path.startsWith("node_modules/") &&
            (e.path.startsWith("src/") ||
              (e.path.endsWith(".map") && !e.path.startsWith("worker-assets/"))),
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

test("large SEA exception rejects another role/path, changed bytes and aggregate overflow", {
  timeout: 60000,
}, async () => {
  const directory = await mkdtemp(resolve(await realpath(tmpdir()), "fortipi-sea-bound-"));
  const local = "worker-assets/linux/container/computerd";
  const original = resolve(repository, "packages/fortipi-cli", local);
  const assets = object(
    await readJson(resolve(repository, "packages/fortipi-cli/worker-assets/asset-manifest.json")),
  );
  assert.ok(Array.isArray(assets.files));
  const asset = assets.files.map(object).find((entry) => entry.path === local.slice(14));
  assert.ok(asset);
  const freeze = object(
    await readJson(resolve(repository, "apps/worker/container/embedded-freeze.json")),
  );
  assert.equal(asset.sha256, freeze.binarySha256);
  assert.equal((await lstat(original)).size, asset.size);
  assert.ok(Number(asset.size) > 32_000_000);
  const name = "@fortipi-ci-test/fortipi-cli";
  const manifest = JSON.stringify({ name, version: "0.1.0" });
  const member = resolve(directory, "package", local);
  const archive = resolve(directory, "counter.tar");
  const expectedSea = {
    path: local,
    size: Number(asset.size),
    mode: 0o644,
    sha256: String(asset.sha256),
  };
  const expected = {
    name,
    sourceName: "fortipi-cli",
    entries: [expectedSea],
  };
  const pack = () => createTar({ cwd: directory, file: archive }, ["package"]);
  try {
    await mkdir(resolve(member, ".."), { recursive: true });
    await copyFile(original, member, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    await writeFile(resolve(directory, "package/package.json"), manifest);
    await pack();
    await assert.rejects(archiveInventory(archive), /Archive byte bound/);
    await assert.rejects(
      archiveInventory(archive, { ...expected, sourceName: "fortipi-contract" }),
      /Archive byte bound/,
    );
    await assert.rejects(
      archiveInventory(archive, {
        ...expected,
        entries: [{ ...expectedSea, sha256: "0".repeat(64) }],
      }),
      /Unreviewed archive SEA identity/,
    );
    await assert.rejects(
      archiveInventory(archive, {
        ...expected,
        entries: [{ ...expectedSea, size: expectedSea.size + 1 }],
      }),
      /Archive byte bound/,
    );
    await writeFile(
      resolve(directory, "package/package.json"),
      JSON.stringify({ name: "@fortipi-ci-test/fortipi-contract", version: "0.1.0" }),
    );
    await pack();
    await assert.rejects(archiveInventory(archive, expected), /Archive package role differs/);
    await writeFile(resolve(directory, "package/package.json"), manifest);
    await rename(member, `${member}.unknown`);
    await pack();
    await assert.rejects(archiveInventory(archive, expected), /Archive byte bound/);
    await rename(`${member}.unknown`, member);
    const handle = await open(member, "r+");
    try {
      const byte = Buffer.alloc(1);
      await handle.read(byte, 0, 1, 0);
      await handle.write(Buffer.from([(byte[0] ?? 0) ^ 0xff]), 0, 1, 0);
      await pack();
      await assert.rejects(archiveInventory(archive, expected), /Archive SEA hash differs/);
      await handle.write(byte, 0, 1, 0);
    } finally {
      await handle.close();
    }
    // Actual sparse files exercise the existing total bound; each stays within 32MB.
    let remaining = 200_000_001 - Number(asset.size) - Buffer.byteLength(manifest);
    for (let index = 0; remaining > 0; index++) {
      const file = await open(resolve(directory, "package", `padding-${index}`), "wx", 0o600);
      const size = Math.min(32_000_000, remaining);
      try {
        await file.truncate(size);
      } finally {
        await file.close();
      }
      remaining -= size;
    }
    await pack();
    await assert.rejects(archiveInventory(archive, expected), /Archive byte bound/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
