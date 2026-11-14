import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { TextDecoder } from "node:util";

export interface FsEntry {
  type: string;
  mode: number;
  uid: number;
  gid: number;
  size: number;
  link: string;
  attributes: Record<string, string>;
  sha256?: string;
  elf?: boolean;
  data?: Buffer;
  major: number;
  minor: number;
}
export interface FilePolicy {
  paths: Set<string>;
  hashes: Set<string>;
}
const decoder = new TextDecoder("utf8", { fatal: true });
function text(bytes: Buffer): string {
  const end = bytes.indexOf(0);
  return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end));
}
function number(bytes: Buffer): number {
  if ((bytes[0] ?? 0) & 0x80) {
    assert.equal((bytes[0] ?? 0) & 0x40, 0, "Negative tar number");
    let value = BigInt((bytes[0] ?? 0) & 0x7f);
    for (const byte of bytes.subarray(1)) value = value * 256n + BigInt(byte);
    assert.ok(value <= BigInt(Number.MAX_SAFE_INTEGER));
    return Number(value);
  }
  const value = text(bytes).trim();
  assert.match(value, /^[0-7]*$/);
  return value ? Number.parseInt(value, 8) : 0;
}
export function rootPath(path: string): string {
  const name = path.replace(/^(?:\.\/)+/, "").replace(/\/$/, "");
  assert.ok(
    !name.startsWith("/") &&
      !name.includes("\\") &&
      !name.includes("\0") &&
      !name.split("/").includes(".."),
    "Unsafe rootfs member path",
  );
  return name === "." || name === "" ? "" : posix.normalize(name);
}
function pax(bytes: Buffer): Map<string, Buffer> {
  const fields = new Map<string, Buffer>();
  let cursor = 0;
  while (cursor < bytes.length) {
    const space = bytes.indexOf(32, cursor);
    assert.ok(space > cursor);
    const digits = bytes.subarray(cursor, space).toString("ascii");
    assert.match(digits, /^[1-9][0-9]*$/);
    const end = cursor + Number(digits);
    assert.ok(end <= bytes.length && bytes[end - 1] === 10, "Truncated PAX record");
    const equal = bytes.indexOf(61, space + 1);
    assert.ok(equal > space + 1 && equal < end - 1);
    const key = decoder.decode(bytes.subarray(space + 1, equal));
    assert.ok(!fields.has(key), "Duplicate PAX field");
    fields.set(key, bytes.subarray(equal + 1, end - 1));
    cursor = end;
  }
  return fields;
}
/** Raw PAX values are retained as hex: node-tar's Pax class drops arbitrary xattrs. */
export async function scanRootfs(
  source: AsyncIterable<Uint8Array>,
  policy?: FilePolicy,
  capture = new Set<string>(),
): Promise<Map<string, FsEntry>> {
  const result = new Map<string, FsEntry>();
  let buffered = Buffer.alloc(0),
    remaining = 0,
    padding = 0,
    expanded = 0,
    zeros = 0;
  let current:
    | {
        path: string;
        entry: FsEntry;
        hash: ReturnType<typeof createHash>;
        parts: Buffer[];
        prefix: Buffer;
        meta: string;
      }
    | undefined;
  let extended = new Map<string, Buffer>(),
    global = new Map<string, Buffer>();
  let longPath = "",
    longLink = "";
  const finish = () => {
    assert.ok(current);
    const { path, entry, hash, parts, meta } = current;
    if (meta) {
      const bytes = Buffer.concat(parts);
      if (meta === "x" || meta === "g") {
        const fields = pax(bytes);
        if (meta === "g") global = new Map([...global, ...fields]);
        else extended = fields;
      } else if (meta === "L") longPath = text(bytes);
      else longLink = text(bytes);
    } else {
      if (entry.type === "File") {
        entry.sha256 = hash.digest("hex");
        entry.elf = current.prefix.equals(Buffer.from([127, 69, 76, 70]));
        assert.ok(
          !policy?.hashes.has(entry.sha256),
          `Forbidden retained binary/archive bytes at ${path}`,
        );
        if (capture.has(path)) entry.data = Buffer.concat(parts);
      }
      assert.ok(!result.has(path), "Duplicate rootfs layer path");
      result.set(path, entry);
    }
    current = undefined;
  };
  for await (const value of source) {
    const chunk = Buffer.from(value);
    expanded += chunk.length;
    assert.ok(expanded <= 2 * 1024 * 1024 * 1024, "Rootfs archive exceeds bound");
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
    for (;;) {
      if (remaining) {
        if (!buffered.length) break;
        const count = Math.min(remaining, buffered.length);
        const part = buffered.subarray(0, count);
        assert.ok(current);
        if (current.meta || capture.has(current.path)) current.parts.push(Buffer.from(part));
        if (current.prefix.length < 4)
          current.prefix = Buffer.concat([
            current.prefix,
            part.subarray(0, 4 - current.prefix.length),
          ]);
        current.hash.update(part);
        remaining -= count;
        buffered = buffered.subarray(count);
        if (!remaining) finish();
      } else if (padding) {
        const count = Math.min(padding, buffered.length);
        padding -= count;
        buffered = buffered.subarray(count);
        if (padding || !buffered.length) break;
      } else {
        if (buffered.length < 512) break;
        const header = buffered.subarray(0, 512);
        buffered = buffered.subarray(512);
        if (header.every((byte: number) => byte === 0)) {
          zeros++;
          continue;
        }
        assert.equal(zeros, 0, "Data after tar end marker");
        let checksum = 0;
        for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : (header[i] ?? 0);
        assert.equal(number(header.subarray(148, 156)), checksum, "Rootfs tar checksum mismatch");
        const type = String.fromCharCode(header[156] ?? 0);
        const meta = ["x", "g", "L", "K"].includes(type) ? type : "";
        const fields = meta ? new Map<string, Buffer>() : new Map([...global, ...extended]);
        const field = (key: string, fallback: string) =>
          fields.has(key) ? decoder.decode(fields.get(key)) : fallback;
        const decimal = (key: string, fallback: number) => {
          const value = field(key, String(fallback));
          assert.match(value, /^[0-9]+$/);
          const n = Number(value);
          assert.ok(Number.isSafeInteger(n));
          return n;
        };
        const prefix = text(header.subarray(345, 500));
        const rawName = text(header.subarray(0, 100));
        const path = meta
          ? ""
          : rootPath(field("path", longPath || (prefix ? `${prefix}/${rawName}` : rawName)));
        const size = decimal("size", number(header.subarray(124, 136)));
        assert.ok(
          size <= (meta || capture.has(path) ? 1024 * 1024 : 256 * 1024 * 1024),
          "Rootfs member exceeds bound",
        );
        const types: Record<string, string> = {
          "0": "File",
          "\0": "File",
          "1": "Link",
          "2": "SymbolicLink",
          "3": "CharacterDevice",
          "4": "BlockDevice",
          "5": "Directory",
          "6": "FIFO",
          "7": "File",
        };
        assert.ok(meta || types[type], "Unsupported rootfs tar type");
        const link = field("linkpath", longLink || text(header.subarray(157, 257)));
        assert.ok(!policy?.paths.has(path), `Forbidden removed executable path ${path}`);
        if (!meta && link)
          assert.ok(
            !policy?.paths.has(
              type === "1"
                ? rootPath(link)
                : posix.resolve("/", posix.dirname(path), link).slice(1),
            ),
            `Forbidden removed executable alias ${path}`,
          );
        const attributes = Object.fromEntries(
          [...fields]
            .filter(
              ([key]) =>
                ![
                  "path",
                  "linkpath",
                  "size",
                  "uid",
                  "gid",
                  "mtime",
                  "atime",
                  "ctime",
                  "uname",
                  "gname",
                  "charset",
                  "comment",
                  "SCHILY.dev",
                  "SCHILY.ino",
                  "SCHILY.nlink",
                ].includes(key),
            )
            .map(([key, bytes]) => [key, bytes.toString("hex")]),
        );
        current = {
          path,
          entry: {
            type: types[type] ?? "meta",
            mode: number(header.subarray(100, 108)) & 0o7777,
            uid: decimal("uid", number(header.subarray(108, 116))),
            gid: decimal("gid", number(header.subarray(116, 124))),
            size,
            link,
            attributes,
            major: number(header.subarray(329, 337)),
            minor: number(header.subarray(337, 345)),
          },
          hash: createHash("sha256"),
          parts: [],
          prefix: Buffer.alloc(0),
          meta,
        };
        if (!meta) {
          extended = new Map();
          longPath = "";
          longLink = "";
        }
        remaining = size;
        padding = (512 - (size % 512)) % 512;
        if (!remaining) finish();
        assert.ok(result.size <= 200000, "Too many rootfs entries");
      }
    }
  }
  assert.ok(
    !remaining && !padding && !buffered.length && !current && zeros >= 2,
    "Truncated rootfs tar",
  );
  return result;
}
export function applyLayer(files: Map<string, FsEntry>, layer: Map<string, FsEntry>): void {
  for (const [path] of layer) {
    const name = posix.basename(path),
      directory = posix.dirname(path) === "." ? "" : posix.dirname(path);
    if (name === ".wh..wh..opq") {
      for (const old of files.keys())
        if (old.startsWith(directory ? `${directory}/` : "")) files.delete(old);
    } else if (name.startsWith(".wh.")) {
      const target = directory ? `${directory}/${name.slice(4)}` : name.slice(4);
      for (const old of files.keys())
        if (old === target || old.startsWith(`${target}/`)) files.delete(old);
    }
  }
  for (const [path, entry] of layer)
    if (!posix.basename(path).startsWith(".wh.")) {
      for (
        let parent = posix.dirname(path);
        parent !== "." && parent !== "/";
        parent = posix.dirname(parent)
      )
        assert.ok(
          !files.has(parent) || files.get(parent)?.type === "Directory",
          "Rootfs layer traverses a non-directory parent",
        );
      if (entry.type !== "Directory" && files.get(path)?.type === "Directory")
        for (const old of files.keys()) if (old.startsWith(`${path}/`)) files.delete(old);
      files.set(path, entry);
    }
}
function normalized(files: Map<string, FsEntry>): Map<string, unknown> {
  const targets = new Map<string, string[]>();
  const target = (path: string, visited = new Set<string>()): string => {
    assert.ok(!visited.has(path) && visited.size < 64, "Cyclic hardlink");
    visited.add(path);
    const entry = files.get(path);
    assert.ok(entry, `Missing hardlink target ${path}`);
    return entry.type === "Link" ? target(rootPath(entry.link), visited) : path;
  };
  for (const [path, entry] of files)
    if (entry.type === "File" || entry.type === "Link") {
      const key = target(path);
      const group = targets.get(key) ?? [];
      group.push(path);
      targets.set(key, group);
    }
  const result = new Map<string, unknown>();
  for (const [path, entry] of files) {
    if (!path) continue;
    if (entry.type === "File" || entry.type === "Link") {
      const key = target(path),
        value = files.get(key);
      assert.ok(value?.type === "File");
      if (entry.type === "Link" && Object.keys(entry.attributes).length)
        assert.deepEqual(entry.attributes, value.attributes, "Hardlink attributes changed");
      result.set(path, { ...value, data: undefined, links: targets.get(key)?.sort() });
    } else result.set(path, entry);
  }
  return result;
}
export function compareRootfs(expected: Map<string, FsEntry>, actual: Map<string, FsEntry>): void {
  const left = normalized(expected),
    right = normalized(actual);
  assert.equal(right.size, left.size, "Cleaned/final rootfs entry count differs");
  for (const [path, entry] of left)
    assert.deepEqual(
      right.get(path),
      entry,
      `Cleaned/final rootfs metadata or bytes changed: ${path}`,
    );
  let helper = actual.get("usr/bin/fusermount3");
  for (let depth = 0; helper?.type === "Link"; depth++) {
    assert.ok(depth < 64);
    helper = actual.get(rootPath(helper.link));
  }
  assert.ok(
    helper && helper.uid === 0 && helper.gid === 0 && helper.mode === 0o4755,
    "Configured FUSE helper ownership/setuid changed",
  );
}
