import assert from "node:assert/strict";
import { lstat, readdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type FileRecord,
  packageEntryPath,
  regularBytes,
  sha256,
} from "../../scripts/verify-release-gates.ts";

/** Installed package addresses include bundled node_modules. Their exact
 * namespace comes from the authenticated package, not artifact path rules. */
export async function installedPackageInventory(
  root: string,
  expected: readonly FileRecord[],
): Promise<FileRecord[]> {
  assert.equal(await realpath(root), root);
  const files = new Map(expected.map((file) => [packageEntryPath(file.path), file]));
  assert.equal(files.size, expected.length);
  const directories = new Set<string>([""]);
  for (const path of files.keys()) {
    const parts = path.split("/");
    while (parts.length > 1) {
      parts.pop();
      directories.add(parts.join("/"));
    }
  }
  const actual: FileRecord[] = [];
  async function walk(path: string): Promise<void> {
    assert.ok(files.has(path) || directories.has(path), "Unexpected installed package member");
    const absolute = resolve(root, path);
    const stat = await lstat(absolute);
    assert.ok(!stat.isSymbolicLink(), "Linked installed package entry");
    assert.equal(stat.mode & 0o222, 0, "Installed package must remain read-only");
    if (stat.isDirectory()) {
      assert.ok(directories.has(path), "Unexpected installed package directory");
      for (const name of (await readdir(absolute)).sort())
        await walk(path ? `${path}/${name}` : name);
    } else {
      const saved = files.get(path);
      assert.ok(saved && stat.isFile() && stat.nlink === 1, "Unexpected installed package member");
      assert.equal(stat.size, saved.size);
      assert.equal(Boolean(stat.mode & 0o111), Boolean(saved.mode & 0o111));
      const hash = sha256(await regularBytes(absolute, saved.size));
      assert.equal(hash, saved.sha256, "Installed package bytes changed");
      actual.push({ path, mode: stat.mode & 0o777, size: stat.size, sha256: hash });
    }
  }
  await walk("");
  assert.deepEqual(
    actual.map((file) => file.path).sort(),
    [...files.keys()].sort(),
    "Missing installed package member",
  );
  return actual.sort((a, b) => a.path.localeCompare(b.path, "en"));
}
