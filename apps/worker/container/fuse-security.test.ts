import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { assertResolved, dynamicSymbols } from "./elf-compatibility.ts";
import { run, verifySigned, verifyUpstream } from "./fuse-security.ts";

// Requires the real inputs reconstructed by build.ts --prepare; absence fails closed.
const output = resolve(import.meta.dirname, "../dist/container");
test("GNU BFD version and visibility columns retain external symbol rules", () => {
  // Captured GNU2.42 and Apple LLVM21 output on actual computerd (SHA7c4c7ef6...)
  // and embedded addon/new library; GNU built from signed release, not a Linux run.
  const table = (rows: string) =>
    `computerd: file format elf64-x86-64\nDYNAMIC SYMBOL TABLE:\n${rows}`;
  const gnu = dynamicSymbols(
    table(
      "0000000003400000 g    D  lpstub\t0000000000000000  Base        .protected __start_lpstub",
    ),
  );
  const llvm = dynamicSymbols(
    table(
      "0000000003400000 g    D  lpstub\t0000000000000000              .protected __start_lpstub",
    ),
  );
  assert.deepEqual(gnu, llvm);
  assert.deepEqual(gnu[0], {
    name: "__start_lpstub",
    version: "",
    undefined: false,
    weak: false,
    visibility: "protected",
  });
  const consumer = dynamicSymbols(
    table("0000000000000000      DF *UND*\t0000000000000000 (FUSE_3.17)  _fuse_new_31"),
  );
  assert.equal(consumer[0]?.weak, false);
  const weak = dynamicSymbols(
    table(
      "0000000000000000  w   D  *UND*\t0000000000000000  Base        _ITM_deregisterTMCloneTable",
    ),
  );
  assert.equal(weak[0]?.weak, true);
  assert.deepEqual(assertResolved(weak, []), []);
  const providerRow = "0000000000016df0 g    DF .text\t0000000000000516  FUSE_3.17   _fuse_new_31";
  assert.deepEqual(assertResolved(consumer, dynamicSymbols(table(providerRow))), [
    "_fuse_new_31@FUSE_3.17",
  ]);
  assert.throws(() => assertResolved(consumer, []), /_fuse_new_31@FUSE_3.17/);
  assert.throws(
    () =>
      assertResolved(consumer, dynamicSymbols(table(providerRow.replace("FUSE_3.17", "FUSE_3.0")))),
    /_fuse_new_31@FUSE_3.17/,
  );
  const provider = (visibility: string) =>
    dynamicSymbols(table(providerRow.replace(" _fuse_new_31", ` ${visibility} _fuse_new_31`)));
  assert.deepEqual(assertResolved(consumer, provider(".protected")), ["_fuse_new_31@FUSE_3.17"]);
  for (const visibility of [".hidden", ".internal"])
    assert.throws(() => assertResolved(consumer, provider(visibility)), /Unresolved native symbol/);
  for (const unknown of ["0x80", ".unknown", ".protected extra"])
    assert.throws(() => provider(unknown), /Unsupported ELF symbol/);
  assert.throws(
    () => dynamicSymbols(table("unrecognized dynamic row")),
    /Unsupported ELF symbol row/,
  );
});
test("actual Debian and upstream signatures reject changed content or signer", async () => {
  const home = await mkdtemp(resolve(output, "signature-oracle-"));
  try {
    const release = resolve(output, "security/sid.InRelease");
    const keyring = resolve(output, "security/archive-keyring.pgp");
    const signer = "04B54C3CDCA79751B16BC6B5225629DF75B188BD";
    assert.match(await verifySigned(release, keyring, home, signer), /^Suite: unstable$/m);
    const changed = (await readFile(release, "utf8")).replace("Suite: unstable", "Suite: testing");
    assert.notEqual(changed, await readFile(release, "utf8"));
    const corrupted = resolve(home, "changed.InRelease");
    await writeFile(corrupted, changed);
    await assert.rejects(verifySigned(corrupted, keyring, home, signer));
    await assert.rejects(
      verifySigned(release, keyring, home, "0000000000000000000000000000000000000000"),
      /frozen signer/,
    );
    const archive = await readFile(resolve(output, "sources/fuse3_3.18.3.orig.tar.gz"));
    const signature = await readFile(
      resolve(output, "sources/fuse3_3.18.3.orig.tar.gz.asc"),
      "utf8",
    );
    const key = await readFile(resolve(output, "security/fuse-3.18.pub"), "utf8");
    verifyUpstream(archive, signature, key);
    archive[archive.length - 1] = (archive[archive.length - 1] ?? 0) ^ 1;
    assert.throws(() => verifyUpstream(archive, signature, key), /signature mismatch/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("actual addon requires the retained FUSE_3.17 ABI and rejects a missing or wrong-version export", async () => {
  const symbols = async (name: string) =>
    dynamicSymbols(
      (await run("objdump", ["-T", resolve(output, "native-compatibility", name)])).toString(
        "utf8",
      ),
    );
  const [addon, library] = await Promise.all([symbols("fuse.node"), symbols("libfuse3.so.4")]);
  const required = addon.filter((symbol) => symbol.undefined && symbol.version.startsWith("FUSE_"));
  assert.ok(
    required.some((symbol) => symbol.name === "_fuse_new_31" && symbol.version === "FUSE_3.17"),
  );
  assertResolved(required, library);
  assert.throws(
    () =>
      assertResolved(
        required,
        library.filter((symbol) => symbol.name !== "_fuse_new_31"),
      ),
    /_fuse_new_31@FUSE_3.17/,
  );
  assert.throws(
    () =>
      assertResolved(
        required,
        library.map((symbol) =>
          symbol.name === "_fuse_new_31" ? { ...symbol, version: "FUSE_3.0" } : symbol,
        ),
      ),
    /_fuse_new_31@FUSE_3.17/,
  );
});
