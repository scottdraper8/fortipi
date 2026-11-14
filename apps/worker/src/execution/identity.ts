import { same } from "../api/common.js";
import type * as D from "../boundary/dto.js";

/** Lease versions/expiry are observations. Every other assignment field stays fixed. */
export function sameLeaseIdentity(a: D.Lease, b: D.Lease): boolean {
  const stable = ({ leaseVersion: _version, expiresAt: _expiry, ...identity }: D.Lease) => identity;
  return same(stable(a), stable(b));
}

export function sameExecutionIdentity(a: D.ExecutionIdentity, b: D.ExecutionIdentity): boolean {
  return same({ ...a, lease: b.lease }, b) && sameLeaseIdentity(a.lease, b.lease);
}
