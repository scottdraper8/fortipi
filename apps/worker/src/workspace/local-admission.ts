import { validateExecutorTransferLimits, validateUploadBlobs, wireLimits } from "fortipi-contract";
import type * as D from "../boundary/dto.js";
import { requireThat } from "./errors.js";
import { snapshotBytes } from "./manifest.js";

/** Validate the whole declared plan before capacity reservation, transfer.open or owner effects. */
export function admitLocalUpload(
  request: D.UploadBegin,
  limits: D.ExecutorTransferLimits | null,
): void {
  requireThat(
    limits,
    "unavailable_executor",
    "Executor has no validated numeric transfer-limit observation",
  );
  const ceilings: D.ExecutorTransferLimits = {
    chunkBytes: wireLimits.chunkBytes,
    fileBytes: wireLimits.fileBytes,
    snapshotBytes: wireLimits.revisionBytes,
    artifactBytes: wireLimits.artifactBytes,
    manifestEntries: wireLimits.manifestEntries,
  };
  for (const field of [
    "chunkBytes",
    "fileBytes",
    "snapshotBytes",
    "artifactBytes",
    "manifestEntries",
  ] as const)
    requireThat(
      Number.isSafeInteger(limits[field]) && limits[field] > 0 && limits[field] <= ceilings[field],
      "unavailable_executor",
      "Invalid executor transfer-limit observation",
    );
  try {
    validateExecutorTransferLimits(limits);
    validateUploadBlobs(request, { required: true });
  } catch {
    requireThat(false, "invalid_request", "Incompatible executor limits or upload chunk plans");
  }
  requireThat(
    request.manifest.entries.length <= limits.manifestEntries &&
      request.mutations.length <= limits.manifestEntries &&
      snapshotBytes(request.manifest) <= limits.snapshotBytes &&
      request.manifest.entries.every(
        (entry) => entry.type !== "file" || entry.size <= limits.fileBytes,
      ),
    "quota_exceeded",
    "Local proposed manifest/mutations exceed the registered executor limits",
  );
  const sizes = new Map<string, number>();
  const plans = new Map(request.blobs?.map((plan) => [plan.sha256, plan]));
  for (const mutation of request.mutations)
    if (mutation.kind === "put") {
      const plan = plans.get(mutation.sha256);
      requireThat(
        plan && plan.chunks.chunkBytes <= limits.chunkBytes && mutation.size <= limits.fileBytes,
        "quota_exceeded",
        "Local put grid or file size exceeds the registered executor limits",
      );
      sizes.set(mutation.sha256, mutation.size);
    }
  requireThat(
    [...sizes.values()].reduce((sum, size) => sum + size, 0) <= limits.snapshotBytes,
    "quota_exceeded",
    "All declared local blobs exceed the registered staging bound",
  );
}
