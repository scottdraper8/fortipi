import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { inventory, regularBytes } from "../../verify-release-gates.ts";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function fixture() {
  const root = await mkdtemp(resolve(await realpath(tmpdir()), "fortipi-artifact-inventory-"));
  return { root, close: () => rm(root, { recursive: true, force: true }) };
}

test("artifact inventory hashes complete binary files with canonical paths, modes and fresh bytes", async () => {
  const f = await fixture();
  try {
    await mkdir(resolve(f.root, "nested"));
    const bytes = Buffer.alloc(640 * 1024 + 7);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    const values = new Map([
      ["empty", Buffer.alloc(0)],
      ["nested/binary", bytes],
      ["text", Buffer.from("complete archive digest\n")],
    ]);
    for (const [path, value] of values) {
      await writeFile(resolve(f.root, path), value, { mode: 0o600 });
      await chmod(resolve(f.root, path), 0o600);
    }
    const expected = [];
    for (const [path, value] of values)
      expected.push({
        path,
        mode: (await lstat(resolve(f.root, path))).mode & 0o777,
        size: value.length,
        sha256: digest(value),
      });
    assert.deepEqual(await inventory(f.root), expected);
    assert.deepEqual(await regularBytes(resolve(f.root, "nested/binary"), bytes.length), bytes);
    assert.deepEqual(await regularBytes(resolve(f.root, "nested/binary")), bytes);
    bytes[bytes.length - 1] = bytes.readUInt8(bytes.length - 1) ^ 255;
    await writeFile(resolve(f.root, "nested/binary"), bytes);
    const changed = await inventory(f.root);
    assert.equal(changed[1]?.sha256, digest(bytes));
    assert.notEqual(
      changed[1]?.sha256,
      expected[1]?.sha256,
      "A changed final byte must invalidate the digest",
    );
  } finally {
    await f.close();
  }
});

test("retained artifact byte ceilings reject oversized and unlisted payloads while permitting exact empty files", async () => {
  const f = await fixture();
  try {
    await writeFile(resolve(f.root, "empty"), "");
    await writeFile(resolve(f.root, "payload"), "abc");
    const exact = new Map([
      ["empty", 0],
      ["payload", 3],
    ]);
    assert.deepEqual(await inventory(f.root, "", exact), await inventory(f.root));
    assert.deepEqual(await regularBytes(resolve(f.root, "empty"), 0), Buffer.alloc(0));
    await assert.rejects(
      inventory(
        f.root,
        "",
        new Map([
          ["empty", 0],
          ["payload", 2],
        ]),
      ),
      /Artifact byte bound/,
    );
    await assert.rejects(
      inventory(f.root, "", new Map([["empty", 0]])),
      /Artifact payload differs/,
    );
    await assert.rejects(regularBytes(resolve(f.root, "payload"), 2), /Artifact byte bound/);
    for (const maximum of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      await assert.rejects(
        inventory(
          f.root,
          "",
          new Map([
            ["empty", maximum],
            ["payload", 3],
          ]),
        ),
      );
  } finally {
    await f.close();
  }
});

test("artifact readers reject hard-linked files and directories", async () => {
  const f = await fixture();
  try {
    const file = resolve(f.root, "payload");
    await writeFile(file, "committed bytes");
    await link(file, resolve(f.root, "second-name"));
    await assert.rejects(inventory(f.root), /Nonregular artifact/);
    await assert.rejects(regularBytes(file), /Nonregular artifact/);
    await assert.rejects(regularBytes(file, 100), /Nonregular artifact/);
    await assert.rejects(regularBytes(f.root), /Nonregular artifact/);
  } finally {
    await f.close();
  }
});

test("artifact inventory and byte readers reject symbolic files and linked parents", {
  skip:
    process.platform === "win32" ? "Windows symbolic links require a separate privilege" : false,
}, async () => {
  const f = await fixture();
  try {
    await mkdir(resolve(f.root, "actual"));
    await writeFile(resolve(f.root, "actual/payload"), "committed bytes");
    await symlink(resolve(f.root, "actual/payload"), resolve(f.root, "linked-file"));
    await symlink(resolve(f.root, "actual"), resolve(f.root, "linked-parent"));
    await assert.rejects(inventory(f.root), /Linked artifact entry/);
    await assert.rejects(inventory(resolve(f.root, "linked-parent")), /Linked artifact directory/);
    for (const path of [resolve(f.root, "linked-file"), resolve(f.root, "linked-parent/payload")])
      for (const maximum of [undefined, 100])
        await assert.rejects(
          regularBytes(path, maximum),
          /Linked artifact parent|Nonregular artifact/,
        );
  } finally {
    await f.close();
  }
});
