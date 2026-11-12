import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { c as tar } from "tar";
import { repository } from "../../../scripts/build-workspaces.ts";
import {
  assertPrivateContainerdApi,
  assertRootlesskitReuse,
  privateContainerdConfig,
  rootlesskitBuildDirectory,
} from "../../../tools/unstale/provision-docker.ts";
import { inspectImageArchive } from "./image-archive.ts";
import {
  assertDistinctStores,
  assertEmptyStore,
  assertImportedImage,
  assertRecipientPostBinding,
  assertRecipientTag,
  recipientCommandFailure,
  recipientFailure,
  recipientFixtureFailure,
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
function backendFixture(ordinal: number) {
  return {
    pid: 100 + ordinal,
    start: `${1000 + ordinal}`,
    root: `/private/backend-${ordinal}/root`,
    state: `/private/backend-${ordinal}/state`,
    socket: `/private/backend-${ordinal}/socket`,
    rootIdentity: `1:${ordinal * 3}`,
    stateIdentity: `1:${ordinal * 3 + 1}`,
    socketIdentity: `1:${ordinal * 3 + 2}`,
  };
}

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
    backend: backendFixture(1),
  };
  const recipient = {
    id: "recipient",
    root: "/private/recipient/data",
    host: "unix:///private/recipient/socket",
    pid: 11,
    start: "101",
    rootless: false,
    networkNamespace: "net:[100]",
    backend: backendFixture(2),
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
        reason: "prerequisite",
        passed: false,
      });
      return true;
    },
  );
});

const canary = "PRIVATE_CANARY_never_emit_91d7";
test("source diagnostics discard command output and classify only finite execution failures", () => {
  for (const [file, input, kind] of [
    ["git", { stderr: `fatal: detected dubious ownership ${canary}` }, "git-ownership"],
    ["docker", { stderr: `detected dubious ownership ${canary}` }, "nonzero"],
    ["git", { killed: true, stderr: canary }, "timeout"],
    ["git", { code: "EACCES", stderr: canary }, "permission"],
    ["git", { code: "ENOENT", stderr: canary }, "missing-command"],
    ["git", { code: 128, stderr: canary }, "nonzero"],
  ] as const) {
    const error = recipientCommandFailure(file, input);
    const result = recipientFixtureFailure("source", error, undefined, "git-revision");
    assert.equal(result.source, "git-revision");
    assert.equal(result.command, kind);
    assert.equal(error.message, "Recipient proof command failed");
    assert.equal(JSON.stringify([result, error]).includes(canary), false);
    for (const key of ["stderr", "stdout", "code", "cause", "actual", "expected"])
      assert.equal(Object.hasOwn(error, key), false);
  }
  const foreign = Object.assign(new Error(canary), { kind: "git-ownership" });
  const result = recipientFixtureFailure("source", foreign, undefined, canary);
  assert.equal(result.source, "unknown");
  assert.equal(Object.hasOwn(result, "command"), false);
  assert.equal(JSON.stringify(result).includes(canary), false);
});
test("fixture diagnostics retain only closed stage/binding labels and existing safe image reasons", () => {
  const foreign = Object.assign(new Error(canary, { cause: { [canary]: canary } }), {
    actual: canary,
    expected: canary,
    reason: canary,
    config: { field: canary },
  });
  assert.deepEqual(recipientFixtureFailure("binding", foreign, "daemon-uid"), {
    probe: "recipient-fixture",
    stage: "binding",
    reason: "unknown",
    passed: false,
    binding: "daemon-uid",
  });
  assert.deepEqual(recipientFixtureFailure(canary, foreign, canary), {
    probe: "recipient-fixture",
    stage: "unknown",
    reason: "unknown",
    passed: false,
  });
  assert.equal(recipientFixtureFailure("binding", foreign, canary).binding, "unknown");
  assert.equal(
    Object.hasOwn(recipientFixtureFailure("stability", foreign, "daemon-uid"), "binding"),
    false,
  );
  const guarded = rejected("tag", () => assertRecipientTag(canary, image.Id));
  assert.equal(recipientFixtureFailure("image-match", guarded).reason, "tag");
  for (const value of [foreign, guarded]) {
    assert.equal(
      JSON.stringify(recipientFixtureFailure("binding", value, "daemon-uid")).includes(canary),
      false,
    );
  }
});
function rejected(
  reason: string,
  action: () => void,
  config?: { field: string; side: string; shape: string },
): Error {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error, "The original guard must still reject");
  const result = recipientFailure("imported-identity", caught);
  assert.deepEqual(result, {
    probe: "recipient-import",
    stage: "imported-identity",
    reason,
    ...(config ? { config } : {}),
    passed: false,
  });
  assert.equal(JSON.stringify(result).includes(canary), false);
  assert.equal(JSON.stringify(caught).includes(canary), false);
  assert.equal(caught.message.includes(canary), false);
  for (const field of ["actual", "expected", "cause"])
    assert.equal(Object.hasOwn(caught, field), false);
  return caught;
}

