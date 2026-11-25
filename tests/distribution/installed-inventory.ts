import assert from "node:assert/strict";
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { posix, resolve } from "node:path";
import {
  type FileRecord,
  packageEntryPath,
  regularBytes,
  sha256,
} from "../../scripts/verify-release-gates.ts";
import {
  type DistributionInventoryCheck,
  observeDistributionInventoryFailure,
} from "../clients/native-evidence-observation.ts";
import { type WindowsBinEntrypoint, windowsBinEntrypoints } from "./windows-bin-entrypoints.ts";

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
  packageName?: unknown,
): Promise<{ files: FileRecord[]; binLinks: InstalledBinLink[]; binEntries: FileRecord[] }> {
  let check: DistributionInventoryCheck = "root-realpath";
  try {
    assert.equal(await realpath(root), root);
    check = "expected-paths";
    const files = new Map(expected.map((file) => [packageEntryPath(file.path), file]));
    check = "expected-unique";
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
    const binPackages = new Map<string, string>();
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
      check = "manifest-link";
      assert.ok(!(await lstat(manifestPath)).isSymbolicLink(), "Linked installed package entry");
      check = "manifest-read";
      const bytes = await regularBytes(manifestPath, record.size);
      check = "manifest-size";
      assert.equal(bytes.length, record.size);
      check = "manifest-hash";
      assert.equal(sha256(bytes), record.sha256, "Installed package bytes changed (bin manifest)");
      check = "manifest-json";
      const pkg: { name?: unknown; bin?: unknown } = JSON.parse(bytes.toString("utf8"));
      if (pkg.bin === undefined) continue;
      const declared =
        typeof pkg.bin === "string"
          ? { [typeof pkg.name === "string" ? posix.basename(pkg.name) : ""]: pkg.bin }
          : pkg.bin;
      check = "bin-shape";
      assert.ok(declared && typeof declared === "object" && !Array.isArray(declared));
      for (const [command, entry] of Object.entries(declared)) {
        check = "bin-name";
        assert.match(command, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
        check = "bin-entry";
        assert.ok(
          typeof entry === "string" &&
            entry.length > 0 &&
            !entry.includes("\\") &&
            !posix.isAbsolute(entry),
        );
        const packageRoot = posix.dirname(path);
        const target = posix.normalize(`${packageRoot}/${entry}`);
        check = "bin-confined";
        assert.ok(target.startsWith(`${packageRoot}/`));
        const file = files.get(target);
        check = "bin-authenticated-target";
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
        check = "bin-unique";
        assert.ok(!bins.has(binPath), "Ambiguous installed bin declaration");
        bins.set(binPath, plan);
        if (process.platform === "win32") {
          check = "bin-shape";
          assert.equal(
            typeof pkg.name,
            "string",
            "Windows bin needs its authenticated package name",
          );
          binPackages.set(binPath, pkg.name as string);
        }
        directories.add(binDirectory);
      }
    }
    const windowsBins = new Map<string, { plan: InstalledBinLink; suffix: string }>();
    if (process.platform === "win32") {
      for (const plan of bins.values()) {
        for (const suffix of ["", ".cmd", ".ps1"]) {
          const path = plan.path + suffix;
          check = "bin-unique";
          assert.ok(!windowsBins.has(path), "Ambiguous installed bin declaration");
          windowsBins.set(path, { plan, suffix });
        }
      }
    }
    const actual: FileRecord[] = [];
    const binEntries: FileRecord[] = [];
    const windowsBodies = new Map<string, WindowsBinEntrypoint[]>();
    const windowsSeen = new Map<string, Set<string>>();
    const binLinks: InstalledBinLink[] = [];
    check = "root-stat";
    const owner = (await lstat(root)).uid;
    async function walk(path: string): Promise<void> {
      check = "member-namespace";
      assert.ok(
        files.has(path) || directories.has(path) || bins.has(path) || windowsBins.has(path),
        "Unexpected installed package member",
      );
      const absolute = resolve(root, path);
      check = "member-stat";
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) {
        const plan = bins.get(path);
        check = "link-declaration";
        assert.ok(plan, "Linked installed package entry");
        check = "link-count";
        assert.equal(stat.nlink, 1);
        check = "link-owner";
        assert.equal(stat.uid, owner);
        check = "link-read";
        const linkTarget = await readlink(absolute);
        check = "link-target";
        assert.equal(
          process.platform === "win32" ? linkTarget.replaceAll("\\", "/") : linkTarget,
          plan.relativeTarget,
          "Installed bin target changed",
        );
        check = "link-realpath";
        assert.equal(await realpath(absolute), resolve(root, plan.target));
        binLinks.push(plan);
        return;
      }
      const windowsBin = windowsBins.get(path);
      check = "bin-link-required";
      assert.ok(!bins.has(path) || windowsBin, "Generated bin must be its exact declared link");
      check = "readonly";
      assert.equal(stat.mode & 0o222, 0, "Installed package must remain read-only");
      if (stat.isDirectory()) {
        check = "directory-namespace";
        assert.ok(directories.has(path), "Unexpected installed package directory");
        check = "directory-read";
        for (const name of (await readdir(absolute)).sort())
          await walk(path ? `${path}/${name}` : name);
      } else {
        if (windowsBin) {
          const { plan, suffix } = windowsBin;
          check = "regular-file";
          assert.ok(stat.isFile() && stat.nlink === 1, "Unexpected installed package member");
          check = "link-owner";
          assert.equal(stat.uid, owner);
          let bodies = windowsBodies.get(plan.path);
          if (!bodies) {
            const targetPath = resolve(root, plan.target),
              target = files.get(plan.target);
            check = "bin-authenticated-target";
            assert.ok(target && (target.mode & 0o111) !== 0);
            const targetStat = await lstat(targetPath);
            assert.ok(
              targetStat.isFile() && !targetStat.isSymbolicLink() && targetStat.nlink === 1,
            );
            check = "link-realpath";
            assert.equal(await realpath(targetPath), targetPath);
            check = "file-read";
            const targetBytes = await regularBytes(targetPath, target.size);
            check = "file-size";
            assert.equal(targetBytes.length, target.size);
            check = "file-hash";
            assert.equal(sha256(targetBytes), target.sha256, "Installed bin target bytes changed");
            check = "bin-link-required";
            const declaredPackage = binPackages.get(plan.path);
            assert.equal(typeof declaredPackage, "string");
            bodies = windowsBinEntrypoints(
              targetPath,
              resolve(root, plan.path),
              targetBytes,
              declaredPackage as string,
            );
            windowsBodies.set(plan.path, bodies);
          }
          const body = bodies.find((entry) => entry.suffix === suffix);
          check = "bin-link-required";
          assert.ok(body, "Unsupported installed bin representation");
          check = "file-size";
          assert.equal(
            stat.size,
            body.bytes.length,
            "Generated bin must be its exact declared link or pinned Windows shim",
          );
          check = "file-read";
          const bytes = await regularBytes(absolute, body.bytes.length);
          check = "file-hash";
          assert.ok(
            bytes.equals(body.bytes),
            "Generated bin must be its exact declared link or pinned Windows shim",
          );
          const seen = windowsSeen.get(plan.path) ?? new Set<string>();
          seen.add(suffix);
          windowsSeen.set(plan.path, seen);
          binEntries.push({
            path,
            mode: stat.mode & 0o777,
            size: stat.size,
            sha256: sha256(bytes),
          });
          // Archived .bin members keep their independent original byte closure.
          if (!files.has(path)) return;
        }
        const saved = files.get(path);
        check = "regular-file";
        assert.ok(
          saved && stat.isFile() && stat.nlink === 1,
          "Unexpected installed package member",
        );
        check = "file-size";
        assert.equal(stat.size, saved.size);
        // Windows stat has no Unix execute bits; installed public bins are exercised separately.
        check = "file-executable";
        if (process.platform !== "win32")
          assert.equal(
            Boolean(stat.mode & 0o111),
            Boolean(saved.mode & 0o111),
            "Installed executable mode differs from archive intent",
          );
        check = "file-read";
        const hash = sha256(await regularBytes(absolute, saved.size));
        check = "file-hash";
        assert.equal(hash, saved.sha256, "Installed package bytes changed");
        actual.push({ path, mode: stat.mode & 0o777, size: stat.size, sha256: hash });
      }
    }
    await walk("");
    check = "complete-files";
    assert.deepEqual(
      actual.map((file) => file.path).sort(),
      [...files.keys()].sort(),
      "Missing installed package member",
    );
    check = "complete-bins";
    const linkedPaths = new Set(binLinks.map((link) => link.path));
    for (const [path, seen] of windowsSeen) {
      assert.ok(!linkedPaths.has(path), "Mixed installed bin representations");
      assert.deepEqual([...seen].sort(), ["", ".cmd", ".ps1"], "Missing installed bin link");
      const plan = bins.get(path);
      assert.ok(plan);
      binLinks.push(plan);
    }
    assert.deepEqual(
      binLinks.map((link) => link.path).sort(),
      [...bins.keys()].sort(),
      "Missing installed bin link",
    );
    return {
      files: actual.sort((a, b) => a.path.localeCompare(b.path, "en")),
      binLinks: binLinks.sort((a, b) => a.path.localeCompare(b.path, "en")),
      binEntries: binEntries.sort((a, b) => a.path.localeCompare(b.path, "en")),
    };
  } catch (error) {
    observeDistributionInventoryFailure(check, packageName, error);
    throw error;
  }
}
