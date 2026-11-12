import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { hashFile } from "../../../../scripts/image-source-distribution.ts";
import {
  observeHarnessFetch,
  verifyApplicationNamespace,
  verifyGatewayEgress,
} from "../../../../tools/unstale/verify-app-network.ts";
import { proveLibraryReplacement } from "../../container/library-replacement.ts";
import { sourceRevision, verifyRecipientFixture } from "../../container/recipient.ts";
import {
  bindLocalImage,
  type NativeImageObservation,
  type PhysicalImageIdentity,
  type PhysicalImageObservation,
  verifyPhysicalImage,
} from "./local-image-binding.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const directory = resolve(root, "apps/worker/dist/container");
// No fallback to the builder's already-loaded image: import receipt is mandatory.
const metadata = { imageId: await verifyRecipientFixture() };
const imageMetadata = JSON.parse(
  await readFile(resolve(directory, "image-metadata.json"), "utf8"),
) as { imageId: string; builtManifestDigest: string };
assert.equal(imageMetadata.imageId, metadata.imageId);
assert.match(imageMetadata.builtManifestDigest, /^sha256:[a-f0-9]{64}$/);
assert.match(metadata.imageId, /^sha256:[a-f0-9]{64}$/);
function checkLoadedImage(): void {
  assert.equal(
    execFileSync(
      "docker",
      ["image", "inspect", "fortipi-computerd:verified", "--format", "{{.Id}}"],
      { encoding: "utf8" },
    ).trim(),
    metadata.imageId,
    "Probe tag differs from the image whose inventory was verified",
  );
}
checkLoadedImage();
const fixture = resolve(directory, "probe-context");
await mkdir(fixture, { recursive: true });
await writeFile(resolve(fixture, "Dockerfile"), "FROM fortipi-computerd:verified\n");
const harness = createTestHarness({
  root,
  workers: [
    {
      config: {
        name: "fortipi-linux-image-probe",
        main: resolve(root, "apps/worker/test/backends/runtime-worker.ts"),
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
            // Wrangler permits local Dockerfile builds; image references require its managed registry.
            images: {
              computerd: { dockerfile: resolve(fixture, "Dockerfile"), build_context: fixture },
            },
          },
        ],
        vars: {
          REQUIRE_FUSE: process.argv.includes("--require-fuse") ? "true" : "false",
          LOCAL_PROBE_IMAGE_ID: metadata.imageId,
          LOCAL_PROBE_MANIFEST: imageMetadata.builtManifestDigest,
        },
      },
    },
  ],
});
try {
  await harness.listen();
  const prepared = await harness.fetch("/prepared-image");
  assert.equal(prepared.status, 200);
  const selected: unknown = await prepared.json();
  assert.ok(typeof selected === "string");
  assert.match(selected, /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}$/);
  assert.equal(
    execFileSync("docker", ["image", "inspect", selected, "--format", "{{.Id}}"], {
      encoding: "utf8",
    }).trim(),
    metadata.imageId,
    "Wrangler's actual prepared runtime image differs from the verified image",
  );
  const binding = bindLocalImage(
    {
      preparedReference: selected,
      imageId: metadata.imageId,
      manifestDigest: imageMetadata.builtManifestDigest,
    },
    metadata.imageId,
    imageMetadata.builtManifestDigest,
    selected,
  );
  const packet = JSON.stringify({
    preparedReference: binding.preparedReference,
    imageId: binding.imageId,
    manifestDigest: binding.manifestDigest,
  });
  assert.equal(
    (
      await harness.fetch("/bind-local-image", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(packet)),
        },
        body: packet,
      })
    ).status,
    200,
  );
  assert.equal(
    (await harness.fetch("/prepare-linux?backend=linux")).status,
    200,
    "Actual native connection must precede physical-image proof and tool execution",
  );
  const inspectPhysical = async (prior?: PhysicalImageIdentity) => {
    checkLoadedImage();
    assert.equal(
      execFileSync("docker", ["image", "inspect", selected, "--format", "{{.Id}}"], {
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 8192,
      }).trim(),
      metadata.imageId,
      "Wrangler prepared tag changed its verified config binding",
    );
    assert.equal(await verifyRecipientFixture(), metadata.imageId);
    const observation = await harness.fetch("/native-image");
    assert.equal(observation.status, 200);
    const native = (await observation.json()) as NativeImageObservation;
    const ids = execFileSync("docker", ["ps", "--quiet", "--no-trunc"], {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 8192,
    })
      .trim()
      .split("\n");
    assert.ok(ids.length > 0 && ids.length <= 8 && ids.every((id) => /^[a-f0-9]{64}$/.test(id)));
    const format =
      '{"id":{{json .Id}},"imageId":{{json .Image}},"reference":{{json .Config.Image}},"running":{{json .State.Running}},"startedAt":{{json .State.StartedAt}}}';
    const containers = execFileSync("docker", ["inspect", "--format", format, ...ids], {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 16384,
    })
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as PhysicalImageObservation);
    const matching = containers.filter((row) => row.reference === selected);
    assert.equal(
      matching.length,
      1,
      "Exactly one actual selected application container is required",
    );
    const actual = matching[0];
    assert.ok(actual);
    return verifyPhysicalImage(binding, native, actual, prior);
  };
  const physical = await inspectPhysical();
  const response = await harness.fetch("/run?backend=linux");
  assert.equal(response.status, 200, "Actual computerd execution failed");
  const body = (await response.json()) as {
    status: string;
    exitCode: number;
    content: string;
    canary: boolean;
    sync: string;
    skipped: number;
    fuse: boolean;
  };
  assert.equal(body.status, "completed");
  assert.equal(body.exitCode, 0);
  assert.equal(body.content, "fortipi-result");
  assert.equal(body.canary, true);
  assert.equal(body.sync, "complete");
  assert.equal(body.skipped, 0);
  if (process.argv.includes("--require-fuse")) assert.equal(body.fuse, true);
  await inspectPhysical(physical);
  const groupResponse = await harness.fetch("/run?backend=linux&process-group=true");
  assert.equal(
    groupResponse.status,
    200,
    "Actual patched daemon process-group cancellation failed",
  );
  const group = (await groupResponse.json()) as {
    cancelled: string;
    observer: string;
    stdout: string;
    sync: string;
    skipped: number;
  };
  assert.equal(group.cancelled, "cancelled");
  assert.equal(group.observer, "completed");
  assert.ok(group.stdout.includes("process-group-stopped"));
  assert.equal(group.sync, "complete");
  assert.equal(group.skipped, 0);
  await inspectPhysical(physical);
  checkLoadedImage();
  assert.equal(await verifyRecipientFixture(), metadata.imageId);
  process.stdout.write(
    `${JSON.stringify({ imageId: metadata.imageId, manifestDigest: binding.manifestDigest, physicalContainerId: physical.id, physicalImageVerifiedBeforeAfter: true, localPreparedReferenceBound: true, recipientImported: true, localExecution: true, realFuse: body.fuse, cloudVerified: false })}\n`,
  );
  const parentNamespace = await readlink("/proc/self/ns/net");
  const observation = observeHarnessFetch();
  let trace: ReturnType<typeof observation.stop> | undefined;
  let namespaceStable = false;
  let network: Awaited<ReturnType<typeof verifyApplicationNamespace>>;
  try {
    network = await verifyApplicationNamespace(metadata.imageId);
  } finally {
    trace = observation.stop();
    try {
      namespaceStable = parentNamespace === (await readlink("/proc/self/ns/net"));
    } catch {
      namespaceStable = false;
    }
    process.stdout.write(`${JSON.stringify({ ...trace, namespaceStable })}\n`);
  }
  verifyGatewayEgress(harness.getLogs(), network, trace && { ...trace, namespaceStable });
  await inspectPhysical(physical);
  assert.ok(
    trace?.complete && namespaceStable,
    "Harness host-fetch observation is incomplete or unknown",
  );
  process.stdout.write(
    `${JSON.stringify({
      probe: "application-namespace-https",
      client: "host Node client in actual application network namespace",
      path: "Cloudflare sidecar -> Computer HTTP gateway -> protected worker egress",
      imageId: metadata.imageId,
      appPid: network.appPid,
      authorityVerifiedBeforeAfter: true,
      allowedBefore: network.allowedBefore,
      deniedStatus: network.deniedStatus,
      allowedAfter: network.allowedAfter,
      tlsAuthorized: true,
      applicationDns: "pinned-sidecar-synthetic",
      stepSecurityGatewayUpstreamSinkhole: true,
      gatewayForwardingVerified: true,
      providerDenialLogRequired: true,
    })}\n`,
  );
} finally {
  try {
    const allowed = new Set(
      ["before-status", "port-capability", "native-fetch", "after-status", "unclassified"].map(
        (stage) => `fortipi-container-request-stage:${stage}`,
      ),
    );
    let emitted = 0;
    for (const { message } of harness.getLogs()) {
      if (!allowed.has(message)) continue;
      process.stdout.write(`${message}\n`);
      if (++emitted === 5) break;
    }
  } finally {
    await harness.close();
  }
}
if (process.argv.includes("--verify-library-replacement")) {
  assert.ok(
    process.argv.includes("--require-fuse"),
    "Replacement needs the verified FUSE namespace",
  );
  const metadataPath = resolve(directory, "image-metadata.json");
  const bound = JSON.parse(await readFile(metadataPath, "utf8")) as {
    sourceCommit: string;
    sourceKitSha256: string;
  };
  assert.equal(bound.sourceCommit, await sourceRevision());
  await proveLibraryReplacement({
    kit: resolve(directory, "sources-and-notices.tar"),
    kitSha256: bound.sourceKitSha256,
    commit: bound.sourceCommit,
    image: resolve(directory, "image.tar"),
    metadata: metadataPath,
    metadataSha256: await hashFile(metadataPath),
    records: directory,
    out: resolve(directory, "library-replacement"),
  });
}
