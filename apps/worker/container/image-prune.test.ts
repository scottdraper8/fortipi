import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { c as createTar, Header } from "tar";
import { describeOCI, inspectImageArchive } from "./image-archive.ts";
import { assertRuntimeConfig, filePolicy, type PrunePolicy, pruningPolicy } from "./image-prune.ts";
import { compareRootfs, scanRootfs } from "./rootfs.ts";

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const output = resolve(import.meta.dirname, "../dist/container");
const layerPath = resolve(
  output,
  "37fb86c2a767b88d500c6872195f88078f64765fe0d2f9cc375cc2efbd4c0a41.tgz",
);
const configPath = resolve(
  output,
  "downloads/596c6d80c879dc94eae22cb9c59a5e18f66f4f9722e170892324c282b4eb19bc",
);
function record(
  path: string,
  bytes = Buffer.alloc(0),
  options: {
    mode?: number;
    uid?: number;
    gid?: number;
    type?: "File" | "Link" | "SymbolicLink" | "ExtendedHeader";
    link?: string;
  } = {},
): Buffer {
  const header = Buffer.alloc(512);
  new Header({
    path,
    size: bytes.length,
    type: options.type ?? "File",
    mode: options.mode ?? 0o644,
    uid: options.uid ?? 0,
    gid: options.gid ?? 0,
    linkpath: options.link ?? "",
  }).encode(header);
  return Buffer.concat([header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)]);
}
const archive = (...records: Buffer[]) => Buffer.concat([...records, Buffer.alloc(1024)]);
function attributes(value: Buffer): Buffer {
  const body = Buffer.concat([
    Buffer.from(" SCHILY.xattr.security.capability="),
    value,
    Buffer.from("\n"),
  ]);
  let size = body.length + 2;
  while (String(size).length + body.length !== size) size = String(size).length + body.length;
  return record("PaxHeaders/helper", Buffer.concat([Buffer.from(String(size)), body]), {
    type: "ExtendedHeader",
  });
}
const configuration = () => ({
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
});
async function image(
  directory: string,
  layers: Buffer[],
  extras: Buffer[] = [],
  gzip = false,
  namedExtras: [string, Uint8Array | string][] = [],
): Promise<{ path: string; id: string }> {
  await mkdir(resolve(directory, "blobs/sha256"), { recursive: true });
  const encoded = layers.map((bytes) => (gzip ? gzipSync(bytes) : bytes));
  const config = JSON.stringify({
    os: "linux",
    architecture: "amd64",
    config: configuration(),
    rootfs: { type: "layers", diff_ids: layers.map((bytes) => `sha256:${sha(bytes)}`) },
  });
  const manifest = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: {
      mediaType: "application/vnd.oci.image.config.v1+json",
      digest: `sha256:${sha(config)}`,
      size: Buffer.byteLength(config),
    },
    layers: encoded.map((bytes) => ({
      mediaType: gzip
        ? "application/vnd.oci.image.layer.v1.tar+gzip"
        : "application/vnd.oci.image.layer.v1.tar",
      digest: `sha256:${sha(bytes)}`,
      size: bytes.length,
    })),
  });
  const index = JSON.stringify({
    schemaVersion: 2,
    manifests: [
      {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: `sha256:${sha(manifest)}`,
        size: Buffer.byteLength(manifest),
      },
    ],
  });
  const files = new Map<string, Uint8Array | string>([
    ["oci-layout", '{"imageLayoutVersion":"1.0.0"}'],
    ["index.json", index],
    [`blobs/sha256/${sha(config)}`, config],
    [`blobs/sha256/${sha(manifest)}`, manifest],
    ...[...encoded, ...extras].map((bytes): [string, Uint8Array] => [
      `blobs/sha256/${sha(bytes)}`,
      bytes,
    ]),
    ...namedExtras,
  ]);
  for (const [name, bytes] of files) await writeFile(resolve(directory, name), bytes);
  const path = resolve(directory, "image.tar");
  await createTar({ cwd: directory, file: path, portable: true }, [...files.keys()]);
  return { path, id: `sha256:${sha(config)}` };
}

