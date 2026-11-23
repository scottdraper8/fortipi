import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, link, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { repository } from "../../build-workspaces.ts";
import { type FileRecord, sha256, verifyPayload } from "../../verify-release-gates.ts";
import { temporary } from "./fixtures.ts";

test("Release workflow checkout preserves authoritative Git-object bytes", async () => {
  const path = ".github/workflows/release.yml";
  const { stdout: committed } = await promisify(execFile)("git", ["show", `HEAD:${path}`], {
    cwd: repository,
    encoding: "buffer",
    timeout: 15000,
    maxBuffer: 4_000_000,
  });
  const working = await readFile(resolve(repository, path));
  assert.ok(working.equals(committed), "Release workflow differs from committed bytes");
});

test("protected artifact bytes survive native permission representation and reject tampering", async () => {
  const root = await temporary("fortipi-payload-portability-");
  const file = resolve(root, "result.json");
  const nested = resolve(root, "legal/notices");
  const notice = resolve(nested, "notice.txt");
  const original = Buffer.from('{"value":1}\n');
  const noticeBytes = Buffer.from("public fixture notice\n");
  const expected: FileRecord[] = [
    {
      path: "legal/notices/notice.txt",
      mode: 0o600,
      size: noticeBytes.length,
      sha256: sha256(noticeBytes),
    },
    { path: "result.json", mode: 0o600, size: original.length, sha256: sha256(original) },
  ];
  try {
    await mkdir(nested, { recursive: true, mode: 0o700 });
    await writeFile(file, original, { mode: 0o600 });
    await writeFile(notice, noticeBytes, { mode: 0o600 });
    if (process.platform === "win32") {
      const { windows, protectWindowsPayloadTree, powershellArgs, windowsUtilityEnvironment } =
        await import("../../../packages/fortipi-executor/src/platform/windows.ts");
      const platform = windows();
      await protectWindowsPayloadTree(root);
      await platform.verifyProtection(root, true);
      await platform.verifyProtection(file, false);
      await platform.verifyProtection(nested, true);
      await platform.verifyProtection(notice, false);
      // Pinned Node's Windows mode bits do not represent these independently checked DACLs.
      assert.notEqual((await lstat(file)).mode & 0o022, 0);
      await verifyPayload(root, expected);
      // Only this freshly owned fixture receives the public Everyone write-grant fault.
      const env = windowsUtilityEnvironment();
      assert.ok(env.SystemRoot);
      const program = `$ErrorActionPreference='Stop';$p=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(notice).toString("base64")}'));$a=[System.IO.File]::GetAccessControl($p);$r=[System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'),[System.Security.AccessControl.FileSystemRights]::Write,[System.Security.AccessControl.AccessControlType]::Allow);$a.AddAccessRule($r);[System.IO.File]::SetAccessControl($p,$a)`;
      try {
        const pending = promisify(execFile)(
          resolve(env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
          powershellArgs(program),
          { env, windowsHide: true, timeout: 10000, maxBuffer: 4096 },
        );
        pending.child.stdin?.on("error", () => {});
        pending.child.stdin?.end();
        await pending;
      } catch {
        throw new Error("Owned Windows payload ACL control failed");
      }
      assert.deepEqual(await readFile(notice), noticeBytes);
      await assert.rejects(verifyPayload(root, expected), /Windows payload protection rejected/);
      await assert.rejects(verifyPayload(root, expected), /Windows payload protection rejected/);
      await assert.rejects(platform.verifyProtection(notice, false), /unsafe executor DACL/);
      // Verification must leave the grant intact. Only explicit owned-fixture cleanup repairs it.
      await platform.protect(notice, false);
    }
    await verifyPayload(root, expected);
    await writeFile(file, '{"value":2}\n');
    await assert.rejects(verifyPayload(root, expected), /payload differs/);
    if (process.platform !== "win32") {
      await writeFile(file, original);
      await chmod(file, 0o666);
      await assert.rejects(verifyPayload(root, expected), /Writable artifact payload/);
    } else {
      const { protectWindowsPayloadTree, verifyWindowsPayloadTree } = await import(
        "../../../packages/fortipi-executor/src/platform/windows.ts"
      );
      const alias = resolve(root, "alias.json");
      await link(file, alias);
      await assert.rejects(protectWindowsPayloadTree(root), /Windows payload protection rejected/);
      await assert.rejects(verifyWindowsPayloadTree(root), /Windows payload protection rejected/);
      await rm(alias);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
