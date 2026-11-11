import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { c as tar } from "tar";
import { inspectImageArchive } from "./image-archive.ts";
import {
  assertDistinctStores,
  assertEmptyStore,
  assertImportedImage,
  singleImportedImage,
} from "./recipient.ts";

const digest = (digit: string) => `sha256:${digit.repeat(64)}`;
const config = {
  Env: [
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "PORT=8080",
    "MOUNT_POINT=/workspace",
    "FUSE_MOUNT=auto",
  ],
  User: "0:0",
  WorkingDir: "/",
  Entrypoint: ["/usr/local/bin/computerd"],
  Cmd: [],
  StopSignal: "SIGTERM",
  ExposedPorts: { "8080/tcp": {} },
};
const graph = {
  saved: {
    manifest: {
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest: digest("a"),
      size: 600,
    },
    config: {
      mediaType: "application/vnd.oci.image.config.v1+json",
      digest: digest("b"),
      size: 300,
    },
    layers: [
      { mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", digest: digest("c"), size: 100 },
    ],
    indexSha256: "d".repeat(64),
    loadedIdentityKind: "manifest" as const,
  },
  configuration: config,
  diffIds: [digest("e")],
};
const image = {
  Id: graph.saved.config.digest,
  Os: "linux",
  Architecture: "amd64",
  RootFS: { Type: "layers", Layers: graph.diffIds },
  Config: config,
};

test("an untagged imported image is selected only when it is the sole valid identity", () => {
  assert.equal(singleImportedImage([digest("a")]), digest("a"));
  assert.equal(singleImportedImage([digest("a"), digest("a")]), digest("a"));
  for (const ids of [
    [],
    [""],
    ["arbitrary-tag"],
    [digest("a"), digest("b")],
    Array.from({ length: 9 }, () => digest("a")),
  ])
    assert.throws(() => singleImportedImage(ids));
});

test("recipient identity oracle uses the strict canonical archive's ordered uncompressed DiffIDs", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "fortipi-recipient-input-"));
  const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  try {
    const layers: Buffer[] = [];
    for (const value of ["first", "second"]) {
      await writeFile(resolve(directory, "public-file"), value);
      layers.push(await tar({ cwd: directory, portable: true }, ["public-file"]).concat());
    }
    const encoded = layers.map((layer) => gzipSync(layer));
    const configuration = Buffer.from(
      JSON.stringify({
        os: "linux",
        architecture: "amd64",
        config,
        rootfs: { type: "layers", diff_ids: layers.map((bytes) => `sha256:${sha(bytes)}`) },
      }),
    );
    const descriptor = (bytes: Buffer, mediaType: string) => ({
      mediaType,
      digest: `sha256:${sha(bytes)}`,
      size: bytes.length,
    });
    const selectedConfig = descriptor(configuration, "application/vnd.oci.image.config.v1+json");
    const manifest = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        config: selectedConfig,
        layers: encoded.map((bytes) =>
          descriptor(bytes, "application/vnd.oci.image.layer.v1.tar+gzip"),
        ),
      }),
    );
    await mkdir(resolve(directory, "blobs/sha256"), { recursive: true });
    const paths = ["index.json", "oci-layout"];
    for (const bytes of [configuration, manifest, ...encoded]) {
      const path = `blobs/sha256/${sha(bytes)}`;
      await writeFile(resolve(directory, path), bytes);
      paths.push(path);
    }
    await writeFile(
      resolve(directory, "index.json"),
      JSON.stringify({
        schemaVersion: 2,
        manifests: [descriptor(manifest, "application/vnd.oci.image.manifest.v1+json")],
      }),
    );
    await writeFile(resolve(directory, "oci-layout"), '{"imageLayoutVersion":"1.0.0"}');
    const archive = resolve(directory, "canonical.tar");
    await tar({ cwd: directory, file: archive }, paths);
    const checked = await inspectImageArchive(archive, selectedConfig.digest, {
      pruning: { removed: [], executables: [], aliases: [], forbiddenLayers: [] },
    });
    assert.deepEqual(
      checked.diffIds,
      layers.map((bytes) => `sha256:${sha(bytes)}`),
    );
    assert.notDeepEqual(
      checked.diffIds,
      encoded.map((bytes) => `sha256:${sha(bytes)}`),
    );
    const imported = {
      ...image,
      Id: checked.saved.config.digest,
      RootFS: { Type: "layers", Layers: checked.diffIds },
    };
    assertImportedImage(imported, checked);
    assert.throws(() =>
      assertImportedImage(
        { ...imported, RootFS: { Type: "layers", Layers: [...checked.diffIds].reverse() } },
        checked,
      ),
    );
    await writeFile(resolve(directory, paths[2] ?? ""), "changed selected blob");
    await tar({ cwd: directory, file: archive }, paths);
    await assert.rejects(
      inspectImageArchive(archive, selectedConfig.digest, {
        pruning: { removed: [], executables: [], aliases: [], forbiddenLayers: [] },
      }),
      /hash mismatch/,
    );
    assert.ok((await readFile(archive)).length > 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recipient accepts only selected config/manifest identities with exact DiffIDs and runtime configuration", () => {
  assert.equal(assertImportedImage(image, graph), graph.saved.config.digest);
  assert.equal(
    assertImportedImage({ ...image, Id: graph.saved.manifest.digest }, graph),
    graph.saved.manifest.digest,
  );
  assertImportedImage(
    { ...image, Config: { ...config, Cmd: null, Labels: null, Volumes: null } },
    graph,
  );
  for (const changed of [
    { ...image, Id: digest("f") },
    { ...image, Os: "darwin" },
    { ...image, Architecture: "arm64" },
    { ...image, RootFS: { Type: "layers", Layers: [digest("f")] } },
    { ...image, RootFS: { Type: "layers", Layers: [...graph.diffIds, digest("f")] } },
    { ...image, Config: { ...config, Entrypoint: ["/bin/bash"] } },
    { ...image, Config: { ...config, Env: [...config.Env].reverse() } },
    { ...image, Config: { ...config, Healthcheck: { Test: ["CMD", "arbitrary"] } } },
    { ...image, Config: { ...config, PrivateExtra: "must-not-be-accepted" } },
  ])
    assert.throws(() => assertImportedImage(changed, graph));
});

