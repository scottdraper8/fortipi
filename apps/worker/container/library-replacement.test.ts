import assert from "node:assert/strict";
import test from "node:test";
import { assertResolved, dynamicSymbols } from "./elf-compatibility.ts";
import { sha256 } from "./fuse-security.ts";
import {
  assertDynamicFuse,
  assertMountedIO,
  assertWitnessCallPath,
  extractAddon,
  modifyLibrary,
  modifyStaticUtility,
  requireLinux,
} from "./library-replacement.ts";

const table = (rows: string) => `addon: file format elf64-x86-64\nDYNAMIC SYMBOL TABLE:\n${rows}`;
const imported = "0000000000000000      DF *UND* 0000000000000000 (FUSE_3.17) _fuse_new_31";
test("replacement requires an actual Linux runtime and complete mounted I/O", () => {
  assert.throws(() => requireLinux("darwin", "arm64"), /actual Linux/);
  assert.throws(() => requireLinux("linux", "arm64"), /actual Linux/);
  requireLinux("linux", "x64");
  const actual = {
    status: "completed",
    exitCode: 0,
    content: "fortipi-result",
    canary: true,
    sync: "complete",
    skipped: 0,
    fuse: true,
  };
  assertMountedIO(actual);
  for (const changed of [
    { fuse: false },
    { canary: false },
    { sync: "pending" },
    { skipped: 1 },
    { content: "" },
    { exitCode: 1 },
  ])
    assert.throws(() => assertMountedIO({ ...actual, ...changed }), /mounted Computer I\/O/);
});
test("dynamic FUSE oracle rejects static, missing and changed-version boundaries", () => {
  const headers = "  NEEDED libc.so.6\n  NEEDED libfuse3.so.4\n";
  assertDynamicFuse(headers, table(imported));
  assert.throws(
    () => assertDynamicFuse(headers.replace("  NEEDED libfuse3.so.4\n", ""), table(imported)),
    /dynamic FUSE boundary/,
  );
  assert.throws(
    () => assertDynamicFuse(headers, table(imported.replace("FUSE_3.17", "FUSE_3.0"))),
    /versioned FUSE import/,
  );
  assert.throws(
    () =>
      assertDynamicFuse(
        headers,
        table(`${imported}\n0000000000010000 g DF .text 0000000000000020 FUSE_3.0 fuse_mount`),
      ),
    /defines library code/,
  );
  const provider = dynamicSymbols(
    table("0000000000010000 g DF .text 0000000000000020 FUSE_3.17 _fuse_new_31"),
  );
  assertResolved(dynamicSymbols(table(imported)), provider);
  assert.throws(
    () =>
      assertResolved(
        dynamicSymbols(table(imported)),
        provider.map((p) => ({ ...p, version: "FUSE_3.0" })),
      ),
    /_fuse_new_31@FUSE_3.17/,
  );
});
test("recipient modification changes the called implementation without changing its result", () => {
  const source =
    "#include <stdio.h>\nconst char *fuse_pkgversion(void)\n{\n\treturn PACKAGE_VERSION;\n}\n";
  const nonce = "a".repeat(32);
  const modified = modifyLibrary(source, nonce);
  assert.notEqual(sha256(modified), sha256(source));
  assert.match(modified, /return PACKAGE_VERSION;/);
  assert.ok(modified.includes(`fputs("${nonce}\\n", fortipi_witness)`));
  assert.throws(
    () => modifyLibrary(source.replace("fuse_pkgversion", "other"), nonce),
    /function changed/,
  );
  assert.throws(() => modifyLibrary(source + source, nonce), /function changed/);
  assert.throws(() => modifyLibrary(source, '"; system("anything");'), /match/);
});
test("static helper modification retains the LGPL utility and adds an initialization witness", () => {
  const source =
    "/* GNU LGPLv2 */\n#include <stdio.h>\nint retained_function(void) { return 4; }\n";
  const changed = modifyStaticUtility(source, "a".repeat(32));
  assert.ok(changed.startsWith(source));
  assert.match(changed, /__attribute__\(\(constructor\)\)/);
  assert.match(changed, /fortipi-static-helper-witness/);
  assert.throws(() => modifyStaticUtility("unreviewed source", "a".repeat(32)), /utility changed/);
});
test("witness must be on the original loader to addon call path", () => {
  const index = "const NATIVE_RUNTIME = Object.freeze(binding.fuse_native_runtime_info())";
  const native =
    "NAPI_METHOD(fuse_native_runtime_info) { const char *package_version = fuse_pkgversion(); }\nNAPI_EXPORT_FUNCTION(fuse_native_runtime_info)";
  assertWitnessCallPath(index, native);
  assert.throws(
    () => assertWitnessCallPath(index.replace("runtime_info()", "other()"), native),
    /loader/,
  );
  assert.throws(
    () => assertWitnessCallPath(index, native.replace("fuse_pkgversion()", "other()")),
    /no longer calls/,
  );
});
test("SEA addon extraction requires one exact ELF payload, not a matching filename", () => {
  const addon = Buffer.from([127, 69, 76, 70, 1, 2, 3, 4]);
  const pin = { sha256: sha256(addon), size: addon.length };
  assert.deepEqual(extractAddon(Buffer.concat([Buffer.from("fuse.node"), addon]), pin), addon);
  assert.throws(
    () => extractAddon(Buffer.from("fuse.node is not the native addon"), pin),
    /pinned SEA addon/,
  );
  assert.throws(() => extractAddon(Buffer.concat([addon, addon]), pin), /ambiguous/);
  assert.throws(
    () => extractAddon(Buffer.concat([addon.subarray(0, -1), Buffer.from([5])]), pin),
    /pinned SEA addon/,
  );
});
