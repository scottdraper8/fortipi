import { createHash } from "node:crypto";
import { canonicalJson } from "fortipi-contract";
import type { RuntimeHostContext } from "../boundary/infrastructure.js";
import { requireThat } from "../workspace/errors.js";

export function hostContext(value: unknown): RuntimeHostContext {
  requireThat(
    value && typeof value === "object" && !Array.isArray(value),
    "invalid_request",
    "Closed runtime Host context required",
  );
  const row = value as Record<string, unknown>;
  requireThat(
    Object.keys(row).sort().join(",") ===
      "allocationId,authorityId,childId,hostId,imageDigest,ownershipNonce" &&
      typeof row.hostId === "string" &&
      row.hostId.length <= 256 &&
      /^fortipi:linux:[A-Za-z0-9_-]{1,128}:[a-f0-9]{64}$/.test(row.hostId) &&
      typeof row.authorityId === "string" &&
      /^[A-Za-z0-9_-]{1,128}$/.test(row.authorityId) &&
      typeof row.allocationId === "string" &&
      /^[A-Za-z0-9_-]{1,128}$/.test(row.allocationId) &&
      typeof row.childId === "string" &&
      /^fortipi:child:[a-f0-9-]{36}$/.test(row.childId) &&
      typeof row.imageDigest === "string" &&
      /^sha256:[a-f0-9]{64}$/.test(row.imageDigest) &&
      typeof row.ownershipNonce === "string" &&
      /^[a-f0-9]{64}$/.test(row.ownershipNonce),
    "invalid_request",
    "Exact retained runtime Host context required",
  );
  return {
    hostId: row.hostId,
    authorityId: row.authorityId,
    allocationId: row.allocationId,
    childId: row.childId,
    imageDigest: row.imageDigest,
    ownershipNonce: row.ownershipNonce,
  };
}

export function hostOwnershipDigest(context: RuntimeHostContext): string {
  return createHash("sha256")
    .update(canonicalJson(hostContext(context)))
    .digest("hex");
}
