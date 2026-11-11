import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import {
  verifyApplicationNamespace,
  verifyGatewayEgress,
} from "../../../../tools/unstale/verify-app-network.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const directory = resolve(root, "apps/worker/dist/container");
const metadata = JSON.parse(await readFile(resolve(directory, "image-metadata.json"), "utf8")) as {
  imageId: string;
};
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
        vars: { REQUIRE_FUSE: process.argv.includes("--require-fuse") ? "true" : "false" },
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
  checkLoadedImage();
  process.stdout.write(
    `${JSON.stringify({ imageId: metadata.imageId, localExecution: true, realFuse: body.fuse, cloudVerified: false })}\n`,
  );
  const network = await verifyApplicationNamespace(metadata.imageId);
  verifyGatewayEgress(harness.getLogs(), network);
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