test("finite reasons distinguish every store separation and empty-store guard without emitting paths or counts", () => {
  const builder = {
    id: "builder",
    root: `/${canary}/builder`,
    host: `unix:///${canary}/builder.sock`,
    pid: 10,
    start: "100",
    rootless: false,
    networkNamespace: "net:[100]",
    backend: backendFixture(1),
  };
  const recipient = {
    id: "recipient",
    root: `/${canary}/recipient`,
    host: `unix:///${canary}/recipient.sock`,
    pid: 11,
    start: "101",
    rootless: false,
    networkNamespace: "net:[100]",
    backend: backendFixture(2),
  };
  assertDistinctStores(builder, recipient);
  assertDistinctStores(builder, { ...recipient, pid: builder.pid });
  for (const [reason, changed] of [
    ["same-id", { ...recipient, id: builder.id }],
    ["same-root", { ...recipient, root: builder.root }],
    ["same-socket", { ...recipient, host: builder.host }],
    ["same-process", { ...recipient, pid: builder.pid, start: builder.start }],
    ["same-namespace", { ...recipient, rootless: true }],
  ] as const)
    rejected(reason, () => assertDistinctStores(builder, changed));
  const empty = ["Images", "Containers", "Local Volumes", "Build Cache"].map((Type) => ({
    Type,
    TotalCount: "0",
  }));
  assertEmptyStore(empty);
  for (const [index, reason] of [
    "store-images",
    "store-containers",
    "store-volumes",
    "store-build-cache",
  ].entries())
    rejected(reason, () =>
      assertEmptyStore(
        empty.map((row, ordinal) => ({
          ...row,
          TotalCount: ordinal === index ? canary : "0",
        })),
      ),
    );
  for (const rows of [
    [],
    empty.slice(0, 3),
    [...empty, { Type: "Images", TotalCount: "0" }],
    [{ Type: canary, TotalCount: canary }],
  ])
    rejected("store-types", () => assertEmptyStore(rows));
});

test("finite reasons identify empty, excessive, malformed and multiple imported image IDs", () => {
  for (const [reason, ids] of [
    ["empty-ids", []],
    ["empty-ids", [""]],
    ["id-format", [canary]],
    ["id-count", Array.from({ length: 9 }, () => digest("a"))],
    ["multiple-ids", [digest("a"), digest("b")]],
  ] as [string, string[]][])
    rejected(reason, () => singleImportedImage(ids));
  assert.equal(singleImportedImage([digest("a"), digest("a")]), digest("a"));
});

test("finite reasons preserve selected graph, platform, DiffID and runtime configuration comparisons", () => {
  for (const [reason, changed] of [
    ["id-format", { ...image, Id: canary }],
    ["graph-id", { ...image, Id: digest("f") }],
    ["os", { ...image, Os: canary }],
    ["arch", { ...image, Architecture: canary }],
    ["rootfs", { ...image, RootFS: { ...image.RootFS, Type: canary } }],
    ["diffids", { ...image, RootFS: { ...image.RootFS, Layers: [canary] } }],
    ["runtime-config", { ...image, Config: { ...config, Entrypoint: [canary] } }],
    ["config-fields", { ...image, Config: { ...config, [canary]: canary } }],
    ["config-equality", { ...image, Config: { ...config, Env: [...config.Env].reverse() } }],
  ] as [string, typeof image][])
    rejected(
      reason,
      () => assertImportedImage(changed, graph),
      reason === "config-fields"
        ? { field: "unknown", side: "actual", shape: "string" }
        : undefined,
    );
  assert.equal(assertImportedImage(image, graph), image.Id);
});

