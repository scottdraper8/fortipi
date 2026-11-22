import assert from "node:assert/strict";
import { chmod, lstat, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { type FileRecord, sha256, verifyPayload } from "../../verify-release-gates.ts";
import { temporary } from "./fixtures.ts";

test("protected artifact bytes survive native permission representation and reject tampering", async () => {
  const root = await temporary("fortipi-payload-portability-");
  const file = resolve(root, "result.json");
  const original = Buffer.from('{"value":1}\n');
  const expected: FileRecord[] = [
    { path: "result.json", mode: 0o600, size: original.length, sha256: sha256(original) },
  ];
  try {
    await writeFile(file, original, { mode: 0o600 });
    if (process.platform === "win32") {
      const { windows } = await import(
        "../../../packages/fortipi-executor/dist/platform/windows.js"
      );
      const platform = windows();
      await platform.protect(root, true);
      await platform.protect(file, false);
      await platform.verifyProtection(root, true);
      await platform.verifyProtection(file, false);
      // Pinned Node's Windows mode bits do not represent these independently checked DACLs.
      assert.notEqual((await lstat(file)).mode & 0o022, 0);
    }
    await verifyPayload(root, expected);
    await writeFile(file, '{"value":2}\n');
    await assert.rejects(verifyPayload(root, expected), /payload differs/);
    if (process.platform !== "win32") {
      await writeFile(file, original);
      await chmod(file, 0o666);
      await assert.rejects(verifyPayload(root, expected), /Writable artifact payload/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
