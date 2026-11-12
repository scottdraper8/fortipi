import assert from "node:assert/strict";
import { lstat, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installConsumer } from "./install-harness.ts";
import { offlineConsumer } from "./offline-consumer.ts";

test("real packs install without workspace links, typecheck strictly, prepare read-only assets and refuse an unisolated offline proof", {
  timeout: 300000,
}, async (t) => {
  const parent = await mkdtemp(join(await realpath(tmpdir()), "fortipi-cli-distribution-"));
  const writable = async (path: string): Promise<void> => {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    await (await import("node:fs/promises")).chmod(path, 0o700);
    for (const name of await readdir(path)) await writable(join(path, name));
  };
  t.after(async () => {
    await writable(parent);
    await rm(parent, { recursive: true, force: true });
  });
  const directory = join(parent, "proof");
  const result = await installConsumer(directory);
  assert.equal(result.strictInstalledConsumer, true);
  assert.equal(result.readOnlyInstall, true);
  assert.equal(result.installedPrepare, true);
  assert.ok(Number(result.publicReviewedArchives) > 0);
  assert.match(String(result.offlineDryBuild), /^not-executed/);
  // This process owns the checkout, so it must not inspect its real home or run Wrangler.
  await assert.rejects(
    offlineConsumer(join(directory, "distribution.json")),
    process.platform === "linux" ? /Dedicated OS identity required/ : /disposable Linux identity/,
  );
});
