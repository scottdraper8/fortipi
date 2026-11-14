import assert from "node:assert/strict";
import { runtimeHostOwnershipLabel } from "../../src/boundary/infrastructure.ts";

export interface LocalImageBinding {
  preparedReference: string;
  imageId: string;
  manifestDigest: string;
  logicalReference: string;
}
export interface NativeImageObservation {
  image: string;
  labels: Record<string, string>;
}
export interface PhysicalImageObservation {
  id: string;
  imageId: string;
  reference: string;
  running: boolean;
  startedAt: string;
}
export interface PhysicalImageIdentity extends PhysicalImageObservation {
  ownership: string;
}

/** Test-only address mapping. The controller must first verify the recipient archive and Docker image ID. */
export function bindLocalImage(
  value: unknown,
  expectedImageId: string,
  expectedManifest: string,
  currentReference: string,
): LocalImageBinding {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  const row = value as Record<string, unknown>;
  assert.deepEqual(Object.keys(row).sort(), ["imageId", "manifestDigest", "preparedReference"]);
  assert.match(expectedImageId, /^sha256:[a-f0-9]{64}$/);
  assert.match(expectedManifest, /^sha256:[a-f0-9]{64}$/);
  assert.match(currentReference, /^cloudflare-dev\/probehost-computerd-[a-f0-9]{12}:[a-f0-9]{8}$/);
  assert.equal(row.preparedReference, currentReference, "Local prepared reference changed");
  assert.equal(row.imageId, expectedImageId, "Local image config differs from verified recipient");
  assert.equal(
    row.manifestDigest,
    expectedManifest,
    "Local manifest differs from verified archive",
  );
  return Object.freeze({
    preparedReference: currentReference,
    imageId: expectedImageId,
    manifestDigest: expectedManifest,
    logicalReference: `fortipi-local/computerd@${expectedManifest}`,
  });
}

/** Preserve real labels; translate only the exact preverified local reference. Never change native start images. */
export function normalizeLocalInspection(
  binding: LocalImageBinding,
  currentReference: string,
  actual: NativeImageObservation | null,
): NativeImageObservation | null {
  assert.equal(currentReference, binding.preparedReference, "Local prepared reference changed");
  if (actual === null) return null;
  assert.equal(
    actual.image,
    binding.preparedReference,
    "Native runtime uses another prepared image",
  );
  return { image: binding.logicalReference, labels: actual.labels };
}

/** Docker's immutable config ID and lifecycle identity independently bind the real running application. */
export function verifyPhysicalImage(
  binding: LocalImageBinding,
  native: NativeImageObservation,
  physical: PhysicalImageObservation,
  prior?: PhysicalImageIdentity,
): PhysicalImageIdentity {
  normalizeLocalInspection(binding, binding.preparedReference, native);
  assert.match(physical.id, /^[a-f0-9]{64}$/);
  assert.equal(
    physical.imageId,
    binding.imageId,
    "Actual Docker container image differs from verified recipient",
  );
  assert.equal(
    physical.reference,
    binding.preparedReference,
    "Actual Docker container selected another reference",
  );
  assert.equal(physical.running, true);
  assert.ok(Number.isFinite(Date.parse(physical.startedAt)));
  const ownership = native.labels[runtimeHostOwnershipLabel];
  assert.ok(ownership && /^[a-f0-9]{64}$/.test(ownership), "Native ownership label missing");
  const identity = { ...physical, ownership };
  if (prior)
    assert.deepEqual(identity, prior, "Actual container or ownership changed during execution");
  return identity;
}
