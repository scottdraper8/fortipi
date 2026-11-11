import {
  canonicalJson,
  effectiveLimits,
  manifestDigest,
  validateManifest,
  validateRelativePath,
} from "fortipi-contract";
import type * as D from "../boundary/dto.js";
import { requireThat } from "./errors.js";

export { validateRelativePath };
export function checkedManifest(manifest: D.Manifest, policy: D.InfrastructurePolicy): D.Manifest {
  const limits = effectiveLimits(policy);
  try {
    validateManifest(manifest, "insensitive");
  } catch {
    requireThat(false, "invalid_request", "Invalid or excluded manifest path, mode, size or alias");
  }
  requireThat(
    manifest.entries.length <= limits.manifestEntries &&
      snapshotBytes(manifest) <= limits.snapshotBytes &&
      manifest.entries.every((entry) => entry.type !== "file" || entry.size <= limits.fileBytes),
    "quota_exceeded",
    "Snapshot exceeds effective workspace bounds",
  );
  requireThat(
    new TextEncoder().encode(canonicalJson(manifest)).length <= 512 * 1024,
    "payload_too_large",
    "Manifest too large",
  );
  return structuredClone(manifest);
}
export { manifestDigest };
export function snapshotBytes(manifest: D.Manifest): number {
  return manifest.entries.reduce((sum, entry) => sum + (entry.type === "file" ? entry.size : 0), 0);
}
export function applyMutations(base: D.Manifest, mutations: D.Mutation[]): D.Manifest {
  const entries = new Map(base.entries.map((entry) => [entry.path, entry]));
  for (const mutation of mutations) {
    validateRelativePath(mutation.path);
    if (mutation.kind === "delete") {
      for (const path of entries.keys())
        if (path === mutation.path || path.startsWith(`${mutation.path}/`)) entries.delete(path);
    } else if (mutation.kind === "mkdir")
      entries.set(mutation.path, { path: mutation.path, type: "directory", mode: 493 });
    else {
      entries.set(mutation.path, {
        path: mutation.path,
        type: "file",
        mode: mutation.mode,
        size: mutation.size,
        sha256: mutation.sha256,
      });
    }
  }
  return { version: 1, entries: [...entries.values()] };
}