test("actual frozen base reproduces the independently reviewed removed-executable inventory", async () => {
  const policy = await pruningPolicy(
    layerPath,
    "sha256:37fb86c2a767b88d500c6872195f88078f64765fe0d2f9cc375cc2efbd4c0a41",
    configPath,
    "sha256:596c6d80c879dc94eae22cb9c59a5e18f66f4f9722e170892324c282b4eb19bc",
  );
  assert.deepEqual(policy.removed, [
    { name: "apt", version: "3.0.4" },
    { name: "sqv", version: "1.3.0-3+b2" },
  ]);
  assert.equal(policy.executables.length, 25);
  assert.equal(policy.executables.filter((file) => file.elf).length, 19);
  const sqv = execFileSync("tar", ["-xOf", layerPath, "usr/bin/sqv"], {
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(policy.executables.find((file) => file.path === "usr/bin/sqv")?.sha256, sha(sqv));
  const work = await mkdtemp(resolve(tmpdir(), "fortipi-pruning-"));
  try {
    const clean = archive(
      record("usr/bin/fusermount3", Buffer.from("public fixture"), { mode: 0o4755 }),
    );
    for (const compressed of [false, true]) {
      const candidate = await image(work, [clean], [], compressed);
      const inspected = await inspectImageArchive(candidate.path, candidate.id, {
        pruning: policy,
      });
      assert.equal(inspected.filesystem.get("usr/bin/fusermount3")?.mode, 0o4755);
    }
    const oldThenWhiteout = await image(work, [
      archive(record("usr/bin/sqv", sqv)),
      archive(record("usr/bin/.wh.sqv")),
    ]);
    await assert.rejects(
      inspectImageArchive(oldThenWhiteout.path, oldThenWhiteout.id, { pruning: policy }),
      /Forbidden removed executable/,
    );
    const renamed = await image(
      work,
      [archive(record("var/cache/renamed-application", sqv))],
      [],
      true,
    );
    await assert.rejects(
      inspectImageArchive(renamed.path, renamed.id, { pruning: policy }),
      /Forbidden retained binary/,
    );
    const unreferenced = await image(
      work,
      [clean],
      [archive(record("unrelated", Buffer.from("unreferenced cache")))],
    );
    await assert.rejects(
      inspectImageArchive(unreferenced.path, unreferenced.id, { pruning: policy }),
      /unreferenced conveyed/,
    );
    const oldBlob = await image(work, [clean], [await readFile(layerPath)]);
    await assert.rejects(
      inspectImageArchive(oldBlob.path, oldBlob.id, { pruning: policy }),
      /binary-bearing base blob/,
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("rejected archive diagnostics cap members and hash tainted names without weakening rejection", async () => {
  const work = await mkdtemp(resolve(tmpdir(), "fortipi-archive-diagnostic-"));
  const originalError = console.error;
  const logs: string[] = [];
  console.error = (message: string) => logs.push(message);
  try {
    const layout = `${"e".repeat(64)}/VERSION`;
    await mkdir(resolve(work, "e".repeat(64)), { recursive: true });
    const tainted = "diagnostic-private-Authorization=not-a-credential";
    const almostBlob = `blobs/sha256/${"f".repeat(64)}?${tainted}`;
    const payload = "diagnostic-private-content";
    const candidate = await image(
      work,
      [archive(record("retained", Buffer.from("safe")))],
      [],
      false,
      [
        [`blobs/sha256/${"f".repeat(64)}`, payload],
        [layout, payload],
        [tainted, payload],
        [almostBlob, payload],
        ["extra-fifth", payload],
        ["extra-sixth", payload],
      ],
    );
    await assert.rejects(
      inspectImageArchive(candidate.path, candidate.id, {
        pruning: { removed: [], executables: [], aliases: [], forbiddenLayers: [] },
      }),
      /Unexpected or unreferenced conveyed/,
    );
    assert.equal(logs.length, 1);
    const diagnostic = JSON.parse(logs[0] ?? "");
    assert.equal(diagnostic.probe, "image-unreferenced-members");
    assert.equal(diagnostic.members.length, 4);
    assert.deepEqual(diagnostic.members[0], {
      class: "oci-blob",
      declaredSha256: `sha256:${"f".repeat(64)}`,
      actualSha256: `sha256:${sha(payload)}`,
      size: Buffer.byteLength(payload),
      type: "unknown",
    });
    for (const [index, name] of [layout, tainted, almostBlob].entries())
      assert.deepEqual(diagnostic.members[index + 1], {
        class: index === 0 ? "known-layout" : "other",
        nameSha256: sha(name),
      });
    assert.doesNotMatch(
      logs.join("\n"),
      /diagnostic-private|Authorization|credential|VERSION|extra-fifth|extra-sixth/,
    );
  } finally {
    console.error = originalError;
    await rm(work, { recursive: true, force: true });
  }
});

test("bounded OCI descriptions validate descriptor triples without exposing metadata values", () => {
  const config = {
    mediaType: "application/vnd.oci.image.config.v1+json",
    digest: `sha256:${"a".repeat(64)}`,
    size: 12,
  };
  const layer = {
    mediaType: "application/vnd.oci.image.layer.v1.tar",
    digest: `sha256:${"b".repeat(64)}`,
    size: 512,
  };
  const manifest = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config,
    layers: [layer],
    annotations: { private: "diagnostic-private-content" },
  };
  const selected = {
    mediaType: manifest.mediaType,
    digest: `sha256:${sha(JSON.stringify(manifest))}`,
    size: Buffer.byteLength(JSON.stringify(manifest)),
  };
  const graph = [selected, config, layer];
  const describe = (value: unknown, budget = 16) => {
    const bytes = Buffer.from(JSON.stringify(value));
    return describeOCI(bytes, `sha256:${sha(bytes)}`, graph, budget);
  };
  const described = describe(manifest);
  assert.deepEqual(described, {
    type: "oci-manifest",
    descriptors: [
      { ...config, role: "config", inSelectedGraph: true },
      { ...layer, role: "layer", inSelectedGraph: true },
    ],
  });
  assert.doesNotMatch(JSON.stringify(described), /private|annotations|Env/);
  for (const changed of [
    { ...layer, size: 513 },
    { ...layer, digest: `sha256:${"c".repeat(64)}` },
    { ...layer, mediaType: "application/vnd.oci.image.layer.v1.tar+gzip" },
  ]) {
    const result = describe({ ...manifest, layers: [changed] });
    assert.ok(result.type !== "unknown");
    assert.equal(result.descriptors[1]?.inSelectedGraph, false);
  }
  for (const value of [
    { ...manifest, Env: ["diagnostic-private-env"] },
    { ...manifest, config: { ...config, size: -1 } },
    { ...manifest, config: { ...config, size: Number.MAX_SAFE_INTEGER + 1 } },
    { ...manifest, config: { ...config, digest: "diagnostic-private-digest" } },
    { ...manifest, config: { ...config, urls: ["diagnostic-private-url"] } },
    { ...manifest, config: { ...config, mediaType: "diagnostic-private-type" } },
    { ...manifest, layers: Array.from({ length: 16 }, () => layer) },
    {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.config.v1+json",
      Env: ["diagnostic-private-env"],
    },
  ])
    assert.deepEqual(describe(value), { type: "unknown" });
  assert.deepEqual(describe(manifest, 1), { type: "unknown" });
  for (const bytes of [Buffer.alloc(8193, 32), Buffer.from([0xc3, 0x28]), Buffer.from("{")])
    assert.deepEqual(describeOCI(bytes, `sha256:${sha(bytes)}`, graph, 16), { type: "unknown" });
  const valid = Buffer.from(JSON.stringify(manifest));
  assert.deepEqual(describeOCI(valid, `sha256:${"0".repeat(64)}`, graph, 16), { type: "unknown" });
});

test("even graph-equivalent OCI indexes stay rejected and share a sixteen-descriptor diagnostic budget", async () => {
  const work = await mkdtemp(resolve(tmpdir(), "fortipi-oci-description-"));
  const originalError = console.error;
  const logs: string[] = [];
  console.error = (message: string) => logs.push(message);
  try {
    const clean = archive(record("retained", Buffer.from("safe")));
    const baseline = await image(work, [clean]);
    const index = JSON.parse(await readFile(resolve(work, "index.json"), "utf8"));
    const selected = index.manifests[0];
    const manifest = JSON.parse(
      await readFile(resolve(work, `blobs/sha256/${selected.digest.slice(7)}`), "utf8"),
    );
    const extras = [
      Buffer.from(
        JSON.stringify({
          ...index,
          mediaType: "application/vnd.oci.image.index.v1+json",
          manifests: Array.from({ length: 16 }, () => selected),
          annotations: { private: "diagnostic-private-annotation" },
        }),
      ),
      Buffer.from(
        JSON.stringify({ ...manifest, annotations: { private: "diagnostic-private-annotation" } }),
      ),
    ];
    const candidate = await image(work, [clean], extras);
    assert.equal(candidate.id, baseline.id);
    await assert.rejects(
      inspectImageArchive(candidate.path, candidate.id, {
        pruning: { removed: [], executables: [], aliases: [], forbiddenLayers: [] },
      }),
      /unreferenced conveyed/,
    );
    const records = JSON.parse(logs[0] ?? "").members;
    assert.equal(records[0].type, "oci-index");
    assert.equal(records[0].descriptors.length, 16);
    assert.ok(
      records[0].descriptors.every((entry: { inSelectedGraph: boolean }) => entry.inSelectedGraph),
    );
    assert.equal(records[1].type, "unknown");
    assert.doesNotMatch(logs.join("\n"), /private|annotations|Env/);
  } finally {
    console.error = originalError;
    await rm(work, { recursive: true, force: true });
  }
});

test("raw xattrs, ownership, setuid, bytes and hardlink groups survive clean-rootfs comparison", async () => {
  const body = Buffer.from("independent retained helper\n");
  const make = (
    mode = 0o4755,
    uid = 0,
    caps = Buffer.from([0x80, 0, 1]),
    payload = body,
    broken = false,
  ) =>
    archive(
      attributes(caps),
      record("usr/bin/fusermount3", payload, { mode, uid }),
      record("usr/bin/helper-alias", broken ? payload : Buffer.alloc(0), {
        mode,
        uid,
        type: broken ? "File" : "Link",
        link: broken ? "" : "usr/bin/fusermount3",
      }),
    );
  const expected = await scanRootfs(Readable.from([make()]));
  assert.equal(
    expected.get("usr/bin/fusermount3")?.attributes["SCHILY.xattr.security.capability"],
    "800001",
  );
  compareRootfs(expected, await scanRootfs(Readable.from([make()])));
  // Await parsing before asserting the synchronous equivalence check.
  for (const changed of [
    make(0o755),
    make(0o4755, 123),
    make(0o4755, 0, Buffer.from([0x81, 0, 1])),
    make(0o4755, 0, Buffer.from([0x80, 0, 1]), Buffer.from("different helper")),
    make(0o4755, 0, Buffer.from([0x80, 0, 1]), body, true),
  ]) {
    const actual = await scanRootfs(Readable.from([changed]));
    assert.throws(() => compareRootfs(expected, actual), /rootfs/);
  }
  await assert.rejects(scanRootfs(Readable.from([make().subarray(0, -513)])), /Truncated/);
  const policy: PrunePolicy = {
    removed: [],
    aliases: [],
    executables: [
      { path: "usr/bin/sqv", sha256: "0".repeat(64), elf: true, size: 0, mode: 0, uid: 0, gid: 0 },
    ],
    forbiddenLayers: [],
  };
  for (const type of ["SymbolicLink", "Link"] as const)
    await assert.rejects(
      scanRootfs(
        Readable.from([
          archive(
            record("usr/bin/alias", Buffer.alloc(0), {
              type,
              link: type === "Link" ? "usr/bin/sqv" : "/usr/bin/sqv",
            }),
          ),
        ]),
        filePolicy(policy),
      ),
      /Forbidden removed executable alias/,
    );
  await assert.rejects(
    scanRootfs(
      Readable.from([archive(record("usr//./bin/sqv", Buffer.from("removed script")))]),
      filePolicy(policy),
    ),
    /Forbidden removed executable path/,
  );
});

test("explicit runtime image configuration rejects dropped defaults without logging values", () => {
  assertRuntimeConfig(configuration());
  assert.throws(
    () => assertRuntimeConfig({ ...configuration(), Env: ["PORT=8080"] }),
    /Runtime ENV changed/,
  );
  assert.throws(
    () => assertRuntimeConfig({ ...configuration(), Cmd: ["bash"] }),
    /command changed/,
  );
  assert.throws(
    () => assertRuntimeConfig({ ...configuration(), User: "123" }),
    /user\/workdir changed/,
  );
  assert.throws(
    () => assertRuntimeConfig({ ...configuration(), StopSignal: "SIGKILL" }),
    /stop signal changed/,
  );
});
