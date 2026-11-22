import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { safePath } from "../../scripts/verify-release-gates.ts";
import { installedPackageInventory } from "./installed-inventory.ts";

test("installed inventory accepts authenticated bundled dependencies while rejecting hidden or changed physical members", async () => {
  const root = await mkdtemp(resolve(await realpath(tmpdir()), "fortipi-installed-inventory-"));
  const hardlink = `${root}.linked-member`;
  const nested = resolve(root, "node_modules/ajv");
  await mkdir(nested, { recursive: true });
  const files = [
    { path: "package.json", bytes: Buffer.from('{"name":"synthetic-owned"}\n'), mode: 0o644 },
    { path: "node_modules/ajv/package.json", bytes: Buffer.from('{"name":"ajv"}\n'), mode: 0o644 },
    { path: "bin.js", bytes: Buffer.from("#!/usr/bin/env node\n"), mode: 0o755 },
  ] as const;
  const expected = files.map((file) => ({
    path: file.path,
    mode: file.mode,
    size: file.bytes.length,
    sha256: createHash("sha256").update(file.bytes).digest("hex"),
  }));
  for (const file of files) {
    await writeFile(resolve(root, file.path), file.bytes);
    await chmod(resolve(root, file.path), file.mode & 0o111 ? 0o555 : 0o444);
  }
  const directories = [root, resolve(root, "node_modules"), nested];
  for (const directory of directories) await chmod(directory, 0o555);
  try {
    assert.throws(
      () => safePath("node_modules/ajv/package.json"),
      "Generic artifact policy remains strict",
    );
    const original = await installedPackageInventory(root, expected);
    assert.deepEqual(
      original.files.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 })),
      [...expected]
        .sort((a, b) => a.path.localeCompare(b.path, "en"))
        .map(({ path, size, sha256 }) => ({ path, size, sha256 })),
    );
    const unknown = resolve(root, "hidden.js");
    await chmod(root, 0o700);
    await writeFile(unknown, "hidden", { mode: 0o444 });
    await chmod(root, 0o555);
    await assert.rejects(
      installedPackageInventory(root, expected),
      /Unexpected installed package member/,
    );
    await chmod(root, 0o700);
    await rm(unknown);
    await mkdir(resolve(root, "empty"), { mode: 0o555 });
    await chmod(root, 0o555);
    await assert.rejects(
      installedPackageInventory(root, expected),
      /Unexpected installed package member/,
    );
    await chmod(root, 0o700);
    await rm(resolve(root, "empty"), { recursive: true });
    await chmod(root, 0o555);
    const target = resolve(nested, "package.json");
    await chmod(target, 0o644);
    await assert.rejects(installedPackageInventory(root, expected), /read-only/);
    await writeFile(target, Buffer.from('{"name":"bad"}\n'));
    await chmod(target, 0o444);
    await assert.rejects(installedPackageInventory(root, expected), /bytes changed/);
    await chmod(target, 0o644);
    await writeFile(target, files[1].bytes);
    await chmod(target, 0o444);
    await link(target, hardlink);
    await assert.rejects(installedPackageInventory(root, expected));
    await rm(hardlink);
    await chmod(nested, 0o700);
    await rm(target);
    await symlink(resolve(root, "package.json"), target);
    await chmod(nested, 0o555);
    await assert.rejects(installedPackageInventory(root, expected), /Linked installed/);
    await chmod(nested, 0o700);
    await rm(target);
    await writeFile(target, files[1].bytes, { mode: 0o444 });
    await chmod(nested, 0o555);
    assert.deepEqual(await installedPackageInventory(root, expected), original);
  } finally {
    await rm(hardlink, { force: true });
    for (const directory of directories) await chmod(directory, 0o700);
    await rm(root, { recursive: true, force: true });
  }
});

test("only package-declared bin links to authenticated executable bytes join the installed inventory", async () => {
  const root = await mkdtemp(resolve(await realpath(tmpdir()), "fortipi-installed-bins-"));
  const module = resolve(root, "node_modules/declared"),
    bins = resolve(root, "node_modules/.bin");
  await mkdir(resolve(module, "bin"), { recursive: true });
  await mkdir(bins);
  const members = [
    {
      path: "node_modules/declared/package.json",
      bytes: Buffer.from('{"name":"declared","bin":{"run-tool":"./bin/run.js"}}\n'),
      mode: 0o644,
    },
    {
      path: "node_modules/declared/bin/run.js",
      bytes: Buffer.from("#!/usr/bin/env node\n"),
      mode: 0o755,
    },
  ];
  const expected = members.map((file) => ({
    path: file.path,
    mode: file.mode,
    size: file.bytes.length,
    sha256: createHash("sha256").update(file.bytes).digest("hex"),
  }));
  for (const file of members) {
    await writeFile(resolve(root, file.path), file.bytes);
    await chmod(resolve(root, file.path), file.mode & 0o111 ? 0o555 : 0o444);
  }
  const command = resolve(bins, "run-tool");
  await symlink("../declared/bin/run.js", command);
  const directories = [root, resolve(root, "node_modules"), module, resolve(module, "bin"), bins];
  for (const path of directories) await chmod(path, 0o555);
  try {
    const original = await installedPackageInventory(root, expected);
    assert.equal(original.files.length, 2);
    assert.deepEqual(original.binLinks, [
      {
        path: "node_modules/.bin/run-tool",
        target: "node_modules/declared/bin/run.js",
        relativeTarget: "../declared/bin/run.js",
        manifest: "node_modules/declared/package.json",
        manifestSha256: expected[0]?.sha256,
        targetSha256: expected[1]?.sha256,
      },
    ]);
    await chmod(bins, 0o755);
    await assert.rejects(installedPackageInventory(root, expected), /read-only/);
    await chmod(bins, 0o555);
    await chmod(bins, 0o700);
    await rm(command);
    await symlink("../declared/package.json", command);
    await chmod(bins, 0o555);
    await assert.rejects(installedPackageInventory(root, expected), /bin target changed/);
    await chmod(bins, 0o700);
    await rm(command);
    await writeFile(command, "replacement shim", { mode: 0o555 });
    await chmod(bins, 0o555);
    await assert.rejects(installedPackageInventory(root, expected), /exact declared link/);
    await chmod(bins, 0o700);
    await rm(command);
    await symlink("../declared/bin/run.js", command);
    await symlink("../declared/bin/run.js", resolve(bins, "undeclared-alias"));
    await chmod(bins, 0o555);
    await assert.rejects(installedPackageInventory(root, expected), /Unexpected installed package/);
    await chmod(bins, 0o700);
    await rm(resolve(bins, "undeclared-alias"));
    await rm(command);
    await chmod(bins, 0o555);
    await assert.rejects(installedPackageInventory(root, expected), /Missing installed bin link/);
    await chmod(bins, 0o700);
    await symlink("../declared/bin/run.js", command);
    await chmod(bins, 0o555);
    assert.deepEqual(await installedPackageInventory(root, expected), original);
  } finally {
    for (const directory of directories) await chmod(directory, 0o700);
    await rm(root, { recursive: true, force: true });
  }
});
