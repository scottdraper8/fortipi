import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { Header } from "tar";
import {
  mesonFailure,
  mesonFiles,
  mesonPin,
  pythonIdentity,
  verifyMesonTree,
} from "./provision-meson.ts";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const source = new Map([
  ["meson.py", Buffer.from("#!/usr/bin/env python3\n# synthetic, never executed\n")],
  ["COPYING", Buffer.from("synthetic license fixture\n")],
  ["mesonbuild/__init__.py", Buffer.alloc(0)],
  ["mesonbuild/mesonmain.py", Buffer.from("# synthetic package fixture\n")],
]);
const prefix = `meson-${mesonPin.source}/`;
type Member = { path: string; type?: "File" | "SymbolicLink" | "Link" | "FIFO"; linkpath?: string };
function archive(extra: Member[] = []) {
  const blocks: Buffer[] = [];
  const add = (member: Member, body = Buffer.alloc(0)) => {
    const header = new Header({ mode: 0o644, type: "File", size: body.length, ...member });
    const block = Buffer.alloc(512);
    assert.equal(header.encode(block), false);
    blocks.push(block, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  };
  for (const [name, bytes] of source) add({ path: `${prefix}${name}` }, bytes);
  for (const member of extra) add(member);
  const raw = gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
  return {
    raw,
    pin: {
      ...mesonPin,
      sourceArchiveSha256: hash(raw),
      entrypointSha256: hash(source.get("meson.py") ?? Buffer.alloc(0)),
      licenseSha256: hash(source.get("COPYING") ?? Buffer.alloc(0)),
    },
  };
}

test("authenticate bytes before parsing; extract only safe package files", async () => {
  // This fixture tests extraction policy, not publisher authenticity. Real upstream execution
  // is a separate check against the committed, immutable archive pin.
  const good = archive([
    { path: `${prefix}tests/link`, type: "SymbolicLink", linkpath: "../fixture" },
  ]);
  assert.deepEqual(await mesonFiles(good.raw, good.pin), source);
  const tampered = Buffer.from(good.raw);
  tampered[0] = 0;
  await assert.rejects(mesonFiles(tampered, good.pin), /archive identity changed/);
  for (const member of [
    { path: `${prefix}../escape` },
    { path: "/absolute" },
    { path: `${prefix}mesonbuild\\escape` },
    { path: `${prefix}meson.py` },
    { path: `${prefix}mesonbuild/link`, type: "SymbolicLink", linkpath: "../COPYING" },
    { path: `${prefix}mesonbuild/hard`, type: "Link", linkpath: `${prefix}COPYING` },
    { path: `${prefix}ignored/fifo`, type: "FIFO" },
    { path: `${prefix}tests/link`, type: "SymbolicLink", linkpath: "../../escape" },
  ] satisfies Member[]) {
    const bad = archive([member]);
    await assert.rejects(
      mesonFiles(bad.raw, bad.pin),
      /(?:Unsafe|Unsupported) Meson archive member/,
    );
  }
});

test("reverification rejects source tampering, extra imports, changed launch links and public roots", async () => {
  const parent = resolve("dist/meson-fixtures");
  await mkdir(parent, { recursive: true });
  const directory = await realpath(await mkdtemp(resolve(parent, "tree-")));
  const bin = resolve(directory, "bin");
  const tree = resolve(directory, "source");
  const packageDirectory = resolve(tree, "mesonbuild");
  // Python is only a link identity in this test; no synthetic source is executed.
  const python = await realpath(process.execPath);
  try {
    await chmod(directory, 0o700);
    await mkdir(bin, { mode: 0o700 });
    for (const [name, bytes] of source) {
      await mkdir(dirname(resolve(tree, name)), { recursive: true, mode: 0o700 });
      await writeFile(resolve(tree, name), bytes, { mode: name === "meson.py" ? 0o500 : 0o400 });
    }
    await symlink("../source/meson.py", resolve(bin, "meson"));
    await symlink(python, resolve(bin, "python3"));
    for (const path of [bin, tree, packageDirectory]) await chmod(path, 0o500);
    const verify = () => verifyMesonTree(directory, source, python);
    await verify();

    const entrypoint = resolve(tree, "meson.py");
    await chmod(entrypoint, 0o700);
    await writeFile(entrypoint, "tampered\n");
    await chmod(entrypoint, 0o500);
    await assert.rejects(verify(), /Meson source changed/);
    await chmod(entrypoint, 0o700);
    await writeFile(entrypoint, source.get("meson.py") ?? Buffer.alloc(0));
    await chmod(entrypoint, 0o500);

    await chmod(packageDirectory, 0o700);
    const extra = resolve(packageDirectory, "shadow.py");
    await writeFile(extra, "# extra import\n", { mode: 0o400 });
    await chmod(packageDirectory, 0o500);
    await assert.rejects(verify(), /Unexpected Meson source member/);
    await chmod(packageDirectory, 0o700);
    await unlink(extra);
    const module = resolve(packageDirectory, "mesonmain.py");
    await unlink(module);
    await symlink("../COPYING", module);
    await chmod(packageDirectory, 0o500);
    await assert.rejects(verify(), /private filesystem identity changed/);
    await chmod(packageDirectory, 0o700);
    await unlink(module);
    await writeFile(module, source.get("mesonbuild/mesonmain.py") ?? Buffer.alloc(0), {
      mode: 0o400,
    });
    await chmod(packageDirectory, 0o500);

    for (const [name, original] of [
      ["meson", "../source/meson.py"],
      ["python3", python],
    ]) {
      assert.ok(name && original);
      await chmod(bin, 0o700);
      await unlink(resolve(bin, name));
      await symlink("/unrelated/tool", resolve(bin, name));
      await chmod(bin, 0o500);
      await assert.rejects(verify(), /Meson launch target changed/);
      await chmod(bin, 0o700);
      await unlink(resolve(bin, name));
      await symlink(original, resolve(bin, name));
      await chmod(bin, 0o500);
    }
    await chmod(directory, 0o755);
    await assert.rejects(verify(), /private filesystem identity changed/);
    await chmod(directory, 0o700);
    await verify();
  } finally {
    for (const path of [directory, bin, tree, packageDirectory]) await chmod(path, 0o700);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Python identity changes fail before execution and child failures remain bounded", async () => {
  await assert.rejects(pythonIdentity("python3"), /Explicit absolute Python path required/);
  const path = await realpath(process.execPath);
  const expected = { path, sha256: "0".repeat(64), version: "3.15.2" };
  await assert.rejects(pythonIdentity(path, expected), /Python identity changed/);
  // A real executable of the wrong kind must not inherit an ambient Python fallback;
  // its raw stderr/error object is never surfaced.
  await assert.rejects(
    pythonIdentity(path, { ...expected, sha256: hash(await readFile(path)) }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Meson provisioner: tool failed or timed out");
      assert.deepEqual(mesonFailure(error), {
        probe: "meson-provisioning",
        passed: false,
        reason: "tool",
        operation: "python",
        kind: "nonzero",
      });
      for (const key of ["stderr", "stdout", "actual", "expected", "cause"])
        assert.equal(Object.hasOwn(error, key), false);
      return true;
    },
  );
  const canary = "PRIVATE_MESON_ERROR_CANARY_53a9";
  const foreign = Object.assign(new Error(canary, { cause: canary }), {
    kind: canary,
    operation: canary,
    stderr: canary,
    actual: canary,
  });
  assert.deepEqual(mesonFailure(foreign), {
    probe: "meson-provisioning",
    passed: false,
    reason: "unknown",
  });
  assert.equal(JSON.stringify(mesonFailure(foreign)).includes(canary), false);
});