test("tag and postbinding failures retain their equality guards and expose only finite reasons", () => {
  const binding = {
    id: "daemon",
    root: `/${canary}`,
    host: `unix:///${canary}.sock`,
    pid: 10,
    start: "100",
    rootless: false,
    networkNamespace: "net:[100]",
  };
  assertRecipientTag(image.Id, image.Id);
  assertRecipientPostBinding(binding, { ...binding });
  rejected("tag", () => assertRecipientTag(canary, image.Id));
  for (const changed of [
    { ...binding, id: canary },
    { ...binding, root: `/${canary}/changed` },
    { ...binding, host: `unix:///${canary}/changed` },
    { ...binding, pid: 11 },
    { ...binding, start: "101" },
    { ...binding, rootless: true },
    { ...binding, networkNamespace: "net:[101]" },
  ])
    rejected("postbinding", () => assertRecipientPostBinding(changed, binding));
});

test("foreign errors and tainted reason properties cannot bypass the finite diagnostic vocabulary", () => {
  const foreign = Object.assign(new Error(canary, { cause: canary }), {
    reason: "same-id",
    actual: canary,
    expected: canary,
  });
  assert.deepEqual(recipientFailure("recipient-empty", foreign), {
    probe: "recipient-import",
    stage: "recipient-empty",
    reason: "unknown",
    passed: false,
  });
  assert.equal(
    JSON.stringify(recipientFailure("recipient-empty", foreign, "receipt")).includes(canary),
    false,
  );
  const genuine = rejected("tag", () => assertRecipientTag(canary, image.Id));
  Object.assign(genuine, { reason: canary });
  assert.equal(recipientFailure("imported-identity", genuine).reason, "unknown");
});

test("rootful recipient requires a different physical backend, not merely different Docker names or namespaces", () => {
  const builder = {
    id: "builder",
    root: "/private/a",
    host: "unix:///private/a.sock",
    pid: 10,
    start: "100",
    rootless: false,
    networkNamespace: "net:[100]",
    backend: backendFixture(1),
  };
  const recipient = {
    id: "recipient",
    root: "/private/b",
    host: "unix:///private/b.sock",
    pid: 11,
    start: "101",
    rootless: false,
    networkNamespace: "net:[100]",
    backend: backendFixture(2),
  };
  assertDistinctStores(builder, recipient);
  for (const [reason, backend] of [
    ["same-backend-root", { ...recipient.backend, root: builder.backend.root }],
    ["same-backend-root", { ...recipient.backend, rootIdentity: builder.backend.rootIdentity }],
    ["same-backend-state", { ...recipient.backend, state: builder.backend.state }],
    ["same-backend-state", { ...recipient.backend, stateIdentity: builder.backend.stateIdentity }],
    ["same-backend-socket", { ...recipient.backend, socket: builder.backend.socket }],
    [
      "same-backend-socket",
      { ...recipient.backend, socketIdentity: builder.backend.socketIdentity },
    ],
    [
      "same-backend-process",
      { ...recipient.backend, pid: builder.backend.pid, start: builder.backend.start },
    ],
  ] as const)
    rejected(reason, () => assertDistinctStores(builder, { ...recipient, backend }));
  const { backend: _builderBackend, ...bareBuilder } = builder;
  const { backend: _recipientBackend, ...bareRecipient } = recipient;
  rejected("backend-binding", () => assertDistinctStores(builder, bareRecipient));
  rejected("backend-binding", () => assertDistinctStores(bareBuilder, recipient));
  // Rootless keeps its existing independent namespace/classic storage architecture.
  assertDistinctStores(
    { ...bareBuilder, rootless: true },
    { ...bareRecipient, rootless: true, networkNamespace: "net:[101]" },
  );
});

test("private containerd uses an explicit configuration and API binding instead of an ambient host service", () => {
  const session = "/tmp/fortipi-docker-test";
  const text = privateContainerdConfig(session);
  for (const [key, value] of [
    ["root", `${session}/containerd-root`],
    ["state", `${session}/containerd-state`],
    ["address", `${session}/containerd.sock`],
  ])
    assert.ok(text.includes(`${key} = "${value}"`));
  assert.ok(text.includes("imports = []") && text.includes('tcp_address = ""'));
  assert.ok(text.includes('[debug]\n  address = ""') && text.includes('[metrics]\n  address = ""'));
  assert.throws(() =>
    privateContainerdConfig(`/tmp/fortipi-docker-${canary}\nimports = ["/ambient"]`),
  );
  const backend = backendFixture(1);
  const api = {
    Address: backend.socket,
    Namespaces: { Containers: "moby", Plugins: "plugins.moby" },
  };
  assertPrivateContainerdApi(api, backend);
  for (const changed of [
    null,
    { ...api, Address: `/run/${canary}/containerd.sock` },
    { ...api, Namespaces: { ...api.Namespaces, Containers: canary } },
    { ...api, Namespaces: { ...api.Namespaces, Plugins: canary } },
  ])
    assert.throws(
      () => assertPrivateContainerdApi(changed, backend),
      (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes(canary), false);
        return true;
      },
    );
});

