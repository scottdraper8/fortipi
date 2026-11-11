import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { promisify } from "node:util";
import { exactOrigin } from "./config.js";
import { CliError, check } from "./errors.js";
import { windowsAclHelper } from "./windows-helper.js";

export function helperEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "LANG", "TERM"])
    if (process.env[key]) env[key] = process.env[key];
  return env;
}
async function windowsAcl(path: string, protect = false): Promise<void> {
  const script =
    "$ErrorActionPreference='Stop';$p=$env:FORTIPI_ACL_TARGET;" +
    "$i=Get-Item -Force -LiteralPath $p;if($i.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'link'};" +
    "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;" +
    (protect
      ? "$a=Get-Acl -LiteralPath $p;$a.SetOwner($sid);$a.SetAccessRuleProtection($true,$false);" +
        "foreach($r in @($a.Access)){$a.RemoveAccessRuleSpecific($r)};" +
        "$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow'));" +
        "Set-Acl -LiteralPath $p -AclObject $a;"
      : "") +
    "$a=Get-Acl -LiteralPath $p;" +
    "if($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or !$a.AreAccessRulesProtected){throw 'owner'};" +
    "$r=@($a.Access);if(!$r.Count){throw 'empty'};foreach($v in $r){if($v.AccessControlType -eq 'Allow' -and " +
    "$v.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'grant'}};";
  try {
    const helper = windowsAclHelper();
    const pending = promisify(execFile)(
      helper.executable,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        env: { ...helper.env, FORTIPI_ACL_TARGET: path },
        timeout: 10000,
        maxBuffer: 4096,
        windowsHide: true,
      },
    );
    pending.child.stdin?.on("error", () => undefined);
    pending.child.stdin?.end();
    await pending;
  } catch {
    throw new CliError("protected_acl_required", 3);
  }
}
/** Check every component before touching a protected path; never follow a link or reparse point. */
export async function safeParents(path: string): Promise<void> {
  path = resolve(path);
  const root = parse(path).root;
  const parts: string[] = [];
  for (let current = path; current !== root; current = dirname(current)) parts.unshift(current);
  for (const part of parts) {
    const info = await lstat(part);
    check(info.isDirectory() && !info.isSymbolicLink(), "unsafe_parent", 3);
    if (process.platform === "win32") {
      check((await realpath(part)).toLowerCase() === part.toLowerCase(), "unsafe_parent", 3);
    } else {
      check(
        (info.mode & 0o022) === 0 || (info.uid === 0 && (info.mode & 0o1000) !== 0),
        "unsafe_parent",
        3,
      );
    }
  }
}
export async function checkProtected(path: string, directory = false): Promise<void> {
  const stat = await lstat(path);
  check(
    !stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1),
    "unsafe_protected_path",
    3,
  );
  if (process.platform === "win32") await windowsAcl(path);
  else
    check(
      stat.uid === process.getuid?.() && (stat.mode & 0o777) === (directory ? 0o700 : 0o600),
      "protected_permissions_required",
      3,
    );
}
export async function outsideCheckout(path: string): Promise<void> {
  for (let parent = dirname(resolve(path)); ; parent = dirname(parent)) {
    let present = false;
    try {
      await lstat(join(parent, ".git"));
      present = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    check(!present, "credential_destination_must_be_outside_checkout", 3);
    if (dirname(parent) === parent) return;
  }
}
async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const directory = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export async function verifyReserved(path: string, file: FileHandle): Promise<void> {
  await checkProtected(path);
  const [named, held] = await Promise.all([lstat(path), file.stat()]);
  check(
    named.ino === held.ino && named.dev === held.dev && held.isFile() && held.nlink === 1,
    "protected_destination_changed",
    3,
  );
  if (process.platform !== "win32")
    check(
      held.uid === process.getuid?.() && (held.mode & 0o777) === 0o600,
      "protected_permissions_required",
      3,
    );
}
export async function protectDirectory(path: string): Promise<void> {
  path = resolve(path);
  await safeParents(dirname(path));
  let created = false;
  try {
    await mkdir(path, { mode: 0o700 });
    created = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST")
      throw new CliError("protected_directory_failed", 3);
  }
  if (created && process.platform === "win32") await windowsAcl(path, true);
  await checkProtected(path, true);
}
export async function reserveProtected(path: string): Promise<FileHandle> {
  await safeParents(dirname(resolve(path)));
  await checkProtected(dirname(resolve(path)), true);
  let file: FileHandle;
  try {
    file = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch {
    throw new CliError("protected_destination_unavailable", 3);
  }
  try {
    if (process.platform === "win32") await windowsAcl(path, true);
    await checkProtected(path);
    await syncDirectory(dirname(resolve(path)));
    return file;
  } catch (e) {
    await file.close();
    throw e;
  }
}
export async function writeProtected(path: string, value: unknown): Promise<void> {
  await outsideCheckout(path);
  const file = await reserveProtected(path);
  try {
    await file.writeFile(`${JSON.stringify(value)}\n`);
    await file.sync();
    await verifyReserved(path, file);
  } finally {
    await file.close();
  }
}
export async function readProtected(path: string): Promise<unknown> {
  await outsideCheckout(path);
  await safeParents(dirname(resolve(path)));
  await checkProtected(dirname(resolve(path)), true);
  await checkProtected(path);
  const before = await lstat(path);
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const after = await file.stat();
    await verifyReserved(path, file);
    check(
      before.ino === after.ino &&
        before.dev === after.dev &&
        after.isFile() &&
        after.nlink === 1 &&
        after.size <= 65536,
      "unsafe_protected_path",
      3,
    );
    const buffer = Buffer.alloc(65537);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    check(bytesRead <= 65536, "protected_file_too_large", 3);
    try {
      return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    } catch {
      throw new CliError("invalid_protected_file", 3);
    }
  } finally {
    await file.close();
  }
}
export async function replaceProtected(path: string, value: unknown): Promise<void> {
  await readProtected(path);
  const temp = join(dirname(path), `.fortipi-${randomUUID()}`);
  try {
    await writeProtected(temp, value);
    await rename(temp, path);
    await syncDirectory(dirname(resolve(path)));
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}
export interface Profile {
  version: 1;
  endpoint: string;
  role: "admin" | "client" | "executor";
  token: string;
}
export function profileRoot(): string {
  // Product-owned location only. No upstream provider/Cloudflare auth files are inspected.
  return join(homedir(), ".fortipi");
}
export function profilePath(name: string, root = profileRoot()): string {
  check(/^[A-Za-z0-9_-]{1,64}$/.test(name) && isAbsolute(root), "invalid_profile");
  return join(root, `${name}.json`);
}
export async function loadProfile(path: string, allowLoopback = false): Promise<Profile> {
  const p = (await readProtected(path)) as Profile;
  check(
    p &&
      p.version === 1 &&
      ["admin", "client", "executor"].includes(p.role) &&
      typeof p.endpoint === "string" &&
      typeof p.token === "string" &&
      p.token.length > 0 &&
      p.token.length <= 16384 &&
      !/[\r\n]/.test(p.token),
    "invalid_profile",
    3,
  );
  exactOrigin(p.endpoint, allowLoopback);
  return p;
}
