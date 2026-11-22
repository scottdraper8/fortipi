import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { c as createTar } from "tar";
import { verifyBuildMetadata, verifyImageArchive } from "../../container/image-archive.ts";

test("saved OCI bytes distinguish built manifest and config and reject changed graph bytes", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "fortipi-image-archive-"));
  const hash = (bytes: string | Uint8Array) =>
    `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const layer = Buffer.from("independent layer fixture\n");
  const config = JSON.stringify({
    os: "linux",
    architecture: "amd64",
    rootfs: { type: "layers", diff_ids: [hash(layer)] },
  });
  const configDescriptor = {
    mediaType: "application/vnd.oci.image.config.v1+json",
    digest: hash(config),
    size: Buffer.byteLength(config),
  };
  const manifest = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: configDescriptor,
    layers: [
      {
        mediaType: "application/vnd.oci.image.layer.v1.tar",
        digest: hash(layer),
        size: layer.length,
      },
    ],
  });
  const selected = {
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    digest: hash(manifest),
    size: Buffer.byteLength(manifest),
  };
  const index = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [selected],
  });
  const path = (digest: string) => `blobs/sha256/${digest.slice(7)}`;
  const files = [
    "index.json",
    "oci-layout",
    path(hash(layer)),
    path(hash(config)),
    path(hash(manifest)),
  ];
  async function archive(): Promise<string> {
    const file = resolve(root, "image.tar");
    await createTar({ cwd: root, file, portable: true }, files);
    return file;
  }
  try {
    await mkdir(resolve(root, "blobs/sha256"), { recursive: true });
    for (const [name, bytes] of [
      ["index.json", index],
      ["oci-layout", '{"imageLayoutVersion":"1.0.0"}'],
      [path(hash(layer)), layer],
      [path(hash(config)), config],
      [path(hash(manifest)), manifest],
    ] as const)
      await writeFile(resolve(root, name), bytes);
    const saved = await verifyImageArchive(await archive(), hash(config));
    assert.equal(saved.loadedIdentityKind, "config");
    const containerd = await verifyImageArchive(await archive(), hash(manifest));
    assert.equal(containerd.loadedIdentityKind, "manifest");
    assert.deepEqual(
      verifyBuildMetadata(
        { "containerimage.digest": hash(manifest), "containerimage.descriptor": selected },
        containerd,
      ),
      { exporterDigest: hash(manifest), exporterDigestKind: "manifest" },
      "Containerd manifest identity was incorrectly treated as a classic-store config",
    );
    assert.equal(saved.manifest.digest, hash(manifest));
    assert.notEqual(saved.manifest.digest, saved.config.digest);
    assert.deepEqual(
      verifyBuildMetadata(
        { "containerimage.digest": hash(config), "containerimage.descriptor": configDescriptor },
        saved,
      ),
      { exporterDigest: hash(config), exporterDigestKind: "config" },
    );
    assert.equal(
      verifyBuildMetadata(
        { "containerimage.digest": hash(config), "containerimage.config.digest": hash(config) },
        saved,
      ).exporterDigestKind,
      "config",
    );
    assert.equal(
      verifyBuildMetadata(
        { "containerimage.digest": hash(manifest), "containerimage.descriptor": selected },
        saved,
      ).exporterDigestKind,
      "manifest",
    );
    assert.throws(() =>
      verifyBuildMetadata({ "containerimage.digest": `sha256:${"0".repeat(64)}` }, saved),
    );
    assert.throws(() =>
      verifyBuildMetadata(
        { "containerimage.digest": hash(config), "containerimage.config.digest": hash(layer) },
        saved,
      ),
    );
    await assert.rejects(verifyImageArchive(await archive(), hash(layer)), /loaded image identity/);
    await writeFile(resolve(root, path(hash(layer))), Buffer.from("changed layer fixture\n"));
    await assert.rejects(verifyImageArchive(await archive(), hash(config)), /hash mismatch/);
    await writeFile(resolve(root, path(hash(layer))), layer);
    await writeFile(
      resolve(root, "index.json"),
      JSON.stringify({ schemaVersion: 2, manifests: [{ ...selected, size: selected.size + 1 }] }),
    );
    await assert.rejects(verifyImageArchive(await archive(), hash(config)), /length mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("containerd gzip descriptors verify compressed bytes and ordered decompressed DiffIDs", {
  timeout: 10000,
}, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "fortipi-compressed-image-"));
  const hash = (bytes: string | Uint8Array) =>
    `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  try {
    await writeFile(resolve(root, "canary.txt"), "actual tar-layer bytes\n");
    await createTar({ cwd: root, file: resolve(root, "layer.tar"), portable: true }, [
      "canary.txt",
    ]);
    const layer = await readFile(resolve(root, "layer.tar"));
    const compressed = gzipSync(layer);
    assert.notEqual(hash(compressed), hash(layer));
    await mkdir(resolve(root, "blobs/sha256"), { recursive: true });
    async function image(
      bytes: Uint8Array,
      diffId: string,
      docker = false,
    ): Promise<{ archive: string; imageId: string }> {
      const prefix = docker ? "application/vnd.docker" : "application/vnd.oci";
      const config = JSON.stringify({
        os: "linux",
        architecture: "amd64",
        rootfs: { type: "layers", diff_ids: [diffId] },
      });
      const manifest = JSON.stringify({
        schemaVersion: 2,
        mediaType: docker
          ? `${prefix}.distribution.manifest.v2+json`
          : `${prefix}.image.manifest.v1+json`,
        config: {
          mediaType: docker
            ? `${prefix}.container.image.v1+json`
            : `${prefix}.image.config.v1+json`,
          digest: hash(config),
          size: Buffer.byteLength(config),
        },
        layers: [
          {
            mediaType: docker
              ? `${prefix}.image.rootfs.diff.tar.gzip`
              : `${prefix}.image.layer.v1.tar+gzip`,
            digest: hash(bytes),
            size: bytes.length,
          },
        ],
      });
      const imageId = hash(manifest);
      const index = JSON.stringify({
        schemaVersion: 2,
        manifests: [
          {
            mediaType: docker
              ? `${prefix}.distribution.manifest.v2+json`
              : `${prefix}.image.manifest.v1+json`,
            digest: imageId,
            size: Buffer.byteLength(manifest),
          },
        ],
      });
      const files = new Map<string, string | Uint8Array>([
        ["oci-layout", '{"imageLayoutVersion":"1.0.0"}'],
        ["index.json", index],
        [`blobs/sha256/${imageId.slice(7)}`, manifest],
        [`blobs/sha256/${hash(config).slice(7)}`, config],
        [`blobs/sha256/${hash(bytes).slice(7)}`, bytes],
      ]);
      for (const [path, value] of files) await writeFile(resolve(root, path), value);
      const archive = resolve(root, "image.tar");
      await createTar({ cwd: root, file: archive, portable: true }, [...files.keys()]);
      return { archive, imageId };
    }
    for (const docker of [false, true]) {
      const built = await image(compressed, hash(layer), docker);
      const saved = await verifyImageArchive(built.archive, built.imageId);
      assert.equal(saved.loadedIdentityKind, "manifest");
      assert.equal(saved.layers[0]?.digest, hash(compressed));
    }
    const wrongDiff = await image(compressed, hash(Buffer.from("different decompressed layer")));
    await assert.rejects(
      verifyImageArchive(wrongDiff.archive, wrongDiff.imageId),
      /DiffID mismatch/,
    );
    const damaged = Uint8Array.from(compressed);
    const last = damaged.length - 1;
    damaged[last] = (damaged[last] ?? 0) ^ 255;
    const corrupt = await image(damaged, hash(layer));
    await assert.rejects(
      verifyImageArchive(corrupt.archive, corrupt.imageId),
      /Compressed layer validation/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
