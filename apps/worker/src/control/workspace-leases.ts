import { validateWorkspaceLeaseSubject, workspaceLeaseDigest } from "fortipi-contract";
import type * as D from "../boundary/dto.js";
import type { Env } from "../boundary/env.js";
import { contains, emptyScope, requireGrant } from "./authorization.js";
import type { Bindings } from "./bindings.js";
import { valid } from "./directory.js";
import type { Dispatch } from "./dispatch.js";
import type { Identities } from "./identity.js";
import type { LocalWorkspace } from "./local-workspace.js";
import { check, fail, hash, json, ref, type Store, same, within } from "./store.js";
import type { ExecutorState } from "./tickets.js";

type Reservation = Extract<D.TargetReservation, { ownerKind: "workspace-operation" }>;
interface LeaseRecord {
  lease: D.WorkspaceOperationLease;
  target: D.BackendRef;
  bindingVersion: number;
  state: "active" | "releasing" | "released";
  reservationId: string;
}
type Pending = { digest: string; workspaceId: string } & (
  | {
      kind: "acquire";
      input: Extract<D.TargetRequest, { ownerKind: "workspace-operation" }>;
      reservation?: Reservation;
      result?: D.WorkspaceOperationLease;
    }
  | {
      kind: "renew";
      input: D.LeaseRenewal;
      reservation: Reservation;
      result?: D.WorkspaceOperationLease;
    }
  | {
      kind: "release";
      input: D.LeaseRelease;
      reservation: Reservation;
      result?: D.WorkspaceLeaseReleaseReceipt;
      proof?: D.ReleaseReceipt;
    }
);

