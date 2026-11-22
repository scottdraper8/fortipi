import { createHash } from "node:crypto";
import type { Assignment, ExecutionIdentity } from "fortipi-contract/executor";
import { canonicalJson } from "fortipi-contract/executor";

export interface LocalPolicy {
  version: number;
  trustedHost: boolean;
  requireConfinement: boolean;
  consent?: { acceptedAt: number; osUser: string; disclosure: "daemon-user-files-and-network" };
  rules: { workspaceId: string; rootBindingId: string; tool: "shell"; argumentDigest: string }[];
}
export const disabledPolicy: LocalPolicy = {
  version: 1,
  trustedHost: false,
  requireConfinement: false,
  rules: [],
};
export function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
export function immutableIdentity(identity: ExecutionIdentity): string {
  const { expiresAt: _expiry, leaseVersion: _version, ...lease } = identity.lease;
  return canonicalJson({ ...identity, lease });
}
export function assignmentBody(assignment: Assignment): string {
  return canonicalJson({
    ...assignment,
    identity: JSON.parse(immutableIdentity(assignment.identity)),
  });
}
export function approvalKey(
  assignment: Assignment,
  policy: LocalPolicy,
  rootIdentity: string,
): string {
  return hash(
    canonicalJson({
      assignment: JSON.parse(assignmentBody(assignment)),
      localPolicy: policy,
      rootIdentity,
      hostTrust: "daemon-user-files-and-network",
    }),
  );
}
export function checkPolicy(assignment: Assignment, policy: LocalPolicy, now: number): void {
  if (
    !Number.isSafeInteger(policy.version) ||
    policy.version < 1 ||
    !policy.trustedHost ||
    !policy.consent ||
    policy.consent.disclosure !== "daemon-user-files-and-network"
  )
    throw new Error("native shell disabled: explicit trusted-host consent required");
  if (policy.requireConfinement) throw new Error("require-confinement rejects native host backend");
  if (
    assignment.tool !== "shell" ||
    typeof assignment.arguments.command !== "string" ||
    assignment.arguments.command.includes("\0") ||
    Buffer.byteLength(assignment.arguments.command) > 65536
  )
    throw new Error("invalid shell operation");
  const a = assignment.approval;
  const i = assignment.identity;
  if (
    a?.trust !== "host" ||
    a.operationDigest !== i.operationDigest ||
    a.tool !== assignment.tool ||
    canonicalJson(a.arguments) !== canonicalJson(assignment.arguments) ||
    a.workspaceId !== assignment.workspaceId ||
    a.baseRevision !== i.baseRevision ||
    canonicalJson(a.target) !== canonicalJson(i.target) ||
    a.grantVersion !== i.lease.credential.grantVersion ||
    now >= a.expiresAt ||
    now >= i.deadline ||
    now >= i.lease.expiresAt
  )
    throw new Error("remote approval context mismatch or expired authority");
  if (Object.keys(assignment.arguments).some((key) => !["command", "env", "cwd"].includes(key)))
    throw new Error("unknown shell argument");
}
export function allowedByRule(assignment: Assignment, policy: LocalPolicy): boolean {
  return policy.rules.some(
    (r) =>
      r.workspaceId === assignment.workspaceId &&
      r.rootBindingId === assignment.rootBindingId &&
      r.tool === assignment.tool &&
      r.argumentDigest === hash(canonicalJson(assignment.arguments)),
  );
}
