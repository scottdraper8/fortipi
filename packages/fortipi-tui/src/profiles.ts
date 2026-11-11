import { rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { FortiPiError } from "fortipi-client/node";
import { checkProtected, protectDirectory, readProtected, writeProtected } from "./credentials.js";

export interface Profile {
  name: string;
  endpoint: string;
  credentialFile: string;
  agentId?: string;
  conversationId?: string;
  allowLoopbackHttp?: boolean;
}
export interface Profiles {
  version: 1;
  profiles: Profile[];
}
export function profileDirectory(): string {
  return process.platform === "win32"
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "FortiPi")
    : process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support", "FortiPi")
      : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "fortipi");
}
export function profilePath(): string {
  return join(profileDirectory(), "profiles.json");
}
export async function loadProfiles(path = profilePath()): Promise<Profiles> {
  let value: unknown;
  try {
    value = JSON.parse(await readProtected(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, profiles: [] };
    throw new FortiPiError("invalid_profiles");
  }
  if (
    !value ||
    typeof value !== "object" ||
    (value as Profiles).version !== 1 ||
    !Array.isArray((value as Profiles).profiles) ||
    (value as Profiles).profiles.length > 100
  )
    throw new FortiPiError("invalid_profiles");
  const names = new Set<string>();
  for (const p of (value as Profiles).profiles) {
    if (
      !p ||
      typeof p.name !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(p.name) ||
      names.has(p.name) ||
      typeof p.endpoint !== "string" ||
      typeof p.credentialFile !== "string" ||
      !isAbsolute(p.credentialFile) ||
      (p.agentId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(p.agentId)) ||
      (p.conversationId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(p.conversationId)) ||
      (p.allowLoopbackHttp !== undefined && typeof p.allowLoopbackHttp !== "boolean")
    )
      throw new FortiPiError("invalid_profiles");
    names.add(p.name);
  }
  return value as Profiles;
}
export async function saveProfiles(profiles: Profiles, path = profilePath()): Promise<void> {
  path = resolve(path);
  await protectDirectory(dirname(path));
  try {
    await checkProtected(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temp = `${path}.${globalThis.crypto.randomUUID()}.tmp`;
  try {
    await writeProtected(temp, `${JSON.stringify(profiles, null, 2)}\n`);
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => {});
  }
}
