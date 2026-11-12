import assert from "node:assert/strict";
import { constants } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { Header } from "tar";
import { run, sha256 } from "../apps/worker/container/fuse-security.ts";
import { imageInputs } from "../apps/worker/container/inputs.ts";
import {
  assertDynamicFuse,
  assertWitnessCallPath,
  extractAddon,
  modifyLibrary,
  modifyStaticUtility,
} from "../apps/worker/container/library-replacement.ts";
import type { FsEntry } from "../apps/worker/container/rootfs.ts";
import {
  commandOptions,
  hashFile,
  materializeSourceKitInventory,
  readSourceKitInventory,
  verifyDaemonInputs,
  verifyKitInventory,
  verifyKitSignatures,
  verifyNodeInputs,
  verifyReplacementRecord,
  verifySecurityOverlay,
  verifySecurityRuntime,
  verifySourceClosure,
  verifySourceKit,
} from "./image-source-distribution.ts";

function entry(bytes: string | Uint8Array): FsEntry {
  return {
    type: "File",
    mode: 0o644,
    uid: 0,
    gid: 0,
    size: Buffer.byteLength(bytes),
    link: "",
    attributes: {},
    sha256: sha256(bytes),
    major: 0,
    minor: 0,
  };
}
test("actual authenticated kit materializes exact raw inventory bytes without a loose producer file or overwrite", async () => {
  const repository = resolve(import.meta.dirname, "..");
  const kit =
    process.env.FORTIPI_SOURCE_KIT ??
    resolve(repository, "apps/worker/dist/container/sources-and-notices.tar");
  const kitSha256 =
    process.env.FORTIPI_SOURCE_KIT_SHA256 ??
    JSON.parse(
      await readFile(resolve(repository, "apps/worker/dist/container/image-metadata.json"), "utf8"),
    ).sourceKitSha256;
  const options = { kit, kitSha256 };
  const directory = await mkdtemp(resolve(await realpath(tmpdir()), "fortipi-inventory-handoff-"));
  try {
    const expected = await run("tar", ["-xOf", kit, "source-kit-inventory.json"]);
    const { inventoryBytes } = await readSourceKitInventory(options);
    assert.deepEqual(inventoryBytes, expected, "Raw producer inventory must not be reserialized");
    const output = resolve(directory, "image/source-kit-inventory.json");
    await mkdir(dirname(output));
    await materializeSourceKitInventory(options, output);
    assert.deepEqual(await readFile(output), expected);
    await writeFile(output, "existing output must survive");
    await assert.rejects(materializeSourceKitInventory(options, output), { code: "EEXIST" });
    assert.equal(await readFile(output, "utf8"), "existing output must survive");
    const untrusted = resolve(directory, "untrusted.json");
    await assert.rejects(
      materializeSourceKitInventory({ kit, kitSha256: "0".repeat(64) }, untrusted),
      /Source-kit transport digest differs/,
    );
    await assert.rejects(readFile(untrusted), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("inventory handoff rejects altered, missing, linked and duplicate members before creating output", async () => {
  // Synthetic parser faults only; positive/legal acceptance uses the actual authenticated kit above.
  const directory = await mkdtemp(resolve(await realpath(tmpdir()), "fortipi-inventory-fault-"));
  function member(path: string, bytes: Buffer, type: "File" | "SymbolicLink" = "File") {
    const header = new Header({
      path,
      type,
      mode: 0o644,
      size: bytes.length,
      uid: 0,
      gid: 0,
      ...(type === "SymbolicLink" ? { linkpath: "payload" } : {}),
    });
    header.encode();
    assert.ok(header.block);
    return Buffer.concat([header.block, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)]);
  }
  const payload = Buffer.from("parser source fixture"),
    notice = Buffer.from("parser notice fixture");
  const inventory = Buffer.from(
    JSON.stringify({
      payload: sha256(payload),
      "context/notices": sha256(JSON.stringify({ NOTICE: sha256(notice) })),
    }),
  );
  const content = [member("payload", payload), member("context/notices/NOTICE", notice)];
  const inventoryMember = member("source-kit-inventory.json", inventory);
  const faults = [
    { name: "missing", members: content, error: /Missing regular file/ },
    {
      name: "altered",
      members: [
        ...content,
        member(
          "source-kit-inventory.json",
          Buffer.from(
            JSON.stringify({
              payload: "0".repeat(64),
              "context/notices": sha256(JSON.stringify({ NOTICE: sha256(notice) })),
            }),
          ),
        ),
      ],
      error: /Kit payload changed/,
    },
    {
      name: "linked",
      members: [...content, member("source-kit-inventory.json", Buffer.alloc(0), "SymbolicLink")],
      error: /Missing regular file/,
    },
    {
      name: "duplicate",
      members: [...content, inventoryMember, inventoryMember],
      error: /Duplicate/,
    },
  ];
  try {
    for (const fault of faults) {
      const kit = resolve(directory, `${fault.name}.tar`),
        output = resolve(directory, `${fault.name}.json`);
      await writeFile(kit, Buffer.concat([...fault.members, Buffer.alloc(1024)]));
      await assert.rejects(
        materializeSourceKitInventory({ kit, kitSha256: await hashFile(kit) }, output),
        fault.error,
      );
      await assert.rejects(readFile(output), { code: "ENOENT" });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("kit membership, payload and notices are independently bound, including negative controls", () => {
  const payload = entry("source bytes");
  const notice = entry("copyright and LGPL text");
  const entries = new Map([
    ["sources/library.dsc", payload],
    ["context/notices/LICENSE", notice],
    ["source-kit-inventory.json", entry("{}")],
  ]);
  const inventory = {
    "sources/library.dsc": payload.sha256 ?? "",
    "context/notices": sha256(JSON.stringify({ LICENSE: notice.sha256 })),
  };
  verifyKitInventory(entries, inventory);
  const changed = new Map(entries);
  changed.set("sources/library.dsc", entry("changed source bytes"));
  assert.throws(() => verifyKitInventory(changed, inventory), /payload changed/);
  const omitted = new Map(entries);
  omitted.delete("context/notices/LICENSE");
  assert.throws(() => verifyKitInventory(omitted, inventory), /notices missing/);
  const forged = new Map(entries);
  forged.set("context/notices/LICENSE", entry("truncated license"));
  assert.throws(() => verifyKitInventory(forged, inventory), /Notice aggregate changed/);
  const extra = new Map(entries);
  extra.set("unexpected-image.tar", entry("hidden conveyed bytes"));
  assert.throws(() => verifyKitInventory(extra, inventory), /Uninventoried/);
  const linked = new Map(entries);
  linked.set("context/notices/LICENSE", { ...notice, type: "SymbolicLink", link: "/etc/passwd" });
  assert.throws(() => verifyKitInventory(linked, inventory));
});
test("source closure uses final conveyance plus actual static dependencies; old inputs do not confer obligations on absent bytes", () => {
  const main = { name: "fuse3", version: "3.18.3-1" };
  const dep = { name: "retained-static-library", version: "1.0" };
  const payload = { name: "library.dsc", sha256: "a".repeat(64), size: 12 };
  const source = (s: typeof main) => ({ ...s, descriptor: "library.dsc", files: [payload] });
  const freeze = {
    installed: [
      {
        name: "helper",
        version: "1",
        source: main.name,
        sourceVersion: main.version,
        builtUsing: [],
        staticBuiltUsing: [dep],
      },
    ],
    sources: [main, dep].map((s) => ({ ...s, files: [payload] })),
    pruning: { removed: [], executables: [], aliases: [], forbiddenLayers: [] },
    releaseSha256: "",
    packagesIndexSha256: "",
    sourcesIndexSha256: "",
    fuseReleaseSha256: "",
    fusePackagesIndexSha256: "",
    fuseSourcesIndexSha256: "",
  };
  verifySourceClosure(freeze, [source(main), source(dep)]);
  assert.throws(() => verifySourceClosure(freeze, [source(main)]), /final closure/);
  assert.throws(
    () =>
      verifySourceClosure({ ...freeze, sources: [{ ...main, files: [payload] }] }, [source(main)]),
    /Final package source closure/,
  );
  assert.throws(
    () => verifySourceClosure(freeze, [source(main), { ...source(dep), version: "0.9" }]),
    /final closure/,
  );
  assert.throws(
    () =>
      verifySourceClosure(freeze, [
        source(main),
        { ...source(dep), files: [{ ...payload, sha256: "b".repeat(64) }] },
      ]),
    /payload closure/,
  );
  // An input's sqv source may be absent only when the final installed closure omits it.
  const installed = freeze.installed[0];
  assert.ok(installed);
  verifySourceClosure(
    {
      ...freeze,
      installed: [{ ...installed, staticBuiltUsing: [] }],
      sources: [{ ...main, files: [payload] }],
    },
    [source(main)],
  );
});
test("distribution CLI rejects missing and duplicate identity inputs", () => {
  assert.deepEqual(commandOptions(["--kit", "exact.tar", "--commit", "exact"]), {
    kit: "exact.tar",
    commit: "exact",
  });
  assert.throws(() => commandOptions(["--kit"]), /pairs/);
  assert.throws(() => commandOptions(["--kit", "a", "--kit", "b"]), /duplicate/);
});
test("replacement record binds actual image and source identities and refuses source-only or fallback results", () => {
  const hash = "a".repeat(64);
  const image = {
    imageId: `sha256:${hash}`,
    imageArchiveSha256: hash,
    metadataSha256: hash,
    builtManifestDigest: `sha256:${hash}`,
  };
  const kit = { sourceCommit: "a".repeat(40), sourceKitSha256: hash };
  const io = {
    status: "completed",
    exitCode: 0,
    content: "fortipi-result",
    canary: true,
    sync: "complete",
    skipped: 0,
    fuse: true,
    computerdSha256: hash,
  };
  const record = {
    schemaVersion: 1,
    claim: "linux-fuse-library-replacement",
    platform: "linux/amd64",
    ...image,
    ...kit,
    originalLibrarySha256: hash,
    modifiedLibrarySha256: "b".repeat(64),
    addonSha256: hash,
    helperSha256: "b".repeat(64),
    originalHelperSha256: hash,
    staticHelperRelinkVerified: true,
    helperBaselineNoWitness: true,
    modificationSha256: hash,
    replacementVerified: true,
    realFuse: true,
    missingExportRejected: true,
    baseline: { ...io, imageId: image.imageId, modifiedImplementationCalled: false },
    replacement: {
      ...io,
      imageId: `sha256:${"b".repeat(64)}`,
      mappedLibrary: "/opt/fortipi-replacement/libfuse3.so.4",
      modifiedImplementationCalled: true,
    },
  };
  verifyReplacementRecord(record, image, kit);
  for (const changed of [
    { sourceKitSha256: "b".repeat(64) },
    { imageArchiveSha256: "b".repeat(64) },
    { replacementVerified: false },
    { realFuse: false },
    { missingExportRejected: false },
    { staticHelperRelinkVerified: false },
    { helperBaselineNoWitness: false },
    { helperSha256: hash },
    { modifiedLibrarySha256: hash },
    { replacement: { ...record.replacement, fuse: false } },
    { replacement: { ...record.replacement, modifiedImplementationCalled: false } },
    { baseline: { ...record.baseline, modifiedImplementationCalled: true } },
  ])
    assert.throws(() => verifyReplacementRecord({ ...record, ...changed }, image, kit));
});

const securityInputs = () =>
  process.env.FORTIPI_SECURITY_INPUTS ??
  resolve(import.meta.dirname, "../apps/worker/dist/container");

test("actual SEA source, injector archives and observed bootstrap receipt reject changed generator and metafile inputs", {
  timeout: 120_000,
}, async () => {
  const source = securityInputs();
  const observed = process.env.FORTIPI_SEA_METADATA;
  const directory = await mkdtemp(resolve(tmpdir(), "fortipi-sea-receiver-test-"));
  const embedded = JSON.parse(
    await readFile(
      observed
        ? resolve(observed, "embedded-freeze.json")
        : resolve(import.meta.dirname, "../apps/worker/container/embedded-freeze.json"),
      "utf8",
    ),
  );
  try {
    const members = [
      "computer-source.tgz",
      "node-runtime.tar.xz",
      "node-source.tar.xz",
      "daemon-build/SHASUMS256.txt",
      "daemon-build/SHASUMS256.txt.sig",
      "daemon-build/node-release-key.pgp",
      "daemon-build/postject.tgz",
      "daemon-build/commander.tgz",
    ];
    for (const name of members) {
      const target = resolve(directory, name);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(
        resolve(source, name),
        target,
        constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL,
      );
    }
    for (const name of [
      "computerd-build.json",
      "daemon-build/build-inputs.json",
      "daemon-build/node-authentication.json",
      "daemon-build/metafile.json",
    ]) {
      const target = resolve(directory, name);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(
        observed ? resolve(observed, name.split("/").at(-1) ?? "") : resolve(source, name),
        target,
        constants.COPYFILE_EXCL,
      );
    }
    for (const pin of embedded.components as { name: string; version: string }[]) {
      if (pin.name === "fuse-napi") continue;
      const name = pin.name.replaceAll("/", "_");
      await copyFile(
        resolve(source, `daemon-build/${name}.tgz`),
        resolve(directory, `embedded-${name}-${pin.version}.tgz`),
        constants.COPYFILE_EXCL,
      );
    }
    const ownSource = new Map<string, FsEntry>();
    for (const name of [
      "apps/worker/container/computerd-build.ts",
      "tools/unstale/supply-chain.json",
    ]) {
      const data = await readFile(resolve(import.meta.dirname, "..", name));
      ownSource.set(name, { ...entry(data), data });
    }
    await verifyDaemonInputs(directory, embedded, ownSource);
    const buildPath = resolve(directory, "computerd-build.json"),
      buildBytes = await readFile(buildPath);
    const build = JSON.parse(buildBytes.toString());
    build.generatorVersion = "22.23.4";
    await writeFile(buildPath, JSON.stringify(build));
    await assert.rejects(verifyDaemonInputs(directory, embedded, ownSource));
    await writeFile(buildPath, buildBytes);
    const metaPath = resolve(directory, "daemon-build/metafile.json");
    const meta = JSON.parse(await readFile(metaPath, "utf8"));
    meta.inputs["packages/computerd/src/exec/runner.ts"].bytes++;
    await writeFile(metaPath, JSON.stringify(meta));
    await assert.rejects(
      verifyDaemonInputs(directory, embedded, ownSource),
      /SEA metafile input differs/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("actual signed Node inputs reject altered checksums, archive bytes and a false authentication receipt", {
  timeout: 120_000,
}, async () => {
  const source = securityInputs();
  const directory = await mkdtemp(resolve(tmpdir(), "fortipi-node-receiver-test-"));
  try {
    for (const name of [
      "node-runtime.tar.xz",
      "node-source.tar.xz",
      "daemon-build/node-release-key.pgp",
      "daemon-build/SHASUMS256.txt",
      "daemon-build/SHASUMS256.txt.sig",
      "daemon-build/node-authentication.json",
    ]) {
      const target = resolve(directory, name);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(
        resolve(source, name),
        target,
        constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL,
      );
    }
    await verifyNodeInputs(directory);
    const sumsPath = resolve(directory, "daemon-build/SHASUMS256.txt");
    const sums = await readFile(sumsPath);
    await writeFile(sumsPath, Buffer.concat([sums, Buffer.from("changed\n")]));
    await assert.rejects(verifyNodeInputs(directory), /gpgv/);
    await writeFile(sumsPath, sums);
    const authPath = resolve(directory, "daemon-build/node-authentication.json");
    const auth = JSON.parse(await readFile(authPath, "utf8"));
    await writeFile(authPath, JSON.stringify({ ...auth, executableSha256: "a".repeat(64) }));
    await assert.rejects(
      verifyNodeInputs(directory),
      /authentication receipt differs: executableSha256/,
    );
    await writeFile(authPath, JSON.stringify(auth));
    const archive = await open(resolve(directory, "node-runtime.tar.xz"), "r+");
    try {
      await archive.write(Buffer.from([0]), 0, 1, 0);
    } finally {
      await archive.close();
    }
    await assert.rejects(verifyNodeInputs(directory), /Node archive identity differs/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("actual authenticated zlib overlay reconstructs effective source and rejects metadata-only or changed-byte upgrades", {
  timeout: 120_000,
}, async () => {
  const source = securityInputs();
  const directory = await mkdtemp(resolve(tmpdir(), "fortipi-zlib-receiver-test-"));
  const freeze = JSON.parse(
    await readFile(
      resolve(import.meta.dirname, "../apps/worker/container/debian-freeze.json"),
      "utf8",
    ),
  );
  try {
    for (const name of [
      "security/archive-keyring.pgp",
      "security/trixie-security.InRelease",
      "security/trixie-security-main-binary-amd64-Packages.xz",
      "security/trixie-security-main-source-Sources.xz",
      "security/zlib-security-authentication.json",
      "zlib-effective.json",
      "sources/zlib_1.3.dfsg+really1.3.1-1+deb13u1.dsc",
      "sources/zlib_1.3.dfsg+really1.3.1.orig.tar.gz",
      "sources/zlib_1.3.dfsg+really1.3.1-1+deb13u1.debian.tar.xz",
    ]) {
      const target = resolve(directory, name);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(resolve(source, name), target, constants.COPYFILE_EXCL);
    }
    await verifySecurityOverlay(directory, freeze);
    const proofPath = resolve(directory, "zlib-effective.json"),
      proofBytes = await readFile(proofPath);
    const proof = JSON.parse(proofBytes.toString());
    proof.patchedSources["gzwrite.c"] = "a".repeat(64);
    await writeFile(proofPath, JSON.stringify(proof));
    await assert.rejects(
      verifySecurityOverlay(directory, freeze),
      /Effective zlib source\/patch evidence differs/,
    );
    await writeFile(proofPath, proofBytes);
    const authPath = resolve(directory, "security/zlib-security-authentication.json");
    const auth = JSON.parse(await readFile(authPath, "utf8"));
    auth.binary.Version = "1:1.3.dfsg+really1.3.1-1+b1";
    await writeFile(authPath, JSON.stringify(auth));
    await assert.rejects(
      verifySecurityOverlay(directory, freeze),
      /authentication receipt differs from signed indexes/,
    );
    const archive = resolve(source, "context/packages/zlib1g.deb");
    const pin = freeze.packages.find((p: { name: string }) => p.name === "zlib1g");
    assert.ok(pin);
    assert.equal(await hashFile(archive), pin.sha256);
    const data = resolve(directory, "zlib-data.tar.xz");
    await writeFile(data, await run("ar", ["-p", archive, "data.tar.xz"]));
    const library = await run("tar", ["-xOf", data, "./usr/lib/x86_64-linux-gnu/libz.so.1.3.1"]);
    const path = "usr/lib/x86_64-linux-gnu/libz.so.1.3.1";
    verifySecurityRuntime(new Map([[path, entry(library)]]));
    library[1024] = (library[1024] ?? 0) ^ 1;
    assert.throws(
      () => verifySecurityRuntime(new Map([[path, entry(library)]])),
      /Conveyed zlib library/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// Like fuse-security.test.ts, this requires real prepared inputs and fails if absent.
// This is explicitly an artifact/static-ELF test, never a Linux execution claim.
test("actual pinned source kit, signatures, addon ELF and automatic witness call path; changed signature is rejected", {
  timeout: 120_000,
}, async () => {
  const repository = resolve(import.meta.dirname, "..");
  const temporary = resolve(repository, ".agent-docs/tmp");
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(resolve(temporary, "source-gate-test-"));
  const kit =
    process.env.FORTIPI_SOURCE_KIT ??
    resolve(repository, "apps/worker/dist/container/sources-and-notices.tar");
  const native =
    process.env.FORTIPI_NATIVE_INPUTS ??
    resolve(repository, "apps/worker/dist/container/native-compatibility");
  try {
    const revision = JSON.parse(
      (await run("tar", ["-xOf", kit, "source-revision.json"])).toString("utf8"),
    ) as { sourceCommit: string };
    const verified = await verifySourceKit(
      {
        kit,
        kitSha256: process.env.FORTIPI_SOURCE_KIT_SHA256 ?? (await hashFile(kit)),
        commit: revision.sourceCommit,
      },
      directory,
    );
    const computer = resolve(directory, "computer-source.tgz");
    const top = `computer-${imageInputs.source}/packages/computerd/vendor/fuse-napi/`;
    assertWitnessCallPath(
      (await run("tar", ["-xOf", computer, `${top}index.js`])).toString("utf8"),
      (await run("tar", ["-xOf", computer, `${top}fuse-native.c`])).toString("utf8"),
    );
    const source = (
      await run("tar", [
        "-xOf",
        resolve(directory, "sources/fuse3_3.18.3.orig.tar.gz"),
        "fuse-3.18.3/lib/fuse.c",
      ])
    ).toString("utf8");
    assert.notEqual(modifyLibrary(source, "a".repeat(32)), source);
    const utility = (
      await run("tar", [
        "-xOf",
        resolve(directory, "sources/fuse3_3.18.3.orig.tar.gz"),
        "fuse-3.18.3/lib/mount_util.c",
      ])
    ).toString("utf8");
    assert.ok(modifyStaticUtility(utility, "a".repeat(32)).startsWith(utility));
    const addon = resolve(native, "fuse.node");
    assertDynamicFuse(
      (await run("objdump", ["-p", addon])).toString("utf8"),
      (await run("objdump", ["-T", addon])).toString("utf8"),
    );
    const pin = verified.embedded.assets["fuse.node"];
    assert.ok(pin);
    assert.deepEqual(
      extractAddon(await readFile(resolve(native, "computerd")), pin),
      await readFile(addon),
    );
    const signed = resolve(directory, "security/sid.InRelease");
    const bytes = await readFile(signed, "utf8");
    const corrupted = bytes.replace("Suite: unstable", "Suite: testing");
    assert.notEqual(bytes, corrupted);
    await writeFile(signed, corrupted);
    await assert.rejects(verifyKitSignatures(directory, verified.freeze));
    await writeFile(signed, bytes);
    const orig = resolve(directory, "sources/fuse3_3.18.3.orig.tar.gz");
    const archive = await readFile(orig);
    archive[archive.length - 1] = (archive.at(-1) ?? 0) ^ 1;
    await writeFile(orig, archive);
    await assert.rejects(verifyKitSignatures(directory, verified.freeze), /signature mismatch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
