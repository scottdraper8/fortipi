import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { create, Header } from "tar";
import { archiveInventory } from "../../prepare-release.ts";

test("a rejected tar header stops input before a following bounded large member is drained", async () => {
  const directory = await mkdtemp(resolve(await realpath(tmpdir()), "fortipi-tar-stop-"));
  const file = resolve(directory, "rejected.tar");
  const header = (path: string, size: number, linkpath?: string) => {
    const value = new Header({
      path,
      size,
      mode: 0o644,
      type: linkpath ? "SymbolicLink" : "File",
      ...(linkpath ? { linkpath } : {}),
    });
    value.encode();
    assert.ok(value.block);
    return value.block;
  };
  let readBytes = 0;
  let tracker: ReturnType<typeof mock.method> | undefined;
  try {
    const manifest = Buffer.from('{"name":"archive-reader-fixture","version":"0.0.0"}');
    const handle = await open(file, "wx", 0o600);
    try {
      await handle.write(header("package/package.json", manifest.length));
      await handle.write(Buffer.concat([manifest, Buffer.alloc(512 - manifest.length)]));
      await handle.write(header("package/rejected", 0, "../../outside"));
      await handle.write(header("package/padding", 18_000_000));
      await handle.truncate(2048 + Math.ceil(18_000_000 / 512) * 512 + 1024);
    } finally {
      await handle.close();
    }
    const original = fs.read;
    tracker = mock.method(fs, "read", (...args: unknown[]) => {
      const callback = args.pop();
      assert.equal(typeof callback, "function");
      return Reflect.apply(original, fs, [
        ...args,
        (error: unknown, bytes: number, buffer: unknown) => {
          readBytes += bytes;
          Reflect.apply(callback as (...values: unknown[]) => unknown, fs, [error, bytes, buffer]);
        },
      ]);
    });
    await assert.rejects(archiveInventory(file), /prefix\/link rejected/);
    assert.ok(readBytes > 0, "The transparent observer must see real filesystem reads");
    assert.ok(readBytes <= 262144, `Rejected input was drained: ${readBytes} bytes read`);
  } finally {
    tracker?.mock.restore();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the streaming reader retains normal gzip member bytes and manifest", async () => {
  const directory = await mkdtemp(resolve(await realpath(tmpdir()), "fortipi-tar-positive-"));
  try {
    await mkdir(resolve(directory, "package"));
    await writeFile(resolve(directory, "package/package.json"), '{"name":"reader-fixture"}');
    await writeFile(resolve(directory, "package/data.txt"), "retained bytes\n");
    const file = resolve(directory, "positive.tgz");
    await create({ file, cwd: directory, gzip: true }, ["package"]);
    const result = await archiveInventory(file);
    assert.equal(result.manifest.name, "reader-fixture");
    assert.deepEqual(
      result.entries.map((entry) => entry.path),
      ["data.txt", "package.json"],
    );
    assert.equal(result.entries[0]?.size, 15);
    assert.equal(
      result.entries[0]?.sha256,
      createHash("sha256").update("retained bytes\n").digest("hex"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
