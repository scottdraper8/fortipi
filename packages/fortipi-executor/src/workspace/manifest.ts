import type { ChunkInventory, LocalReadResult } from "fortipi-contract/executor";
import {
  canonicalJson,
  manifestDigest,
  validateChunkInventory,
  validateManifest,
} from "fortipi-contract/executor";
import type { Limits } from "../config.js";
import { hash } from "../policy.js";
import type { SafeRoot } from "./paths.js";
import { excluded } from "./paths.js";

export type Manifest = Extract<LocalReadResult, { kind: "snapshot" }>["result"]["manifest"];
export type Entry = Manifest["entries"][number];
export function inventoryFor(bytes: Uint8Array, chunkBytes: number): ChunkInventory {
  validateChunkInventory({ chunkBytes, chunkHashes: [] }, 0);
  if (Math.ceil(bytes.byteLength / chunkBytes) > 256)
    throw new Error("payload_too_large: negotiated chunk grid cannot represent this file");
  const chunks: ChunkInventory = { chunkBytes, chunkHashes: [] };
  for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes)
    chunks.chunkHashes.push(hash(bytes.subarray(offset, offset + chunkBytes)));
  validateChunkInventory(chunks, bytes.byteLength);
  return chunks;
}
export function checkManifest(
  manifest: Manifest,
  limits: Limits,
  caseBehavior: "sensitive" | "insensitive",
): void {
  validateManifest(manifest, caseBehavior);
  if (
    manifest.entries.length > limits.manifestEntries ||
    manifest.entries.reduce((sum, e) => sum + (e.type === "file" ? e.size : 0), 0) >
      limits.snapshotBytes ||
    manifest.entries.some((e) => e.type === "file" && e.size > limits.fileBytes)
  )
    throw new Error("workspace capacity exceeded");
}
export async function scan(
  root: SafeRoot,
  limits: Limits,
): Promise<{ manifest: Manifest; manifestHash: string }> {
  const entries: Entry[] = [];
  let bytes = 0;
  async function visit(parent?: string): Promise<void> {
    for (const name of await root.entries(parent)) {
      const path = parent ? `${parent}/${name}` : name;
      // Denylisted paths are noncanonical; invalid unexcluded spellings fail rather than silently disappear.
      if (excluded(path)) {
        if (
          /^(\.fortipi|\.git|node_modules|\.cache|\.next|dist|build|coverage|\.env.*|.*\.(key|pem)|\.ssh|\.aws|\.npmrc|\.pnpmrc|credentials.*\.json|auth\.json)$/i.test(
            name,
          )
        )
          continue;
        throw new Error("invalid filesystem path");
      }
      const stat = await root.stat(path);
      if (entries.length >= limits.manifestEntries) throw new Error("manifest capacity");
      if (stat.isDirectory()) {
        entries.push({ path, type: "directory", mode: 493 });
        await visit(path);
      } else {
        const data = await root.read(path, limits.fileBytes);
        bytes += data.length;
        if (bytes > limits.snapshotBytes) throw new Error("snapshot capacity");
        entries.push({
          path,
          type: "file",
          mode:
            process.platform === "win32"
              ? (root.modes.get(path) ?? 420)
              : stat.mode & 0o111
                ? 493
                : 420,
          size: data.length,
          sha256: hash(data),
        });
      }
    }
  }
  await visit();
  const manifest: Manifest = { version: 1, entries };
  checkManifest(manifest, limits, root.identity.caseBehavior);
  return { manifest, manifestHash: await manifestDigest(manifest) };
}
export type Mutation =
  | { kind: "put"; entry: Extract<Entry, { type: "file" }>; blob: string }
  | { kind: "delete"; path: string }
  | { kind: "mkdir"; path: string };
export function differences(
  before: Manifest,
  after: Manifest,
): { path: string; change: "added" | "modified" | "deleted" }[] {
  const a = new Map(before.entries.map((e) => [e.path, e])),
    b = new Map(after.entries.map((e) => [e.path, e]));
  const result: { path: string; change: "added" | "modified" | "deleted" }[] = [];
  for (const [path, entry] of b) {
    const old = a.get(path);
    if (!old) result.push({ path, change: "added" });
    else if (canonicalJson(old) !== canonicalJson(entry)) result.push({ path, change: "modified" });
  }
  for (const path of a.keys()) if (!b.has(path)) result.push({ path, change: "deleted" });
  return result.sort((x, y) => Buffer.compare(Buffer.from(x.path), Buffer.from(y.path)));
}
export function mutationsFor(before: Manifest, after: Manifest): Mutation[] {
  const previous = new Map(before.entries.map((e) => [e.path, e])),
    next = new Map(after.entries.map((e) => [e.path, e]));
  const deletes: Mutation[] = [],
    directories: Mutation[] = [],
    files: Mutation[] = [];
  for (const e of before.entries) {
    const other = next.get(e.path);
    if (!other || other.type !== e.type) deletes.push({ kind: "delete", path: e.path });
  }
  for (const e of after.entries) {
    const old = previous.get(e.path);
    if (old && canonicalJson(old) === canonicalJson(e)) continue;
    if (e.type === "directory") directories.push({ kind: "mkdir", path: e.path });
    else files.push({ kind: "put", entry: e, blob: e.sha256 });
  }
  deletes.sort(
    (a, b) =>
      ("path" in b ? b.path : "").split("/").length - ("path" in a ? a.path : "").split("/").length,
  );
  directories.sort(
    (a, b) =>
      ("path" in a ? a.path : "").split("/").length - ("path" in b ? b.path : "").split("/").length,
  );
  return [...deletes, ...directories, ...files];
}