test("same daemon, real store or Unix API cannot count as an independent empty recipient", () => {
  const builder = {
    id: "builder",
    root: "/private/builder/data",
    host: "unix:///private/builder/socket",
    pid: 10,
    start: "100",
    rootless: false,
    networkNamespace: "net:[100]",
  };
  const recipient = {
    id: "recipient",
    root: "/private/recipient/data",
    host: "unix:///private/recipient/socket",
    pid: 11,
    start: "101",
    rootless: false,
    networkNamespace: "net:[100]",
  };
  assertDistinctStores(builder, recipient);
  assertDistinctStores(builder, { ...recipient, rootless: true, networkNamespace: "net:[101]" });
  assert.throws(() => assertDistinctStores(builder, { ...recipient, rootless: true }));
  for (const changed of [
    { ...recipient, id: builder.id },
    { ...recipient, root: builder.root },
    { ...recipient, host: builder.host },
    { ...recipient, pid: builder.pid, start: builder.start },
  ])
    assert.throws(() => assertDistinctStores(builder, changed));
  const empty = ["Images", "Containers", "Local Volumes", "Build Cache"].map((Type) => ({
    Type,
    TotalCount: "0",
  }));
  assertEmptyStore(empty);
  for (const ordinal of [0, 1, 2, 3])
    assert.throws(() =>
      assertEmptyStore(
        empty.map((row, index) => ({ ...row, TotalCount: index === ordinal ? "1" : "0" })),
      ),
    );
  for (const rows of [
    [],
    empty.slice(0, 3),
    [...empty, empty[0] as { Type: string; TotalCount: string }],
  ])
    assert.throws(() => assertEmptyStore(rows));
});

test("unprotected recipient invocation fails before Docker and emits only a finite prerequisite result", async () => {
  await assert.rejects(
    promisify(execFile)(
      process.execPath,
      [new URL("./recipient.ts", import.meta.url).pathname, "capture"],
      {
        env: { HOME: process.env.HOME, PATH: process.env.PATH },
        timeout: 3000,
        maxBuffer: 4096,
        encoding: "utf8",
      },
    ),
    (error: unknown) => {
      assert.ok(error && typeof error === "object" && "stderr" in error && "stdout" in error);
      assert.equal(error.stdout, "");
      assert.deepEqual(JSON.parse(String(error.stderr)), {
        probe: "recipient-import",
        stage: "prerequisite",
        passed: false,
      });
      return true;
    },
  );
});
