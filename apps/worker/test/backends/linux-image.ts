import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const harness = createTestHarness({
  root,
  workers: [
    {
      config: {
        name: "fortipi-linux-image-probe",
        main: resolve(root, "apps/worker/test/backends/runtime-worker.ts"),
        compatibility_date: "2026-11-10",
        compatibility_flags: ["nodejs_compat"],
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
            images: { computerd: "fortipi-computerd:verified" },
          },
        ],
        vars: { REQUIRE_FUSE: process.argv.includes("--require-fuse") ? "true" : "false" },
      },
    },
  ],
});
try {
  await harness.listen();
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
  const directory = resolve(root, "apps/worker/dist/container");
  await mkdir(directory, { recursive: true });
  const metadata = JSON.parse(
    await readFile(resolve(directory, "image-metadata.json"), "utf8"),
  ) as Record<string, unknown>;
  process.stdout.write(
    `${JSON.stringify({ imageId: metadata.imageId, localExecution: true, realFuse: body.fuse, cloudVerified: false })}\n`,
  );
} finally {
  await harness.close();
}
