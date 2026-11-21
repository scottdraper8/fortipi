import type { ChildProcess } from "node:child_process";
import type { Stats } from "node:fs";
import { win32 } from "node:path";

export interface RootIdentity {
  path: string;
  device: number;
  inode: number;
  caseBehavior: "sensitive" | "insensitive";
}
export interface SpawnSpec {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}
export interface TreeDisposition {
  state: "stopped" | "unknown";
  possibleExternalEffects: true;
}
export interface PlatformAdapter {
  platform: "darwin" | "linux" | "win32";
  confinement: "host";
  protect(path: string, directory: boolean): Promise<void>;
  verifyProtection(path: string, directory: boolean): Promise<void>;
  verifyEntry(path: string, stat: Stats): Promise<void>;
  shell(command: string, cwd: string, env: Record<string, string>): SpawnSpec;
  spawn(spec: SpawnSpec): ChildProcess;
  cancel(child: ChildProcess, graceMs: number): Promise<TreeDisposition>;
}

export function sameFile(a: Pick<Stats, "dev" | "ino">, b: Pick<Stats, "dev" | "ino">): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/** Values are selected locally; assignment env may never inherit the daemon's env. */
export function childEnvironment(overrides: Record<string, string> = {}): Record<string, string> {
  const names =
    process.platform === "win32"
      ? ["SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "PATH"]
      : ["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "TERM"];
  const result: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) result[name] = value;
  }
  if (process.platform === "win32" && result.SystemRoot) {
    result.ComSpec = win32.join(result.SystemRoot, "System32", "cmd.exe");
    result.PATHEXT = ".COM;.EXE;.BAT;.CMD";
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (!/^(LANG|LC_ALL|TERM|NO_COLOR)$/.test(name) || value.includes("\0"))
      throw new Error("unsafe child environment override");
    result[name] = value;
  }
  return result;
}
