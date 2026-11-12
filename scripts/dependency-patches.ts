import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { parse, parseAllDocuments } from "yaml";

export interface DependencyPatch {
  path: string;
  sha256: string;
  source: string;
  reason: string;
  files: Record<string, { originalSha256: string; patchedSha256: string }>;
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const safe = (path: string) =>
  /^[A-Za-z0-9_./@+-]+$/.test(path) &&
  path.split("/").every((part) => part && part !== "." && part !== "..");

/** Declared pnpm transformations retain the authenticated upstream archive identity. */
export async function dependencyPatches(
  root: string,
  installed = false,
): Promise<Record<string, DependencyPatch>> {
  let patches: Record<string, DependencyPatch> = {};
  try {
    patches = JSON.parse(await readFile(resolve(root, "patches/review.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const workspace = parse(await readFile(resolve(root, "pnpm-workspace.yaml"), "utf8"));
  const declarations = Object.fromEntries(
    Object.entries(patches).map(([id, patch]) => [id, patch.path]),
  );
  assert.deepEqual(
    workspace.patchedDependencies ?? {},
    declarations,
    "Unreviewed pnpm patch declaration",
  );
  const documents = parseAllDocuments(await readFile(resolve(root, "pnpm-lock.yaml"), "utf8"));
  assert.equal(documents.length, 2);
  for (const document of documents) assert.equal(document.errors.length, 0);
  const locked = documents[1]?.toJSON().patchedDependencies ?? {};
  assert.deepEqual(
    locked,
    Object.fromEntries(Object.entries(patches).map(([id, patch]) => [id, patch.sha256])),
    "Patch lock identity differs from review",
  );
  for (const [id, patch] of Object.entries(patches)) {
    assert.match(id, /^(?:@[a-z0-9-]+\/)?[a-z0-9-]+@\d+\.\d+\.\d+$/);
    assert.ok(
      safe(patch.path) && patch.path.startsWith("patches/") && patch.path.endsWith(".patch"),
    );
    assert.match(patch.sha256, /^[a-f0-9]{64}$/);
    assert.match(
      patch.source,
      /^https:\/\/github.com\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/(?:commit|blob)\/[a-f0-9]{40}(?:\/.*)?$/,
    );
    assert.ok(patch.reason.length > 0 && Object.keys(patch.files).length > 0);
    const path = resolve(root, patch.path);
    const stat = await lstat(path);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 65536);
    const bytes = await readFile(path);
    assert.equal(hash(bytes), patch.sha256, `Reviewed patch changed: ${id}`);
    const changed = [...bytes.toString().matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)].map(
      (match) => {
        assert.equal(match[1], match[2], "Dependency patches cannot rename files");
        return match[1];
      },
    );
    assert.deepEqual(
      changed.sort(),
      Object.keys(patch.files).sort(),
      "Patch file inventory differs from review",
    );
    const name = id.slice(0, id.lastIndexOf("@"));
    for (const [file, identities] of Object.entries(patch.files)) {
      assert.ok(safe(file));
      assert.match(identities.originalSha256, /^[a-f0-9]{64}$/);
      assert.match(identities.patchedSha256, /^[a-f0-9]{64}$/);
      if (installed) {
        const path = await realpath(resolve(root, "apps/worker/node_modules", name, file));
        assert.ok(path.startsWith(`${await realpath(root)}${sep}`));
        assert.equal(
          hash(await readFile(path)),
          identities.patchedSha256,
          `Installed patch differs: ${id}/${file}`,
        );
      }
    }
  }
  return patches;
}
export function patchStatus(patch: DependencyPatch | undefined): string {
  return patch
    ? `Modified by FortiPi: ${patch.reason}; ${patch.path}; SHA256 ${patch.sha256}; source ${patch.source}`
    : "unmodified upstream archive";
}