/** Durable business requests retain the first derived private input; there is no renewal scheduler. */
export class WorkspaceLeases {
  readonly store: Store;
  readonly identities: Identities;
  readonly bindings: Bindings;
  readonly dispatch: Dispatch;
  readonly env: Env;
  readonly local: LocalWorkspace;
  constructor(
    store: Store,
    identities: Identities,
    bindings: Bindings,
    dispatch: Dispatch,
    env: Env,
    local: LocalWorkspace,
  ) {
    this.store = store;
    this.identities = identities;
    this.bindings = bindings;
    this.dispatch = dispatch;
    this.env = env;
    this.local = local;
  }
  private resources(reservation: Pick<Reservation, "workspaceId" | "target">): D.ResourceScope {
    return {
      ...emptyScope(),
      workspaceIds: [reservation.workspaceId],
      actions: ["workspace.write"],
      executorIds: reservation.target.kind === "executor" ? [reservation.target.executorId] : [],
    };
  }
  private current(
    ctx: D.AuthContext,
    reservation: Reservation,
    allowHistoricalRelease = false,
  ): void {
    this.identities.current(ctx);
    requireGrant(ctx, "workspace.write", this.resources(reservation));
    check(
      same(ref(ctx), reservation.credential),
      "unauthorized",
      "Workspace lease credential changed",
    );
    if (reservation.target.kind === "executor") {
      const executor = this.store.get<ExecutorState>("executor", reservation.target.executorId);
      check(
        executor &&
          executor.status !== "revoked" &&
          executor.generation === reservation.target.generation,
        "unavailable_executor",
        "Workspace lease executor generation changed",
      );
    }
    if (!allowHistoricalRelease) {
      const binding = this.bindings.current(reservation.workspaceId);
      check(
        binding &&
          binding.bindingVersion === reservation.bindingVersion &&
          (binding.config.kind === "local"
            ? reservation.target.kind === "executor" &&
              binding.config.executorId === reservation.target.executorId
            : reservation.target.kind === "backend" &&
              reservation.target.backendId === binding.workspaceId &&
              reservation.target.generation === binding.bindingVersion),
        "conflict",
        "Workspace lease binding is no longer current",
      );
    }
  }
  private expiry(
    ctx: D.AuthContext,
    reservation: Pick<Reservation, "workspaceId" | "target" | "deadline">,
  ): number {
    const resources = this.resources(reservation);
    requireGrant(ctx, "workspace.write", resources);
    const grant = ctx.grants.find(
      (g) =>
        (g.expiresAt === undefined || g.expiresAt > Date.now()) && contains(g.resources, resources),
    );
    check(grant, "unauthorized", "Workspace lease grant unavailable");
    const expiresAt = Math.min(
      Date.now() + 30000,
      reservation.deadline,
      ctx.credentialExpiresAt ?? Number.MAX_SAFE_INTEGER,
      grant.expiresAt ?? Number.MAX_SAFE_INTEGER,
    );
    check(expiresAt > Date.now(), "conflict", "Workspace lease deadline expired");
    return expiresAt;
  }
  private async fingerprint(
    ctx: D.AuthContext,
    kind: string,
    workspaceId: string,
    requestId: string,
    body: unknown,
  ): Promise<{ key: string; digest: string; old?: Pending }> {
    const key = `${ctx.principalId}:${kind}:${workspaceId}:${requestId}`;
    const digest = await hash(json(body));
    this.identities.current(ctx);
    const old = this.store.get<Pending>("workspace_lease_request", key);
    check(!old || old.digest === digest, "conflict", "Workspace lease request changed");
    return { key, digest, ...(old ? { old } : {}) };
  }
  async acquire(
    ctx: D.AuthContext,
    input: D.OperationRequest<"acquireWorkspaceLease">,
  ): Promise<D.WorkspaceOperationLease> {
    check(
      valid("workspaces", "WorkspaceLeaseAcquire", input.body),
      "invalid_request",
      "Invalid lease acquisition",
    );
    const workspaceId = input.path.workspaceId;
    requireGrant(ctx, "workspace.write", { ...emptyScope(), workspaceIds: [workspaceId] });
    const lookup = await this.fingerprint(ctx, "acquire", workspaceId, input.body.requestId, input);
    let request = lookup.old;
    if (!request) {
      const binding = this.bindings.current(workspaceId);
      check(
        binding && binding.bindingVersion === input.body.bindingVersion,
        "conflict",
        "Workspace binding changed",
      );
      const executor =
        binding.config.kind === "local"
          ? this.store.get<ExecutorState>("executor", binding.config.executorId)
          : undefined;
      if (binding.config.kind === "local")
        check(
          executor && executor.status !== "revoked",
          "unavailable_executor",
          "Workspace executor unavailable",
        );
      const target: D.BackendRef =
        binding.config.kind === "local"
          ? {
              kind: "executor",
              executorId: binding.config.executorId,
              generation:
                executor?.generation ??
                fail("unavailable_executor", "Workspace executor unavailable"),
            }
          : { kind: "backend", backendId: binding.workspaceId, generation: binding.bindingVersion };
      check(
        input.body.deadline > Date.now() && input.body.deadline <= Date.now() + 86400000,
        "invalid_request",
        "Invalid operation deadline",
      );
      const preimage: D.WorkspaceLeaseDigestInput = {
        deploymentId: ctx.deploymentId,
        operationId: input.body.operationId,
        workspaceId,
        bindingVersion: binding.bindingVersion,
        baseRevision: input.body.baseRevision,
        target,
        credential: ref(ctx),
        deadline: input.body.deadline,
      };
      const operationDigest = await workspaceLeaseDigest(preimage);
      request = this.store.tx(() => {
        this.identities.current(ctx);
        const concurrent = this.store.get<Pending>("workspace_lease_request", lookup.key);
        if (concurrent) {
          check(concurrent.digest === lookup.digest, "conflict", "Workspace lease request changed");
          return concurrent;
        }
        check(
          this.bindings.current(workspaceId)?.bindingVersion === binding.bindingVersion,
          "conflict",
          "Workspace binding changed",
        );
        const pending: Pending = {
          kind: "acquire",
          workspaceId,
          digest: lookup.digest,
          input: {
            ownerKind: "workspace-operation",
            operationId: input.body.operationId,
            operationDigest,
            workspaceId,
            bindingVersion: binding.bindingVersion,
            baseRevision: input.body.baseRevision,
            target,
            actions: ["workspace.write"],
            deadline: input.body.deadline,
            expiresAt: this.expiry(ctx, { workspaceId, target, deadline: input.body.deadline }),
          },
        };
        this.store.put("workspace_lease_request", lookup.key, pending);
        return pending;
      });
    }
    check(request.kind === "acquire", "conflict", "Lease request kind changed");
    if (!request.reservation) {
      const reserved = await this.dispatch.reserve(ctx, request.input);
      check(
        reserved.ownerKind === "workspace-operation",
        "conflict",
        "Lease reservation cannot be a job",
      );
      request = { ...request, reservation: reserved };
      const durable = this.store.get<Pending>("workspace_lease_request", lookup.key);
      if (durable?.kind === "acquire" && durable.result) request = durable;
      else this.store.put("workspace_lease_request", lookup.key, request);
    }
    const reservation = request.reservation;
    check(reservation, "internal", "Missing lease reservation");
    this.current(ctx, reservation);
    const existing = this.store.get<LeaseRecord>("lease", request.result?.leaseId ?? "");
    check(
      !existing || existing.state === "active",
      "conflict",
      "Workspace lease is closing or released",
    );
    const authority = this.env.WORKSPACES.getByName(workspaceId);
    check(
      (await authority.contractVersion) === "1.0",
      "unsupported",
      "Workspace contract mismatch",
    );
    const response = await within<D.Outcome<D.Lease>>(
      authority.acquireLease(
        { ...ctx, registrationId: reservation.registrationIds.workspace },
        reservation,
      ),
      Math.max(1, Math.min(30000, ctx.deadline - Date.now())),
    );
    if (!response.ok) fail(response.code, "Workspace lease acquisition rejected", response.details);
    const lease = this.verify(reservation, response.value);
    check(
      !request.result || same(request.result, lease),
      "conflict",
      "Acquisition receipt changed",
    );
    this.current(ctx, reservation);
    this.store.tx(() => {
      this.remember(reservation, lease);
      this.store.put("workspace_lease_request", lookup.key, { ...request, result: lease });
    });
    return lease;
  }
  private verify(reservation: Reservation, lease: D.Lease): D.WorkspaceOperationLease {
    check(valid("workspaces", "Lease", lease), "conflict", "Invalid lease receipt");
    const holder =
      reservation.target.kind === "executor"
        ? reservation.target.executorId
        : reservation.target.backendId;
    check(
      lease.ownerKind === "workspace-operation" &&
        lease.workspaceId === reservation.workspaceId &&
        lease.operationId === reservation.operationId &&
        lease.baseRevision === reservation.baseRevision &&
        same(lease.credential, reservation.credential) &&
        lease.registrationId === reservation.registrationIds.workspace &&
        lease.executorId === holder &&
        lease.executorGeneration === reservation.target.generation &&
        lease.expiresAt <= reservation.deadline,
      "conflict",
      "Workspace lease receipt scope mismatch",
    );
    return lease;
  }
  private remember(reservation: Reservation, lease: D.WorkspaceOperationLease): void {
    const previous = this.store.get<LeaseRecord>("lease", lease.leaseId);
    check(
      !previous || previous.state === "active",
      "conflict",
      "Workspace lease is closing or released",
    );
    if (!previous || previous.lease.leaseVersion <= lease.leaseVersion)
      this.store.put("lease", lease.leaseId, {
        ...previous,
        lease,
        target: reservation.target,
        bindingVersion: reservation.bindingVersion,
        reservationId: reservation.reservationId,
        state: "active",
      } satisfies LeaseRecord);
  }
  private reservation(ctx: D.AuthContext, lease: D.WorkspaceOperationLease): Reservation {
    const reservation = this.store.get<D.TargetReservation>(
      "reservation",
      `${ctx.principalId}:${lease.operationId}`,
    );
    check(
      reservation?.ownerKind === "workspace-operation",
      "unauthorized",
      "Unknown workspace lease reservation",
    );
    this.verify(reservation, lease);
    return reservation;
  }
  async renew(
    ctx: D.AuthContext,
    input: D.OperationRequest<"renewWorkspaceLease">,
  ): Promise<D.WorkspaceOperationLease> {
    check(
      valid("workspaces", "WorkspaceLeaseRenew", input.body),
      "invalid_request",
      "Invalid lease renewal",
    );
    validateWorkspaceLeaseSubject(input.path, input.body.lease);
    const reservation = this.reservation(ctx, input.body.lease);
    this.current(ctx, reservation);
    const lookup = await this.fingerprint(
      ctx,
      "renew",
      input.path.workspaceId,
      input.body.requestId,
      input,
    );
    let request = lookup.old;
    const known = this.store.get<LeaseRecord>("lease", input.body.lease.leaseId);
    check(known && known.state === "active", "conflict", "Workspace lease is not active");
    if (!request) {
      check(same(known.lease, input.body.lease), "conflict", "Lease version changed");
      request = this.store.tx(() => {
        const concurrent = this.store.get<Pending>("workspace_lease_request", lookup.key);
        if (concurrent) {
          check(concurrent.digest === lookup.digest, "conflict", "Workspace lease request changed");
          return concurrent;
        }
        this.current(ctx, reservation);
        const pending: Pending = {
          kind: "renew",
          workspaceId: input.path.workspaceId,
          digest: lookup.digest,
          reservation,
          input: {
            requestId: input.body.requestId,
            lease: input.body.lease,
            expectedLeaseVersion: input.body.lease.leaseVersion,
            expiresAt: this.expiry(ctx, reservation),
          },
        };
        this.store.put("workspace_lease_request", lookup.key, pending);
        return pending;
      });
    }
    check(request.kind === "renew", "conflict", "Lease request kind changed");
    const authority = this.env.WORKSPACES.getByName(input.path.workspaceId);
    check(
      (await authority.contractVersion) === "1.0",
      "unsupported",
      "Workspace contract mismatch",
    );
    const response = await within<D.Outcome<D.Lease>>(
      authority.renewLease(
        { ...ctx, registrationId: reservation.registrationIds.workspace },
        request.input,
      ),
      Math.max(1, Math.min(30000, ctx.deadline - Date.now())),
    );
    if (!response.ok) fail(response.code, "Workspace lease renewal rejected", response.details);
    const lease = this.verify(reservation, response.value);
    check(
      lease.leaseId === input.body.lease.leaseId &&
        lease.fence === input.body.lease.fence &&
        lease.leaseVersion === input.body.lease.leaseVersion + 1 &&
        lease.expiresAt === request.input.expiresAt &&
        (!request.result || same(request.result, lease)),
      "conflict",
      "Renewal receipt changed",
    );
    this.current(ctx, reservation);
    this.store.tx(() => {
      this.remember(reservation, lease);
      this.store.put("workspace_lease_request", lookup.key, { ...request, result: lease });
    });
    if (reservation.target.kind === "executor") await this.local.renew(ctx, lease);
    return lease;
  }
  async release(
    ctx: D.AuthContext,
    input: D.OperationRequest<"releaseWorkspaceLease">,
  ): Promise<D.WorkspaceLeaseReleaseReceipt> {
    check(
      valid("workspaces", "WorkspaceLeaseRelease", input.body),
      "invalid_request",
      "Invalid lease release",
    );
    validateWorkspaceLeaseSubject(input.path, input.body.lease);
    const reservation = this.reservation(ctx, input.body.lease);
    const lookup = await this.fingerprint(
      ctx,
      "release",
      input.path.workspaceId,
      input.body.requestId,
      input,
    );
    this.current(ctx, reservation, lookup.old?.kind === "release" && !!lookup.old.result);
    let request = lookup.old;
    if (!request) {
      const known = this.store.get<LeaseRecord>("lease", input.body.lease.leaseId);
      check(
        known?.state === "active" && same(known.lease, input.body.lease),
        "conflict",
        "Lease version or disposition changed",
      );
      request = {
        kind: "release",
        workspaceId: input.path.workspaceId,
        digest: lookup.digest,
        reservation,
        input: {
          requestId: input.body.requestId,
          lease: input.body.lease,
          reason: input.body.reason,
        },
      };
      this.store.tx(() => {
        this.identities.current(ctx);
        this.store.put("workspace_lease_request", lookup.key, request);
        this.store.put("lease", input.body.lease.leaseId, { ...known, state: "releasing" });
      });
    }
    check(request.kind === "release", "conflict", "Lease request kind changed");
    const authority = this.env.WORKSPACES.getByName(input.path.workspaceId);
    check(
      (await authority.contractVersion) === "1.0",
      "unsupported",
      "Workspace contract mismatch",
    );
    const response = await within<D.Outcome<D.ReleaseReceipt>>(
      authority.releaseLease(
        { ...ctx, registrationId: reservation.registrationIds.workspace },
        request.input,
      ),
      Math.max(1, Math.min(30000, ctx.deadline - Date.now())),
    );
    if (!response.ok) fail(response.code, "Workspace lease release rejected", response.details);
    check(
      response.value.leaseId === input.body.lease.leaseId,
      "conflict",
      "Release receipt scope mismatch",
    );
    check(
      !request.proof || same(request.proof, response.value),
      "conflict",
      "Release proof changed",
    );
    const result = { leaseId: response.value.leaseId, released: response.value.released };
    this.current(ctx, reservation, true);
    this.store.tx(() => {
      this.store.put("lease", input.body.lease.leaseId, {
        lease: input.body.lease,
        target: reservation.target,
        bindingVersion: reservation.bindingVersion,
        reservationId: reservation.reservationId,
        state: "released",
      } satisfies LeaseRecord);
      this.store.put("workspace_lease_request", lookup.key, {
        ...request,
        result,
        proof: response.value,
      });
    });
    return result;
  }
}
