import assert from "node:assert/strict";
import { mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { repository } from "../../build-workspaces.ts";
import { hashFile } from "../../image-source-distribution.ts";
import { importQualifiedImageInputs } from "../../prepare-release.ts";

test("qualified source kit imports exact image inputs without rebuilding; altered SEA and unexpected files reject", {
  timeout: 120000,
}, async () => {
  const input = resolve(repository, "apps/worker/dist/container");
  const metadata = await readFile(resolve(input, "image-metadata.json"));
  const image = JSON.parse(metadata.toString()) as {
    sourceCommit: string;
    sourceKitSha256: string;
    runtimeVerified: boolean;
    registryDigest: string | null;
  };
  const temporary = await mkdtemp(resolve(await realpath(tmpdir()), "fortipi-image-import-"));
  try {
    const imported = resolve(temporary, "imported");
    await importQualifiedImageInputs(input, image.sourceCommit, metadata, imported);
    assert.deepEqual(await readFile(resolve(imported, "image-metadata.json")), metadata);
    assert.equal(
      await hashFile(resolve(imported, "sources-and-notices.tar")),
      image.sourceKitSha256,
    );
    assert.equal(
      await hashFile(resolve(imported, "context/computerd")),
      await hashFile(resolve(input, "context/computerd")),
    );
    assert.equal(
      JSON.parse((await readFile(resolve(imported, "image-metadata.json"))).toString())
        .runtimeVerified,
      image.runtimeVerified,
    );
    assert.equal(
      JSON.parse((await readFile(resolve(imported, "image-metadata.json"))).toString())
        .registryDigest,
      image.registryDigest,
    );
    const binary = await open(resolve(imported, "context/computerd"), "r+");
    const original = Buffer.alloc(1);
    try {
      await binary.read(original, 0, 1, 0);
      await binary.write(Buffer.from([original[0]! ^ 0xff]), 0, 1, 0);
    } finally {
      await binary.close();
    }
    await assert.rejects(
      importQualifiedImageInputs(
        imported,
        image.sourceCommit,
        metadata,
        resolve(temporary, "wrong-sea"),
      ),
      /Qualified image input differs/,
    );
    const restore = await open(resolve(imported, "context/computerd"), "r+");
    try {
      await restore.write(original, 0, 1, 0);
    } finally {
      await restore.close();
    }
    await writeFile(resolve(imported, "context/unexpected.json"), "{}");
    await assert.rejects(
      importQualifiedImageInputs(
        imported,
        image.sourceCommit,
        metadata,
        resolve(temporary, "unexpected"),
      ),
      /Unexpected qualified image input/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
