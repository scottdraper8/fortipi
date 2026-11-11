import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { TextDecoder } from "node:util";
import { createGunzip } from "node:zlib";
import { t as listTar } from "tar";
import {
  assertRuntimeConfig,
  filePolicy,
  type ImageConfig,
  type PrunePolicy,
} from "./image-prune.ts";
import { applyLayer, type FsEntry, scanRootfs } from "./rootfs.ts";

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
interface DiagnosticDescriptor extends Descriptor {
  role: "child" | "config" | "layer";
  inSelectedGraph: boolean;
}
type OCIDiagnostic =
  | { type: "unknown" }
  | { type: "oci-index" | "oci-manifest"; descriptors: DiagnosticDescriptor[] };

/** Describe bounded retained metadata only; this never admits an archive member. */
export function describeOCI(
  bytes: Buffer | undefined,
  expectedDigest: string,
  graph: readonly Descriptor[],
  budget: number,
): OCIDiagnostic {
  const unknown = { type: "unknown" } as const;
  if (
    !bytes ||
    bytes.length > 8192 ||
    !Number.isSafeInteger(budget) ||
    budget < 0 ||
    budget > 16 ||
    `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== expectedDigest
  )
    return unknown;
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const annotations = (value: unknown) =>
    value === undefined ||
    (object(value) && Object.values(value).every((item) => typeof item === "string"));
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
    if (!object(value) || value.schemaVersion !== 2 || !annotations(value.annotations))
      return unknown;
    const index = value.mediaType === "application/vnd.oci.image.index.v1+json";
    if (!index && value.mediaType !== manifestTypes[0]) return unknown;
    const keys = index
      ? ["schemaVersion", "mediaType", "manifests", "annotations"]
      : ["schemaVersion", "mediaType", "config", "layers", "annotations"];
    if (!Object.keys(value).every((key) => keys.includes(key))) return unknown;
    const values = index ? value.manifests : value.layers;
    if (!Array.isArray(values) || values.length + (index ? 0 : 1) > budget) return unknown;
    const descriptors: DiagnosticDescriptor[] = [];
    const inputs: [unknown, DiagnosticDescriptor["role"]][] = index
      ? values.map((item) => [item, "child"])
      : [[value.config, "config"], ...values.map((item): [unknown, "layer"] => [item, "layer"])];
    for (const [input, role] of inputs) {
      const types =
        role === "child"
          ? ["application/vnd.oci.image.index.v1+json", ...manifestTypes]
          : role === "config"
            ? configTypes
            : [layerType, ...gzipTypes];
      if (
        !object(input) ||
        !Object.keys(input).every((key) =>
          ["mediaType", "digest", "size", "annotations", "platform"].includes(key),
        ) ||
        typeof input.mediaType !== "string" ||
        !types.includes(input.mediaType) ||
        typeof input.digest !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(input.digest) ||
        !Number.isSafeInteger(input.size) ||
        Number(input.size) < 0 ||
        !annotations(input.annotations)
      )
        return unknown;
      if (input.platform !== undefined) {
        if (
          !object(input.platform) ||
          !Object.entries(input.platform).every(([key, item]) =>
            ["architecture", "os", "os.version", "variant"].includes(key)
              ? typeof item === "string"
              : ["os.features", "features"].includes(key) &&
                Array.isArray(item) &&
                item.length <= 16 &&
                item.every((entry) => typeof entry === "string"),
          )
        )
          return unknown;
      }
      const descriptor = {
        role,
        mediaType: input.mediaType,
        digest: input.digest,
        size: Number(input.size),
      };
      descriptors.push({
        ...descriptor,
        inSelectedGraph: graph.some(
          (selected) =>
            selected.mediaType === descriptor.mediaType &&
            selected.digest === descriptor.digest &&
            selected.size === descriptor.size,
        ),
      });
    }
    return { type: index ? "oci-index" : "oci-manifest", descriptors };
  } catch {
    return unknown;
  }
}
export interface SavedImage {
  manifest: Descriptor;
  config: Descriptor;
  layers: Descriptor[];
  indexSha256: string;
  loadedIdentityKind: "config" | "manifest";
}

/** Hash the actual Docker-save OCI graph, independently of exporter metadata labels. */
export async function inspectImageArchive(
  file: string,
  imageId: string,
  options: { filesystem?: boolean; pruning?: PrunePolicy } = {},
): Promise<{ saved: SavedImage; filesystem: Map<string, FsEntry>; configuration: ImageConfig }> {
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
    config?: ImageConfig;
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
  if (options.pruning) {
    assertRuntimeConfig(config.config ?? {});
    for (const member of members.values())
      assert.ok(
        !options.pruning.forbiddenLayers.includes(member.digest),
        "Original binary-bearing base blob conveyed",
      );
    for (const diff of config.rootfs.diff_ids)
      assert.ok(
        !options.pruning.forbiddenLayers.includes(diff),
        "Original binary-bearing base DiffID conveyed",
      );
    const allowed = new Set([
      "index.json",
      "oci-layout",
      `blobs/sha256/${selected.digest.slice(7)}`,
      `blobs/sha256/${manifest.config.digest.slice(7)}`,
      ...manifest.layers.map((layer) => `blobs/sha256/${layer.digest.slice(7)}`),
    ]);
    if (members.has("manifest.json")) {
      const compatibility = json<{ Config: string; Layers: string[] }[]>("manifest.json");
      assert.equal(compatibility.length, 1, "Multiple compatibility images conveyed");
      const item = compatibility[0];
      assert.ok(item);
      assert.equal(
        members.get(item.Config)?.digest,
        manifest.config.digest,
        "Compatibility config changed",
      );
      assert.equal(item.Layers.length, manifest.layers.length, "Compatibility layers changed");
      allowed.add("manifest.json");
      allowed.add(item.Config);
      for (const [index, path] of item.Layers.entries()) {
        assert.ok(
          members.get(path)?.digest === manifest.layers[index]?.digest ||
            members.get(path)?.digest === config.rootfs.diff_ids[index],
          "Compatibility layer is not a verified layer",
        );
        allowed.add(path);
      }
    }
    if (members.has("repositories")) {
      const repositories = json<Record<string, Record<string, string>>>("repositories");
      assert.ok(
        repositories && typeof repositories === "object" && !Array.isArray(repositories),
        "Invalid compatibility repositories",
      );
      for (const tags of Object.values(repositories)) {
        assert.ok(
          tags && typeof tags === "object" && !Array.isArray(tags),
          "Invalid compatibility tags",
        );
        for (const digest of Object.values(tags))
          assert.match(digest, /^[a-f0-9]{64}$/, "Invalid compatibility repository identity");
      }
      allowed.add("repositories");
    }
    const unexpected = [...members].filter(([path]) => !allowed.has(path));
    let descriptorBudget = 16;
    if (unexpected.length)
      console.error(
        JSON.stringify({
          probe: "image-unreferenced-members",
          members: unexpected.slice(0, 4).map(([path, member]) => {
            const blob = /^blobs\/sha256\/([a-f0-9]{64})$/.exec(path);
            if (blob) {
              const description = describeOCI(
                member.bytes?.length === member.size ? member.bytes : undefined,
                `sha256:${blob[1]}`,
                [selected, manifest.config, ...manifest.layers],
                descriptorBudget,
              );
              if (description.type !== "unknown")
                descriptorBudget -= description.descriptors.length;
              return {
                class: "oci-blob",
                declaredSha256: `sha256:${blob[1]}`,
                actualSha256: member.digest,
                size: member.size,
                ...description,
              };
            }
            return {
              class:
                /^(?:[a-f0-9]{64}\/(?:json|VERSION|layer\.tar)|index\.json|oci-layout|manifest\.json|repositories)$/.test(
                  path,
                )
                  ? "known-layout"
                  : "other",
              nameSha256: createHash("sha256").update(path).digest("hex"),
            };
          }),
        }),
      );
    for (const path of members.keys())
      assert.ok(allowed.has(path), "Unexpected or unreferenced conveyed image file/blob");
  }
  const filesystem = new Map<string, FsEntry>();
  if (options.filesystem || options.pruning) {
    const layers = new Map(
      manifest.layers.map((layer, index) => [
        `blobs/sha256/${layer.digest.slice(7)}`,
        { layer, index },
      ]),
    );
    const inventories: (Map<string, FsEntry> | undefined)[] = [];
    const tasks: Promise<void>[] = [],
      failures: unknown[] = [];
    await listTar({
      file,
      strict: true,
      noResume: true,
      filter: (path) => layers.has(path.replace(/^\.\//, "")),
      onReadEntry(entry) {
        const item = layers.get(entry.path.replace(/^\.\//, ""));
        if (!item) return entry.resume();
        const hash = createHash("sha256");
        let size = 0;
        const meter = new Transform({
          transform(bytes: Buffer, _encoding, callback) {
            hash.update(bytes);
            size += bytes.length;
            callback(null, bytes);
          },
        });
        const policy = options.pruning ? filePolicy(options.pruning) : undefined;
        const scan = async (source: AsyncIterable<Uint8Array>) => {
          const iterator = source[Symbol.asyncIterator]();
          // A format/policy rejection still drains the containing tar member so
          // the outer parser can finish and surface the bounded failure.
          const readable = { [Symbol.asyncIterator]: () => ({ next: () => iterator.next() }) };
          try {
            inventories[item.index] = await scanRootfs(readable, policy);
          } catch (error) {
            while (!(await iterator.next()).done) {}
            throw error;
          }
        };
        const task = (
          gzipTypes.includes(item.layer.mediaType)
            ? pipeline(Readable.from(entry), meter, createGunzip(), scan)
            : pipeline(Readable.from(entry), meter, scan)
        )
          .then(() => {
            assert.equal(size, item.layer.size);
            assert.equal(
              `sha256:${hash.digest("hex")}`,
              item.layer.digest,
              "Inspected filesystem layer changed",
            );
          })
          .catch((error: unknown) => {
            failures.push(error);
          });
        tasks.push(task);
      },
    });
    await Promise.all(tasks);
    assert.equal(
      failures.length,
      0,
      `Filesystem layer validation failed: ${String(failures[0] ?? "")}`,
    );
    assert.equal(inventories.length, manifest.layers.length, "Missing filesystem layer");
    for (const inventory of inventories) {
      assert.ok(inventory, "Missing filesystem layer");
      applyLayer(filesystem, inventory);
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
    saved: {
      manifest: selected,
      config: manifest.config,
      layers: manifest.layers,
      indexSha256: indexMember.digest.slice(7),
      loadedIdentityKind: imageId === manifest.config.digest ? "config" : "manifest",
    },
    filesystem,
    configuration: config.config ?? {},
  };
}

export async function verifyImageArchive(file: string, imageId: string): Promise<SavedImage> {
  return (await inspectImageArchive(file, imageId)).saved;
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
