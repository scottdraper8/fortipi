import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { t as listTar } from "tar";

const manifestTypes = [
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
];
const configTypes = [
  "application/vnd.oci.image.config.v1+json",
  "application/vnd.docker.container.image.v1+json",
];
const layerType = "application/vnd.oci.image.layer.v1.tar";
const gzipTypes = [
  "application/vnd.oci.image.layer.v1.tar+gzip",
  "application/vnd.docker.image.rootfs.diff.tar.gzip",
];
interface Descriptor {
  mediaType: string;
  digest: string;
  size: number;
}
interface Member {
  digest: string;
  size: number;
  bytes?: Buffer;
}
export interface SavedImage {
  manifest: Descriptor;
  config: Descriptor;
  layers: Descriptor[];
  indexSha256: string;
  loadedIdentityKind: "config" | "manifest";
}

/** Hash the actual Docker-save OCI graph, independently of exporter metadata labels. */
export async function verifyImageArchive(file: string, imageId: string): Promise<SavedImage> {
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
  const members = new Map<string, Member>();
  const names = new Set<string>();
  let invalid = false;
  let buffered = 0;
  await listTar({
    file,
    strict: true,
    onReadEntry(entry) {
      if (entry.type === "Directory" && (entry.path === "." || entry.path === "./"))
        return entry.resume();
      const path = entry.path.replace(/^\.\//, "").replace(/\/$/, "");
      if (
        !path ||
        path.startsWith("/") ||
        path.includes("\\") ||
        path.split("/").some((part) => part === ".." || part === ".") ||
        names.has(path) ||
        (entry.type !== "File" && entry.type !== "Directory") ||
        names.size >= 4096
      )
        invalid = true;
      names.add(path);
      if (entry.type !== "File") return entry.resume();
      const hash = createHash("sha256");
      const parts: Buffer[] = [];
      const keep = entry.size <= 1024 * 1024 && buffered + entry.size <= 16 * 1024 * 1024;
      if (entry.size <= 1024 * 1024 && !keep) invalid = true;
      if (keep) buffered += entry.size;
      let size = 0;
      entry.on("data", (bytes: Buffer) => {
        hash.update(bytes);
        size += bytes.length;
        if (keep) parts.push(bytes);
      });
      entry.on("end", () => {
        if (size !== entry.size) invalid = true;
        members.set(path, {
          digest: `sha256:${hash.digest("hex")}`,
          size,
          ...(keep ? { bytes: Buffer.concat(parts) } : {}),
        });
      });
      entry.resume();
    },
  });
  assert.equal(invalid, false, "Unsafe, duplicate or truncated image archive member");
  function json<T>(path: string): T {
    const bytes = members.get(path)?.bytes;
    assert.ok(bytes, `Missing or oversized image metadata ${path}`);
    return JSON.parse(bytes.toString("utf8")) as T;
  }
  function descriptor(input: Descriptor, types: string[]): Member {
    assert.ok(types.includes(input.mediaType), "Unexpected saved image media type");
    assert.match(input.digest, /^sha256:[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(input.size) && input.size >= 0);
    const member = members.get(`blobs/sha256/${input.digest.slice(7)}`);
    assert.ok(member, "Missing saved image descriptor bytes");
    assert.equal(member.digest, input.digest, "Saved image descriptor hash mismatch");
    assert.equal(member.size, input.size, "Saved image descriptor length mismatch");
    return member;
  }
  assert.equal(json<{ imageLayoutVersion: string }>("oci-layout").imageLayoutVersion, "1.0.0");
  const index = json<{ schemaVersion: number; manifests: Descriptor[] }>("index.json");
  assert.equal(index.schemaVersion, 2);
  assert.equal(index.manifests.length, 1, "Only one built image may be exported");
  const selected = index.manifests[0];
  assert.ok(selected);
  descriptor(selected, manifestTypes);
  const manifest = json<{
    schemaVersion: number;
    mediaType: string;
    config: Descriptor;
    layers: Descriptor[];
  }>(`blobs/sha256/${selected.digest.slice(7)}`);
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.mediaType, selected.mediaType);
  descriptor(manifest.config, configTypes);
  assert.ok(
    imageId === manifest.config.digest || imageId === selected.digest,
    "Saved graph differs from loaded image identity",
  );
  const config = json<{
    os: string;
    architecture: string;
    rootfs: { type: string; diff_ids: string[] };
  }>(`blobs/sha256/${manifest.config.digest.slice(7)}`);
  assert.equal(config.os, "linux");
  assert.equal(config.architecture, "amd64");
  assert.equal(config.rootfs.type, "layers");
  assert.ok(manifest.layers.length > 0 && manifest.layers.length <= 128);
  assert.equal(config.rootfs.diff_ids.length, manifest.layers.length);
  const compressed = new Map<string, { layer: Descriptor; diffId: string }>();
  for (const [index, layer] of manifest.layers.entries()) {
    descriptor(layer, [layerType, ...gzipTypes]);
    const diffId = config.rootfs.diff_ids[index];
    assert.ok(diffId);
    assert.match(diffId, /^sha256:[a-f0-9]{64}$/);
    if (layer.mediaType === layerType)
      assert.equal(layer.digest, diffId, "Uncompressed layer DiffID mismatch");
    else {
      const path = `blobs/sha256/${layer.digest.slice(7)}`;
      assert.ok(
        !compressed.has(path) || compressed.get(path)?.diffId === diffId,
        "Repeated layer DiffID changed",
      );
      compressed.set(path, { layer, diffId });
    }
  }
  // Containerd preserves compressed blobs. DiffIDs hash decompressed tar bytes,
  // whereas descriptors hash compressed bytes; verify both without extracting files.
  if (compressed.size) {
    const pending: Promise<void>[] = [];
    const failures: unknown[] = [];
    const completed = new Set<string>();
    let expanded = 0;
    await listTar({
      file,
      strict: true,
      noResume: true,
      filter: (path) => compressed.has(path.replace(/^\.\//, "")),
      onReadEntry(entry) {
        const path = entry.path.replace(/^\.\//, "");
        const expected = compressed.get(path);
        if (!expected) return entry.resume();
        const raw = createHash("sha256");
        const unpacked = createHash("sha256");
        let rawSize = 0;
        const checkRaw = new Transform({
          transform(bytes: Buffer, _encoding, callback) {
            raw.update(bytes);
            rawSize += bytes.length;
            callback(null, bytes);
          },
        });
        const task = pipeline(
          Readable.from(entry),
          checkRaw,
          createGunzip(),
          async (source) => {
            for await (const bytes of source) {
              expanded += bytes.length;
              assert.ok(
                expanded <= 2 * 1024 * 1024 * 1024,
                "Expanded image layers exceed build bound",
              );
              unpacked.update(bytes);
            }
          },
          { signal: AbortSignal.timeout(120000) },
        )
          .then(() => {
            assert.equal(rawSize, expected.layer.size, "Compressed layer length changed");
            assert.equal(
              `sha256:${raw.digest("hex")}`,
              expected.layer.digest,
              "Compressed layer hash changed",
            );
            assert.equal(
              `sha256:${unpacked.digest("hex")}`,
              expected.diffId,
              "Compressed layer DiffID mismatch",
            );
            completed.add(path);
          })
          .catch((error: unknown) => {
            failures.push(error);
          });
        pending.push(task);
      },
    });
    await Promise.all(pending);
    assert.equal(
      failures.length,
      0,
      `Compressed layer validation failed: ${String(failures[0] ?? "")}`,
    );
    assert.equal(completed.size, compressed.size, "Missing compressed layer");
  }
  const indexMember = members.get("index.json");
  assert.ok(indexMember);
  return {
    manifest: selected,
    config: manifest.config,
    layers: manifest.layers,
    indexSha256: indexMember.digest.slice(7),
    loadedIdentityKind: imageId === manifest.config.digest ? "config" : "manifest",
  };
}

/** Classic Moby reports its config as containerimage.digest; that is not a manifest. */
export function verifyBuildMetadata(
  built: {
    "containerimage.digest"?: string;
    "containerimage.config.digest"?: string;
    "containerimage.descriptor"?: Descriptor;
  },
  saved: SavedImage,
): { exporterDigest: string; exporterDigestKind: "config" | "manifest" } {
  const digest = built["containerimage.digest"];
  assert.ok(digest, "Missing actual build exporter digest");
  assert.ok(
    digest === saved.config.digest || digest === saved.manifest.digest,
    "Build exporter identity mismatch",
  );
  const config = built["containerimage.config.digest"];
  if (config !== undefined)
    assert.equal(config, saved.config.digest, "Build config identity mismatch");
  const descriptor = built["containerimage.descriptor"];
  if (descriptor) {
    const expected = configTypes.includes(descriptor.mediaType) ? saved.config : saved.manifest;
    assert.equal(descriptor.mediaType, expected.mediaType);
    assert.equal(descriptor.digest, expected.digest);
    assert.equal(descriptor.size, expected.size);
  }
  return {
    exporterDigest: digest,
    exporterDigestKind: digest === saved.config.digest ? "config" : "manifest",
  };
}
