// Explicit Linux runtime gate; importing this module never certifies replacement.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import {
  commandOptions,
  hashFile,
  type ImageOptions,
  verifyImageSourceDistribution,
  verifySourceKit,
} from "../../../scripts/image-source-distribution.ts";
import { mesonPin, verifyMeson } from "../../../tools/unstale/provision-meson.ts";
import { assertResolved, dynamicSymbols } from "./elf-compatibility.ts";
import { sha256 } from "./fuse-security.ts";
import { imageInputs } from "./inputs.ts";
import { verifyRecipientFixture } from "./recipient.ts";

const repository = resolve(import.meta.dirname, "../../..");
const execute = promisify(execFile);
const markerPath = "/tmp/fortipi-lgpl-witness";
const helperMarkerPath = "/tmp/fortipi-static-helper-witness";
export function requireLinux(platform: string, architecture: string): void {
  assert.ok(
    platform === "linux" && architecture === "x64",
    "Library replacement requires actual Linux amd64, reviewed Docker and a working /dev/fuse; no source-only PASS",
  );
}
/** A change in a called library function, preserving its signature and result. */
export function modifyLibrary(source: string, nonce: string): string {
  assert.match(nonce, /^[a-f0-9]{32}$/);
  const original = "const char *fuse_pkgversion(void)\n{\n\treturn PACKAGE_VERSION;\n}";
  assert.equal(source.split(original).length, 2, "Reviewed FUSE function changed");
  return source.replace(
    original,
    `const char *fuse_pkgversion(void)\n{\n\t/* Recipient modification: witness this implementation being called. */\n\tFILE *fortipi_witness = fopen("${markerPath}", "w");\n\tif (fortipi_witness) {\n\t\tfputs("${nonce}\\n", fortipi_witness);\n\t\tfclose(fortipi_witness);\n\t}\n\treturn PACKAGE_VERSION;\n}`,
  );
}
/** mount_util.c is compiled into both the DSO and the GPL helper executable. */
export function modifyStaticUtility(source: string, nonce: string): string {
  assert.match(nonce, /^[a-f0-9]{32}$/);
  assert.ok(
    source.includes("GNU LGPLv2") && source.includes("#include <stdio.h>"),
    "Reviewed static utility changed",
  );
  return `${source}\n/* Recipient modification: witness rebuilt static utility initialization. */\n__attribute__((constructor)) static void fortipi_static_utility_witness(void)\n{\n\tFILE *witness = fopen("${helperMarkerPath}", "w");\n\tif (witness) { fputs("${nonce}\\n", witness); fclose(witness); }\n}\n`;
}
/** These are the hash-verified vendor sources, not a new caller of the witness. */
export function assertWitnessCallPath(index: string, native: string): void {
  assert.match(
    index,
    /const NATIVE_RUNTIME = Object\.freeze\(binding\.fuse_native_runtime_info\(\)\)/,
    "Original addon loader no longer calls runtime_info",
  );
  assert.match(
    native,
    /NAPI_METHOD\(fuse_native_runtime_info\)\s*\{[\s\S]*?const char \*package_version = fuse_pkgversion\(\);/,
    "Original native runtime_info no longer calls fuse_pkgversion",
  );
  assert.match(
    native,
    /NAPI_EXPORT_FUNCTION\(fuse_native_runtime_info\)/,
    "Native runtime_info is not exported to the original loader",
  );
}
/** Locate the exact embedded ELF by size+digest, without executing or replacing the SEA. */
export function extractAddon(binary: Buffer, pin: { sha256: string; size: number }): Buffer {
  const magic = Buffer.from([127, 69, 76, 70]);
  const matches: Buffer[] = [];
  for (
    let offset = binary.indexOf(magic);
    offset >= 0;
    offset = binary.indexOf(magic, offset + 1)
  ) {
    const bytes = binary.subarray(offset, offset + pin.size);
    if (bytes.length === pin.size && sha256(bytes) === pin.sha256) matches.push(bytes);
  }
  assert.equal(matches.length, 1, "Missing/ambiguous pinned SEA addon");
  return Buffer.from(matches[0] ?? []);
}
export function assertDynamicFuse(headers: string, table: string): void {
  const needed = [...headers.matchAll(/^\s+NEEDED\s+(\S+)\s*$/gm)].map((match) => match[1]).sort();
  assert.deepEqual(
    needed,
    ["libc.so.6", "libfuse3.so.4"],
    "Addon dynamic FUSE boundary changed; review relink inputs",
  );
  const symbols = dynamicSymbols(table);
  assert.ok(
    symbols.some((s) => s.undefined && s.name === "_fuse_new_31" && s.version === "FUSE_3.17"),
    "Missing actual versioned FUSE import",
  );
  assert.ok(
    !symbols.some(
      (s) =>
        !s.undefined &&
        /^(?:_?fuse_|fusermount)/.test(s.name) &&
        !s.name.startsWith("fuse_native_"),
    ),
    "Addon defines library code; review static relink inputs",
  );
}
export interface RuntimeObservation {
  status: string;
  exitCode: number;
  content: string;
  canary: boolean;
  sync: string;
  skipped: number;
  fuse: boolean;
}
export function assertMountedIO(result: RuntimeObservation): void {
  assert.deepEqual(
    result,
    {
      status: "completed",
      exitCode: 0,
      content: "fortipi-result",
      canary: true,
      sync: "complete",
      skipped: 0,
      fuse: true,
    },
    "Actual mounted Computer I/O was not established",
  );
}
export async function proveLibraryReplacement(
  options: ImageOptions & { out: string },
): Promise<void> {
  requireLinux(process.platform, process.arch);
  const mesonBin = (process.env.PATH ?? "")
    .split(delimiter)
    .find(
      (path) =>
        path.startsWith(resolve(repository, "dist/toolchain/meson-")) && path.endsWith("/bin"),
    );
  assert.ok(mesonBin, "Pinned private Meson is required");
  await verifyMeson(dirname(mesonBin), await realpath(resolve(mesonBin, "python3")));
  const { createTestHarness } = await import("wrangler");
  // Preserve only tool/private-daemon settings, never model/deployment credentials.
  await mkdir(options.out, { recursive: false });
  const home = await mkdtemp(resolve(tmpdir(), "fortipi-library-home-"));
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    DOCKER_HOST: process.env.DOCKER_HOST,
    DOCKER_CONFIG: process.env.DOCKER_CONFIG,
    BUILDX_CONFIG: process.env.BUILDX_CONFIG,
    BUILDX_BUILDER: "default",
    CI: "true",
    WRANGLER_SEND_METRICS: "false",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONNOUSERSITE: "1",
  };
  const command = async (program: string, args: string[], cwd = repository) => {
    const result = await execute(program, args, {
      cwd,
      env,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return result.stdout.trim();
  };
  const kitDirectory = resolve(options.out, "verified-kit");
  const ownImages: string[] = [];
  try {
    const kit = await verifySourceKit(options, kitDirectory);
    const image = await verifyImageSourceDistribution(options, kit);
    assert.equal(
      await verifyRecipientFixture(),
      image.imageId,
      "Replacement must start from the independently imported canonical image",
    );
    const versions = JSON.parse(await command("docker", ["version", "--format", "{{json .}}"])) as {
      Client: { Version: string };
      Server: { Version: string };
    };
    assert.equal(versions.Client.Version, imageInputs.docker);
    assert.equal(versions.Server.Version, imageInputs.docker);
    assert.ok(
      (await command("docker", ["buildx", "inspect", "--bootstrap"])).includes(
        `v${imageInputs.buildkit}`,
      ),
    );
    const tools: Record<string, string> = {
      mesonSource: mesonPin.source,
      mesonArchiveSha256: mesonPin.sourceArchiveSha256,
    };
    for (const [program, args] of [
      ["cc", ["--version"]],
      ["meson", ["--version"]],
      ["ninja", ["--version"]],
      ["dpkg-source", ["--version"]],
      ["objdump", ["--version"]],
    ] as const)
      tools[program] = await command(program, [...args]);
    const native = resolve(options.out, "native");
    await mkdir(native);
    const container = await command("docker", ["create", "--network=none", image.imageId]);
    assert.match(container, /^[a-f0-9]{64}$/);
    try {
      for (const [from, to] of [
        ["/usr/local/bin/computerd", "computerd"],
        ["/usr/lib/x86_64-linux-gnu/libc.so.6", "libc.so.6"],
        ["/usr/lib/x86_64-linux-gnu/libfuse3.so.3.18.3", "original.so"],
        ["/usr/bin/fusermount3", "original-helper"],
      ]) {
        assert.ok(from && to);
        await command("docker", ["cp", `${container}:${from}`, resolve(native, to)]);
      }
    } finally {
      await command("docker", ["rm", container]);
    }
    assert.equal(await hashFile(resolve(native, "computerd")), kit.embedded.binarySha256);
    const addonPin = kit.embedded.assets["fuse.node"];
    assert.ok(addonPin);
    await writeFile(
      resolve(native, "fuse.node"),
      extractAddon(await readFile(resolve(native, "computerd")), addonPin),
    );
    const vendor = `computer-${imageInputs.source}/packages/computerd/vendor/fuse-napi/`;
    assertWitnessCallPath(
      await command("tar", [
        "-xOf",
        resolve(kitDirectory, "computer-source.tgz"),
        `${vendor}index.js`,
      ]),
      await command("tar", [
        "-xOf",
        resolve(kitDirectory, "computer-source.tgz"),
        `${vendor}fuse-native.c`,
      ]),
    );
    const symbols = async (name: string) =>
      dynamicSymbols(await command("objdump", ["-T", resolve(native, name)]));
    assertDynamicFuse(
      await command("objdump", ["-p", resolve(native, "fuse.node")]),
      await command("objdump", ["-T", resolve(native, "fuse.node")]),
    );
    const compatibility = JSON.parse(
      await readFile(resolve(kitDirectory, "native-compatibility.json"), "utf8"),
    ) as { inputs: Record<string, string> };
    for (const [name, original] of [
      ["fuse.node", "fuse.node"],
      ["computerd", "computerd"],
      ["libc.so.6", "libc.so.6"],
      ["original.so", "libfuse3.so.4"],
      ["original-helper", "fusermount3"],
    ]) {
      assert.ok(name && original);
      assert.equal(
        await hashFile(resolve(native, name)),
        compatibility.inputs[original],
        "Actual image/native record differs",
      );
    }
    // dpkg-source reconstructs packaging and applies any recorded Debian patches.
    // gpgv verification with an explicit pinned keyring has already succeeded above.
    const source = resolve(options.out, "modified-fuse");
    await command("dpkg-source", [
      "-x",
      resolve(kitDirectory, "sources/fuse3_3.18.3-1.dsc"),
      source,
    ]);
    const nonce = randomBytes(16).toString("hex");
    const path = resolve(source, "lib/fuse.c");
    const before = await readFile(path, "utf8");
    const modified = modifyLibrary(before, nonce);
    await writeFile(path, modified);
    const utilityPath = resolve(source, "lib/mount_util.c");
    const utilityBefore = await readFile(utilityPath, "utf8");
    const utilityModified = modifyStaticUtility(utilityBefore, nonce);
    await writeFile(utilityPath, utilityModified);
    await writeFile(
      resolve(options.out, "modification.json"),
      `${JSON.stringify({ source: "lib/fuse.c", beforeSha256: sha256(before), afterSha256: sha256(modified), utility: { source: "lib/mount_util.c", beforeSha256: sha256(utilityBefore), afterSha256: sha256(utilityModified), markerPath: helperMarkerPath }, nonce, markerPath, purpose: "Demonstrate a modified implementation called through the original addon and a relinked static utility" }, null, 2)}\n`,
    );
    // No downloads or subproject fallback. Build the helper too: its Meson target
    // statically compiles mount_util.c/fuse_log.c/util.c, all supplied by this DSC.
    const build = resolve(options.out, "meson-build");
    const setup = [
      "setup",
      "--wrap-mode=nodownload",
      "--buildtype=release",
      "-Ddefault_library=shared",
      "-Duseroot=false",
      "-Dexamples=false",
      "-Dtests=false",
      "-Dutils=true",
      "-Denable-io-uring=false",
      build,
      source,
    ];
    await command("meson", setup);
    await command("meson", ["compile", "-C", build]);
    await copyFile(resolve(build, "lib/libfuse3.so.3.18.3"), resolve(native, "modified.so"));
    await copyFile(resolve(build, "util/fusermount3"), resolve(native, "rebuilt-helper"));
    const modifiedHash = await hashFile(resolve(native, "modified.so"));
    assert.notEqual(
      modifiedHash,
      await hashFile(resolve(native, "original.so")),
      "Replacement is unchanged",
    );
    const headers = await command("objdump", ["-p", resolve(native, "modified.so")]);
    assert.match(headers, /^\s+SONAME\s+libfuse3\.so\.4\s*$/m);
    assert.deepEqual(
      [...headers.matchAll(/^\s+NEEDED\s+(\S+)\s*$/gm)].map((m) => m[1]),
      ["libc.so.6"],
    );
    const [addon, library, libc, computerd, helper] = await Promise.all([
      symbols("fuse.node"),
      symbols("modified.so"),
      symbols("libc.so.6"),
      symbols("computerd"),
      symbols("rebuilt-helper"),
    ]);
    assertResolved(addon, [...library, ...libc, ...computerd]);
    assertResolved(library, libc);
    assertResolved(helper, libc);
    const helperHeaders = await command("objdump", ["-p", resolve(native, "rebuilt-helper")]);
    assert.deepEqual(
      [...helperHeaders.matchAll(/^\s+NEEDED\s+(\S+)\s*$/gm)].map((m) => m[1]),
      ["libc.so.6"],
      "Helper witness must be statically linked, not loaded from the modified FUSE DSO",
    );
    assert.throws(
      () =>
        assertResolved(
          addon.filter((s) => s.undefined && s.version.startsWith("FUSE_")),
          library.filter((s) => s.name !== "_fuse_new_31"),
        ),
      /_fuse_new_31/,
      "Missing-export negative control did not fail",
    );
    const runFixture = async (id: string, name: string, witness: boolean) => {
      const context = resolve(options.out, `${name}-context`);
      await mkdir(context);
      await writeFile(resolve(context, "Dockerfile"), `FROM ${id}\n`);
      const harness = createTestHarness({
        root: repository,
        workers: [
          {
            config: {
              name: `fortipi-lgpl-${name}`,
              main: resolve(repository, "apps/worker/test/backends/runtime-worker.ts"),
              compatibility_date: "2026-11-10",
              compatibility_flags: [
                "nodejs_compat",
                "enable_request_signal",
                "request_signal_passthrough",
              ],
              durable_objects: {
                bindings: [
                  { name: "WORKSPACES", class_name: "BackendProbe" },
                  { name: "LINUX_CONTAINERS", class_name: "ProbeHost" },
                ],
              },
              migrations: [{ tag: "v1", new_sqlite_classes: ["BackendProbe", "ProbeHost"] }],
              containers: [
                {
                  class_name: "ProbeHost",
                  scheduling_policy: "durable_object",
                  images: {
                    computerd: {
                      dockerfile: resolve(context, "Dockerfile"),
                      build_context: context,
                    },
                  },
                },
              ],
              vars: { REQUIRE_FUSE: "true" },
            },
          },
        ],
      });
      try {
        await harness.listen();
        const prepared = await harness.fetch("/prepared-image");
        assert.equal(prepared.status, 200);
        const selected: unknown = await prepared.json();
        assert.equal(typeof selected, "string");
        assert.equal(
          await command("docker", ["image", "inspect", String(selected), "--format", "{{.Id}}"]),
          id,
          "Harness changed the replacement image",
        );
        const response = await harness.fetch("/run?backend=linux");
        assert.equal(response.status, 200, "Computer native mount/execution failed");
        const io = (await response.json()) as RuntimeObservation;
        assertMountedIO(io);
        const ids = (
          await command("docker", [
            "ps",
            "--no-trunc",
            "--filter",
            `ancestor=${id}`,
            "--format",
            "{{.ID}}",
          ])
        )
          .split("\n")
          .filter(Boolean);
        assert.equal(ids.length, 1, "Runtime container identity is ambiguous");
        const runtime = ids[0];
        assert.ok(runtime);
        assert.equal(await command("docker", ["inspect", runtime, "--format", "{{.Image}}"]), id);
        // Observe the actual process's mappings and executable, not the launch environment.
        const maps = await command("docker", ["exec", runtime, "cat", "/proc/1/maps"]);
        assert.ok(
          maps.includes(
            witness
              ? "/opt/fortipi-replacement/libfuse3.so.4"
              : "/usr/lib/x86_64-linux-gnu/libfuse3.so.3.18.3",
          ),
          "Expected shared library was not mapped by computerd",
        );
        const exe = (await command("docker", ["exec", runtime, "sha256sum", "/proc/1/exe"])).split(
          /\s+/,
        )[0];
        assert.equal(exe, kit.embedded.binarySha256, "Original computerd was replaced");
        if (witness) {
          assert.equal(
            await command("docker", ["exec", runtime, "cat", markerPath]),
            nonce,
            "Modified implementation was not called",
          );
          assert.equal(
            (
              await command("docker", [
                "exec",
                runtime,
                "sha256sum",
                "/opt/fortipi-replacement/libfuse3.so.4",
              ])
            ).split(/\s+/)[0],
            modifiedHash,
          );
        } else
          await assert.rejects(
            command("docker", ["exec", runtime, "cat", markerPath]),
            "Unmodified-library negative control produced a witness",
          );
        return {
          ...io,
          imageId: id,
          computerdSha256: exe,
          modifiedImplementationCalled: witness,
          mappedLibrary: witness
            ? "/opt/fortipi-replacement/libfuse3.so.4"
            : "/usr/lib/x86_64-linux-gnu/libfuse3.so.3.18.3",
        };
      } finally {
        await harness.close();
      }
    };
    const baseline = await runFixture(image.imageId, "baseline", false);
    assert.equal(
      await command("docker", [
        "run",
        "--rm",
        "--network=none",
        "--entrypoint",
        "/bin/sh",
        image.imageId,
        "-c",
        `test ! -e ${helperMarkerPath} && /usr/bin/fusermount3 --version && test ! -e ${helperMarkerPath}`,
      ]),
      "fusermount3 version: 3.18.3",
      "Unmodified helper negative control produced a static witness",
    );
    const context = resolve(options.out, "replacement-context");
    await mkdir(context);
    await copyFile(resolve(native, "modified.so"), resolve(context, "libfuse3.so.4"));
    await copyFile(resolve(native, "rebuilt-helper"), resolve(context, "fusermount3"));
    await writeFile(
      resolve(context, "Dockerfile"),
      `FROM ${image.imageId}\nCOPY libfuse3.so.4 /opt/fortipi-replacement/libfuse3.so.4\nCOPY fusermount3 /usr/bin/fusermount3\nRUN chown 0:0 /usr/bin/fusermount3 && chmod 4755 /usr/bin/fusermount3\nENV LD_LIBRARY_PATH=/opt/fortipi-replacement\n`,
    );
    const iid = resolve(options.out, "replacement-image-id");
    await command("docker", [
      "buildx",
      "build",
      "--platform=linux/amd64",
      "--pull=false",
      "--no-cache",
      "--network=none",
      "--provenance=false",
      "--load",
      "--iidfile",
      iid,
      context,
    ]);
    const replacementId = (await readFile(iid, "utf8")).trim();
    assert.match(replacementId, /^sha256:[a-f0-9]{64}$/);
    ownImages.push(replacementId);
    assert.equal(
      await command("docker", [
        "run",
        "--rm",
        "--network=none",
        "--entrypoint",
        "/bin/sh",
        replacementId,
        "-c",
        `/usr/bin/fusermount3 --version && cat ${helperMarkerPath}`,
      ]),
      `fusermount3 version: 3.18.3\n${nonce}`,
    );
    const replacement = await runFixture(replacementId, "modified", true);
    assert.equal(await verifyRecipientFixture(), image.imageId);
    assert.equal(await hashFile(options.image), image.imageArchiveSha256);
    const receipt = {
      schemaVersion: 1,
      claim: "linux-fuse-library-replacement",
      platform: "linux/amd64",
      sourceCommit: kit.sourceCommit,
      sourceKitSha256: kit.sourceKitSha256,
      ...image,
      originalLibrarySha256: await hashFile(resolve(native, "original.so")),
      modifiedLibrarySha256: modifiedHash,
      addonSha256: addonPin.sha256,
      helperSha256: await hashFile(resolve(native, "rebuilt-helper")),
      originalHelperSha256: await hashFile(resolve(native, "original-helper")),
      staticHelperRelinkVerified: true,
      helperBaselineNoWitness: true,
      modificationSha256: await hashFile(resolve(options.out, "modification.json")),
      tools,
      setup,
      baseline,
      replacement,
      missingExportRejected: true,
      realFuse: true,
      replacementVerified: true,
      deliveryVerified: false,
      cloudVerified: false,
    };
    await writeFile(
      resolve(options.out, "library-replacement.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
      { flag: "wx" },
    );
    process.stdout.write(
      `${JSON.stringify({ imageId: image.imageId, sourceKitSha256: kit.sourceKitSha256, replacementVerified: true, realFuse: true, cloudVerified: false })}\n`,
    );
  } finally {
    for (const id of ownImages) await command("docker", ["image", "rm", id]);
    await rm(home, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  try {
    requireLinux(process.platform, process.arch);
    const args = commandOptions(process.argv.slice(2).filter((arg) => arg !== "--require-fuse"));
    const required = (name: string) => {
      const value = args[name];
      assert.ok(value, `Required --${name}`);
      return value;
    };
    await proveLibraryReplacement({
      kit: required("kit"),
      kitSha256: required("kit-sha256"),
      commit: required("commit"),
      image: required("image"),
      metadata: required("metadata"),
      metadataSha256: required("metadata-sha256"),
      records: required("records"),
      out: resolve(required("out")),
    });
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Library replacement failed"}\n`,
    );
    process.exitCode = 1;
  }
}
