import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { run, sha256 } from "../apps/worker/container/fuse-security.ts";
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
  verifyKitInventory,
  verifyKitSignatures,
  verifyReplacementRecord,
  verifySourceClosure,
  verifySourceKit,
} from "./image-source-distribution.ts";

function entry(bytes: string): FsEntry {
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
    const top =
      "computer-bb0a5db4b7e8c8a79625d63e0e272602f909640e/packages/computerd/vendor/fuse-napi/";
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
