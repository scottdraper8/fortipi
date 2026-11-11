import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { CredentialRef, TransferDescriptor } from "fortipi-contract/executor";
import { linux } from "./platform/linux.js";
import { macos } from "./platform/macos.js";
import type { PlatformAdapter } from "./platform/types.js";
import { windows } from "./platform/windows.js";
import type { LocalPolicy } from "./policy.js";

export interface Limits {
  chunkBytes: number;
  fileBytes: number;
  snapshotBytes: number;
  manifestEntries: number;
  inlineTailBytes: number;
  artifactBytes: number;
  outputBytesPerJob: number;
  activeMutatingJobs: number;
  queuedAdmissions: number;
  transferConcurrency: number;
  ledgerBytes: number;
  historyRows: number;
}
export const defaults: Limits = {
  chunkBytes: 262144,
  fileBytes: 4194304,
  snapshotBytes: 16777216,
  manifestEntries: 512,
  inlineTailBytes: 32768,
  artifactBytes: 1048576,
  outputBytesPerJob: 8388608,
  activeMutatingJobs: 1,
  queuedAdmissions: 4,
  transferConcurrency: 2,
  ledgerBytes: 134217728,
  historyRows: 10000,
};
export function effectiveLimits(...sets: Partial<Limits>[]): Limits {
  const result = { ...defaults };
  for (const set of sets)
    for (const key of Object.keys(result) as (keyof Limits)[]) {
      const value = set[key];
      if (value !== undefined) {
        if (!Number.isSafeInteger(value) || value < 1) throw new Error("invalid capacity");
        result[key] = Math.min(result[key], value);
      }
    }
  return result;
}
export interface Binding {
  rootBindingId: string;
  workspaceId: string;
  bindingVersion: number;
  path: string;
  revision: string;
  manifestHash: string;
  providerKind: "local" | "computer";
}
export interface Profile {
  version: 1;
  origin: string;
  deploymentId: string;
  executorId: string;
  executorGeneration: number;
  credential: CredentialRef;
  token: string;
  ledgerId: string;
  bindings: Binding[];
  resources: TransferDescriptor["consumer"];
  policy: LocalPolicy;
  limits: Partial<Limits>;
}
export function adapter(): PlatformAdapter {
  if (process.platform === "linux") return linux();
  if (process.platform === "darwin") return macos();
  if (process.platform === "win32") return windows();
  throw new Error("unsupported native platform");
}
export function stateHome(): string {
  if (process.platform === "win32") {
    const value = process.env.LOCALAPPDATA;
    if (!value || !isAbsolute(value)) throw new Error("LOCALAPPDATA required");
    return join(value, "FortiPi", "Executor");
  }
  if (process.platform === "darwin")
    return join(homedir(), "Library", "Application Support", "FortiPi", "Executor");
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg && !isAbsolute(xdg)) throw new Error("XDG_STATE_HOME must be absolute");
  return join(xdg || join(homedir(), ".local", "state"), "fortipi", "executor");
}
export function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
export function validateOrigin(input: string, local = false): string {
  const url = new URL(input);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(
        local &&
        url.protocol === "http:" &&
        ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
      ))
  )
    throw new Error("HTTPS origin required");
  return url.origin;
}
export async function secureDirectory(path: string, platform = adapter()): Promise<void> {
  const absolute = resolve(path);
  let stat: Stats | undefined;
  try {
    stat = await lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(absolute);
    try {
      await lstat(parent);
    } catch {
      await secureDirectory(parent, platform);
    }
    await mkdir(absolute, { mode: 0o700 });
    await platform.protect(absolute, true);
  }
  if (stat?.isSymbolicLink()) throw new Error("state symlink");
  await platform.verifyProtection(absolute, true);
  if ((await realpath(absolute)) !== absolute) throw new Error("state path alias");
}
export async function privateWrite(
  path: string,
  data: string | Uint8Array,
  platform = adapter(),
  exclusive = false,
): Promise<void> {
  await platform.verifyProtection(dirname(path), true);
  const target = exclusive ? path : `${path}.${randomUUID()}.tmp`;
  const fd = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await platform.protect(target, false);
    await fd.writeFile(data);
    await fd.sync();
  } finally {
    await fd.close();
  }
  await platform.verifyProtection(target, false);
  if (!exclusive) {
    try {
      await platform.verifyProtection(path, false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(target, path);
  }
  await syncDirectory(dirname(path));
}
export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return; // Node cannot fsync a Windows directory handle; SQLite still uses FULL.
  const fd = await open(path, constants.O_RDONLY);
  try {
    await fd.sync();
  } finally {
    await fd.close();
  }
}
export async function privateRead(
  path: string,
  platform = adapter(),
  limit = 1048576,
): Promise<string> {
  return (await privateBytes(path, platform, limit)).toString("utf8");
}
export async function privateBytes(
  path: string,
  platform = adapter(),
  limit = 1048576,
): Promise<Buffer> {
  await platform.verifyProtection(dirname(path), true);
  if ((await realpath(dirname(path))) !== resolve(dirname(path)))
    throw new Error("private parent alias");
  await platform.verifyProtection(path, false);
  const before = await lstat(path);
  if (before.size > limit) throw new Error("profile size");
  const fd = await open(
    path,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  try {
    const opened = await fd.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.nlink !== 1)
      throw new Error("profile replacement");
    const value = Buffer.alloc(Math.min(limit, opened.size) + 1);
    let length = 0;
    while (length < value.length) {
      const read = await fd.read(value, length, value.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const final = await fd.stat();
    const after = await lstat(path);
    if (
      length !== opened.size ||
      length > limit ||
      final.size !== opened.size ||
      final.ctimeMs !== opened.ctimeMs ||
      final.nlink !== 1 ||
      after.nlink !== 1 ||
      after.ino !== opened.ino ||
      after.dev !== opened.dev ||
      after.mtimeMs !== opened.mtimeMs ||
      after.size !== opened.size
    )
      throw new Error("profile changed");
    return value.subarray(0, length);
  } finally {
    await fd.close();
  }
}
export async function loadProfile(
  path: string,
  platform = adapter(),
  local = false,
): Promise<Profile> {
  let p: Profile;
  try {
    p = JSON.parse(await privateRead(path, platform)) as Profile;
  } catch {
    throw new Error("invalid or unsafe protected executor profile");
  }
  if (
    p.version !== 1 ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(p.executorId) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(p.ledgerId) ||
    !Number.isSafeInteger(p.executorGeneration) ||
    p.executorGeneration < 0 ||
    typeof p.token !== "string" ||
    !/^[\x21-\x7e]{16,4096}$/.test(p.token) ||
    !Array.isArray(p.bindings) ||
    p.bindings.length > 100 ||
    !p.credential ||
    !p.resources ||
    !p.policy
  )
    throw new Error("invalid executor profile");
  p.origin = validateOrigin(p.origin, local);
  for (const b of p.bindings) {
    b.path = await realpath(b.path);
    if (contains(b.path, resolve(path)) || contains(b.path, await futurePath(stateHome())))
      throw new Error("state must be outside workspaces");
  }
  for (let current = dirname(resolve(path)); ; current = dirname(current)) {
    try {
      await lstat(join(current, ".git"));
      throw new Error("profile inside checkout");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (dirname(current) === current) break;
  }
  effectiveLimits(p.limits);
  return p;
}
async function futurePath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw error;
    return join(await futurePath(dirname(path)), basename(path));
  }
}
