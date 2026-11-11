import { canonicalJson, incrementSafe } from "fortipi-contract";
import type * as D from "../boundary/dto.js";
import { requireThat } from "./errors.js";
import type { State } from "./state.js";

export interface AuthorityRecord {
  workspaceId: string;
  deploymentId: string;
  binding: D.WorkspaceBinding;
  fence: string;
  lease?: D.Lease;
  leaseTarget?: D.BackendRef;
}
export interface RevisionRecord {
  manifest: D.Manifest;
  manifestHash: string;
  store?: D.SealedStore;
  revision: string;
}
export interface UploadRecord {
  request: D.UploadBegin;
  owner: D.CredentialRef;
  status: D.UploadStatus;
  allocation: D.StoreAllocation;
  stage?: D.SealedStore;
  capacity: D.CapacityReservation;
}
export interface AllocationRecord {
  state: D.StoreState;
  seal?: D.SealedStore;
  referenced: boolean;
  pins: number;
}
export function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
/** AuthContext is CP-validated; bootstrap may carry internal wildcard grants. */
export function permitsResource(values: readonly string[], value: string): boolean {
  return values.includes(value) || values.includes("*");
}
export function transferConsumer(
  workspaceId: string,
  action: string,
  executorId: string,
): D.ResourceScope {
  return {
    agentIds: [],
    conversationIds: [],
    workspaceIds: [workspaceId],
    actions: [action],
    tools: [],
    executorIds: [executorId],
    backendIds: [],
  };
}
export function authorize(
  state: State,
  ctx: D.AuthContext,
  workspaceId: string,
  action: string,
): void {
  const now = Date.now();
  requireThat(
    ctx.deadline > now && (ctx.credentialExpiresAt === null || ctx.credentialExpiresAt > now),
    "unauthenticated",
    "Authentication expired",
  );
  requireThat(ctx.registrationId, "unauthorized", "Authority registration required");
  const authority = state.get<AuthorityRecord>("authority");
  requireThat(
    !authority || authority.deploymentId === ctx.deploymentId,
    "unauthorized",
    "Wrong deployment",
  );
  requireThat(
    ctx.generation >= (state.get<number>(`floor:credential:${ctx.credentialId}`) ?? 0),
    "unauthorized",
    "Credential generation revoked",
  );
  requireThat(
    ctx.grants.some(
      (grant) =>
        (grant.expiresAt === undefined || grant.expiresAt > now) &&
        permitsResource(grant.resources.workspaceIds, workspaceId) &&
        permitsResource(grant.resources.actions, action),
    ),
    "unauthorized",
    "Workspace grant required",
  );
}
/** Historical immutable identity; renewal observations never rewrite the original authority. */
export function immutableLease(lease: D.Lease) {
  const { expiresAt: _expiry, leaseVersion: _version, ...identity } = lease;
  return identity;
}
export function reservedLease(state: State, lease: D.Lease): D.TargetReservation {
  const reservation = state.get<D.TargetReservation>(`reservation:${lease.leaseId}`);
  const acquired = reservation
    ? state.get<{ lease: D.Lease }>(`lease-acquire:${reservation.reservationId}`)
    : undefined;
  requireThat(
    reservation &&
      acquired &&
      same(immutableLease(acquired.lease), immutableLease(lease)) &&
      reservation.workspaceId === lease.workspaceId &&
      reservation.operationId === lease.operationId &&
      same(reservation.credential, lease.credential) &&
      reservation.registrationIds.workspace === lease.registrationId &&
      reservation.ownerKind === lease.ownerKind &&
      (reservation.ownerKind !== "job" ||
        (lease.ownerKind === "job" && reservation.jobId === lease.jobId)) &&
      reservation.target.generation === lease.executorGeneration &&
      (reservation.target.kind === "executor"
        ? reservation.target.executorId
        : reservation.target.backendId) === lease.executorId,
    "conflict",
    "Original lease reservation mismatch",
  );
  return reservation;
}
/** Private operation proof only. Public read methods continue to require workspace.read. */
export function authorizeReservedAction(
  state: State,
  ctx: D.AuthContext,
  lease: D.Lease,
  action: "workspace.read" | "workspace.write",
): D.TargetReservation {
  authorize(state, ctx, lease.workspaceId, action);
  const reservation = reservedLease(state, lease);
  requireThat(
    (reservation.actions.includes(action) ||
      (action === "workspace.read" && reservation.actions.includes("workspace.write"))) &&
      (reservation.target.kind !== "executor" ||
        reservation.target.generation >=
          (state.get<number>(`floor:executor:${reservation.target.executorId}`) ?? 0)) &&
      ctx.grants.some(
        (grant) =>
          (grant.expiresAt === undefined || grant.expiresAt > Date.now()) &&
          permitsResource(grant.resources.workspaceIds, reservation.workspaceId) &&
          permitsResource(grant.resources.actions, action) &&
          (!reservation.agentId ||
            permitsResource(grant.resources.agentIds, reservation.agentId)) &&
          (!reservation.conversationId ||
            permitsResource(grant.resources.conversationIds, reservation.conversationId)) &&
          (reservation.target.kind === "executor"
            ? permitsResource(grant.resources.executorIds, reservation.target.executorId)
            : permitsResource(grant.resources.backendIds, reservation.target.backendId) ||
              (reservation.ownerKind === "workspace-operation" &&
                reservation.target.backendId === reservation.workspaceId)),
      ),
    "unauthorized",
    "Current reserved operation grant or target generation required",
  );
  return reservation;
}
export function validateLease(
  state: State,
  authority: AuthorityRecord,
  lease: D.Lease,
  ctx: D.AuthContext,
): D.Lease {
  authorize(state, ctx, authority.workspaceId, "workspace.write");
  const active = authority.lease;
  requireThat(active && active.expiresAt > Date.now(), "workspace.conflict", "Lease expired", {
    reason: "expired_lease",
  });
  requireThat(
    lease.workspaceId === authority.workspaceId &&
      active.leaseId === lease.leaseId &&
      active.fence === lease.fence &&
      active.operationId === lease.operationId &&
      active.executorId === lease.executorId &&
      active.executorGeneration === lease.executorGeneration &&
      active.baseRevision === lease.baseRevision &&
      active.ownerKind === lease.ownerKind &&
      (active.ownerKind !== "job" || (lease.ownerKind === "job" && active.jobId === lease.jobId)) &&
      same(active.credential, lease.credential) &&
      active.registrationId === lease.registrationId,
    "workspace.conflict",
    "Stale lease identity",
    { reason: "stale_fence" },
  );
  requireThat(
    same(active.credential, {
      credentialId: ctx.credentialId,
      generation: ctx.generation,
      grantVersion: ctx.grantVersion,
    }) && active.registrationId === ctx.registrationId,
    "unauthorized",
    "Lease authority mismatch",
  );
  requireThat(
    authority.leaseTarget &&
      authority.leaseTarget.generation === active.executorGeneration &&
      (authority.leaseTarget.kind === "executor"
        ? authority.leaseTarget.executorId
        : authority.leaseTarget.backendId) === active.executorId &&
      (authority.leaseTarget.kind !== "executor" ||
        active.executorGeneration >=
          (state.get<number>(`floor:executor:${active.executorId}`) ?? 0)),
    "workspace.conflict",
    "Executor generation revoked",
    { reason: "stale_generation" },
  );
  requireThat(
    active.credential.generation >=
      (state.get<number>(`floor:credential:${active.credential.credentialId}`) ?? 0),
    "unauthorized",
    "Credential revoked",
  );
  requireThat(
    authority.binding.revision === lease.baseRevision,
    "workspace.conflict",
    "Base revision changed",
    { reason: "expected_revision" },
  );
  return active;
}
export function nextFence(value: string): string {
  const next = (BigInt(value) + 1n).toString();
  requireThat(next.length <= 128, "conflict", "Workspace fence namespace exhausted");
  return next;
}
export function renew(
  state: State,
  authority: AuthorityRecord,
  ctx: D.AuthContext,
  input: D.LeaseRenewal,
): D.Lease {
  const lease = validateLease(state, authority, input.lease, ctx);
  requireThat(
    lease.leaseVersion === input.expectedLeaseVersion &&
      input.lease.leaseVersion === input.expectedLeaseVersion &&
      input.expiresAt > Date.now() &&
      input.expiresAt <= Date.now() + 30_000 &&
      (ctx.credentialExpiresAt === null || input.expiresAt <= ctx.credentialExpiresAt) &&
      ctx.grants.some(
        (grant) =>
          permitsResource(grant.resources.workspaceIds, authority.workspaceId) &&
          permitsResource(grant.resources.actions, "workspace.write") &&
          (grant.expiresAt === undefined || grant.expiresAt >= input.expiresAt),
      ),
    "conflict",
    "Invalid renewal version or expiry",
  );
  const renewed = {
    ...lease,
    leaseVersion: incrementSafe(lease.leaseVersion),
    expiresAt: input.expiresAt,
  };
  state.put("authority", { ...authority, lease: renewed });
  return renewed;
}
