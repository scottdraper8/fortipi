import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { t as listTar } from "tar";
import { prepare, verifyAssets, verifyPrepared } from "../dist/assets.js";
import { packageWorkerAssets } from "../scripts/package-worker-assets.ts";
import { config, temp } from "./fixtures.ts";

const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function fileHash(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const bytes of createReadStream(path)) digest.update(bytes);
  return digest.digest("hex");
}

// Static package/prepare only: no deployment, account access or image build.
test("actual AD source-kit context cannot retain old built-image provenance after repackaging", {
  timeout: 60000,
}, async (context) => {
  const directory = await temp(context);
  const generated = join(root, "apps/worker/dist/container");
  const metadataPath = join(generated, "image-metadata.json");
  const metadataBytes = await readFile(metadataPath);
  const metadata = JSON.parse(metadataBytes.toString()) as {
    sourceCommit: string;
    sourceKitSha256: string;
    builtManifestDigest: string;
    registryDigest: null;
    runtimeVerified: boolean;
  };
  const kitPath = join(generated, "sources-and-notices.tar");
  // This is the actual verified AD archive, not the current checkout's kit.
  assert.equal(await fileHash(kitPath), metadata.sourceKitSha256);
  assert.equal(metadata.registryDigest, null);
  assert.equal(metadata.runtimeVerified, false);
  const member = "context/notices/Node-LICENSE";
  const input = join(generated, member);
  const original = await readFile(input);
  let conveyed: Buffer | undefined;
  await listTar({
    file: kitPath,
    strict: true,
    onReadEntry(entry) {
      if (entry.path !== member) return;
      const chunks: Buffer[] = [];
      entry.on("data", (bytes) => chunks.push(Buffer.from(bytes)));
      entry.on("end", () => {
        conveyed = Buffer.concat(chunks);
      });
    },
  });
  assert.ok(conveyed, "The metadata-bound AD kit must actually convey this context input");
  assert.deepEqual(original, conveyed);
  assert.ok(original.length > 0);
  const commit = (
    await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: root })
  ).stdout.trim();
  const produce = () =>
    packageWorkerAssets({
      workerBuild: "apps/worker/dist/worker",
      commit,
      version: "0.1.0",
    });
  const operator = await config();
  // Schema-valid static Linux selection, not evidence of this user's plan or
  // paid entitlement. This command does not contact Cloudflare or Docker.
  operator.runtime.infrastructure.profile = "verified";
  operator.runtime.infrastructure.accountPlan = "paid";
  operator.runtime.infrastructure.capabilities = [
    {
      capability: "containers",
      state: "available",
      accountPlan: "paid",
      deploymentId: operator.deployment.name,
      observedAt: 1,
    },
  ];
  operator.runtime.execution = {
    kind: "linux",
    backendId: "linux",
    host: "container",
    imageDigest: metadata.builtManifestDigest,
    runtime: { cpuMs: 1000, memoryBytes: 1048576, timeoutMs: 1000 },
  };
  const configPath = join(directory, "operator.json");
  await writeFile(configPath, JSON.stringify(operator), { flag: "wx" });
  const positiveManifest = await produce();
  const positive = await prepare(configPath, join(directory, "positive"));
  await verifyPrepared(join(directory, "positive"));
  assert.equal(positiveManifest.image?.builtManifestDigest, metadata.builtManifestDigest);
  assert.equal(positiveManifest.image.sourceCommit, metadata.sourceCommit);
  const altered = Buffer.from(original);
  altered[0] = altered[0]! ^ 1;
  assert.notEqual(hash(altered), hash(original));
  try {
    await writeFile(input, altered);
    await assert.rejects(
      async () => {
        const repackaged = await produce();
        const checked = await verifyAssets();
        const changed = await prepare(configPath, join(directory, "changed"));
        await verifyPrepared(join(directory, "changed"));
        const preparedInput = await readFile(
          join(directory, "changed/assets/linux/container/notices/Node-LICENSE"),
        );
        const wrangler = JSON.parse(
          await readFile(join(directory, "changed/wrangler.json"), "utf8"),
        ) as { vars: { FORTIPI_CONFIG: { execution: { imageDigest: string } } } };
        assert.deepEqual(preparedInput, altered);
        assert.equal(repackaged.image?.builtManifestDigest, metadata.builtManifestDigest);
        assert.equal(
          wrangler.vars.FORTIPI_CONFIG.execution.imageDigest,
          metadata.builtManifestDigest,
        );
        assert.notEqual(changed.assetManifestSha256, positive.assetManifestSha256);
        assert.equal(checked.manifestSha256, changed.assetManifestSha256);
        assert.deepEqual(await readFile(metadataPath), metadataBytes);
        console.log(
          JSON.stringify({
            positivePackageAndPrepare: true,
            sourceKitSha256: metadata.sourceKitSha256,
            originalContextMatchesKitMember: true,
            changedInput: member,
            originalInputSha256: hash(original),
            changedInputSha256: hash(altered),
            oldBuiltManifestDigest: metadata.builtManifestDigest,
            repackagedManifestChanged: true,
            selfConsistentAssetHashesAccepted: true,
            changedLinuxPrepareAccepted: true,
            preparedImageDigestStillOriginal: true,
            packageFiles: repackaged.files.length,
          }),
        );
      },
      /source.?kit|provenance|image.*(?:context|identity)|(?:context|image).*changed|asset_integrity_failed/i,
      "Changed metadata-bound image input must reject before advertising matched old-image provenance",
    );
  } finally {
    await writeFile(input, original);
    assert.equal(await fileHash(input), hash(original));
    assert.deepEqual(await readFile(metadataPath), metadataBytes);
    // Leave the owned generated package truthful as well as restoring the input.
    await produce();
  }
});
