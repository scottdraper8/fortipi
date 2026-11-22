import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import {
  bindLocalImage,
  normalizeLocalInspection,
  verifyPhysicalImage,
} from "./local-image-binding.ts";

test("local address mapping preserves native labels and binds independently observed config/lifecycle identities", () => {
  // Shape controls only: these synthetic observations are not Docker/FUSE or paid-provider proof.
  const imageId = `sha256:${"a".repeat(64)}`,
    manifest = `sha256:${"b".repeat(64)}`,
    reference = "cloudflare-dev/probehost-computerd-8d30bbdf7d69:aaf24570";
  const binding = bindLocalImage(
    { preparedReference: reference, imageId, manifestDigest: manifest },
    imageId,
    manifest,
    reference,
  );
  assert.equal(binding.logicalReference, `fortipi-local/computerd@${manifest}`);
  const labels = { fortipi_owner: "c".repeat(64) };
  const native = { image: reference, labels };
  assert.deepEqual(normalizeLocalInspection(binding, reference, native), {
    image: binding.logicalReference,
    labels,
  });
  assert.equal(normalizeLocalInspection(binding, reference, native)?.labels, labels);
  assert.equal(normalizeLocalInspection(binding, reference, null), null);
  const physical = {
    id: "d".repeat(64),
    imageId,
    reference,
    running: true,
    startedAt: "2026-11-12T12:00:00.000Z",
  };
  const before = verifyPhysicalImage(binding, native, physical);
  assert.deepEqual(verifyPhysicalImage(binding, native, physical, before), before);
  assert.throws(
    () => verifyPhysicalImage(binding, native, { ...physical, imageId: manifest }),
    /Docker container image differs/,
  );
  assert.throws(
    () =>
      verifyPhysicalImage(
        binding,
        native,
        { ...physical, startedAt: "2026-11-12T12:01:00.000Z" },
        before,
      ),
    /changed during execution/,
  );
  assert.throws(
    () =>
      verifyPhysicalImage(
        binding,
        { ...native, labels: { fortipi_owner: "e".repeat(64) } },
        physical,
        before,
      ),
    /changed during execution/,
  );
});

test("actual Worker retains its backend gate and SDK rejection of an existing execution", {
  timeout: 60000,
}, async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
  const server = createTestHarness({
    root,
    workers: [
      {
        config: {
          name: "fortipi-local-binding-cache-control",
          main: resolve(root, "apps/worker/test/backends/runtime-worker.ts"),
          compatibility_date: "2026-11-10",
          compatibility_flags: ["nodejs_compat"],
          worker_loaders: [{ binding: "LOADER" }],
          durable_objects: { bindings: [{ name: "WORKSPACES", class_name: "BackendProbe" }] },
          migrations: [{ tag: "v1", new_sqlite_classes: ["BackendProbe"] }],
        },
      },
    ],
  });
  try {
    await server.listen();
    const response = await server.fetch("/run?backend=js");
    assert.equal(response.status, 200);
    const result = (await response.json()) as {
      status: string;
      content: string;
      sync: string;
      skipped: number;
    };
    assert.equal(result.status, "completed");
    assert.equal(result.content, "fortipi-result");
    assert.equal(result.sync, "complete");
    assert.equal(result.skipped, 0);
    await assert.rejects(
      server.fetch("/prepare-linux?backend=linux"),
      /Probe cannot change backend after preparation/,
    );
    await assert.rejects(
      server.fetch("/run?backend=js"),
      /execution probe-execution already exists/,
    );
  } finally {
    await server.close();
  }
});

test("unbound, altered and native-mismatched prepared references cannot acquire the canonical identity", () => {
  const imageId = `sha256:${"a".repeat(64)}`,
    manifest = `sha256:${"b".repeat(64)}`,
    reference = "cloudflare-dev/probehost-computerd-8d30bbdf7d69:aaf24570";
  const input = { preparedReference: reference, imageId, manifestDigest: manifest };
  const binding = bindLocalImage(input, imageId, manifest, reference);
  assert.throws(
    () => bindLocalImage({ ...input, imageId: manifest }, imageId, manifest, reference),
    /config differs/,
  );
  assert.throws(
    () => bindLocalImage({ ...input, manifestDigest: imageId }, imageId, manifest, reference),
    /manifest differs/,
  );
  assert.throws(() => bindLocalImage(input, imageId, manifest, `${reference}@${manifest}`));
  assert.throws(
    () => normalizeLocalInspection(binding, `${reference}0`, null),
    /reference changed/,
  );
  assert.throws(
    () =>
      normalizeLocalInspection(binding, reference, { image: binding.logicalReference, labels: {} }),
    /another prepared image/,
  );
});
