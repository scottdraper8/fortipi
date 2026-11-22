import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { copyPrivatePython, removePrivatePython, verifyPrivatePython } from "./private-python.ts";
import { pythonIdentity } from "./provision-meson.ts";

test("a world-writable setup tree is copied privately without changing or executing it; stdlib tampering and source links fail", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "fortipi-private-python-"));
  const prefix = resolve(directory, "setup");
  const binary = resolve(prefix, "bin/python3.15");
  const module = "lib/python3.15/os.py";
  const library = "lib/libpython3.15.so.1.0";
  let copied: string | undefined;
  try {
    for (const [name, text] of [
      ["bin/python3.15", "not executable Python; this test must never execute it"],
      [module, "synthetic standard library"],
      [library, "synthetic shared library"],
      ["lib/python3.15/site-packages/sitecustomize.py", "ambient import must be absent"],
    ]) {
      assert.ok(name && text);
      await mkdir(resolve(prefix, name, ".."), { recursive: true });
      await writeFile(resolve(prefix, name), text);
      await chmod(resolve(prefix, name), 0o777);
    }
    const original = await readFile(binary);
    await symlink("os.py", resolve(prefix, "lib/python3.15/alias.py"));
    const runtime = await copyPrivatePython(binary, directory);
    copied = runtime.root;
    assert.equal((await lstat(binary)).mode & 0o777, 0o777);
    assert.deepEqual(await readFile(binary), original);
    assert.equal((await lstat(resolve(runtime.root, "bin/python3.15"))).mode & 0o777, 0o500);
    assert.equal((await lstat(resolve(runtime.root, module))).mode & 0o777, 0o400);
    await assert.rejects(lstat(resolve(runtime.root, "lib/python3.15/site-packages")), {
      code: "ENOENT",
    });
    await verifyPrivatePython(runtime);
    assert.equal((await lstat(resolve(runtime.root, "lib/python3.15/alias.py"))).isFile(), true);
    assert.equal(
      await readFile(resolve(runtime.root, "lib/python3.15/alias.py"), "utf8"),
      "synthetic standard library",
    );
    const changed = resolve(runtime.root, module);
    await chmod(changed, 0o600);
    await writeFile(changed, "changed after isolation");
    await chmod(changed, 0o400);
    // This must reject the imported-code identity before attempting to run the
    // deliberately invalid interpreter, not merely compare its version later.
    await assert.rejects(
      pythonIdentity(resolve(runtime.root, "bin/python3.15"), undefined, runtime),
      /Private Python tree changed/,
    );
    const outside = resolve(directory, "outside.py");
    await writeFile(outside, "outside source prefix");
    await symlink(outside, resolve(prefix, "lib/python3.15/escape.py"));
    await assert.rejects(copyPrivatePython(binary, directory), /links or special members/);
  } finally {
    if (copied) await removePrivatePython(copied);
    await rm(directory, { recursive: true, force: true });
  }
});
