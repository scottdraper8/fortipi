// Independent artifact counterexample only: this synthetic OCI filesystem is never runtime proof.
import assert from "node:assert/strict";
import {
  copyFile,
  cp,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { c as createTar } from "tar";
import { run, sha256 } from "../apps/worker/container/fuse-security.ts";
import { inspectImageArchive } from "../apps/worker/container/image-archive.ts";
import { runtimeEnvironment } from "../apps/worker/container/image-prune.ts";
import { imageInputs } from "../apps/worker/container/inputs.ts";
import {
  hashFile,
  verifyImageSourceDistribution,
  verifySourceKit,
} from "./image-source-distribution.ts";

test("final image must retain kit-bound Node notice even when producer inventory omits it", {
  timeout: 120_000,
}, async () => {
  const kitPath = process.env.FORTIPI_SOURCE_KIT;
  const kitSha256 = process.env.FORTIPI_SOURCE_KIT_SHA256;
  const native = process.env.FORTIPI_NATIVE_INPUTS;
  assert.ok(kitPath && kitSha256 && native, "Real authenticated kit/native inputs required");
  const temporary = await mkdtemp(resolve(tmpdir(), "fortipi-notice-enforcer-"));
  try {
    const { sourceCommit } = JSON.parse(
      (await run("tar", ["-xOf", kitPath, "source-revision.json"])).toString("utf8"),
    ) as { sourceCommit: string };
    const kit = await verifySourceKit(
      { kit: kitPath, kitSha256, commit: sourceCommit },
      resolve(temporary, "kit"),
    );
    const kitIdentity = { kit: kitPath, kitSha256, commit: sourceCommit };
    const filesystem = resolve(temporary, "filesystem");
    for (const [name, path] of [
      ["computerd", "usr/local/bin/computerd"],
      ["libc.so.6", "usr/lib/x86_64-linux-gnu/libc.so.6"],
      ["libfuse3.so.4", "usr/lib/x86_64-linux-gnu/libfuse3.so.3.18.3"],
      ["fusermount3", "usr/bin/fusermount3"],
    ] as const) {
      const target = resolve(filesystem, path);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(resolve(native, name), target);
    }
    // This is an artifact oracle, not a runtime image. Include the actual fixed
    // zlib payload from normal preparation so the new byte-level receiver gate runs.
    const zlib =
      process.env.FORTIPI_ZLIB_PACKAGE ?? resolve(native, "../context/packages/zlib1g.deb");
    const zlibPin = kit.freeze.packages.find((p) => p.name === "zlib1g");
    assert.ok(zlibPin);
    assert.equal(await hashFile(zlib), zlibPin.sha256);
    const zlibData = resolve(temporary, "zlib-data.tar.xz");
    await writeFile(zlibData, await run("ar", ["-p", zlib, "data.tar.xz"]));
    await writeFile(
      resolve(filesystem, "usr/lib/x86_64-linux-gnu/libz.so.1.3.1"),
      await run("tar", ["-xOf", zlibData, "./usr/lib/x86_64-linux-gnu/libz.so.1.3.1"]),
    );
    const noticeDirectory = resolve(filesystem, "usr/share/doc/fortipi-computerd");
    await cp(resolve(kit.directory, "context/notices"), noticeDirectory, { recursive: true });
    const nodeNotice = resolve(noticeDirectory, "Node-LICENSE");
    assert.equal(await hashFile(nodeNotice), imageInputs.embeddedNodeLicenseSha256);
    const installed = kit.freeze.installed
      .map(({ name, version, source, sourceVersion, builtUsing, staticBuiltUsing }) => ({
        name,
        version,
        source,
        sourceVersion,
        builtUsing,
        staticBuiltUsing,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const relation = (entries: { name: string; version: string }[]) =>
      entries.map(({ name, version }) => `${name} (= ${version})`).join(", ");
    const status = installed
      .map((p) =>
        [
          `Package: ${p.name}`,
          "Status: install ok installed",
          `Version: ${p.version}`,
          `Source: ${p.source} (${p.sourceVersion})`,
          ...(p.builtUsing.length ? [`Built-Using: ${relation(p.builtUsing)}`] : []),
          ...(p.staticBuiltUsing.length
            ? [`Static-Built-Using: ${relation(p.staticBuiltUsing)}`]
            : []),
        ].join("\n"),
      )
      .join("\n\n");
    await mkdir(resolve(filesystem, "var/lib/dpkg"), { recursive: true });
    await writeFile(resolve(filesystem, "var/lib/dpkg/status"), `${status}\n`);
    const records = resolve(temporary, "records");
    await mkdir(records);
    await writeFile(resolve(records, "installed-source-inventory.json"), JSON.stringify(installed));
    const configuration = {
      Env: runtimeEnvironment,
      User: "0:0",
      WorkingDir: "/",
      Entrypoint: ["/usr/local/bin/computerd"],
      Cmd: [],
      StopSignal: "SIGTERM",
      ExposedPorts: { "8080/tcp": {} },
    };
    async function checkFixture(label: string, hardlinked = false) {
      const directory = resolve(temporary, label);
      await mkdir(resolve(directory, "blobs/sha256"), { recursive: true });
      const layer = resolve(directory, "layer.tar");
      await createTar(
        { cwd: filesystem, file: layer, portable: true },
        hardlinked ? ["notice-data", "usr", "var"] : ["usr", "var"],
      );
      const layerHash = await hashFile(layer);
      const layerBytes = await readFile(layer);
      const config = JSON.stringify({
        os: "linux",
        architecture: "amd64",
        config: configuration,
        rootfs: { type: "layers", diff_ids: [`sha256:${layerHash}`] },
      });
      const configHash = sha256(config);
      const manifest = JSON.stringify({
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        config: {
          mediaType: "application/vnd.oci.image.config.v1+json",
          digest: `sha256:${configHash}`,
          size: Buffer.byteLength(config),
        },
        layers: [
          {
            mediaType: "application/vnd.oci.image.layer.v1.tar",
            digest: `sha256:${layerHash}`,
            size: layerBytes.length,
          },
        ],
      });
      const manifestHash = sha256(manifest);
      const files = new Map<string, string | Buffer>([
        ["oci-layout", '{"imageLayoutVersion":"1.0.0"}'],
        [
          "index.json",
          JSON.stringify({
            schemaVersion: 2,
            manifests: [
              {
                mediaType: "application/vnd.oci.image.manifest.v1+json",
                digest: `sha256:${manifestHash}`,
                size: Buffer.byteLength(manifest),
              },
            ],
          }),
        ],
        [`blobs/sha256/${configHash}`, config],
        [`blobs/sha256/${manifestHash}`, manifest],
        [`blobs/sha256/${layerHash}`, layerBytes],
      ]);
      for (const [path, bytes] of files) await writeFile(resolve(directory, path), bytes);
      const image = resolve(directory, "synthetic-image.tar");
      await createTar({ cwd: directory, file: image, portable: true }, [...files.keys()]);
      const imageId = `sha256:${configHash}`;
      const inspected = await inspectImageArchive(image, imageId, { filesystem: true });
      if (hardlinked)
        assert.equal(
          inspected.filesystem.get("usr/share/doc/fortipi-computerd/Node-LICENSE")?.type,
          "Link",
          "Positive control must exercise an actual OCI hardlink notice",
        );
      const licenses: Record<string, string> = {};
      async function notices(prefix = "") {
        for (const item of await readdir(resolve(noticeDirectory, prefix), {
          withFileTypes: true,
        })) {
          const path = prefix ? `${prefix}/${item.name}` : item.name;
          if (item.isDirectory()) await notices(path);
          else
            licenses[`fortipi-computerd/${path}`] = await hashFile(resolve(noticeDirectory, path));
        }
      }
      await notices();
      await writeFile(resolve(records, "license-inventory.json"), JSON.stringify(licenses));
      const metadata = resolve(directory, "metadata.json");
      await writeFile(
        metadata,
        JSON.stringify({
          schemaVersion: 1,
          computerSource: imageInputs.source,
          computerSourceArchiveSha256: imageInputs.sourceArchiveSha256,
          embeddedNodeVersion: imageInputs.embeddedNodeVersion,
          computerVersion: imageInputs.computerVersion,
          sourceCommit,
          sourceKitSha256: kitSha256,
          platform: "linux/amd64",
          freezeSha256: await hashFile(
            resolve(kit.directory, "source-kit-recipe/debian-freeze.json"),
          ),
          embeddedInventorySha256: await hashFile(
            resolve(kit.directory, "source-kit-recipe/embedded-freeze.json"),
          ),
          archiveSha256: await hashFile(image),
          imageId,
          savedImage: inspected.saved,
          builtManifestDigest: inspected.saved.manifest.digest,
          runtimeImageConfigSha256: sha256(JSON.stringify(inspected.configuration)),
          installedSourceInventorySha256: await hashFile(
            resolve(records, "installed-source-inventory.json"),
          ),
          licenseInventorySha256: await hashFile(resolve(records, "license-inventory.json")),
        }),
      );
      return verifyImageSourceDistribution(
        {
          ...kitIdentity,
          image,
          metadata,
          metadataSha256: await hashFile(metadata),
          records,
        },
        kit,
      );
    }
    await checkFixture("baseline");
    const hardlinkDirectory = resolve(filesystem, "notice-data");
    await mkdir(hardlinkDirectory);
    const target = resolve(hardlinkDirectory, "Node-LICENSE");
    await copyFile(nodeNotice, target);
    await rm(nodeNotice);
    await link(target, nodeNotice);
    await checkFixture("hardlinked-node-notice", true);
    await rm(nodeNotice);
    await copyFile(target, nodeNotice);
    await rm(hardlinkDirectory, { recursive: true });
    await writeFile(nodeNotice, "changed notice with self-consistent producer hashes\n");
    await assert.rejects(checkFixture("changed-node-notice"), /Kit notice changed.*Node-LICENSE/);
    await rm(nodeNotice);
    await assert.rejects(
      checkFixture("omitted-node-notice"),
      /notice|license/i,
      "Image gate accepted missing kit-bound Node-LICENSE with self-consistent producer records",
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