test("Config diagnostics disclose only whitelisted field, side and finite shape while every value still rejects", () => {
  const withField = (field: string, value: unknown) => ({ ...config, [field]: value });
  for (const [shape, value] of [
    ["null", null],
    ["emptystring", ""],
    ["string", canary],
    ["false", false],
    ["true", true],
    ["number", 17],
    ["emptyarray", []],
    ["array", [canary]],
    ["emptyobject", {}],
    ["object", { [canary]: canary }],
  ] as const) {
    rejected(
      "config-fields",
      () => assertImportedImage({ ...image, Config: withField("StopTimeout", value) }, graph),
      { field: "StopTimeout", side: "actual", shape },
    );
    rejected(
      "config-fields",
      () =>
        assertImportedImage(image, { ...graph, configuration: withField("StopTimeout", value) }),
      { field: "StopTimeout", side: "expected", shape },
    );
    rejected(
      "config-fields",
      () => assertImportedImage({ ...image, Config: withField(canary, value) }, graph),
      { field: "unknown", side: "actual", shape },
    );
  }
  for (const field of [
    "Hostname",
    "Domainname",
    "AttachStdin",
    "AttachStdout",
    "AttachStderr",
    "Tty",
    "OpenStdin",
    "StdinOnce",
    "Healthcheck",
    "ArgsEscaped",
    "Image",
    "NetworkDisabled",
    "OnBuild",
    "StopTimeout",
  ])
    rejected(
      "config-fields",
      () =>
        assertImportedImage(
          { ...image, Config: { ...config, [field]: { [canary]: canary } } },
          graph,
        ),
      { field, side: "actual", shape: "object" },
    );
  const genuine = rejected(
    "config-fields",
    () => assertImportedImage({ ...image, Config: withField(canary, canary) }, graph),
    { field: "unknown", side: "actual", shape: "string" },
  );
  for (const detail of [
    { field: canary, side: "actual", shape: "string" },
    { field: "Image", side: canary, shape: "string" },
    { field: "Image", side: "actual", shape: canary },
  ]) {
    Object.assign(genuine, { config: detail });
    const result = recipientFailure("imported-identity", genuine);
    assert.equal(Object.hasOwn(result, "config"), false);
    assert.equal(JSON.stringify(result).includes(canary), false);
  }
});

test("Linux ArgsEscaped is boolean-only and must match the selected canonical config without changing command semantics", () => {
  const withFlag = (value: unknown) => ({ ...config, ArgsEscaped: value });
  for (const flag of [false, true])
    assert.equal(
      assertImportedImage(
        { ...image, Config: withFlag(flag) },
        { ...graph, configuration: withFlag(flag) },
      ),
      image.Id,
    );
  assertImportedImage({ ...image, Config: withFlag(false) }, graph);
  assertImportedImage(image, { ...graph, configuration: withFlag(false) });
  for (const value of [null, "true", "false", 0, [], {}, undefined]) {
    assert.throws(() => assertImportedImage({ ...image, Config: withFlag(value) }, graph));
    assert.throws(() => assertImportedImage(image, { ...graph, configuration: withFlag(value) }));
  }
  assert.throws(() => assertImportedImage({ ...image, Config: withFlag(true) }, graph));
  assert.throws(() => assertImportedImage(image, { ...graph, configuration: withFlag(true) }));
  const canonical = { ...graph, configuration: withFlag(true) };
  for (const changed of [
    { ...image, Os: "windows", Config: withFlag(true) },
    { ...image, Architecture: "arm64", Config: withFlag(true) },
    { ...image, Id: digest("f"), Config: withFlag(true) },
    { ...image, RootFS: { ...image.RootFS, Layers: [digest("f")] }, Config: withFlag(true) },
    { ...image, Config: { ...withFlag(true), Entrypoint: [canary] } },
    { ...image, Config: { ...withFlag(true), Cmd: [canary] } },
    { ...image, Config: { ...withFlag(true), Env: [...config.Env, canary] } },
    { ...image, Config: { ...withFlag(true), User: canary } },
    { ...image, Config: { ...withFlag(true), NetworkDisabled: true } },
  ])
    assert.throws(() => assertImportedImage(changed, canonical));
});

