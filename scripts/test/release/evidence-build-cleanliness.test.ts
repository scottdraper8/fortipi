import assert from "node:assert/strict";
import test from "node:test";
import { projectEvidenceBuildCleanliness } from "../../evidence-build-cleanliness.ts";

test("cleanliness preserves tracked changes and rename/copy origins without unlisted names", () => {
  const canary = "private-unlisted-path-canary";
  const inventory =
    "scripts/build-workspaces.ts\0scripts/current-candidate-read.ts\0scripts/verify-foundation.ts\0scripts/install-dependencies.ts\0";
  const status =
    " M scripts/build-workspaces.ts\0D  scripts/current-candidate-read.ts\0" +
    `R  ${canary}-rename\0scripts/verify-foundation.ts\0` +
    `C  ${canary}-copy\0scripts/install-dependencies.ts\0?? ${canary}/\0`;
  const result = projectEvidenceBuildCleanliness(inventory, status);
  assert.deepEqual(result, {
    dirty: true,
    entries: 5,
    unlistedPaths: 3,
    omittedPaths: 0,
    paths: [
      { status: " M", path: "scripts/build-workspaces.ts" },
      { status: "D ", path: "scripts/current-candidate-read.ts" },
      { status: "C ", path: "scripts/install-dependencies.ts" },
      { status: "R ", path: "scripts/verify-foundation.ts" },
    ],
  });
  assert.equal(JSON.stringify(result).includes(canary), false);
});

test("untracked-only changes remain dirty when no path can be emitted", () => {
  const inventory = "scripts/build-workspaces.ts\0";
  assert.deepEqual(projectEvidenceBuildCleanliness(inventory, "?? private-directory/\0"), {
    dirty: true,
    entries: 1,
    unlistedPaths: 1,
    omittedPaths: 0,
    paths: [],
  });
  assert.deepEqual(projectEvidenceBuildCleanliness(inventory, ""), {
    dirty: false,
    entries: 0,
    unlistedPaths: 0,
    omittedPaths: 0,
    paths: [],
  });
});

test("cleanliness bounds sorted paths and rejects malformed data even after the output cap", () => {
  const names = Array.from(
    { length: 40 },
    (_, i) => `scripts/file-${String(i).padStart(2, "0")}.ts`,
  );
  const oversized = `scripts/${"x".repeat(520)}.ts`;
  const inventory = [...names, oversized].join("\0") + "\0";
  const status =
    [...names]
      .reverse()
      .map((path) => ` M ${path}\0`)
      .join("") + ` M ${oversized}\0`;
  const result = projectEvidenceBuildCleanliness(inventory, status);
  assert.equal(result.dirty, true);
  assert.equal(result.entries, 41);
  assert.equal(result.omittedPaths, 9);
  assert.deepEqual(
    result.paths,
    names.slice(0, 32).map((path) => ({ status: " M", path })),
  );
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 20000);
  for (const malformed of [
    " M scripts/file-00.ts",
    "R  scripts/file-00.ts\0",
    "C  scripts/file-00.ts\0",
    "   scripts/file-00.ts\0",
    " M \0",
    " M scripts/\nprivate-control-canary\0",
    "?? private/\0\0",
    `${status}ZZ private-malformed-canary\0`,
  ]) {
    assert.throws(() => projectEvidenceBuildCleanliness(inventory, malformed), {
      name: "Error",
      message: "Invalid Git cleanliness data",
    });
  }
  assert.throws(() => projectEvidenceBuildCleanliness("scripts/file-00.ts", ""), {
    message: "Invalid Git cleanliness data",
  });
});
