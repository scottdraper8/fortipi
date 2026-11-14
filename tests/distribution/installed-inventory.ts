import assert from "node:assert/strict";
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { posix, resolve } from "node:path";
import {
  type FileRecord,
  packageEntryPath,
  regularBytes,
  sha256,
} from "../../scripts/verify-release-gates.ts";

/** Installed package addresses include bundled node_modules. Their exact
 * namespace comes from the authenticated package, not artifact path rules. */
export interface InstalledBinLink {
  path: string;
  target: string;
  relativeTarget: string;
  manifest: string;
  manifestSha256: string;
  targetSha256: string;
}
export async function installedPackageInventory(
  root: string,
  expected: readonly FileRecord[],
): Promise<{ files: FileRecord[]; binLinks: InstalledBinLink[] }> {
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
  const bins = new Map<string, InstalledBinLink>();
  for (const [path, record] of files) {
    if (!path.endsWith("/package.json")) continue;
    const parts = path.split("/"),
      at = parts.lastIndexOf("node_modules");
    if (at < 0) continue;
    const tail = parts.slice(at + 1, -1);
    if (
      !(tail.length === 1 && !tail[0]?.startsWith("@")) &&
      !(tail.length === 2 && tail[0]?.startsWith("@"))
    )
      continue;
    const manifestPath = resolve(root, path);
    assert.ok(!(await lstat(manifestPath)).isSymbolicLink(), "Linked installed package entry");
    const bytes = await regularBytes(manifestPath, record.size);
    assert.equal(bytes.length, record.size);
    assert.equal(sha256(bytes), record.sha256, "Installed package bytes changed (bin manifest)");
    const pkg: { name?: unknown; bin?: unknown } = JSON.parse(bytes.toString("utf8"));
    if (pkg.bin === undefined) continue;
    const declared =
      typeof pkg.bin === "string"
        ? { [typeof pkg.name === "string" ? posix.basename(pkg.name) : ""]: pkg.bin }
        : pkg.bin;
    assert.ok(declared && typeof declared === "object" && !Array.isArray(declared));
    for (const [command, entry] of Object.entries(declared)) {
      assert.match(command, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
      assert.ok(
        typeof entry === "string" &&
          entry.length > 0 &&
          !entry.includes("\\") &&
          !posix.isAbsolute(entry),
      );
      const packageRoot = posix.dirname(path);
      const target = posix.normalize(`${packageRoot}/${entry}`);
      assert.ok(target.startsWith(`${packageRoot}/`));
      const file = files.get(target);
      assert.ok(
        file && (file.mode & 0o111) !== 0,
        "Bin target must be an authenticated executable",
      );
      const binDirectory = [...parts.slice(0, at + 1), ".bin"].join("/");
      const binPath = `${binDirectory}/${command}`;
      const plan = {
        path: binPath,
        target,
        relativeTarget: posix.relative(binDirectory, target),
        manifest: path,
        manifestSha256: record.sha256,
        targetSha256: file.sha256,
      };
      assert.ok(!bins.has(binPath), "Ambiguous installed bin declaration");
      bins.set(binPath, plan);
      directories.add(binDirectory);
    }
  }
  const actual: FileRecord[] = [];
  const binLinks: InstalledBinLink[] = [];
  const owner = (await lstat(root)).uid;
  async function walk(path: string): Promise<void> {
    assert.ok(
      files.has(path) || directories.has(path) || bins.has(path),
      "Unexpected installed package member",
    );
    const absolute = resolve(root, path);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) {
      const plan = bins.get(path);
      assert.ok(plan, "Linked installed package entry");
      assert.equal(stat.nlink, 1);
      assert.equal(stat.uid, owner);
      assert.equal(await readlink(absolute), plan.relativeTarget, "Installed bin target changed");
      assert.equal(await realpath(absolute), resolve(root, plan.target));
      binLinks.push(plan);
      return;
    }
    assert.ok(!bins.has(path), "Generated bin must be its exact declared link");
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
  assert.deepEqual(
    binLinks.map((link) => link.path).sort(),
    [...bins.keys()].sort(),
    "Missing installed bin link",
  );
  return {
    files: actual.sort((a, b) => a.path.localeCompare(b.path, "en")),
    binLinks: binLinks.sort((a, b) => a.path.localeCompare(b.path, "en")),
  };
}
