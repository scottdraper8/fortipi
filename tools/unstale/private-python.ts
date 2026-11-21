// Isolate the setup action's interpreter; never change its shared installation.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

export interface PrivatePython {
  root: string;
  treeSha256: string;
}
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const owner = (uid: number) => uid === 0 || uid === process.getuid?.();
const version = "3.15";
const executable = `bin/python${version}`;
const safeName = (name: string) =>
  !name.includes("\\") && [...name].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127);

export async function verifyPrivatePython(runtime: PrivatePython): Promise<string> {
  assert.equal(await realpath(runtime.root), runtime.root, "Private Python root changed");
  const root = await lstat(runtime.root);
  assert.ok(
    root.isDirectory() && root.uid === process.getuid?.() && (root.mode & 0o7777) === 0o700,
    "Private Python root changed",
  );
  const records: unknown[] = [];
  let count = 0,
    bytes = 0;
  const walk = async (local: string): Promise<void> => {
    for (const name of (await readdir(resolve(runtime.root, local))).sort()) {
      assert.ok(safeName(name), "Unsafe Python member");
      assert.ok(++count <= 30000, "Python member bound exceeded");
      const child = local ? `${local}/${name}` : name;
      const path = resolve(runtime.root, child);
      const stat = await lstat(path);
      assert.equal(stat.uid, process.getuid?.(), "Private Python owner changed");
      if (stat.isDirectory()) {
        assert.equal(stat.mode & 0o7777, 0o500, "Private Python directory changed");
        records.push([child, "directory"]);
        await walk(child);
      } else {
        assert.ok(stat.isFile() && stat.nlink === 1, "Private Python member changed");
        bytes += stat.size;
        assert.ok(bytes <= 256 * 1024 * 1024, "Python byte bound exceeded");
        assert.equal(
          stat.mode & 0o7777,
          child === executable ? 0o500 : 0o400,
          "Private Python mode changed",
        );
        records.push([child, hash(await readFile(path))]);
      }
    }
  };
  await walk("");
  const actual = hash(JSON.stringify(records));
  if (runtime.treeSha256) assert.equal(actual, runtime.treeSha256, "Private Python tree changed");
  return actual;
}

export async function removePrivatePython(root: string): Promise<void> {
  const walk = async (path: string): Promise<void> => {
    if (!(await lstat(path)).isDirectory()) return;
    await chmod(path, 0o700);
    for (const name of await readdir(path)) await walk(resolve(path, name));
  };
  await walk(root);
  await rm(root, { recursive: true, force: true });
}

/** Source trust is the pinned setup action; this adds isolation, not publisher authentication. */
export async function copyPrivatePython(input: string, parent: string): Promise<PrivatePython> {
  const binary = await realpath(input);
  assert.equal(basename(binary), `python${version}`, "Unsupported bootstrap Python layout");
  assert.equal(basename(dirname(binary)), "bin", "Unsupported bootstrap Python layout");
  const prefix = dirname(dirname(binary));
  const sourceRoot = await lstat(prefix);
  assert.ok(sourceRoot.isDirectory() && owner(sourceRoot.uid), "Unowned bootstrap Python");
  const root = await mkdtemp(resolve(await realpath(parent), "python-"));
  await chmod(root, 0o700);
  let bytes = 0,
    count = 0;
  const copy = async (source: string, local: string): Promise<void> => {
    assert.ok(++count <= 30000, "Python member bound exceeded");
    let stat = await lstat(source);
    if (stat.isSymbolicLink()) {
      const target = await realpath(source);
      assert.ok(
        target.startsWith(`${prefix}/`),
        "Bootstrap Python links or special members are unsupported",
      );
      source = target;
      stat = await lstat(source);
      assert.ok(stat.isFile(), "Bootstrap Python links or special members are unsupported");
    }
    assert.ok(owner(stat.uid), "Unowned bootstrap Python member");
    const target = resolve(root, local);
    if (stat.isDirectory()) {
      await mkdir(target, { recursive: true, mode: 0o700 });
      for (const name of (await readdir(source)).sort()) {
        assert.ok(safeName(name), "Unsafe Python member");
        if (name === "site-packages" || name === "__pycache__") continue;
        await copy(resolve(source, name), `${local}/${name}`);
      }
      await chmod(target, 0o500);
    } else {
      assert.ok(stat.isFile(), "Bootstrap Python links or special members are unsupported");
      bytes += stat.size;
      assert.ok(bytes <= 256 * 1024 * 1024, "Python byte bound exceeded");
      const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
      let data: Buffer;
      try {
        const before = await file.stat();
        assert.deepEqual(
          [before.dev, before.ino, before.size, before.mtimeMs],
          [stat.dev, stat.ino, stat.size, stat.mtimeMs],
          "Bootstrap Python changed during copy",
        );
        data = await file.readFile();
        const after = await file.stat();
        assert.deepEqual(
          [after.dev, after.ino, after.size, after.mtimeMs],
          [stat.dev, stat.ino, stat.size, stat.mtimeMs],
          "Bootstrap Python changed during copy",
        );
      } finally {
        await file.close();
      }
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, data, { flag: "wx", mode: local === executable ? 0o500 : 0o400 });
    }
  };
  try {
    await copy(binary, executable);
    await copy(resolve(prefix, `lib/python${version}`), `lib/python${version}`);
    await copy(resolve(prefix, `lib/libpython${version}.so.1.0`), `lib/libpython${version}.so.1.0`);
    await chmod(resolve(root, "bin"), 0o500);
    await chmod(resolve(root, "lib"), 0o500);
    const runtime = { root, treeSha256: "" };
    runtime.treeSha256 = await verifyPrivatePython(runtime);
    return runtime;
  } catch (error) {
    await removePrivatePython(root).catch(() => {});
    throw error;
  }
}