test("same-job RootlessKit reuse requires actual pinned bytes, compiler, graph and closed prior-build provenance", () => {
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  const modules = "example.invalid/public v1.0.0 h1:public h1:module\n";
  const packages = "example.invalid/public/cmd/rootlesskit\n";
  const pin = {
    version: "3.3.0",
    source: "a".repeat(40),
    go: "go1.27.4",
    sourceArchiveSha256: sha("source"),
    goModSha256: sha("go.mod"),
    goSumSha256: sha("go.sum"),
    moduleGraphSha256: sha(modules),
    packageGraphSha256: sha(packages),
    binarySha256: sha("built public binary"),
  };
  const job = {
    runId: "123",
    attempt: "1",
    job: "image",
    sourceCommit: "b".repeat(40),
    mode: "rootless" as const,
  };
  const directory = "/private/prior-source-build";
  const build = `${directory}/rootlesskit: go1.27.4\n\tbuild\tGOOS=linux\n\tbuild\tGOARCH=amd64\n\tbuild\tCGO_ENABLED=0\n`;
  const record = {
    source: pin.source,
    sourceArchiveSha256: pin.sourceArchiveSha256,
    compiler: pin.go,
    binarySha256: pin.binarySha256,
    modules,
    packages,
    build,
    buildDirectory: directory,
    job,
  };
  const observed = {
    directory,
    binarySha256: pin.binarySha256,
    goModSha256: pin.goModSha256,
    goSumSha256: pin.goSumSha256,
    build,
  };
  assertRootlesskitReuse(record, job, observed, pin);
  const reject = (action: () => void) =>
    assert.throws(action, (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Prior same-job RootlessKit source build rejected");
      assert.equal(JSON.stringify(error).includes(canary), false);
      return true;
    });
  for (const changed of [
    { ...record, source: canary },
    { ...record, sourceArchiveSha256: canary },
    { ...record, compiler: "go1.26.10" },
    { ...record, binarySha256: canary },
    { ...record, modules: `${modules}${canary}` },
    { ...record, packages: `${packages}${canary}` },
    { ...record, build: canary },
    { ...record, buildDirectory: canary },
    { ...record, job: { ...job, runId: "456" } },
    { ...record, job: { ...job, attempt: "2" } },
    { ...record, job: { ...job, job: canary } },
    { ...record, job: { ...job, sourceCommit: "c".repeat(40) } },
    { ...record, [canary]: canary },
  ])
    reject(() => assertRootlesskitReuse(changed, job, observed, pin));
  const { job: _job, ...withoutJob } = record;
  reject(() => assertRootlesskitReuse(withoutJob, job, observed, pin));
  for (const changed of [
    { ...observed, directory: canary },
    { ...observed, binarySha256: sha("tampered binary") },
    { ...observed, goModSha256: sha("tampered go.mod") },
    { ...observed, goSumSha256: sha("tampered go.sum") },
    { ...observed, build: build.replace("go1.27.4", "go1.26.10") },
  ])
    reject(() => assertRootlesskitReuse(record, job, changed, pin));
  for (const badBuild of [
    build.replace("GOOS=linux", "GOOS=windows"),
    build.replace("GOARCH=amd64", "GOARCH=arm64"),
    build.replace("CGO_ENABLED=0", "CGO_ENABLED=1"),
  ])
    reject(() =>
      assertRootlesskitReuse(
        { ...record, build: badBuild },
        job,
        { ...observed, build: badBuild },
        pin,
      ),
    );
});

test("same-job build directory must be canonical, owned and private without following a symlink", async () => {
  const base = resolve(repository, "dist/toolchain");
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(resolve(base, "docker-rootless-reuse-test-"));
  try {
    await rootlesskitBuildDirectory(directory);
    await chmod(directory, 0o755);
    await assert.rejects(rootlesskitBuildDirectory(directory));
    await chmod(directory, 0o700);
    await symlink(directory, resolve(directory, "alias"));
    await assert.rejects(rootlesskitBuildDirectory(resolve(directory, "alias")));
    await assert.rejects(rootlesskitBuildDirectory(base));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
