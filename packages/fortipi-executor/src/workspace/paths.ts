import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { validateRelativePath } from "fortipi-contract/executor";
import { syncDirectory } from "../config.js";
import type { PlatformAdapter, RootIdentity } from "../platform/types.js";
import { sameFile } from "../platform/types.js";

export function excluded(path: string): boolean {
  try {
    validateRelativePath(path);
    return false;
  } catch {
    return true;
  }
}
export class SafeRoot {
  identity: RootIdentity;
  platform: PlatformAdapter;
  key: string;
  modes = new Map<string, 420 | 493>();
  rememberModes(manifest: {
    entries: { path: string; type: "file" | "directory"; mode: 420 | 493 }[];
  }): void {
    if (this.platform.platform === "win32")
      for (const e of manifest.entries)
        if (e.type === "file" && !this.modes.has(e.path)) this.modes.set(e.path, e.mode);
  }
  private constructor(identity: RootIdentity, platform: PlatformAdapter) {
    this.identity = identity;
    this.platform = platform;
    this.key = `${identity.device}:${identity.inode}`;
  }
  static async open(path: string, platform: PlatformAdapter): Promise<SafeRoot> {
    const canonical = await realpath(path);
    const stat = await lstat(canonical);
    await platform.verifyEntry(canonical, stat);
    if (!stat.isDirectory()) throw new Error("root must be directory");
    // Probe the actual filesystem, not the OS default. Probe is removed before any manifest observation.
    const name = `FortipiCase${randomUUID().replaceAll("-", "")}`;
    const fd = await open(join(canonical, name), "wx", 0o600);
    await fd.close();
    let insensitive = false;
    try {
      await lstat(join(canonical, name.toLowerCase()));
      insensitive = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      await unlink(join(canonical, name));
    }
    return new SafeRoot(
      {
        path: canonical,
        device: stat.dev,
        inode: stat.ino,
        caseBehavior: insensitive ? "insensitive" : "sensitive",
      },
      platform,
    );
  }
  async verify(): Promise<void> {
    const stat = await lstat(this.identity.path);
    await this.platform.verifyEntry(this.identity.path, stat);
    if (
      !stat.isDirectory() ||
      stat.dev !== this.identity.device ||
      stat.ino !== this.identity.inode ||
      (await realpath(this.identity.path)) !== this.identity.path
    )
      throw new Error("workspace root identity changed");
  }
  private async spelling(path: string): Promise<void> {
    if (this.platform.platform === "win32" && (await realpath(path)) !== path)
      throw new Error("noncanonical filesystem alias or case spelling");
  }
  async ancestors(path: string): Promise<{ path: string; stat: Stats }[]> {
    validateRelativePath(path);
    await this.verify();
    const result: { path: string; stat: Stats }[] = [];
    const segments = path.split("/");
    segments.pop();
    let current = this.identity.path;
    result.push({ path: current, stat: await lstat(current) });
    for (const part of segments) {
      current = join(current, part);
      const stat = await lstat(current);
      await this.platform.verifyEntry(current, stat);
      await this.spelling(current);
      if (!stat.isDirectory()) throw new Error("non-directory ancestor");
      result.push({ path: current, stat });
    }
    return result;
  }
  async recheck(chain: { path: string; stat: Stats }[]): Promise<void> {
    await this.verify();
    for (const entry of chain) {
      const stat = await lstat(entry.path);
      await this.platform.verifyEntry(entry.path, stat);
      await this.spelling(entry.path);
      if (!sameFile(stat, entry.stat)) throw new Error("ancestor replaced");
    }
  }
  native(path: string): string {
    validateRelativePath(path);
    const result = resolve(this.identity.path, ...path.split("/"));
    if (!result.startsWith(`${this.identity.path}${sep}`)) throw new Error("path escape");
    return result;
  }
  async stat(path: string): Promise<Stats> {
    const chain = await this.ancestors(path),
      native = this.native(path),
      before = await lstat(native);
    await this.platform.verifyEntry(native, before);
    await this.spelling(native);
    await this.recheck(chain);
    if (!sameFile(before, await lstat(native))) throw new Error("entry replaced");
    return before;
  }
  async read(path: string, maximum: number): Promise<Buffer> {
    const chain = await this.ancestors(path),
      native = this.native(path),
      before = await this.stat(path);
    if (!before.isFile() || before.size > maximum) throw new Error("file size/type limit");
    const fd = await open(
      native,
      constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
    );
    try {
      const opened = await fd.stat();
      if (!sameFile(before, opened) || opened.nlink !== 1)
        throw new Error("file replaced before open");
      // Read at most the bound +1 even if a host writer grows the file after stat.
      const data = Buffer.alloc(Math.min(maximum, opened.size) + 1);
      let size = 0;
      while (size < data.length) {
        const chunk = await fd.read(data, size, data.length - size, size);
        if (!chunk.bytesRead) break;
        size += chunk.bytesRead;
      }
      const after = await fd.stat();
      await this.recheck(chain);
      const current = await this.stat(path);
      if (
        size !== opened.size ||
        size > maximum ||
        !sameFile(opened, current) ||
        after.mtimeMs !== opened.mtimeMs ||
        after.ctimeMs !== opened.ctimeMs ||
        after.size !== opened.size ||
        current.mtimeMs !== opened.mtimeMs
      )
        throw new Error("file drift during read");
      return data.subarray(0, size);
    } finally {
      await fd.close();
    }
  }
  async entries(path?: string): Promise<string[]> {
    if (path) {
      const stat = await this.stat(path);
      if (!stat.isDirectory()) throw new Error("not directory");
    } else await this.verify();
    const native = path ? this.native(path) : this.identity.path;
    const before = await lstat(native);
    const names = await readdir(native);
    if (!sameFile(before, await lstat(native))) throw new Error("directory replaced");
    return names.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  }
  async write(path: string, data: Uint8Array, mode: 420 | 493): Promise<void> {
    const chain = await this.ancestors(path),
      target = this.native(path);
    let previous: Stats | undefined;
    try {
      previous = await this.stat(path);
      if (!previous.isFile()) throw new Error("write target type");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temp = join(dirname(target), `FortipiWrite${randomUUID().replaceAll("-", "")}`);
    const fd = await open(
      temp,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
      mode,
    );
    try {
      await fd.writeFile(data);
      if (process.platform !== "win32") await fd.chmod(mode);
      await fd.sync();
      await this.recheck(chain);
      let current: Stats | undefined;
      try {
        current = await this.stat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (
        (previous &&
          (!current || !sameFile(previous, current) || previous.mtimeMs !== current.mtimeMs)) ||
        (!previous && current)
      )
        throw new Error("write replacement race");
      const tempStat = await lstat(temp);
      if (!sameFile(tempStat, await fd.stat()) || tempStat.nlink !== 1)
        throw new Error("temporary file replaced");
      await rename(temp, target);
      await this.recheck(chain);
      if (!sameFile(await lstat(target), await fd.stat()))
        throw new Error("post-write replacement");
      await syncDirectory(dirname(target));
      if (this.platform.platform === "win32") this.modes.set(path, mode);
    } finally {
      await fd.close();
      await unlink(temp).catch(() => {}); // Failed cleanup is noncanonical residue; never overwrite the operation failure.
    }
  }
  async mkdir(path: string): Promise<void> {
    const chain = await this.ancestors(path);
    await this.recheck(chain);
    try {
      const existing = await this.stat(path);
      if (existing.isDirectory()) return;
      throw new Error("mkdir existing file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(this.native(path), { mode: 0o755 });
    await this.stat(path);
    await this.recheck(chain);
    await syncDirectory(dirname(this.native(path)));
  }
  async delete(path: string): Promise<void> {
    const chain = await this.ancestors(path),
      before = await this.stat(path);
    await this.recheck(chain);
    if (!sameFile(before, await lstat(this.native(path)))) throw new Error("delete replacement");
    if (before.isDirectory()) await rmdir(this.native(path));
    else await unlink(this.native(path));
    this.modes.delete(path);
    await this.recheck(chain);
    await syncDirectory(dirname(this.native(path)));
  }
  async deletionPaths(path: string, maximum: number): Promise<string[]> {
    const result: string[] = [];
    const visit = async (current: string): Promise<void> => {
      if (result.length >= maximum) throw new Error("delete path capacity");
      const stat = await this.stat(current);
      if (stat.isDirectory())
        for (const name of await this.entries(current)) {
          validateRelativePath(`${current}/${name}`);
          await visit(`${current}/${name}`);
        }
      result.push(current);
    };
    try {
      await visit(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return [];
    }
    return result;
  }
}
