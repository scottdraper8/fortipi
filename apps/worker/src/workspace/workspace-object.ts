import { DurableObject } from "cloudflare:workers";
import type { WorkspaceRuntimeResult } from "@cloudflare/computer";
import {
  commitDigest,
  digestJson,
  errorStatuses,
  incrementSafe,
  localIntentDigest,
  manifestDigest,
  publicCommitReceipt,
  validateUploadBlobs,
  wireLimits,
  workspaceLeaseDigest,
} from "fortipi-contract";
import { ExecutionLedger } from "../backends/ledger.js";
import type * as D from "../boundary/dto.js";
import type { Env } from "../boundary/env.js";
import type { WorkspaceObjectRpc } from "../boundary/workspace-object.js";
import {
  type AllocationRecord,
  type AuthorityRecord,
  authorize,
  authorizeReservedAction,
  nextFence,
  permitsResource,
  type RevisionRecord,
  renew,
  same,
  type UploadRecord,
  validateLease,
} from "./authority.js";
import { ComputerStore } from "./computer.js";
import { outcome, requireThat, unwrap, WorkspaceError } from "./errors.js";
import { WorkspaceExports } from "./export.js";
import { LocalProvider } from "./local.js";
import { LocalReads } from "./local-read.js";
import { LocalUploads } from "./local-upload.js";
import {
  applyMutations,
  checkedManifest,
  snapshotBytes,
  validateRelativePath,
} from "./manifest.js";
import { Mutex } from "./mutex.js";
import { State } from "./state.js";
import {
  boundedBytes,
  bytesStream,
  chunkBytes,
  fixedLengthStream,
  hashInventory,
  hashStream,
  limitedStream,
  sliceStream,
} from "./streams.js";
import { terminalProof } from "./terminal-proof.js";

const lookup = (allocation: D.StoreLookup): D.StoreLookup => ({
  allocationId: allocation.allocationId,
  childId: allocation.childId,
  authorityId: allocation.authorityId,
  workspaceId: allocation.workspaceId,
});
const credential = (ctx: D.AuthContext): D.CredentialRef => ({
  credentialId: ctx.credentialId,
  generation: ctx.generation,
  grantVersion: ctx.grantVersion,
});
export const internalHeader = "x-fortipi-workspace-context";
interface InternalContext {
  auth: D.AuthContext;
  allocation: D.StoreAllocation;
  entry?: D.ManifestEntry;
  index?: number;
  hash?: string;
  length?: number;
  artifact?: { path: string; offset: number; size: number };
  exportId?: string;
}
interface ArtifactRecord {
  reference: D.ByteReference;
  allocation: D.StoreAllocation;
  jobId: string;
  agentId: string;
  conversationId: string;
  path: string;
  offset: number;
  expiresAt: number;
  state: "ready" | "expired";
}
interface DueRecord {
  at: number;
  kind: "upload" | "artifact" | "local-upload" | "export";
  id: string;
}
interface FactRow {
  fact: D.Fact;
  acknowledgments: D.FactAck[];
}

/** One namespace, permanent roles. Public workspace IDs resolve authorities by idFromName(workspaceId). */
export class WorkspaceObject extends DurableObject<Env> implements WorkspaceObjectRpc {
  get contractVersion(): "1.0" {
    return "1.0";
  }
  readonly mutex = new Mutex();
  readonly state: State;
  readonly execution: ExecutionLedger;
  readonly localUploads: LocalUploads;
  readonly localReads: LocalReads;
  private readonly exports: WorkspaceExports;
  private child: ComputerStore | undefined;
  private deleted = false;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.state = new State(ctx.storage);
    this.execution = new ExecutionLedger(this, env);
    this.localUploads = new LocalUploads(this);
    this.localReads = new LocalReads(this);
    this.exports = new WorkspaceExports(this);
  }
  trackLocalRead(completion: Promise<unknown>): void {
    this.ctx.waitUntil(completion);
  }
  get policy(): D.InfrastructurePolicy {
    return this.env.FORTIPI_CONFIG.infrastructure;
  }
  applyBinding(
    ctx: D.ResourceAuthContext,
    input: D.WorkspaceBindingApplication,
  ): Promise<D.Outcome<D.WorkspaceBinding>> {
    return outcome(async () => {
      const workspaceId = input.binding.workspaceId;
      requireThat(
        /^[A-Za-z0-9_-]{1,128}$/.test(workspaceId),
        "invalid_request",
        "Public workspace ID required",
      );
      requireThat(
        this.isSelf(workspaceId) && !this.state.get("child"),
        "unauthorized",
        "Authority binding identity required",
      );
      const action = input.expectedVersion === null ? "workspaces.create" : "workspaces.rebind";
      const authorizeBinding = () => {
        const now = Date.now();
        const old = this.state.get<AuthorityRecord>("authority");
        requireThat(
          ctx.registrationId &&
            ctx.deadline > now &&
            (ctx.credentialExpiresAt === null || ctx.credentialExpiresAt > now) &&
            (!old || old.deploymentId === ctx.deploymentId) &&
            ctx.generation >= (this.state.get<number>(`floor:credential:${ctx.credentialId}`) ?? 0),
          "unauthorized",
          "Binding authority expired or revoked",
        );
        requireThat(
          ctx.grants.some(
            (grant) =>
              (grant.expiresAt === undefined || grant.expiresAt > now) &&
              permitsResource(grant.resources.actions, action) &&
              (input.expectedVersion === null ||
                permitsResource(grant.resources.workspaceIds, workspaceId)),
          ),
          "unauthorized",
          "Explicit binding grant required",
        );
        if (input.executor)
          requireThat(
            input.executor.generation >=
              (this.state.get<number>(`floor:executor:${input.executor.executorId}`) ?? 0),
            "conflict",
            "Binding executor generation revoked",
            { reason: "stale_generation" },
          );
      };
      const requestDigest = await digestJson("operation", {
        kind: "binding-application",
        application: input,
        credential: credential(ctx),
        principalId: ctx.principalId,
        registrationId: ctx.registrationId,
        deploymentId: ctx.deploymentId,
      });
      const key = `binding-request:${ctx.principalId}:${input.requestId}`;
      const prior = await this.mutex.run(() => {
        authorizeBinding();
        const row = this.state.get<{ digest: string; binding: D.WorkspaceBinding }>(key);
        if (row)
          requireThat(row.digest === requestDigest, "conflict", "Binding request identity changed");
        return row;
      });
      if (prior) return prior.binding;
      requireThat(
        Number.isSafeInteger(input.binding.bindingVersion) &&
          input.binding.bindingVersion > 0 &&
          (input.expectedVersion === null || input.import) &&
          (input.binding.config.kind === "local"
            ? input.executor?.executorId === input.binding.config.executorId
            : input.executor === undefined),
        "invalid_request",
        "Binding version, import or executor identity missing",
      );
      let manifest: D.Manifest = input.import
        ? checkedManifest(input.import.manifest, this.policy)
        : { version: 1, entries: [] };
      const hash = await manifestDigest(manifest);
      const revision = input.import?.revision ?? crypto.randomUUID();
      let store: D.SealedStore | undefined;
      if (input.binding.config.kind === "local") {
        const owner = unwrap(
          await this.control().resolveExecutorGeneration(ctx, {
            workspaceId,
            bindingVersion: input.binding.bindingVersion,
            executorId: input.binding.config.executorId,
          }),
        );
        requireThat(
          owner.executorGeneration === input.executor?.generation,
          "conflict",
          "Local owner generation changed",
          { reason: "stale_generation" },
        );
        if (input.import) {
          const observed = unwrap(
            await this.control().requestLocalWorkspace(ctx, {
              kind: "snapshot",
              operationId: input.requestId,
              workspaceId,
              bindingVersion: input.binding.bindingVersion,
              rootBindingId: input.binding.config.rootBindingId,
              executorId: owner.executorId,
              executorGeneration: owner.executorGeneration,
              credential: credential(ctx),
              revision: input.import.revision,
              deadline: ctx.deadline,
            }),
          );
          requireThat(
            "kind" in observed &&
              observed.kind === "snapshot" &&
              observed.result.workspaceId === workspaceId &&
              observed.result.revision === input.import.revision,
            "workspace.conflict",
            "Imported local revision is unavailable",
            { reason: "revision_unavailable" },
          );
          manifest = checkedManifest(observed.result.manifest, this.policy);
          requireThat(
            (await manifestDigest(manifest)) === hash && observed.result.manifestHash === hash,
            "workspace.conflict",
            "Local import drift",
            { reason: "local_drift" },
          );
        }
      } else if (input.import && manifest.entries.length > 0) {
        const retained = this.state.get<RevisionRecord>(`revision:${revision}`);
        requireThat(
          retained?.store && retained.manifestHash === hash,
          "workspace.conflict",
          "A Computer import requires a retained sealed revision with actual bytes",
          { reason: "revision_unavailable" },
        );
        store = retained.store;
      }
      return this.mutex.run(() =>
        this.state.transaction(() => {
          authorizeBinding();
          const repeated = this.state.get<{ digest: string; binding: D.WorkspaceBinding }>(key);
          if (repeated) {
            requireThat(repeated.digest === requestDigest, "conflict", "Binding request changed");
            return repeated.binding;
          }
          const previous = this.state.get<AuthorityRecord>("authority");
          requireThat(
            input.expectedVersion === null
              ? !previous
              : previous?.binding.bindingVersion === input.expectedVersion &&
                  input.binding.bindingVersion > input.expectedVersion &&
                  input.import?.acknowledgeExternalEffects === true,
            "conflict",
            "Binding version CAS failed",
            { reason: "version_mismatch" },
          );
          const binding: D.WorkspaceBinding = {
            ...input.binding,
            revision,
            manifestHash: hash,
            availability:
              input.binding.config.kind === "computer" || input.import ? "available" : "unknown",
          };
          this.state.put("authority", {
            workspaceId,
            deploymentId: ctx.deploymentId,
            fence: previous ? nextFence(previous.fence) : "0",
            binding,
          } satisfies AuthorityRecord);
          this.state.put(`revision:${revision}`, {
            revision,
            manifestHash: hash,
            manifest,
            ...(store ? { store } : {}),
          } satisfies RevisionRecord);
          if (!previous)
            this.state.put("retained", {
              versions: 1,
              unique: Object.fromEntries(
                manifest.entries
                  .filter((entry) => entry.type === "file")
                  .map((entry) => [entry.sha256, entry.size]),
              ),
            });
          else {
            const retained = this.state.get<{ versions: number; unique: Record<string, number> }>(
              "retained",
            );
            requireThat(
              retained && retained.versions < this.policy.bounds.retainedVersions,
              "quota_exceeded",
              "Binding import exceeds retained version capacity",
            );
            retained.versions++;
            for (const entry of manifest.entries)
              if (entry.type === "file") retained.unique[entry.sha256] = entry.size;
            requireThat(
              Object.values(retained.unique).reduce((sum, size) => sum + size, 0) <=
                this.policy.bounds.workspaceBytes,
              "quota_exceeded",
              "Import retained bytes exceed capacity",
            );
            this.state.put("retained", retained);
          }
          this.state.put(key, { digest: requestDigest, binding });
          return binding;
        }),
      );
    }, ctx.requestId);
  }
  get objectId(): string {
    return this.ctx.id.toString();
  }
  control() {
    return this.env.CONTROL_PLANE.getByName("control");
  }
  stub(name: string) {
    return this.env.WORKSPACES.getByName(name);
  }
  isSelf(name: string): boolean {
    return this.env.WORKSPACES.idFromName(name).equals(this.ctx.id);
  }
  async authority(
    ctx: D.AuthContext,
    workspaceId: string,
    action = "workspace.read",
  ): Promise<AuthorityRecord> {
    const record = await this.mutex.run(() => {
      authorize(this.state, ctx, workspaceId, action);
      requireThat(
        !this.state.get("child") && this.env.WORKSPACES.idFromName(workspaceId).equals(this.ctx.id),
        "unauthorized",
        "Only the workspace authority accepts this operation",
      );
      const record = this.state.get<AuthorityRecord>("authority");
      requireThat(
        record,
        "not_found",
        "Workspace binding has not been initialized by ControlPlane",
      );
      requireThat(record.workspaceId === workspaceId, "unauthorized", "Workspace mismatch");
      return record;
    });
    if (action === "workspace.write") await this.maintain(ctx);
    return record;
  }
  current(): AuthorityRecord {
    const record = this.state.get<AuthorityRecord>("authority");
    requireThat(record, "not_found", "Workspace not initialized");
    return record;
  }
  private async checkLocalSnapshot(
    ctx: D.AuthContext,
    authority: AuthorityRecord,
    revision: string,
  ): Promise<void> {
    const retained = this.revision(revision);
    if (authority.binding.config.kind !== "local" || retained.store) return;
    const observed = await new LocalProvider(this.control()).snapshot(
      ctx,
      authority.binding,
      revision,
    );
    requireThat(
      observed.workspaceId === authority.workspaceId &&
        observed.revision === revision &&
        observed.manifestHash === retained.manifestHash &&
        (await manifestDigest(checkedManifest(observed.manifest, this.policy))) ===
          retained.manifestHash,
      "workspace.conflict",
      "Local retained snapshot drift",
      { reason: "local_drift" },
    );
  }
  revision(revision: string): RevisionRecord {
    const record = this.state.get<RevisionRecord>(`revision:${revision}`);
    requireThat(record, "workspace.conflict", "Revision unavailable", {
      reason: "revision_unavailable",
    });
    return record;
  }
  private childStore(): ComputerStore {
    requireThat(!this.state.get("authority"), "unauthorized", "Authority contains no Computer");
    this.child ??= new ComputerStore(this.state, this.mutex, this.policy);
    return this.child;
  }
  async registry(ctx: D.AuthContext, input: D.StoreLookup): Promise<AllocationRecord> {
    const result = unwrap(await this.stub(input.authorityId).describeStore(ctx, input));
    requireThat(
      same(lookup(result.allocation), lookup(input)),
      "unauthorized",
      "Registry allocation mismatch",
    );
    return { state: result, referenced: false, pins: 0 };
  }
  reserveCapacity(
    ctx: D.AuthContext,
    input: {
      operationId: string;
      ownerId: string;
      policyVersion: number;
      bytes: number;
      admissionSlots: number;
    },
  ): Promise<D.Outcome<D.CapacityReservation>> {
    return outcome(async () => {
      await this.authority(ctx, input.ownerId, "workspace.write");
      return this.mutex.run(() =>
        this.state.transaction(() => {
          authorize(this.state, ctx, input.ownerId, "workspace.write");
          requireThat(
            input.policyVersion === this.policy.version &&
              Number.isSafeInteger(input.bytes) &&
              input.bytes >= 0 &&
              input.admissionSlots === 0,
            "invalid_request",
            "Invalid workspace reservation",
          );
          const existing = this.state.get<D.CapacityReservation>(`capacity:${input.operationId}`);
          if (existing) {
            requireThat(
              existing.ownerId === input.ownerId &&
                existing.bytes === input.bytes &&
                existing.policyVersion === input.policyVersion,
              "conflict",
              "Reservation changed",
            );
            return existing;
          }
          const reserved = this.state.get<number>("reserved") ?? 0;
          requireThat(
            reserved + input.bytes + this.state.bytes <=
              this.policy.bounds.workspaceBytes * (1 - this.policy.bounds.headroomFraction),
            "quota_exceeded",
            "Workspace capacity exhausted",
            {
              pressure: {
                resource: "storage",
                scope: { kind: "object" },
                source: "policy",
                measurement: "estimated",
                reason: "Complete snapshots, staging and recovery reserve exceed workspace bound",
                action: "reclaim-storage",
              },
            },
          );
          const reservation: D.CapacityReservation = {
            ...input,
            reservationId: crypto.randomUUID(),
            state: "reserved",
          };
          this.state.put(`capacity:${input.operationId}`, reservation);
          this.state.put(`capacity-id:${reservation.reservationId}`, input.operationId);
          this.state.put("reserved", reserved + input.bytes);
          return reservation;
        }),
      );
    }, ctx.requestId);
  }
  settleCapacity(
    ctx: D.AuthContext,
    input: { reservationId: string; disposition: "consumed" | "unused"; observedBytes?: number },
  ): Promise<D.Outcome<D.CapacityReservation>> {
    return outcome(
      () =>
        this.mutex.run(() =>
          this.state.transaction(() => {
            const owner = this.current();
            authorize(this.state, ctx, owner.workspaceId, "workspace.write");
            const operationId = this.state.get<string>(`capacity-id:${input.reservationId}`);
            const record = this.state.get<D.CapacityReservation>(`capacity:${operationId}`);
            requireThat(record, "not_found", "Unknown capacity reservation");
            // A caller cannot release potentially written bytes. Only confirmed deleteStore cleanup releases them.
            requireThat(
              input.disposition === "consumed" ||
                this.state.get<boolean>(`deallocated:${input.reservationId}`),
              "conflict",
              "Capacity remains reserved until deallocation is confirmed",
            );
            if (record.state === "settled") return record;
            const settled = { ...record, state: "settled" as const };
            this.state.put(`capacity:${operationId}`, settled);
            if (input.disposition === "unused")
              this.state.put(
                "reserved",
                Math.max(0, (this.state.get<number>("reserved") ?? 0) - record.bytes),
              );
            return settled;
          }),
        ),
      ctx.requestId,
    );
  }
  acquireLease(ctx: D.AuthContext, reservation: D.TargetReservation): Promise<D.Outcome<D.Lease>> {
    return outcome(async () => {
      await this.authority(ctx, reservation.workspaceId, "workspace.write");
      if (reservation.ownerKind === "workspace-operation")
        requireThat(
          reservation.operationDigest ===
            (await workspaceLeaseDigest({
              deploymentId: ctx.deploymentId,
              operationId: reservation.operationId,
              workspaceId: reservation.workspaceId,
              bindingVersion: reservation.bindingVersion,
              baseRevision: reservation.baseRevision,
              target: reservation.target,
              credential: reservation.credential,
              deadline: reservation.deadline,
            })),
          "conflict",
          "Canonical workspace lease digest mismatch",
        );
      const digest = await digestJson("operation", { kind: "lease-acquire", reservation });
      const replay = () => {
        authorize(this.state, ctx, reservation.workspaceId, "workspace.write");
        const targetId =
          reservation.target.kind === "executor"
            ? reservation.target.executorId
            : reservation.target.backendId;
        requireThat(
          same(reservation.credential, credential(ctx)) &&
            reservation.registrationIds.workspace === ctx.registrationId &&
            (reservation.target.kind !== "executor" ||
              reservation.target.generation >=
                (this.state.get<number>(`floor:executor:${targetId}`) ?? 0)),
          "unauthorized",
          "Reservation authority expired or revoked",
        );
        const prior = this.state.get<{ digest: string; lease: D.Lease }>(
          `lease-acquire:${reservation.reservationId}`,
        );
        if (prior)
          requireThat(prior.digest === digest, "conflict", "Lease acquisition request changed");
        return prior?.lease;
      };
      const prior = await this.mutex.run(replay);
      if (prior) return prior;
      const {
        reservationId: _id,
        credential: _credential,
        registrationIds: _registrations,
        ...request
      } = reservation;
      const verified = unwrap(await this.control().reserveTarget(ctx, request));
      requireThat(
        same(verified, reservation),
        "unauthorized",
        "Reservation was not issued by ControlPlane",
      );
      return this.mutex.run(() =>
        this.state.transaction(() => {
          const prior = replay();
          if (prior) return prior;
          const record = this.current();
          authorize(this.state, ctx, record.workspaceId, "workspace.write");
          requireThat(
            record.binding.config.kind !== "local" || record.binding.availability === "available",
            "unavailable_executor",
            "Local lease acquisition requires an explicitly imported verified binding",
          );
          if (reservation.ownerKind === "workspace-operation") {
            requireThat(
              reservation.baseRevision === record.binding.revision,
              "workspace.conflict",
              "Workspace lease expected base changed",
              { reason: "expected_revision" },
            );
            requireThat(
              record.binding.config.kind === "computer"
                ? reservation.target.kind === "backend" &&
                    reservation.target.backendId === record.workspaceId &&
                    reservation.target.generation === record.binding.bindingVersion
                : reservation.target.kind === "executor" &&
                    reservation.target.executorId === record.binding.config.executorId,
              "conflict",
              "Workspace lease target differs from the bound storage authority",
            );
          }
          requireThat(
            reservation.expiresAt > Date.now() &&
              reservation.deadline > Date.now() &&
              reservation.bindingVersion === record.binding.bindingVersion &&
              same(reservation.credential, credential(ctx)) &&
              reservation.registrationIds.workspace === ctx.registrationId &&
              reservation.actions.includes("workspace.write"),
            "unauthorized",
            "Reservation scope or authority mismatch",
          );
          const targetId =
            reservation.target.kind === "executor"
              ? reservation.target.executorId
              : reservation.target.backendId;
          requireThat(
            reservation.target.kind !== "executor" ||
              reservation.target.generation >=
                (this.state.get<number>(`floor:executor:${targetId}`) ?? 0),
            "workspace.conflict",
            "Delayed acquisition revoked",
            { reason: "stale_generation" },
          );
          if (record.lease?.expiresAt && record.lease.expiresAt > Date.now()) {
            requireThat(false, "workspace.conflict", "Workspace already leased", {
              reason: "busy",
            });
          }
          const fence = nextFence(record.fence);
          const lease: D.Lease = {
            leaseId: crypto.randomUUID(),
            operationId: reservation.operationId,
            credential: reservation.credential,
            registrationId: reservation.registrationIds.workspace,
            leaseVersion: 1,
            workspaceId: reservation.workspaceId,
            executorId: targetId,
            executorGeneration: reservation.target.generation,
            fence,
            baseRevision: record.binding.revision,
            expiresAt: Math.min(Date.now() + 30_000, reservation.expiresAt, reservation.deadline),
            ...(reservation.ownerKind === "job"
              ? { ownerKind: "job", jobId: reservation.jobId }
              : { ownerKind: "workspace-operation" }),
          };
          this.state.put("authority", { ...record, fence, lease, leaseTarget: reservation.target });
          this.state.put(`reservation:${lease.leaseId}`, reservation);
          this.state.put(`lease-acquire:${reservation.reservationId}`, { digest, lease });
          return lease;
        }),
      );
    }, ctx.requestId);
  }
  renewLease(ctx: D.AuthContext, input: D.LeaseRenewal) {
    return outcome(async () => {
      const digest = await digestJson("operation", { kind: "lease-renew", input });
      return this.mutex.run(() =>
        this.state.transaction(() => {
          this.authorizeLeaseReceipt(ctx, input.lease);
          requireThat(
            this.current().lease?.leaseId === input.lease.leaseId &&
              !this.state.get(`release:${input.lease.leaseId}`),
            "workspace.conflict",
            "Released or superseded lease cannot renew",
            { reason: "stale_fence" },
          );
          const key = `lease-renew:${ctx.credentialId}:${input.requestId}`;
          const prior = this.state.get<{ digest: string; lease: D.Lease }>(key);
          if (prior) {
            requireThat(prior.digest === digest, "conflict", "Lease renewal request changed");
            return prior.lease;
          }
          const reservation = this.state.get<D.TargetReservation>(
            `reservation:${input.lease.leaseId}`,
          );
          requireThat(
            reservation && reservation.deadline >= input.expiresAt,
            "conflict",
            "Renewal exceeds target reservation",
          );
          const lease = renew(this.state, this.current(), ctx, input);
          this.state.put(key, { digest, lease });
          return lease;
        }),
      );
    }, ctx.requestId);
  }
  releaseLease(ctx: D.AuthContext, input: D.LeaseRelease): Promise<D.Outcome<D.ReleaseReceipt>> {
    return outcome(async () => {
      const digest = await digestJson("operation", { kind: "lease-release", input });
      return this.mutex.run(() =>
        this.state.transaction(() => {
          const record = this.current();
          this.authorizeLeaseReceipt(ctx, input.lease);
          const requestKey = `lease-release:${ctx.credentialId}:${input.requestId}`;
          const previousRequest = this.state.get<{ digest: string; receipt: D.ReleaseReceipt }>(
            requestKey,
          );
          if (previousRequest) {
            requireThat(
              previousRequest.digest === digest,
              "conflict",
              "Lease release request ID reused",
            );
            return previousRequest.receipt;
          }
          const prior = this.state.get<{ digest: string; receipt: D.ReleaseReceipt }>(
            `release:${input.lease.leaseId}`,
          );
          if (prior) {
            requireThat(prior.digest === digest, "conflict", "Lease release request changed");
            return prior.receipt;
          }
          requireThat(
            record.lease &&
              same(record.lease.credential, credential(ctx)) &&
              record.lease.leaseId === input.lease.leaseId &&
              record.lease.fence === input.lease.fence,
            "conflict",
            "Lease release mismatch",
          );
          const { lease: _lease, leaseTarget: _target, ...rest } = record;
          this.state.put("authority", rest);
          const receipt = {
            leaseId: input.lease.leaseId,
            released: true,
            tombstoneId: crypto.randomUUID(),
          };
          this.state.put(`release:${receipt.leaseId}`, { digest, receipt });
          this.state.put(requestKey, { digest, receipt });
          return receipt;
        }),
      );
    }, ctx.requestId);
  }
  private authorizeLeaseReceipt(ctx: D.AuthContext, lease: D.Lease): void {
    const record = this.current();
    const reservation = this.state.get<D.TargetReservation>(`reservation:${lease.leaseId}`);
    authorize(this.state, ctx, record.workspaceId, "workspace.write");
    requireThat(
      lease.workspaceId === record.workspaceId &&
        same(lease.credential, credential(ctx)) &&
        lease.registrationId === ctx.registrationId &&
        reservation &&
        reservation.operationId === lease.operationId &&
        reservation.target.generation === lease.executorGeneration &&
        (reservation.target.kind === "executor"
          ? reservation.target.executorId
          : reservation.target.backendId) === lease.executorId &&
        reservation.ownerKind === lease.ownerKind &&
        (reservation.ownerKind !== "job" ||
          (lease.ownerKind === "job" && reservation.jobId === lease.jobId)) &&
        (reservation.target.kind !== "executor" ||
          lease.executorGeneration >=
            (this.state.get<number>(`floor:executor:${lease.executorId}`) ?? 0)),
      "unauthorized",
      "Lease receipt authority revoked or mismatched",
    );
  }
  invalidateGeneration(
    ctx: D.RecoveryContext,
    input: D.Invalidation,
  ): Promise<D.Outcome<D.InvalidationAck>> {
    return outcome(
      () =>
        this.mutex.run(() =>
          this.state.transaction(() => {
            const record = this.current();
            requireThat(
              ctx.kind === "control-recovery" &&
                ctx.deploymentId === record.deploymentId &&
                ctx.deadline > Date.now() &&
                ctx.revocationId === input.revocationId &&
                ctx.recipient.kind === "workspace" &&
                ctx.recipient.id === record.workspaceId &&
                ctx.actions.includes("invalidate"),
              "unauthorized",
              "Invalid recovery authority",
            );
            const id =
              input.subject.kind === "credential"
                ? input.subject.credentialId
                : input.subject.executorId;
            const key = `floor:${input.subject.kind}:${id}`;
            const floor = Math.max(
              this.state.get<number>(key) ?? 0,
              input.subject.minimumGeneration,
            );
            this.state.put(key, floor);
            const ack: D.InvalidationAck = {
              ...input,
              recipient: ctx.recipient,
              persistedFloor: floor,
            };
            this.state.put(`invalidation:${input.revocationId}:${id}`, ack);
            return ack;
          }),
        ),
      ctx.revocationId,
    );
  }
  allocateStore(
    ctx: D.AuthContext,
    input: D.StoreAllocationRequest,
  ): Promise<D.Outcome<D.StoreAllocation>> {
    return outcome(async () => {
      await this.authority(ctx, input.workspaceId, "workspace.write");
      return this.mutex.run(() =>
        this.state.transaction(() => {
          const owner = this.current();
          authorize(this.state, ctx, owner.workspaceId, "workspace.write");
          const intent =
            input.role === "revision-store"
              ? `allocate:upload:${input.uploadId}`
              : `allocate:exec:${input.executionId}`;
          const prior = this.state.get<D.StoreAllocation>(intent);
          if (prior) {
            const { allocationId: _a, childId: _c, ...original } = prior;
            requireThat(same(original, input), "conflict", "Allocation retry changed");
            return prior;
          }
          requireThat(
            owner.binding.config.kind === "computer",
            "unsupported",
            "Local authorities contain metadata only",
          );
          const active = owner.lease;
          requireThat(active, "conflict", "Allocation requires an active reservation and lease");
          validateLease(this.state, owner, active, ctx);
          const target = this.state.get<D.TargetReservation>(`reservation:${active.leaseId}`);
          requireThat(
            target &&
              input.generation === active.executorGeneration &&
              input.operationDigest === target.operationDigest &&
              (input.role !== "scratch" ||
                (active.ownerKind === "job" &&
                  input.jobId === active.jobId &&
                  target.ownerKind === "job" &&
                  target.executionId === input.executionId)),
            "conflict",
            "Allocation operation, job or generation mismatch",
          );
          requireThat(
            input.authorityId === owner.workspaceId &&
              input.baseRevision === owner.binding.revision &&
              input.deadline > Date.now(),
            "conflict",
            "Invalid store allocation",
          );
          const capacityOp = this.state.get<string>(`capacity-id:${input.capacityReservationId}`);
          const capacity = this.state.get<D.CapacityReservation>(`capacity:${capacityOp}`);
          requireThat(
            capacity && capacity.bytes >= input.reservedBytes && input.reservedBytes > 0,
            "quota_exceeded",
            "Missing complete-copy capacity reservation",
          );
          requireThat(
            !this.state.get(`capacity-allocation:${capacity.reservationId}`),
            "conflict",
            "Capacity reservation already belongs to another child",
          );
          const allocation: D.StoreAllocation = {
            ...input,
            allocationId: crypto.randomUUID(),
            childId: `fortipi:child:${crypto.randomUUID()}`,
          };
          const row: AllocationRecord = {
            state: { allocation, source: "registry", version: 1, state: "allocated" },
            referenced: false,
            pins: 0,
          };
          this.state.put(`allocation:${allocation.allocationId}`, row);
          this.state.put(`allocation-lease:${allocation.allocationId}`, active.leaseId);
          this.state.put(`capacity-allocation:${capacity.reservationId}`, allocation.allocationId);
          this.state.put(`allocation-child:${allocation.childId}`, allocation.allocationId);
          this.state.put(intent, allocation);
          return allocation;
        }),
      );
    }, ctx.requestId);
  }
  describeStore(ctx: D.AuthContext, input: D.StoreLookup): Promise<D.Outcome<D.StoreState>> {
    return outcome(async () => {
      if (this.isSelf(input.authorityId))
        return this.mutex.run(() => {
          const read = ctx.grants.some(
            (grant) =>
              (grant.expiresAt === undefined || grant.expiresAt > Date.now()) &&
              permitsResource(grant.resources.workspaceIds, input.workspaceId) &&
              permitsResource(grant.resources.actions, "workspace.read"),
          );
          authorize(
            this.state,
            ctx,
            input.workspaceId,
            read ? "workspace.read" : "workspace.write",
          );
          const row = this.state.get<AllocationRecord>(`allocation:${input.allocationId}`);
          requireThat(
            row && same(lookup(row.state.allocation), lookup(input)),
            "not_found",
            "Unknown allocation",
          );
          if (!read) {
            const allocation = row.state.allocation;
            const leaseId = this.state.get<string>(`allocation-lease:${allocation.allocationId}`);
            const allocationLease = leaseId
              ? this.state.get<D.TargetReservation>(`reservation:${leaseId}`)
              : undefined;
            const acquired = allocationLease
              ? this.state.get<{ lease: D.Lease }>(`lease-acquire:${allocationLease.reservationId}`)
              : undefined;
            const upload =
              allocation.role === "revision-store"
                ? this.state.get<UploadRecord>(`upload:${allocation.uploadId}`)
                : undefined;
            const scratch =
              allocation.role === "scratch"
                ? this.state.get<{ prepared: D.PreparedExecution }>(
                    `execution:${allocation.executionId}`,
                  )
                : undefined;
            const lease = row.referenced
              ? this.current().lease
              : (acquired?.lease ??
                upload?.request.lease ??
                scratch?.prepared.request.identity.lease);
            requireThat(lease, "unauthorized", "Registered store operation required");
            const reservation = authorizeReservedAction(this.state, ctx, lease, "workspace.write");
            if (row.referenced) validateLease(this.state, this.current(), lease, ctx);
            else
              requireThat(
                allocation.baseRevision === lease.baseRevision &&
                  allocation.operationDigest === reservation.operationDigest &&
                  allocation.generation === lease.executorGeneration &&
                  (allocation.role !== "scratch" ||
                    (reservation.ownerKind === "job" &&
                      allocation.jobId === reservation.jobId &&
                      allocation.executionId === reservation.executionId)),
                "unauthorized",
                "Store operation scope mismatch",
              );
          }
          return row.state;
        });
      const registered = await this.registry(ctx, input);
      return this.mutex.run(() => {
        requireThat(this.isSelf(input.childId), "unauthorized", "Wrong child");
        if (registered.state.state === "retiring" || registered.state.state === "deleted")
          return { ...registered.state, measuredBytes: this.state.bytes };
        const state = this.state.get<D.StoreState>("child");
        return state ? { ...state, measuredBytes: this.state.bytes } : registered.state;
      });
    }, ctx.requestId);
  }
  initializeStore(ctx: D.AuthContext, input: D.StoreAllocation): Promise<D.Outcome<D.StoreState>> {
    return outcome(async () => {
      requireThat(
        this.isSelf(input.childId) && !this.isSelf(input.authorityId),
        "unauthorized",
        "Wrong permanent child identity",
      );
      const row = await this.registry(ctx, lookup(input));
      requireThat(
        same(row.state.allocation, input) &&
          (row.state.state === "allocated" || row.state.state === "writable"),
        "conflict",
        "Allocation retired or sealed",
        { reason: "retired_allocation" },
      );
      return this.childStore().initialize(input);
    }, ctx.requestId);
  }
  sealStore(ctx: D.AuthContext, input: D.StoreSeal): Promise<D.Outcome<D.SealedStore>> {
    return outcome(async () => {
      const registered = await this.registry(ctx, input);
      requireThat(
        registered.state.state !== "retiring" &&
          registered.state.state !== "deleted" &&
          this.isSelf(input.childId),
        "conflict",
        "Store retired",
      );
      const manifest = this.state.get<D.Manifest>("staged-manifest");
      requireThat(manifest, "conflict", "Snapshot not complete");
      return this.childStore().seal(input, manifest);
    }, ctx.requestId);
  }
  retireStore(ctx: D.AuthContext, input: D.StoreLookup): Promise<D.Outcome<D.StoreRetirement>> {
    return outcome(
      () =>
        this.mutex.run(() =>
          this.state.transaction(() => {
            authorize(this.state, ctx, input.workspaceId, "workspace.write");
            requireThat(this.isSelf(input.authorityId), "unauthorized", "Authority required");
            const row = this.state.get<AllocationRecord>(`allocation:${input.allocationId}`);
            requireThat(
              row && same(lookup(row.state.allocation), lookup(input)),
              "not_found",
              "Allocation unknown",
            );
            requireThat(
              !row.referenced &&
                row.pins === 0 &&
                !this.execution.pins(row.state.allocation) &&
                row.state.allocation.deadline + 60_000 <= Date.now(),
              "conflict",
              "Allocation is referenced, pinned or within cleanup grace",
            );
            if (row.state.state !== "retiring" && row.state.state !== "deleted") {
              row.state = {
                ...row.state,
                state: "retiring",
                tombstoneId: crypto.randomUUID(),
                version: incrementSafe(row.state.version),
              };
              this.state.put(`allocation:${input.allocationId}`, row);
            }
            requireThat(row.state.tombstoneId, "conflict", "Missing retirement tombstone");
            return {
              ...input,
              tombstoneId: row.state.tombstoneId,
              registryVersion: row.state.version,
            };
          }),
        ),
      ctx.requestId,
    );
  }
  deleteStore(ctx: D.AuthContext, input: D.StoreRetirement): Promise<D.Outcome<D.CleanupReceipt>> {
    return outcome(async () => {
      if (this.isSelf(input.authorityId)) {
        const row = await this.mutex.run(() => {
          authorize(this.state, ctx, input.workspaceId, "workspace.write");
          const record = this.state.get<AllocationRecord>(`allocation:${input.allocationId}`);
          requireThat(
            record &&
              !record.referenced &&
              record.pins === 0 &&
              (record.state.state === "retiring" || record.state.state === "deleted") &&
              record.state.tombstoneId === input.tombstoneId &&
              record.state.version === input.registryVersion,
            "conflict",
            "Retirement identity mismatch",
          );
          return record;
        });
        const receipt = unwrap(await this.stub(input.childId).deleteStore(ctx, input));
        requireThat(
          receipt.deallocated && receipt.tombstoneId === input.tombstoneId,
          "conflict",
          "Deallocation not confirmed",
        );
        await this.mutex.run(() =>
          this.state.transaction(() => {
            const current = this.state.get<AllocationRecord>(`allocation:${input.allocationId}`);
            requireThat(
              current?.state.tombstoneId === input.tombstoneId && !current.referenced,
              "conflict",
              "Retirement changed",
            );
            this.state.put(`allocation:${input.allocationId}`, {
              ...current,
              state: { ...current.state, state: "deleted" },
            });
            this.state.put(`deallocated:${row.state.allocation.capacityReservationId}`, true);
          }),
        );
        unwrap(
          await this.settleCapacity(ctx, {
            reservationId: row.state.allocation.capacityReservationId,
            disposition: "unused",
          }),
        );
        const installCapacity = this.state.get<string>(
          `install-capacity:${row.state.allocation.capacityReservationId}`,
        );
        if (installCapacity)
          unwrap(
            await this.control().settleCapacity(ctx, {
              reservationId: installCapacity,
              disposition: "unused",
            }),
          );
        return receipt;
      }
      const row = await this.registry(ctx, input);
      requireThat(
        this.isSelf(input.childId) &&
          (row.state.state === "retiring" || row.state.state === "deleted") &&
          row.state.tombstoneId === input.tombstoneId &&
          row.state.version === input.registryVersion,
        "unauthorized",
        "Confirmed authority tombstone required",
      );
      if (!this.deleted) {
        await this.execution.stopChild();
        await this.childStore().dispose();
        this.child = undefined;
        this.deleted = true;
      }
      return {
        allocationId: input.allocationId,
        childId: input.childId,
        authorityId: input.authorityId,
        workspaceId: input.workspaceId,
        tombstoneId: input.tombstoneId,
        deallocated: true,
        observedAt: Date.now(),
      };
    }, ctx.requestId);
  }
  describe(
    ctx: D.AuthContext,
    input: D.OperationRequest<"describeWorkspace">,
  ): Promise<D.Outcome<D.OperationResponse<"describeWorkspace">>> {
    return outcome(
      async () => ({
        status: 200,
        body: (await this.authority(ctx, input.path.workspaceId)).binding,
      }),
      ctx.requestId,
    );
  }
  manifest(
    ctx: D.AuthContext,
    input: D.OperationRequest<"getWorkspaceManifest">,
  ): Promise<D.Outcome<D.OperationResponse<"getWorkspaceManifest">>> {
    return outcome(async () => {
      const authority = await this.authority(ctx, input.path.workspaceId);
      await this.checkLocalSnapshot(ctx, authority, input.query.revision);
      return this.mutex.run(() => {
        authorize(this.state, ctx, input.path.workspaceId, "workspace.read");
        const revision = this.revision(input.query.revision);
        return {
          status: 200 as const,
          body: {
            workspaceId: input.path.workspaceId,
            revision: revision.revision,
            manifestHash: revision.manifestHash,
            manifest: revision.manifest,
          },
        };
      });
    }, ctx.requestId);
  }
  list(
    ctx: D.AuthContext,
    input: D.OperationRequest<"listWorkspaceFiles">,
  ): Promise<D.Outcome<D.OperationResponse<"listWorkspaceFiles">>> {
    return outcome(async () => {
      const authority = await this.authority(ctx, input.path.workspaceId);
      await this.checkLocalSnapshot(ctx, authority, input.query.revision);
      if (input.query.path) validateRelativePath(input.query.path);
      return this.mutex.run(() => {
        authorize(this.state, ctx, input.path.workspaceId, "workspace.read");
        const all = this.revision(input.query.revision)
          .manifest.entries.filter(
            (entry) => !input.query.path || entry.path.startsWith(`${input.query.path}/`),
          )
          .sort((a, b) => (a.path < b.path ? -1 : 1));
        const page = this.page(
          ctx,
          all,
          input.query.pageToken,
          input.query.limit,
          `${input.query.revision}:${input.query.path ?? ""}`,
        );
        return { status: 200 as const, body: { revision: input.query.revision, ...page } };
      });
    }, ctx.requestId);
  }
  private page<T>(
    ctx: D.AuthContext,
    all: T[],
    token: string | undefined,
    limit = 100,
    scope = "",
  ): { items: T[]; nextPageToken?: string } {
    requireThat(
      Number.isInteger(limit) &&
        limit > 0 &&
        limit <= Math.min(100, this.policy.bounds.sqlPageRows),
      "invalid_request",
      "Invalid page limit",
    );
    const binding = `${ctx.principalId}:${scope}:`;
    let offset = 0;
    if (token) {
      const decoded = atob(token);
      requireThat(
        decoded.startsWith(binding) && /^\d+$/.test(decoded.slice(binding.length)),
        "invalid_request",
        "Invalid page token",
      );
      offset = Number(decoded.slice(binding.length));
    }
    return {
      items: all.slice(offset, offset + limit),
      ...(offset + limit < all.length
        ? { nextPageToken: btoa(`${binding}${offset + limit}`) }
        : {}),
    };
  }
  stat(
    ctx: D.AuthContext,
    input: D.OperationRequest<"statWorkspaceFile">,
  ): Promise<D.Outcome<D.OperationResponse<"statWorkspaceFile">>> {
    return outcome(async () => {
      const authority = await this.authority(ctx, input.path.workspaceId);
      await this.checkLocalSnapshot(ctx, authority, input.query.revision);
      validateRelativePath(input.query.path);
      return this.mutex.run(() => {
        authorize(this.state, ctx, input.path.workspaceId, "workspace.read");
        const entry = this.revision(input.query.revision).manifest.entries.find(
          (item) => item.path === input.query.path,
        );
        requireThat(entry, "not_found", "File absent from revision");
        return { status: 200 as const, body: { revision: input.query.revision, entry } };
      });
    }, ctx.requestId);
  }
  read(
    ctx: D.AuthContext,
    input: D.OperationRequest<"readWorkspaceFile">,
  ): Promise<D.Outcome<D.ByteReference>> {
    return outcome(async () => {
      const authority = await this.authority(ctx, input.path.workspaceId);
      validateRelativePath(input.query.path);
      const entry = await this.mutex.run(() => {
        authorize(this.state, ctx, input.path.workspaceId, "workspace.read");
        return this.revision(input.query.revision).manifest.entries.find(
          (item) => item.path === input.query.path,
        );
      });
      requireThat(entry?.type === "file", "not_found", "File absent from revision");
      const range = input.query.range
        ? checkedRange(input.query.range.start, input.query.range.end ?? entry.size - 1, entry.size)
        : undefined;
      const length = range ? range.end - range.start + 1 : entry.size;
      const endpoint = `/v1/workspaces/${input.path.workspaceId}/read?revision=${encodeURIComponent(input.query.revision)}&path=${encodeURIComponent(entry.path)}${range ? `&range[start]=${range.start}&range[end]=${range.end}` : ""}`;
      if (authority.binding.config.kind === "local" && !this.revision(input.query.revision).store) {
        const reference = await new LocalProvider(this.control()).read(
          ctx,
          authority.binding,
          input.query.revision,
          entry.path,
        );
        requireThat(
          reference.workspaceId === authority.workspaceId &&
            reference.revision === input.query.revision &&
            reference.sha256 === entry.sha256 &&
            reference.size === entry.size,
          "workspace.conflict",
          "Local byte reference drift",
          { reason: "local_drift" },
        );
        if (!range)
          return this.mutex.run(() => {
            authorize(this.state, ctx, input.path.workspaceId, "workspace.read");
            return { ...reference, endpoint };
          });
        requireThat(reference.chunks, "interrupted", "Local range requires owner chunk inventory");
        const observed = await hashInventory(
          sliceStream(
            await this.localReads.open(
              ctx,
              authority.binding,
              input.query.revision,
              entry,
              this.revision(input.query.revision).manifestHash,
              new AbortController().signal,
            ),
            range.start,
            length,
          ),
          length,
          reference.chunks.chunkBytes,
          ctx.deadline,
        );
        return this.mutex.run(() => {
          authorize(this.state, ctx, input.path.workspaceId, "workspace.read");
          return {
            ...reference,
            endpoint,
            size: length,
            sha256: observed.sha256,
            chunks: observed.chunks,
          };
        });
      }
      const hash = range
        ? await hashStream(
            sliceStream(
              await this.readStored(ctx, this.revision(input.query.revision), entry),
              range.start,
              length,
            ),
            length,
            ctx.deadline,
          )
        : entry.sha256;
      return this.mutex.run(() => {
        authorize(this.state, ctx, input.path.workspaceId, "workspace.read");
        return {
          workspaceId: input.path.workspaceId,
          revision: input.query.revision,
          size: length,
          sha256: hash,
          endpoint,
          owner: { kind: "cloud" as const },
        };
      });
    }, ctx.requestId);
  }
  snapshot(
    ctx: D.AuthContext,
    input: D.OperationRequest<"snapshotWorkspace">,
  ): Promise<D.Outcome<D.OperationResponse<"snapshotWorkspace">>> {
    return outcome(async () => {
      const authority = await this.authority(ctx, input.path.workspaceId);
      await this.checkLocalSnapshot(ctx, authority, input.body.baseRevision);
      return this.mutex.run(() => {
        validateLease(this.state, this.current(), input.body.lease, ctx);
        const record = this.revision(input.body.baseRevision);
        requireThat(
          record.manifestHash === input.body.manifestHash,
          "conflict",
          "Snapshot identity mismatch",
        );
        return {
          status: 201 as const,
          body: {
            snapshotId: input.body.requestId,
            workspaceId: input.path.workspaceId,
            revision: record.revision,
            manifestHash: record.manifestHash,
          },
        };
      });
    }, ctx.requestId);
  }
  diff(
    ctx: D.AuthContext,
    input: D.OperationRequest<"diffWorkspace">,
  ): Promise<D.Outcome<D.OperationResponse<"diffWorkspace">>> {
    return outcome(async () => {
      const authority = await this.authority(ctx, input.path.workspaceId);
      await this.checkLocalSnapshot(ctx, authority, input.query.revision);
      await this.checkLocalSnapshot(ctx, authority, input.query.otherRevision);
      return this.mutex.run(() => {
        authorize(this.state, ctx, input.path.workspaceId, "workspace.read");
        const before = new Map(
          this.revision(input.query.revision).manifest.entries.map((entry) => [entry.path, entry]),
        );
        const after = new Map(
          this.revision(input.query.otherRevision).manifest.entries.map((entry) => [
            entry.path,
            entry,
          ]),
        );
        const changes: D.WorkspaceDiff["items"] = [];
        for (const path of [...new Set([...before.keys(), ...after.keys()])].sort())
          if (!same(before.get(path) ?? null, after.get(path) ?? null))
            changes.push({
              path,
              change: !before.has(path) ? "added" : !after.has(path) ? "deleted" : "modified",
            });
        return {
          status: 200 as const,
          body: {
            revision: input.query.revision,
            otherRevision: input.query.otherRevision,
            ...this.page(
              ctx,
              changes,
              input.query.pageToken,
              input.query.limit,
              `${input.query.revision}:${input.query.otherRevision}`,
            ),
          },
        };
      });
    }, ctx.requestId);
  }
  beginUpload(
    ctx: D.AuthContext,
    input: D.OperationRequest<"beginUpload">,
  ): Promise<D.Outcome<D.OperationResponse<"beginUpload">>> {
    return outcome(async () => {
      requireThat(
        new TextEncoder().encode(JSON.stringify(input.body)).length <= wireLimits.jsonBytes,
        "payload_too_large",
        "Upload metadata exceeds control-body bound",
      );
      const authority = await this.authority(ctx, input.path.workspaceId, "workspace.write");
      try {
        validateUploadBlobs(input.body, { required: authority.binding.config.kind === "local" });
      } catch {
        requireThat(
          false,
          "invalid_request",
          "Upload chunk plans must exactly cover all puts and fit the control-body bounds",
        );
      }
      if (authority.binding.config.kind === "local") {
        const response = await this.localUploads.begin(ctx, input);
        if (response.status === 201) {
          await this.mutex.run(() =>
            this.state.put(
              dueKey(response.body.expiresAt + 60_000, "local-upload", response.body.uploadId),
              {
                kind: "local-upload",
                at: response.body.expiresAt + 60_000,
                id: response.body.uploadId,
              } satisfies DueRecord,
            ),
          );
          await this.armDue(response.body.expiresAt + 60_000);
        }
        return response;
      }
      const manifest = checkedManifest(input.body.manifest, this.policy);
      const hash = await manifestDigest(manifest);
      requireThat(
        hash === input.body.manifestHash && input.body.operationId === input.body.lease.operationId,
        "conflict",
        "Upload identity mismatch",
      );
      const prior = await this.mutex.run(() => {
        authorize(this.state, ctx, input.path.workspaceId, "workspace.write");
        const row = this.state.get<UploadRecord>(`upload:${input.body.requestId}`);
        if (row)
          requireThat(
            same(row.request, input.body) && same(row.owner, credential(ctx)),
            "conflict",
            "Upload request reused",
          );
        return row;
      });
      if (prior) {
        if (prior.status.state === "open" && prior.status.expiresAt > Date.now())
          unwrap(await this.stub(prior.allocation.childId).initializeStore(ctx, prior.allocation));
        return { status: 201 as const, body: prior.status };
      }
      const bytes = uploadStorageBytes(input.body);
      requireThat(
        uploadEntries(input.body).reduce(
          (total, entry) => total + Math.ceil(entry.size / uploadGrid(input.body, entry.sha256)),
          0,
        ) <= 1024,
        "payload_too_large",
        "Upload exceeds the bounded chunk-receipt capacity; choose a compatible grid or smaller upload",
      );
      for (const entry of uploadEntries(input.body))
        checkedManifest({ version: 1, entries: [entry] }, this.policy);
      await this.mutex.run(() => {
        validateLease(this.state, this.current(), input.body.lease, ctx);
        const base = this.revision(input.body.baseRevision).manifest;
        requireThat(
          same(
            awaitlessSorted(applyMutations(base, input.body.mutations)),
            awaitlessSorted(manifest),
          ),
          "conflict",
          "Proposed snapshot must equal explicit mutations applied to base",
        );
        requireThat(
          (this.state.get<number>("active-upload-bytes") ?? 0) + bytes <=
            this.policy.bounds.stagingBytesPerWorkspace &&
            (this.state.get<number>("active-uploads") ?? 0) < wireLimits.activeUploads,
          "quota_exceeded",
          "Active upload bound reached",
        );
      });
      const reservedBytes = Math.max(1024 * 1024, bytes * 3 + 1024 * 1024);
      const operationId = `upload-${input.body.requestId}`;
      const capacity = unwrap(
        await this.reserveCapacity(ctx, {
          operationId,
          ownerId: input.path.workspaceId,
          policyVersion: this.policy.version,
          bytes: reservedBytes,
          admissionSlots: 0,
        }),
      );
      const installCapacity = unwrap(
        await this.control().reserveCapacity(ctx, {
          operationId,
          ownerId: input.path.workspaceId,
          policyVersion: this.policy.version,
          bytes: reservedBytes,
          admissionSlots: 0,
        }),
      );
      await this.mutex.run(() =>
        this.state.put(`install-capacity:${capacity.reservationId}`, installCapacity.reservationId),
      );
      const targetReservation = this.state.get<D.TargetReservation>(
        `reservation:${input.body.lease.leaseId}`,
      );
      requireThat(targetReservation, "conflict", "Upload target reservation missing");
      const allocation = unwrap(
        await this.allocateStore(ctx, {
          authorityId: input.path.workspaceId,
          workspaceId: input.path.workspaceId,
          role: "revision-store",
          uploadId: input.body.requestId,
          baseRevision: input.body.baseRevision,
          generation: input.body.lease.executorGeneration,
          operationDigest: targetReservation.operationDigest,
          capacityReservationId: capacity.reservationId,
          reservedBytes,
          deadline: Date.now() + wireLimits.uploadTtlMs,
        }),
      );
      const upload = await this.mutex.run(() =>
        this.state.transaction(() => {
          validateLease(this.state, this.current(), input.body.lease, ctx);
          const raced = this.state.get<UploadRecord>(`upload:${input.body.requestId}`);
          if (raced) {
            requireThat(same(raced.request, input.body), "conflict", "Upload request changed");
            return raced;
          }
          requireThat(
            (this.state.get<number>("active-upload-bytes") ?? 0) + bytes <=
              this.policy.bounds.stagingBytesPerWorkspace &&
              (this.state.get<number>("active-uploads") ?? 0) < wireLimits.activeUploads,
            "quota_exceeded",
            "Competing uploads exhausted capacity",
          );
          const row: UploadRecord = {
            request: input.body,
            owner: credential(ctx),
            allocation,
            capacity,
            status: {
              uploadId:
                allocation.role === "revision-store" ? allocation.uploadId : input.body.requestId,
              state: "open",
              baseRevision: input.body.baseRevision,
              manifestHash: hash,
              receivedChunks: [],
              expiresAt: allocation.deadline,
            },
          };
          this.state.put(`upload:${row.status.uploadId}`, row);
          this.state.put(dueKey(row.status.expiresAt + 60_000, "upload", row.status.uploadId), {
            at: row.status.expiresAt + 60_000,
            kind: "upload",
            id: row.status.uploadId,
          } satisfies DueRecord);
          this.state.put("active-uploads", (this.state.get<number>("active-uploads") ?? 0) + 1);
          this.state.put(
            "active-upload-bytes",
            (this.state.get<number>("active-upload-bytes") ?? 0) + bytes,
          );
          return row;
        }),
      );
      unwrap(await this.stub(allocation.childId).initializeStore(ctx, allocation));
      await this.armDue(upload.status.expiresAt + 60_000);
      return { status: 201 as const, body: upload.status };
    }, ctx.requestId);
  }
  private upload(
    ctx: D.AuthContext,
    workspaceId: string,
    uploadId: string,
    writable = true,
  ): UploadRecord {
    authorize(this.state, ctx, workspaceId, "workspace.write");
    const row = this.state.get<UploadRecord>(`upload:${uploadId}`);
    requireThat(row && same(row.owner, credential(ctx)), "not_found", "Upload not available");
    if (writable) {
      validateLease(this.state, this.current(), row.request.lease, ctx);
      requireThat(
        row.status.expiresAt > Date.now() &&
          (row.status.state === "open" || row.status.state === "validated"),
        "conflict",
        "Upload closed or expired",
      );
    }
    return row;
  }
  getUpload(
    ctx: D.AuthContext,
    input: D.OperationRequest<"getUpload">,
  ): Promise<D.Outcome<D.OperationResponse<"getUpload">>> {
    return outcome(async () => {
      if (this.localUploads.has(input.path.uploadId))
        return {
          status: 200 as const,
          body: this.localUploads.get(ctx, input.path.workspaceId, input.path.uploadId, false)
            .status,
        };

      await this.authority(ctx, input.path.workspaceId, "workspace.write");
      return this.mutex.run(() => ({
        status: 200 as const,
        body: this.upload(ctx, input.path.workspaceId, input.path.uploadId, false).status,
      }));
    }, ctx.requestId);
  }
  putChunk(
    ctx: D.AuthContext,
    input: D.OperationRequest<"putUploadChunk">,
  ): Promise<D.Outcome<D.OperationResponse<"putUploadChunk">>> {
    return outcome(async () => {
      if (this.localUploads.has(input.path.uploadId)) return this.localUploads.put(ctx, input);

      const row = await this.mutex.run(() =>
        this.upload(ctx, input.path.workspaceId, input.path.uploadId),
      );
      const entry = uploadEntries(row.request).find((item) => item.sha256 === input.path.sha256);
      requireThat(
        entry?.type === "file" &&
          row.request.mutations.some(
            (mutation) => mutation.kind === "put" && mutation.sha256 === entry.sha256,
          ),
        "unauthorized",
        "Chunk is not part of upload mutations",
      );
      requireThat(
        Number.isInteger(input.path.chunkIndex) &&
          input.path.chunkIndex >= 0 &&
          input.path.chunkIndex < Math.ceil(entry.size / uploadGrid(row.request, entry.sha256)) &&
          input.query.length ===
            Math.min(
              uploadGrid(row.request, entry.sha256),
              Math.max(
                0,
                entry.size - input.path.chunkIndex * uploadGrid(row.request, entry.sha256),
              ),
            ) &&
          (!row.request.blobs ||
            row.request.blobs.find((blob) => blob.sha256 === entry.sha256)?.chunks.chunkHashes[
              input.path.chunkIndex
            ] === input.query.sha256),
        "invalid_request",
        "Chunk bounds mismatch",
      );
      const bytes = await boundedBytes(
        bytesStream(input.body),
        input.query.length,
        input.query.sha256,
        ctx.deadline,
      );
      const index = this.chunkIndex(row.request, entry.sha256, input.path.chunkIndex);
      const response = await this.childFetch(ctx, row.allocation, `/chunk/${index}`, {
        method: "PUT",
        body: bytes,
        hash: input.query.sha256,
        length: bytes.length,
      });
      requireThat(response.ok, "interrupted", "Chunk write interrupted");
      await this.mutex.run(() => {
        const current = this.upload(ctx, input.path.workspaceId, input.path.uploadId);
        requireThat(current.status.state === "open", "conflict", "Upload already validated");
        if (!current.status.receivedChunks.includes(index))
          current.status.receivedChunks.push(index);
        this.state.put(`upload:${input.path.uploadId}`, current);
      });
      return { status: 204 as const, body: undefined };
    }, ctx.requestId);
  }
  private chunkIndex(request: D.UploadBegin, hash: string, offset: number): number {
    let index = 0;
    const seen = new Set<string>();
    for (const entry of uploadEntries(request))
      if (entry.type === "file" && !seen.has(entry.sha256)) {
        if (entry.sha256 === hash) return index + offset;
        seen.add(entry.sha256);
        index += Math.ceil(entry.size / uploadGrid(request, entry.sha256));
      }
    throw new Error("Manifest file absent");
  }
  async childFetch(
    ctx: D.AuthContext,
    allocation: D.StoreAllocation,
    path: string,
    init: {
      method?: string;
      body?: BodyInit | ReadableStream<Uint8Array>;
      entry?: D.ManifestEntry;
      hash?: string;
      length?: number;
      artifact?: { path: string; offset: number; size: number };
      exportId?: string;
    } = {},
  ): Promise<Response> {
    const auth: InternalContext = {
      auth: ctx,
      allocation,
      ...(init.entry ? { entry: init.entry } : {}),
      ...(init.hash ? { hash: init.hash } : {}),
      ...(init.length === undefined ? {} : { length: init.length }),
      ...(init.artifact ? { artifact: init.artifact } : {}),
      ...(init.exportId ? { exportId: init.exportId } : {}),
    };
    return this.stub(allocation.childId).fetch(
      new Request(`https://workspace.internal/__fortipi/store${path}`, {
        method: init.method ?? "GET",
        headers: { [internalHeader]: JSON.stringify(auth) },
        ...(init.body === undefined ? {} : { body: init.body }),
      }),
    );
  }
  validateUpload(
    ctx: D.AuthContext,
    input: D.OperationRequest<"validateUpload">,
  ): Promise<D.Outcome<D.OperationResponse<"validateUpload">>> {
    return outcome(async () => {
      if (this.localUploads.has(input.path.uploadId)) return this.localUploads.validate(ctx, input);

      const row = await this.mutex.run(() =>
        this.upload(ctx, input.path.workspaceId, input.path.uploadId),
      );
      if (row.stage)
        return {
          status: 200 as const,
          body: {
            uploadId: row.status.uploadId,
            manifestHash: row.stage.manifestHash,
            stageId: row.stage.stageId,
            validated: true as const,
          },
        };
      // Pin complete base until copy and sealing finish. No authority FIFO is held during child calls.
      const base = await this.mutex.run(() => this.revision(row.request.baseRevision));
      for (const entry of uploadEntries(row.request)) {
        const assembled = await this.childFetch(ctx, row.allocation, "/assemble", {
          method: "POST",
          body: JSON.stringify({
            entry,
            chunks: Array.from(
              { length: Math.ceil(entry.size / uploadGrid(row.request, entry.sha256)) },
              (_, offset) => this.chunkIndex(row.request, entry.sha256, offset),
            ),
          }),
        });
        requireThat(
          assembled.ok,
          "interrupted",
          "A declared upload file failed full-file verification",
        );
      }
      for (const entry of row.request.manifest.entries)
        if (entry.type === "file") {
          const changed = row.request.mutations.some(
            (mutation) => mutation.kind === "put" && mutation.sha256 === entry.sha256,
          );
          if (changed) {
            const response = await this.childFetch(ctx, row.allocation, "/assemble", {
              method: "POST",
              body: JSON.stringify({
                entry,
                chunks: Array.from(
                  { length: Math.ceil(entry.size / uploadGrid(row.request, entry.sha256)) },
                  (_, offset) => this.chunkIndex(row.request, entry.sha256, offset),
                ),
              }),
            });
            requireThat(response.ok, "interrupted", "File assembly failed");
          } else {
            requireThat(
              base.store && base.manifest.entries.some((item) => same(item, entry)),
              "conflict",
              "Unchanged file missing from base",
            );
            const source = await this.readStored(ctx, base, entry);
            const response = await this.childFetch(ctx, row.allocation, "/blob", {
              method: "PUT",
              entry,
              body: source,
            });
            requireThat(response.ok, "interrupted", "Complete snapshot copy interrupted");
          }
        }
      const final = await this.childFetch(ctx, row.allocation, "/manifest", {
        method: "PUT",
        body: JSON.stringify(row.request.manifest),
      });
      requireThat(final.ok, "interrupted", "Manifest staging failed");
      const store = this.stub(row.allocation.childId);
      let seal = await store.sealStore(ctx, {
        ...lookup(row.allocation),
        uploadId: row.status.uploadId,
        manifestHash: row.status.manifestHash,
        expectedVersion: 1,
      });
      if (!seal.ok) {
        const observed = unwrap(await store.describeStore(ctx, lookup(row.allocation)));
        requireThat(
          observed.state === "sealed" && observed.manifestHash === row.status.manifestHash,
          "interrupted",
          "Seal acknowledgment uncertain",
        );
        seal = await store.sealStore(ctx, {
          ...lookup(row.allocation),
          uploadId: row.status.uploadId,
          manifestHash: row.status.manifestHash,
          expectedVersion: 1,
        });
      }
      const evidence = unwrap(seal);
      await this.mutex.run(() =>
        this.state.transaction(() => {
          const current = this.upload(ctx, input.path.workspaceId, input.path.uploadId);
          const registered = this.state.get<AllocationRecord>(
            `allocation:${row.allocation.allocationId}`,
          );
          requireThat(
            registered &&
              registered.state.state !== "retiring" &&
              registered.state.state !== "deleted",
            "conflict",
            "Store retired during validation",
          );
          current.stage = evidence;
          current.status.state = "validated";
          this.state.put(`upload:${row.status.uploadId}`, current);
          this.state.put(`allocation:${row.allocation.allocationId}`, {
            ...registered,
            seal: evidence,
            state: { ...registered.state, state: "sealed", manifestHash: evidence.manifestHash },
          });
        }),
      );
      return {
        status: 200 as const,
        body: {
          uploadId: row.status.uploadId,
          manifestHash: evidence.manifestHash,
          stageId: evidence.stageId,
          validated: true as const,
        },
      };
    }, ctx.requestId);
  }
  abortUpload(
    ctx: D.AuthContext,
    input: D.OperationRequest<"abortUpload">,
  ): Promise<D.Outcome<D.OperationResponse<"abortUpload">>> {
    return outcome(async () => {
      if (this.localUploads.has(input.path.uploadId)) {
        await this.mutex.run(() =>
          this.localUploads.abort(ctx, input.path.workspaceId, input.path.uploadId),
        );
        return { status: 204 as const, body: undefined };
      }

      await this.mutex.run(() =>
        this.state.transaction(() => {
          const row = this.upload(ctx, input.path.workspaceId, input.path.uploadId, false);
          requireThat(
            row.status.state !== "committed",
            "conflict",
            "Committed upload cannot abort",
          );
          if (row.status.state !== "aborted" && row.status.state !== "expired") {
            row.status.state = "aborted";
            this.closeUpload(row);
            this.state.put(`upload:${row.status.uploadId}`, row);
          }
        }),
      );
      return { status: 204 as const, body: undefined };
    }, ctx.requestId);
  }
  private closeUpload(row: UploadRecord): void {
    this.state.put(
      "active-uploads",
      Math.max(0, (this.state.get<number>("active-uploads") ?? 0) - 1),
    );
    this.state.put(
      "active-upload-bytes",
      Math.max(
        0,
        (this.state.get<number>("active-upload-bytes") ?? 0) - uploadStorageBytes(row.request),
      ),
    );
  }
  commitUpload(
    ctx: D.AuthContext,
    input: D.OperationRequest<"commitUpload">,
  ): Promise<D.Outcome<D.OperationResponse<"commitUpload">>> {
    return outcome(async () => {
      if (this.localUploads.has(input.path.uploadId)) return this.localUploads.commit(ctx, input);

      requireThat(
        input.body.workspaceId === input.path.workspaceId &&
          input.body.uploadId === input.path.uploadId,
        "invalid_request",
        "Upload route mismatch",
      );
      const proof = await this.mutex.run(() => {
        const row = this.upload(ctx, input.path.workspaceId, input.path.uploadId, false);
        requireThat(
          row.stage &&
            row.stage.stageId === input.body.stageId &&
            row.request.operationId === input.body.operationId &&
            row.request.commitId === input.body.commitId &&
            row.request.baseRevision === input.body.baseRevision &&
            row.request.manifestHash === input.body.manifestHash &&
            row.request.lease.leaseId === input.body.lease.leaseId,
          "conflict",
          "Validated stage mismatch",
        );
        return row.stage;
      });
      const base = {
        commitId: input.body.commitId,
        uploadId: input.body.uploadId,
        operationId: input.body.operationId,
        ...(input.body.jobId ? { jobId: input.body.jobId } : {}),
        workspaceId: input.body.workspaceId,
        baseRevision: input.body.baseRevision,
        manifestHash: input.body.manifestHash,
      };
      const digest = await commitDigest({
        ...base,
        leaseIdentity: input.body.lease,
        storage: { kind: "computer", storeRef: proof },
      });
      const receipt = unwrap(
        await this.commit(ctx, {
          ...base,
          lease: input.body.lease,
          commitDigest: digest,
          providerKind: "computer",
          storeRef: proof,
        }),
      );
      return { status: 200 as const, body: publicCommitReceipt(receipt) };
    }, ctx.requestId);
  }
  commit(ctx: D.AuthContext, input: D.CommitInput): Promise<D.Outcome<D.CommitReceipt>> {
    return outcome(async () => {
      await this.authority(ctx, input.workspaceId, "workspace.write");
      const prior = await this.mutex.run(() => this.receipt(ctx, input, "workspace.write"));
      if (prior) return prior;
      if (input.providerKind === "local") return this.localUploads.publishObserved(ctx, input);
      const digest = await commitDigest({
        ...input,
        leaseIdentity: input.lease,
        storage: { kind: "computer", storeRef: input.storeRef },
      });
      requireThat(digest === input.commitDigest, "conflict", "Commit digest mismatch");
      const child = unwrap(
        await this.stub(input.storeRef.childId).describeStore(ctx, input.storeRef),
      );
      requireThat(
        child.state === "sealed" && child.manifestHash === input.manifestHash,
        "conflict",
        "Child seal not confirmed",
      );
      return this.mutex.run(() =>
        this.state.transaction(() => {
          const repeated = this.receipt(ctx, input, "workspace.write");
          if (repeated) return repeated;
          const authority = this.current();
          validateLease(this.state, authority, input.lease, ctx);
          const upload = this.upload(ctx, input.workspaceId, input.uploadId);
          const allocation = this.state.get<AllocationRecord>(
            `allocation:${input.storeRef.allocationId}`,
          );
          requireThat(
            upload.status.state === "validated" &&
              upload.stage &&
              same(upload.stage, input.storeRef) &&
              upload.request.commitId === input.commitId &&
              upload.request.operationId === input.operationId &&
              upload.status.manifestHash === input.manifestHash &&
              input.baseRevision === input.lease.baseRevision &&
              allocation?.state.state === "sealed" &&
              same(allocation.seal, input.storeRef),
            "conflict",
            "Upload, allocation or seal changed",
          );
          requireThat(
            input.lease.ownerKind === "job"
              ? input.jobId === input.lease.jobId
              : input.jobId === undefined,
            "conflict",
            "Commit ownership mismatch",
          );
          const receipt: D.CommitReceipt = {
            ...this.publication(ctx, input, upload.request.manifest),
            providerKind: "computer",
            storeRef: input.storeRef,
          };
          allocation.referenced = true;
          this.state.put(`allocation:${input.storeRef.allocationId}`, allocation);
          this.state.put(`revision:${receipt.revision}`, {
            revision: receipt.revision,
            manifest: upload.request.manifest,
            manifestHash: receipt.manifestHash,
            store: input.storeRef,
          } satisfies RevisionRecord);
          this.finishPublication(receipt, input.lease);
          upload.status.state = "committed";
          this.closeUpload(upload);
          this.state.put(`upload:${input.uploadId}`, upload);
          return receipt;
        }),
      );
    }, ctx.requestId);
  }
  private receipt(
    ctx: D.AuthContext,
    input: D.CommitLookup,
    action: "workspace.read" | "workspace.write" = "workspace.read",
  ): D.CommitReceipt | undefined {
    authorize(this.state, ctx, input.workspaceId, action);
    const prior = this.state.get<D.CommitReceipt>(`receipt:${input.commitId}`);
    if (prior) {
      if (action === "workspace.write") this.receiptReservation(ctx, prior);
      requireThat(
        prior.commitDigest === input.commitDigest,
        "conflict",
        "Commit ID reused with different digest",
      );
    }
    return prior;
  }
  private receiptReservation(ctx: D.AuthContext, receipt: D.CommitReceipt): D.TargetReservation {
    const upload =
      receipt.providerKind === "computer"
        ? this.state.get<UploadRecord>(`upload:${receipt.storeRef.uploadId}`)
        : undefined;
    const local =
      receipt.providerKind === "local"
        ? this.state.get<D.LocalCommitIntent>(`local-intent:${receipt.commitId}`)
        : undefined;
    const lease = upload?.request.lease ?? local?.scope.lease;
    requireThat(
      lease &&
        lease.workspaceId === receipt.workspaceId &&
        lease.baseRevision === receipt.baseRevision &&
        lease.operationId === receipt.operationId &&
        (lease.ownerKind === "job" ? lease.jobId === receipt.jobId : receipt.jobId === undefined),
      "conflict",
      "Stored publication operation mismatch",
    );
    return authorizeReservedAction(this.state, ctx, lease, "workspace.write");
  }
  /** Receipt recovery may use write authority, but never grants a public read capability. */
  private receiptReadAction(
    ctx: D.AuthContext,
    workspaceId: string,
  ): "workspace.read" | "workspace.write" {
    try {
      authorize(this.state, ctx, workspaceId, "workspace.read");
      return "workspace.read";
    } catch (error) {
      if (!(error instanceof WorkspaceError) || error.code !== "unauthorized") throw error;
      authorize(this.state, ctx, workspaceId, "workspace.write");
      return "workspace.write";
    }
  }
  private lookupReceipt(
    ctx: D.AuthContext,
    input: D.CommitLookup,
    action: "workspace.read" | "workspace.write",
  ): D.CommitReceipt {
    const receipt = this.receipt(ctx, input, action);
    requireThat(
      !this.state.get("child") &&
        this.isSelf(input.workspaceId) &&
        this.current().workspaceId === input.workspaceId,
      "unauthorized",
      "Only the workspace authority accepts this operation",
    );
    requireThat(receipt, "not_found", "Receipt not found");
    return receipt;
  }
  private publication(
    _ctx: D.AuthContext,
    input: {
      commitId: string;
      commitDigest: string;
      operationId: string;
      jobId?: string;
      workspaceId: string;
      baseRevision: string;
      manifestHash: string;
    },
    manifest: D.Manifest,
  ) {
    const retained = this.state.get<{ versions: number; unique: Record<string, number> }>(
      "retained",
    );
    requireThat(retained, "internal", "Retention state missing");
    requireThat(
      retained.versions < this.policy.bounds.retainedVersions,
      "quota_exceeded",
      "Retained version bound reached; explicit retention change required",
    );
    for (const entry of manifest.entries)
      if (entry.type === "file") retained.unique[entry.sha256] = entry.size;
    requireThat(
      Object.values(retained.unique).reduce((sum, bytes) => sum + bytes, 0) <=
        this.policy.bounds.workspaceBytes &&
        this.state.bytes <
          this.policy.bounds.objectBytes * (1 - this.policy.bounds.headroomFraction),
      "quota_exceeded",
      "Retained bytes or metadata bound reached",
    );
    retained.versions++;
    this.state.put("retained", retained);
    return {
      commitId: input.commitId,
      commitDigest: input.commitDigest,
      operationId: input.operationId,
      ...(input.jobId ? { jobId: input.jobId } : {}),
      workspaceId: input.workspaceId,
      baseRevision: input.baseRevision,
      revision: crypto.randomUUID(),
      manifestHash: input.manifestHash,
      sourceFactId: crypto.randomUUID(),
      committedAt: Date.now(),
    };
  }
  private finishPublication(receipt: D.CommitReceipt, lease: D.Lease): void {
    const authority = this.current();
    this.state.put("authority", {
      ...authority,
      binding: {
        ...authority.binding,
        revision: receipt.revision,
        manifestHash: receipt.manifestHash,
      },
    });
    this.state.put(`receipt:${receipt.commitId}`, receipt);
    this.state.put(`commit-fact:${receipt.sourceFactId}`, { receipt });
    const reservation = this.state.get<D.TargetReservation>(`reservation:${lease.leaseId}`);
    if (reservation?.agentId && reservation.conversationId) {
      const fact: D.Fact = {
        factId: receipt.sourceFactId,
        source: { kind: "workspace", id: receipt.workspaceId },
        recipients: [{ kind: "agent", id: reservation.agentId }],
        conversationId: reservation.conversationId,
        createdAt: receipt.committedAt,
        event: {
          protocolVersion: "1.0",
          schemaVersion: "1.0.0",
          deploymentId: authority.deploymentId,
          conversationId: reservation.conversationId,
          durability: "durable",
          type: "workspace.revision.committed",
          payload: publicCommitReceipt(receipt),
        },
      };
      this.state.put(`fact:${fact.factId}`, { fact, acknowledgments: [] } satisfies FactRow);
    }
  }
  getReceipt(ctx: D.AuthContext, input: D.CommitLookup): Promise<D.Outcome<D.CommitReceipt>> {
    return outcome(
      () =>
        this.mutex.run(() =>
          this.lookupReceipt(ctx, input, this.receiptReadAction(ctx, input.workspaceId)),
        ),
      ctx.requestId,
    );
  }
  getCommitReceipt(
    ctx: D.AuthContext,
    input: D.OperationRequest<"getCommitReceipt">,
  ): Promise<D.Outcome<D.OperationResponse<"getCommitReceipt">>> {
    return outcome(
      () =>
        this.mutex.run(() => ({
          status: 200 as const,
          body: publicCommitReceipt(
            this.lookupReceipt(
              ctx,
              {
                workspaceId: input.path.workspaceId,
                commitId: input.path.commitId,
                commitDigest: input.query.commitDigest,
              },
              "workspace.read",
            ),
          ),
        })),
      ctx.requestId,
    );
  }
  transact(ctx: D.AuthContext, input: D.WorkspaceTransaction) {
    return outcome(async () => {
      const row = await this.mutex.run(() =>
        this.localUploads.has(input.commit.uploadId)
          ? this.localUploads.get(ctx, input.commit.workspaceId, input.commit.uploadId, false)
          : this.upload(ctx, input.commit.workspaceId, input.commit.uploadId, false),
      );
      requireThat(
        same(row.request.mutations, input.mutations),
        "conflict",
        "Transaction mutations changed",
      );
      return unwrap(await this.commit(ctx, input.commit));
    }, ctx.requestId);
  }
  transactWorkspace(
    ctx: D.AuthContext,
    input: D.OperationRequest<"transactWorkspace">,
  ): Promise<D.Outcome<D.OperationResponse<"transactWorkspace">>> {
    return outcome(async () => {
      await this.mutex.run(() => {
        const staged = this.localUploads.has(input.body.commit.uploadId)
          ? this.localUploads.get(ctx, input.path.workspaceId, input.body.commit.uploadId, false)
          : this.upload(ctx, input.path.workspaceId, input.body.commit.uploadId, false);
        requireThat(
          same(staged.request.mutations, input.body.mutations),
          "conflict",
          "Transaction mutations differ from the validated enclosing upload",
        );
      });
      const response = unwrap(
        await this.commitUpload(ctx, {
          operationId: "commitUpload",
          path: { workspaceId: input.path.workspaceId, uploadId: input.body.commit.uploadId },
          query: {},
          body: input.body.commit,
        }),
      );
      return response;
    }, ctx.requestId);
  }
  prepareLocalCommit(
    ctx: D.AuthContext,
    input: {
      scope: D.LocalScope;
      commitId: string;
      preparation: D.LocalPrepared;
      expectedPostManifestHash?: string;
    },
  ): Promise<D.Outcome<D.LocalCommitIntent>> {
    return outcome(async () => {
      await this.authority(ctx, input.scope.workspaceId, "workspace.write");
      const candidate: D.LocalCommitIntent = {
        commitId: input.commitId,
        intentDigest: await localIntentDigest({
          commitId: input.commitId,
          scope: input.scope,
          preparationId: input.preparation.preparationId,
          preManifestHash: input.preparation.preManifestHash,
          ...(input.expectedPostManifestHash
            ? { expectedPostManifestHash: input.expectedPostManifestHash }
            : {}),
        }),
        scope: input.scope,
        preparationId: input.preparation.preparationId,
        preManifestHash: input.preparation.preManifestHash,
        ...(input.expectedPostManifestHash
          ? { expectedPostManifestHash: input.expectedPostManifestHash }
          : {}),
        state: "pending_apply",
      };
      return this.mutex.run(() =>
        this.state.transaction(() => {
          const authority = this.current();
          validateLease(this.state, authority, input.scope.lease, ctx);
          requireThat(
            authority.binding.config.kind === "local" &&
              authority.binding.availability === "available" &&
              input.scope.bindingVersion === authority.binding.bindingVersion &&
              input.scope.executorId === authority.binding.config.executorId &&
              input.scope.rootBindingId === authority.binding.config.rootBindingId &&
              input.scope.baseRevision === authority.binding.revision &&
              input.scope.lease.executorGeneration === input.scope.executorGeneration &&
              input.scope.lease.executorId === input.scope.executorId &&
              same(input.scope.credential, credential(ctx)) &&
              input.scope.operationId === input.scope.lease.operationId,
            "conflict",
            "Local scope mismatch",
          );
          requireThat(
            input.preparation.state === "prepared" &&
              input.preparation.expiresAt > Date.now() &&
              input.preparation.operationId === input.scope.operationId &&
              input.preparation.operationDigest === input.scope.operationDigest &&
              input.preparation.preManifestHash === authority.binding.manifestHash,
            "workspace.conflict",
            "Local pre-manifest drift",
            { reason: "local_drift" },
          );
          const prior = this.state.get<D.LocalCommitIntent>(`local-intent:${input.commitId}`);
          if (prior) {
            requireThat(
              prior.intentDigest === candidate.intentDigest,
              "conflict",
              "Local intent ID reused",
            );
            return prior;
          }
          this.state.put(`local-intent:${input.commitId}`, candidate);
          return candidate;
        }),
      );
    }, ctx.requestId);
  }
  commitLocal(
    ctx: D.AuthContext,
    input: { intent: D.LocalCommitIntent; observation: D.LocalObservation; manifest: D.Manifest },
  ): Promise<D.Outcome<D.CommitReceipt>> {
    return outcome(async () => {
      const manifest = checkedManifest(input.manifest, this.policy);
      const hash = await manifestDigest(manifest);
      const { intent, observation } = input;
      requireThat(
        observation.state === "applied" &&
          observation.operationId === intent.scope.operationId &&
          observation.operationDigest === intent.scope.operationDigest &&
          observation.commitId === intent.commitId &&
          observation.preparationId === intent.preparationId &&
          observation.preManifestHash === intent.preManifestHash &&
          observation.postManifestHash === hash &&
          (intent.expectedPostManifestHash === undefined ||
            hash === intent.expectedPostManifestHash) &&
          observation.observationSeq > 0,
        "workspace.conflict",
        "Local effect is incomplete, uncertain or drifted",
        { reason: "local_drift" },
      );
      requireThat(
        intent.intentDigest === (await localIntentDigest(intent)),
        "conflict",
        "Local intent digest mismatch",
      );
      const uploadId = this.localUploads.uploadForIntent(intent);
      const finalDigest = await commitDigest({
        commitId: intent.commitId,
        ...(uploadId ? { uploadId } : {}),
        operationId: intent.scope.operationId,
        workspaceId: intent.scope.workspaceId,
        baseRevision: intent.scope.baseRevision,
        manifestHash: hash,
        leaseIdentity: intent.scope.lease,
        ...(intent.scope.lease.ownerKind === "job" ? { jobId: intent.scope.lease.jobId } : {}),
        storage: {
          kind: "local",
          preparationId: intent.preparationId,
          observationSeq: observation.observationSeq,
          preManifestHash: observation.preManifestHash,
          postManifestHash: hash,
        },
      });
      return this.mutex.run(() =>
        this.state.transaction(() => {
          const previous = this.receipt(
            ctx,
            {
              workspaceId: intent.scope.workspaceId,
              commitId: intent.commitId,
              commitDigest: finalDigest,
            },
            "workspace.write",
          );
          if (previous) return previous;
          const pending = this.state.get<D.LocalCommitIntent>(`local-intent:${intent.commitId}`);
          requireThat(
            pending && same(pending, intent),
            "conflict",
            "Pending local intent mismatch",
          );
          const authority = this.current();
          validateLease(this.state, authority, intent.scope.lease, ctx);
          requireThat(
            authority.binding.config.kind === "local" &&
              authority.binding.bindingVersion === intent.scope.bindingVersion &&
              authority.binding.manifestHash === intent.preManifestHash,
            "workspace.conflict",
            "Local base changed",
            { reason: "local_drift" },
          );
          const receipt: D.CommitReceipt = {
            ...this.publication(
              ctx,
              {
                commitId: intent.commitId,
                commitDigest: finalDigest,
                operationId: intent.scope.operationId,
                workspaceId: intent.scope.workspaceId,
                baseRevision: intent.scope.baseRevision,
                manifestHash: hash,
                ...(intent.scope.lease.ownerKind === "job"
                  ? { jobId: intent.scope.lease.jobId }
                  : {}),
              },
              manifest,
            ),
            providerKind: "local",
            preparationId: intent.preparationId,
            observationSeq: observation.observationSeq,
          };
          this.state.put(`revision:${receipt.revision}`, {
            revision: receipt.revision,
            manifestHash: hash,
            manifest,
          } satisfies RevisionRecord);
          this.state.put(`local-observation:${intent.commitId}`, observation);
          this.finishPublication(receipt, intent.scope.lease);
          return receipt;
        }),
      );
    }, ctx.requestId);
  }
  pageFacts(ctx: D.AuthContext, input: D.FactPageRequest): Promise<D.Outcome<D.FactPage>> {
    return outcome(
      () =>
        this.mutex.run(() => {
          const authority = this.current();
          this.receiptReadAction(ctx, authority.workspaceId);
          requireThat(
            input.recipient.kind === "agent" &&
              ctx.grants.some(
                (grant) =>
                  (grant.expiresAt === undefined || grant.expiresAt > Date.now()) &&
                  permitsResource(grant.resources.workspaceIds, authority.workspaceId) &&
                  (permitsResource(grant.resources.actions, "workspace.read") ||
                    permitsResource(grant.resources.actions, "workspace.write")) &&
                  permitsResource(grant.resources.agentIds, input.recipient.id),
              ),
            "unauthorized",
            "Fact recipient grant required",
          );
          requireThat(
            input.limit >= 1 &&
              input.limit <= Math.min(100, this.policy.bounds.sqlPageRows) &&
              (!input.after || input.after.startsWith("fact:")),
            "invalid_request",
            "Invalid fact page",
          );
          const rows = this.state.page<FactRow>("fact:", input.after, input.limit);
          return {
            items: rows
              .filter(
                (row) =>
                  this.canReadFact(ctx, row.value.fact, input.recipient) &&
                  !row.value.acknowledgments.some((ack) => same(ack.recipient, input.recipient)),
              )
              .map((row) => row.value.fact),
            ...(rows.length === input.limit ? { nextPageToken: rows.at(-1)?.key ?? "" } : {}),
          };
        }),
      ctx.requestId,
    );
  }
  ackFacts(ctx: D.AuthContext, input: D.FactAckRequest): Promise<D.Outcome<D.FactAck>> {
    return outcome(
      () =>
        this.mutex.run(() =>
          this.state.transaction(() => {
            const authority = this.current();
            this.receiptReadAction(ctx, authority.workspaceId);
            requireThat(
              input.recipient.kind === "agent" &&
                input.eventSeq > 0 &&
                Number.isSafeInteger(input.eventSeq),
              "unauthorized",
              "Invalid recipient acknowledgment",
            );
            const row = this.state.get<FactRow>(`fact:${input.factId}`);
            requireThat(row, "not_found", "Fact absent");
            requireThat(
              this.canReadFact(ctx, row.fact, input.recipient),
              "unauthorized",
              "Fact scope or recipient grant required",
            );
            const prior = row.acknowledgments.find((ack) => same(ack.recipient, input.recipient));
            if (prior) {
              requireThat(
                prior.eventId === input.eventId && prior.eventSeq === input.eventSeq,
                "conflict",
                "Fact coordinates changed",
              );
              return prior;
            }
            const ack: D.FactAck = { ...input, persisted: true };
            row.acknowledgments.push(ack);
            this.state.put(`fact:${input.factId}`, row);
            return ack;
          }),
        ),
      ctx.requestId,
    );
  }
  private canReadFact(ctx: D.AuthContext, fact: D.Fact, recipient: D.Recipient): boolean {
    const authority = this.current();
    if (
      this.state.get("child") ||
      !this.isSelf(authority.workspaceId) ||
      !same(fact.source, { kind: "workspace", id: authority.workspaceId }) ||
      fact.event.deploymentId !== authority.deploymentId ||
      fact.event.conversationId !== fact.conversationId ||
      recipient.kind !== "agent" ||
      !fact.recipients.some((saved) => same(saved, recipient))
    )
      return false;
    const scoped = (action: "workspace.read" | "workspace.write") =>
      ctx.grants.some(
        (grant) =>
          (grant.expiresAt === undefined || grant.expiresAt > Date.now()) &&
          permitsResource(grant.resources.workspaceIds, authority.workspaceId) &&
          permitsResource(grant.resources.actions, action) &&
          permitsResource(grant.resources.agentIds, recipient.id) &&
          permitsResource(grant.resources.conversationIds, fact.conversationId),
      );
    if (scoped("workspace.read")) return true;
    if (!scoped("workspace.write")) return false;
    // Write-only recovery exposes only the actual publication's intended recipient fact.
    const saved = this.state.get<{ receipt: D.CommitReceipt }>(`commit-fact:${fact.factId}`);
    const receipt = saved && this.state.get<D.CommitReceipt>(`receipt:${saved.receipt.commitId}`);
    if (
      !receipt ||
      !same(saved?.receipt, receipt) ||
      receipt.sourceFactId !== fact.factId ||
      fact.event.type !== "workspace.revision.committed" ||
      !same(fact.event.payload, publicCommitReceipt(receipt))
    )
      return false;
    try {
      const reservation = this.receiptReservation(ctx, receipt);
      return (
        reservation.agentId === recipient.id && reservation.conversationId === fact.conversationId
      );
    } catch (error) {
      if (!(error instanceof WorkspaceError)) throw error;
      return false;
    }
  }
  exportData(ctx: D.AuthContext, input: D.ExportRequest): Promise<D.Outcome<D.ExportDescriptor>> {
    return outcome(() => this.exports.create(ctx, input), ctx.requestId);
  }
  async captureArtifacts(
    ctx: D.AuthContext,
    allocation: D.StoreAllocation,
    identity: D.ExecutionIdentity,
    result: WorkspaceRuntimeResult<"utf8">,
  ): Promise<D.ByteReference[]> {
    const authority = this.current();
    authorizeReservedAction(this.state, ctx, identity.lease, "workspace.write");
    const reservation = this.state.get<D.TargetReservation>(
      `reservation:${identity.lease.leaseId}`,
    );
    requireThat(
      allocation.role === "scratch" &&
        allocation.executionId === identity.executionId &&
        allocation.jobId === identity.jobId &&
        reservation?.ownerKind === "job",
      "unauthorized",
      "Job output allocation mismatch",
    );
    const existing = this.state.get<D.ByteReference[]>(
      `artifacts-execution:${identity.executionId}`,
    );
    if (existing) return existing;
    const streams = [result.truncated?.stdout, result.truncated?.stderr].filter(
      (entry) => entry?.status === "saved",
    );
    const total = streams.reduce((sum, entry) => sum + (entry?.totalBytes ?? 0), 0);
    const maximum = Math.min(this.policy.bounds.artifactBytes, wireLimits.artifactBytes);
    requireThat(
      total <= this.policy.bounds.outputBytesPerJob &&
        streams.reduce((sum, entry) => sum + Math.ceil((entry?.totalBytes ?? 0) / maximum), 0) <=
          16,
      "quota_exceeded",
      "Retained job output exceeds admitted bounds",
    );
    const records: ArtifactRecord[] = [];
    for (const saved of streams)
      if (saved?.status === "saved") {
        for (let offset = 0; offset < saved.totalBytes; offset += maximum) {
          const size = Math.min(maximum, saved.totalBytes - offset);
          const response = await this.childFetch(ctx, allocation, "/artifact-read", {
            artifact: { path: saved.path, offset, size },
          });
          requireThat(response.ok && response.body, "interrupted", "Saved output unavailable");
          const sha256 = await hashStream(response.body, size, ctx.deadline);
          const artifactId = crypto.randomUUID();
          const expiresAt = Date.now() + 3_600_000;
          const reference: D.ByteReference = {
            workspaceId: authority.workspaceId,
            revision: identity.baseRevision,
            artifactId,
            sha256,
            size,
            endpoint: `/v1/workspaces/${authority.workspaceId}/artifacts/${artifactId}?revision=${encodeURIComponent(identity.baseRevision)}`,
            owner: { kind: "cloud", expiresAt },
          };
          records.push({
            reference,
            allocation,
            jobId: identity.jobId,
            agentId: reservation.agentId,
            conversationId: reservation.conversationId,
            path: saved.path,
            offset,
            expiresAt,
            state: "ready",
          });
        }
      }
    const references = await this.mutex.run(() =>
      this.state.transaction(() => {
        authorizeReservedAction(this.state, ctx, identity.lease, "workspace.write");
        const repeated = this.state.get<D.ByteReference[]>(
          `artifacts-execution:${identity.executionId}`,
        );
        if (repeated) return repeated;
        const registered = this.state.get<AllocationRecord>(
          `allocation:${allocation.allocationId}`,
        );
        requireThat(
          registered &&
            registered.state.state !== "retiring" &&
            registered.state.state !== "deleted",
          "conflict",
          "Output store retired",
        );
        registered.pins += records.length;
        this.state.put(`allocation:${allocation.allocationId}`, registered);
        for (const record of records) {
          this.state.put(`artifact:${record.reference.artifactId}`, record);
          this.state.put(dueKey(record.expiresAt, "artifact", record.reference.artifactId ?? ""), {
            at: record.expiresAt,
            kind: "artifact",
            id: record.reference.artifactId ?? "",
          } satisfies DueRecord);
        }
        const references = records.map((record) => record.reference);
        this.state.put(`artifacts-execution:${identity.executionId}`, references);
        return references;
      }),
    );
    if (records[0]) await this.armDue(records[0].expiresAt);
    return references;
  }
  private async armDue(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || at < current) await this.ctx.storage.setAlarm(at);
  }
  prepareExecution(ctx: D.AuthContext, input: D.ExecutionRequest) {
    return this.execution.prepare(ctx, input);
  }
  startOnce(ctx: D.AuthContext, input: D.PreparedExecution) {
    return this.execution.startOnce(ctx, input);
  }
  queryExecution(ctx: D.AuthContext, input: D.ExecutionIdentity) {
    return this.execution.queryExisting(ctx, input);
  }
  cancelExecution(ctx: D.AuthContext, input: D.CancelRequest) {
    return this.execution.cancel(ctx, input);
  }
  collectResult(ctx: D.AuthContext, input: D.ExecutionIdentity) {
    return this.execution.collectResult(ctx, input);
  }
  async readStored(
    ctx: D.AuthContext,
    revision: RevisionRecord,
    entry: Extract<D.ManifestEntry, { type: "file" }>,
  ): Promise<ReadableStream<Uint8Array>> {
    requireThat(
      revision.store && revision.manifest.entries.some((item) => same(item, entry)),
      "unauthorized",
      "Committed revision membership required",
    );
    const registered = this.state.get<AllocationRecord>(
      `allocation:${revision.store.allocationId}`,
    );
    requireThat(registered?.referenced, "conflict", "Revision not retained");
    const response = await this.childFetch(ctx, registered.state.allocation, "/read", { entry });
    requireThat(response.ok && response.body, "interrupted", "Stored byte stream unavailable");
    return response.body;
  }
  async fetch(request: Request): Promise<Response> {
    // The entry strips this header from public requests and constructs it only after authentication.
    // No public route resolves child IDs or forwards Computer's /api surface.
    const raw = request.headers.get(internalHeader);
    if (!raw && this.execution.hasCallback()) return this.execution.callback(request);
    if (!raw || raw.length > 65_536) return new Response(null, { status: 403 });
    const result = await outcome(async () => {
      const envelope = JSON.parse(raw) as InternalContext;
      const { auth } = envelope;
      const url = new URL(request.url);
      if (url.pathname.startsWith("/v1/admin/")) {
        const match = /^\/v1\/admin\/artifacts\/([A-Za-z0-9_-]{1,128})$/.exec(url.pathname);
        requireThat(
          match && request.method === "GET" && !url.search,
          "invalid_request",
          "Exact private export artifact GET required",
        );
        const peer = await this.exports.peer(auth, match[1] ?? "", request.signal);
        return byteResponse(
          request,
          peer.reference.size,
          peer.reference.sha256,
          auth.deadline,
          async () => peer.open(),
        );
      }
      if (url.pathname === "/__fortipi/operational-metadata") {
        requireThat(
          request.method === "GET",
          "invalid_request",
          "Operational metadata requires GET",
        );
        const keys = ["revision", "agentId", "conversationId"];
        requireThat(
          [...url.searchParams.keys()].every((key) => keys.includes(key)) &&
            keys.every(
              (key) =>
                url.searchParams.getAll(key).length === 1 &&
                /^[A-Za-z0-9_-]{1,128}$/.test(url.searchParams.get(key) ?? ""),
            ),
          "invalid_request",
          "Operational metadata requires an exact base and agent scope",
        );
        const metadata = await this.mutex.run(() => {
          const authority = this.current();
          authorize(this.state, auth, authority.workspaceId, "workspace.write");
          requireThat(
            !this.state.get("child") && this.isSelf(authority.workspaceId),
            "unauthorized",
            "Only the workspace authority accepts operational metadata",
          );
          requireThat(
            auth.grants.some(
              (grant) =>
                (grant.expiresAt === undefined || grant.expiresAt > Date.now()) &&
                permitsResource(grant.resources.workspaceIds, authority.workspaceId) &&
                permitsResource(grant.resources.agentIds, url.searchParams.get("agentId") ?? "") &&
                permitsResource(
                  grant.resources.conversationIds,
                  url.searchParams.get("conversationId") ?? "",
                ) &&
                permitsResource(grant.resources.actions, "jobs.dispatch") &&
                permitsResource(grant.resources.actions, "workspace.write"),
            ),
            "unauthorized",
            "One current dispatch and workspace write grant required",
          );
          const binding = authority.binding;
          requireThat(
            binding.revision === url.searchParams.get("revision") &&
              this.revision(binding.revision).manifestHash === binding.manifestHash,
            "workspace.conflict",
            "Operational metadata base revision changed",
            { reason: "expected_revision" },
          );
          requireThat(
            binding.config.kind === "computer" || binding.config.kind === "local",
            "conflict",
            "Unknown workspace provider",
          );
          const result: D.WorkspaceBinding = {
            workspaceId: authority.workspaceId,
            bindingVersion: binding.bindingVersion,
            revision: binding.revision,
            manifestHash: binding.manifestHash,
            availability: binding.availability,
            config:
              binding.config.kind === "computer"
                ? { kind: "computer" }
                : {
                    kind: "local",
                    executorId: binding.config.executorId,
                    rootBindingId: binding.config.rootBindingId,
                  },
          };
          return result;
        });
        return Response.json(metadata, { headers: { "Cache-Control": "no-store" } });
      }
      if (url.pathname === "/__fortipi/terminal-proof") {
        requireThat(request.method === "POST", "invalid_request", "Terminal proof requires POST");
        const input = await boundedJson<unknown>(request, 65_536);
        const proof = await this.mutex.run(() => terminalProof(this, auth, input));
        return Response.json(proof, { headers: { "Cache-Control": "no-store" } });
      }
      if (url.pathname.startsWith("/__fortipi/authority/")) {
        const action = url.pathname.split("/").at(-1);
        if (action === "prepare")
          return Response.json(
            await this.prepareExecution(
              auth,
              await boundedJson<D.ExecutionRequest>(request, wireLimits.jsonBytes),
            ),
          );
        if (action === "start")
          return Response.json(
            await this.startOnce(
              auth,
              await boundedJson<D.PreparedExecution>(request, wireLimits.jsonBytes),
            ),
          );
        if (action === "query")
          return Response.json(
            await this.queryExecution(
              auth,
              await boundedJson<D.ExecutionIdentity>(request, wireLimits.jsonBytes),
            ),
          );
        if (action === "collect")
          return Response.json(
            await this.collectResult(
              auth,
              await boundedJson<D.ExecutionIdentity>(request, wireLimits.jsonBytes),
            ),
          );
        requireThat(false, "not_found", "Authority operation absent");
      }
      if (url.pathname === "/__fortipi/facts")
        return Response.json(
          await this.pageFacts(
            auth,
            await boundedJson<D.FactPageRequest>(request, wireLimits.jsonBytes),
          ),
        );
      if (url.pathname.startsWith("/__fortipi/transfer/"))
        return this.transferRequest(request, auth);
      if (url.pathname === "/__fortipi/execution/permit")
        return this.execution.permit(request, envelope.auth);
      if (url.pathname === "/__fortipi/execution/observed")
        return this.execution.observed(request, envelope.allocation);
      if (url.pathname.startsWith("/__fortipi/execution/"))
        return this.execution.fetch(request, envelope, this.childStore());
      if (!url.pathname.startsWith("/__fortipi/store/")) {
        const authority = this.current();
        const publicWorkspace = /^\/v1\/workspaces\/([^/]+)\//.exec(url.pathname)?.[1];
        requireThat(
          !publicWorkspace || publicWorkspace === authority.workspaceId,
          "unauthorized",
          "Workspace route does not match authority",
        );
        const artifactId = /\/artifacts\/([A-Za-z0-9_-]+)$/.exec(url.pathname)?.[1];
        await this.authority(
          auth,
          authority.workspaceId,
          artifactId ? "artifacts.read" : "workspace.read",
        );
        if (artifactId) {
          const artifact = this.state.get<ArtifactRecord>(`artifact:${artifactId}`);
          if (!artifact)
            return this.nativeArtifact(request, auth, authority.workspaceId, artifactId);
          requireThat(
            artifact.state === "ready" &&
              artifact.expiresAt > Date.now() &&
              artifact.reference.revision === url.searchParams.get("revision"),
            "not_found",
            "Artifact unavailable",
          );
          this.authorizeArtifact(auth, artifact);
          const open = async () => {
            const response = await this.childFetch(auth, artifact.allocation, "/artifact-read", {
              artifact: {
                path: artifact.path,
                offset: artifact.offset,
                size: artifact.reference.size,
              },
            });
            requireThat(response.ok && response.body, "interrupted", "Artifact bytes unavailable");
            return response.body;
          };
          return byteResponse(
            request,
            artifact.reference.size,
            artifact.reference.sha256,
            auth.deadline,
            async () => this.authorizedBytes(auth, "artifacts.read", await open(), artifact),
          );
        }
        const path = url.searchParams.get("path");
        const revisionId = url.searchParams.get("revision");
        const blob = /\/blobs\/([a-f0-9]{64})$/.exec(url.pathname)?.[1];
        requireThat(
          (path || blob) && revisionId,
          "invalid_request",
          "Revision and path or committed blob required",
        );
        if (path) validateRelativePath(path);
        const revision = this.revision(revisionId);
        const entry = revision.manifest.entries.find((item) =>
          path ? item.path === path : item.type === "file" && item.sha256 === blob,
        );
        requireThat(entry?.type === "file", "not_found", "File absent from revision");
        if (!revision.store && authority.binding.config.kind === "local")
          return byteResponse(request, entry.size, entry.sha256, auth.deadline, async () =>
            this.authorizedBytes(
              auth,
              "workspace.read",
              await this.localReads.open(
                auth,
                authority.binding,
                revisionId,
                entry,
                revision.manifestHash,
                request.signal,
              ),
            ),
          );
        return byteResponse(request, entry.size, entry.sha256, auth.deadline, async () =>
          this.authorizedBytes(
            auth,
            "workspace.read",
            await this.readStored(auth, revision, entry),
          ),
        );
      }
      const { allocation } = envelope;
      const path = url.pathname.slice("/__fortipi/store".length);
      if (
        path === "/read" &&
        request.method === "POST" &&
        envelope.exportId &&
        envelope.entry &&
        allocation &&
        this.isSelf(allocation.authorityId)
      ) {
        const entry = envelope.entry;
        return this.mutex.run(() =>
          Response.json(this.exports.member(auth, envelope.exportId ?? "", allocation, entry)),
        );
      }
      // Reuse the private store fetch lane for an exact output-member observation.
      // A current artifacts.read consumer never receives workspace.read authority.
      if (
        path === "/artifact-read" &&
        request.method === "POST" &&
        allocation &&
        this.isSelf(allocation.authorityId)
      )
        return this.mutex.run(() => {
          const authority = this.current();
          authorize(this.state, auth, authority.workspaceId, "artifacts.read");
          requireThat(
            allocation.role === "scratch" && allocation.workspaceId === authority.workspaceId,
            "unauthorized",
            "Output scratch authority required",
          );
          const row = this.state.get<AllocationRecord>(`allocation:${allocation.allocationId}`);
          requireThat(
            row &&
              same(row.state.allocation, allocation) &&
              row.state.state !== "retiring" &&
              row.state.state !== "deleted",
            "unauthorized",
            "Output allocation unavailable",
          );
          const references = this.state.get<D.ByteReference[]>(
            `artifacts-execution:${allocation.executionId}`,
          );
          const artifact = references
            ?.map((ref) => this.state.get<ArtifactRecord>(`artifact:${ref.artifactId}`))
            .find(
              (record) =>
                record &&
                same(record.allocation, allocation) &&
                record.path === envelope.artifact?.path &&
                record.offset === envelope.artifact?.offset &&
                record.reference.size === envelope.artifact?.size,
            );
          requireThat(artifact, "unauthorized", "Exact output member required");
          this.authorizeArtifact(auth, artifact);
          return Response.json(row.state);
        });
      requireThat(
        allocation && this.isSelf(allocation.childId),
        "unauthorized",
        "Child identity required",
      );
      const registry =
        path === "/read" && request.method === "GET" && envelope.exportId
          ? await this.exportRegistry(envelope)
          : path === "/artifact-read" && request.method === "GET"
            ? await this.artifactRegistry(envelope)
            : await this.registry(auth, lookup(allocation));
      requireThat(
        same(registry.state.allocation, allocation) &&
          registry.state.state !== "retiring" &&
          registry.state.state !== "deleted",
        "conflict",
        "Allocation unavailable",
      );
      const child = this.childStore();
      if (path.startsWith("/chunk/") && request.method === "PUT") {
        const index = Number(path.slice(7));
        requireThat(
          Number.isSafeInteger(index) &&
            index >= 0 &&
            index < 1024 &&
            request.body &&
            envelope.hash &&
            envelope.length !== undefined,
          "invalid_request",
          "Invalid chunk request",
        );
        const bytes = await boundedBytes(
          request.body,
          envelope.length,
          envelope.hash,
          auth.deadline,
        );
        await child.writeChunk(index, bytes, envelope.hash);
        return new Response(null, { status: 204 });
      }
      if (path === "/blob" && request.method === "PUT") {
        requireThat(
          envelope.entry?.type === "file" && request.body,
          "invalid_request",
          "File and body required",
        );
        checkedManifest({ version: 1, entries: [envelope.entry] }, this.policy);
        await child.writeBlob(envelope.entry, request.body);
        return new Response(null, { status: 204 });
      }
      if (path === "/materialize" && request.method === "PUT") {
        requireThat(
          envelope.entry && allocation.role === "scratch",
          "invalid_request",
          "Scratch entry required",
        );
        checkedManifest({ version: 1, entries: [envelope.entry] }, this.policy);
        await child.materialize(envelope.entry, request.body ?? undefined);
        return new Response(null, { status: 204 });
      }
      if (path === "/assemble" && request.method === "POST") {
        const input = await boundedJson<{ entry: D.ManifestEntry; chunks: number[] }>(request);
        requireThat(
          input.entry.type === "file" && input.chunks.length <= 256,
          "invalid_request",
          "Invalid file assembly",
        );
        checkedManifest({ version: 1, entries: [input.entry] }, this.policy);
        await child.assemble(input.entry, input.chunks);
        return new Response(null, { status: 204 });
      }
      if (path === "/manifest" && request.method === "PUT") {
        const manifest = checkedManifest(await boundedJson<D.Manifest>(request), this.policy);
        await this.mutex.run(() => {
          child.writable();
          this.state.put("staged-manifest", manifest);
        });
        return new Response(null, { status: 204 });
      }
      if (path === "/read" && request.method === "GET") {
        requireThat(envelope.entry?.type === "file", "invalid_request", "File membership required");
        return new Response(await child.read(envelope.entry));
      }
      if (path === "/scratch-read" && request.method === "GET") {
        requireThat(
          envelope.entry?.type === "file" && allocation.role === "scratch",
          "invalid_request",
          "Scratch file required",
        );
        return new Response(await child.read(envelope.entry, true));
      }
      if (path === "/artifact-read" && request.method === "GET") {
        requireThat(
          envelope.artifact && allocation.role === "scratch",
          "unauthorized",
          "Scratch output proof required",
        );
        return new Response(
          await child.artifact(
            envelope.artifact.path,
            envelope.artifact.offset,
            envelope.artifact.size,
          ),
        );
      }
      requireThat(false, "not_found", "Internal operation absent");
    });
    if (result.ok) return result.value;
    const { ok: _ok, ...error } = result;
    return Response.json({ error }, { status: errorStatuses[error.code] });
  }
  async alarm(): Promise<void> {
    // One bounded due queue. No historical credential is renewed by maintenance.
    const next = await this.mutex.run(() =>
      this.state.transaction(() => {
        const rows = this.state.page<DueRecord>(
          "due:",
          "",
          Math.min(100, this.policy.bounds.sqlPageRows),
        );
        for (const { key, value } of rows) {
          if (value.at > Date.now()) break;
          if (value.kind === "upload") {
            const upload = this.state.get<UploadRecord>(`upload:${value.id}`);
            if (upload && (upload.status.state === "open" || upload.status.state === "validated")) {
              upload.status.state = "expired";
              this.closeUpload(upload);
              this.state.put(`upload:${value.id}`, upload);
            }
          } else if (value.kind === "local-upload") {
            this.localUploads.expire(value.id);
          } else if (value.kind === "export") {
            this.exports.expire(value.id);
          } else {
            const artifact = this.state.get<ArtifactRecord>(`artifact:${value.id}`);
            if (artifact?.state === "ready") {
              artifact.state = "expired";
              const allocation = this.state.get<AllocationRecord>(
                `allocation:${artifact.allocation.allocationId}`,
              );
              if (allocation) {
                allocation.pins = Math.max(0, allocation.pins - 1);
                this.state.put(`allocation:${artifact.allocation.allocationId}`, allocation);
              }
              this.state.put(`artifact:${value.id}`, artifact);
            }
          }
          this.state.delete(key);
        }
        return this.state.page<DueRecord>("due:", "", 1)[0]?.value.at;
      }),
    );
    if (next !== undefined) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, next));
  }
  private async maintain(ctx: D.AuthContext): Promise<void> {
    const candidate = await this.mutex.run(() => {
      const after = this.state.get<string>("gc-cursor") ?? "";
      const rows = this.state.page<AllocationRecord>(
        "allocation:",
        after,
        Math.min(100, this.policy.bounds.sqlPageRows),
      );
      const eligible = rows.find(
        ({ value }) =>
          !value.referenced &&
          value.pins === 0 &&
          !this.execution.pins(value.state.allocation) &&
          value.state.state !== "deleted" &&
          value.state.allocation.deadline + 60_000 <= Date.now(),
      );
      if (rows.length === Math.min(100, this.policy.bounds.sqlPageRows))
        this.state.put("gc-cursor", rows.at(-1)?.key);
      else this.state.delete("gc-cursor");
      return eligible?.value;
    });
    if (!candidate) return;
    const retirement = await this.retireStore(ctx, lookup(candidate.state.allocation));
    if (retirement.ok) await this.deleteStore(ctx, retirement.value);
  }
  private authorizedBytes(
    ctx: D.AuthContext,
    action: string,
    stream: ReadableStream<Uint8Array>,
    artifact?: ArtifactRecord,
  ): ReadableStream<Uint8Array> {
    const reader = stream.getReader();
    let closed = false;
    const finish = async () => {
      if (!closed) {
        closed = true;
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    };
    return new ReadableStream({
      pull: async (controller) => {
        try {
          await this.mutex.run(() =>
            authorize(this.state, ctx, this.current().workspaceId, action),
          );
          const next = await reader.read();
          await this.mutex.run(() => {
            authorize(this.state, ctx, this.current().workspaceId, action);
            if (artifact) this.authorizeArtifact(ctx, artifact);
            if (!next.done) controller.enqueue(next.value);
          });
          if (next.done) {
            await finish();
            controller.close();
          }
        } catch (error) {
          await finish();
          controller.error(error);
        }
      },
      cancel: finish,
    });
  }
  private authorizeArtifact(ctx: D.AuthContext, artifact: ArtifactRecord): void {
    authorize(this.state, ctx, artifact.reference.workspaceId, "artifacts.read");
    requireThat(
      artifact.state === "ready" && artifact.expiresAt > Date.now(),
      "not_found",
      "Artifact unavailable",
    );
    requireThat(
      ctx.grants.some(
        (grant) =>
          (grant.expiresAt === undefined || grant.expiresAt > Date.now()) &&
          permitsResource(grant.resources.workspaceIds, artifact.reference.workspaceId) &&
          permitsResource(grant.resources.actions, "artifacts.read") &&
          permitsResource(grant.resources.agentIds, artifact.agentId) &&
          permitsResource(grant.resources.conversationIds, artifact.conversationId),
      ),
      "unauthorized",
      "Job output owner grant required",
    );
  }
  private async artifactRegistry(envelope: InternalContext): Promise<AllocationRecord> {
    const observation = await this.stub(envelope.allocation.authorityId).describeStore(
      envelope.auth,
      lookup(envelope.allocation),
    );
    if (observation.ok) return { state: observation.value, referenced: false, pins: 0 };
    requireThat(observation.code === "unauthorized", observation.code, observation.message);
    const response = await this.stub(envelope.allocation.authorityId).fetch(
      new Request("https://workspace.internal/__fortipi/store/artifact-read", {
        method: "POST",
        headers: { [internalHeader]: JSON.stringify(envelope) },
      }),
    );
    requireThat(response.ok, "unauthorized", "Output member authority required");
    return { state: await response.json<D.StoreState>(), referenced: false, pins: 0 };
  }
  private async exportRegistry(envelope: InternalContext): Promise<AllocationRecord> {
    const response = await this.stub(envelope.allocation.authorityId).fetch(
      new Request("https://workspace.internal/__fortipi/store/read", {
        method: "POST",
        headers: { [internalHeader]: JSON.stringify(envelope) },
      }),
    );
    requireThat(response.ok, "unauthorized", "Retained export member authority required");
    return { state: await response.json<D.StoreState>(), referenced: true, pins: 0 };
  }
  private async nativeArtifact(
    request: Request,
    auth: D.AuthContext,
    workspaceId: string,
    artifactId: string,
  ): Promise<Response> {
    requireThat(request.method === "GET", "invalid_request", "Artifact reads require GET");
    const incoming = new URL(request.url);
    const url = new URL(`https://control.internal/internal/artifacts/${workspaceId}/${artifactId}`);
    for (const key of ["revision", "range[start]", "range[end]"])
      for (const value of incoming.searchParams.getAll(key)) url.searchParams.append(key, value);
    const headers = new Headers({ "X-Fortipi-Context": JSON.stringify(auth) });
    const range = request.headers.get("Range");
    if (range) headers.set("Range", range);
    // CP owns the immutable native result index and performs current job/resource/floor checks.
    // No historical job credential/lease is reconstructed here and no artifact bytes are retained.
    const response = await this.control().fetch(
      new Request(url, { headers, signal: request.signal }),
    );
    const exposed = new Headers({ "Cache-Control": "no-store" });
    for (const key of [
      "Content-Type",
      "Content-Length",
      "Content-Range",
      "X-Content-SHA256",
      "Retry-After",
    ])
      if (response.headers.has(key)) exposed.set(key, response.headers.get(key) ?? "");
    const maximum = response.ok
      ? Math.min(this.policy.bounds.artifactBytes, wireLimits.artifactBytes)
      : wireLimits.jsonBytes;
    const declared = response.headers.get("Content-Length");
    const size = declared !== null && /^\d+$/.test(declared) ? Number(declared) : undefined;
    try {
      requireThat(
        size === undefined || (Number.isSafeInteger(size) && size <= maximum),
        "payload_too_large",
        "Artifact response exceeds the reader bound",
      );
      if (response.ok)
        requireThat(
          (response.status === 200 || response.status === 206) &&
            size !== undefined &&
            /^[a-f0-9]{64}$/.test(response.headers.get("X-Content-SHA256") ?? "") &&
            response.body,
          "interrupted",
          "Artifact response metadata missing",
        );
    } catch (error) {
      await response.body?.cancel().catch(() => {});
      throw error;
    }
    const body = response.body
      ? this.authorizedBytes(
          auth,
          "artifacts.read",
          limitedStream(response.body, size ?? maximum, auth.deadline, size !== undefined),
        )
      : null;
    return new Response(body && size !== undefined ? fixedLengthStream(body, size) : body, {
      status: response.status,
      headers: exposed,
    });
  }
  private async transferRequest(request: Request, auth: D.AuthContext): Promise<Response> {
    const action = new URL(request.url).pathname.split("/").at(-1);
    if (action === "materialize") {
      const plan = await boundedJson<D.SnapshotPlan>(request);
      await this.authority(auth, plan.workspaceId, "workspace.write");
      const record = await this.mutex.run(() => {
        const id = this.state.get<string>(`allocation-child:${plan.scratchId}`);
        const row = this.state.get<AllocationRecord>(`allocation:${id}`);
        requireThat(
          row &&
            row.state.allocation.role === "scratch" &&
            row.state.allocation.baseRevision === plan.revision &&
            row.state.state !== "retiring" &&
            row.state.state !== "deleted",
          "conflict",
          "Scratch allocation mismatch",
        );
        return row;
      });
      const revision = this.revision(plan.revision);
      requireThat(
        (await manifestDigest(plan.manifest)) === revision.manifestHash &&
          plan.deadline > Date.now(),
        "conflict",
        "Snapshot identity mismatch",
      );
      unwrap(
        await this.stub(record.state.allocation.childId).initializeStore(
          auth,
          record.state.allocation,
        ),
      );
      for (const entry of revision.manifest.entries) {
        const response = await this.childFetch(auth, record.state.allocation, "/materialize", {
          method: "PUT",
          entry,
          ...(entry.type === "file" ? { body: await this.readStored(auth, revision, entry) } : {}),
        });
        requireThat(response.ok, "interrupted", "Materialization incomplete");
      }
      return Response.json({
        scratchId: plan.scratchId,
        workspaceId: plan.workspaceId,
        revision: plan.revision,
      } satisfies D.ScratchHandle);
    }
    if (action === "abort") {
      const input = await boundedJson<D.UploadLookup>(request);
      unwrap(
        await this.abortUpload(auth, {
          operationId: "abortUpload",
          path: input,
          query: {},
          body: undefined,
        }),
      );
      const row = this.upload(auth, input.workspaceId, input.uploadId, false);
      const retirement = unwrap(await this.retireStore(auth, lookup(row.allocation)));
      return Response.json(unwrap(await this.deleteStore(auth, retirement)));
    }
    requireThat(
      action === "upload" || action === "upload-stream",
      "not_found",
      "Transfer action absent",
    );
    const input =
      action === "upload"
        ? await boundedJson<D.ScratchResult>(request)
        : (JSON.parse(request.headers.get("x-fortipi-upload") ?? "null") as D.UploadLookup);
    requireThat(input, "invalid_request", "Upload scope required");
    const workspaceId = "scratch" in input ? input.scratch.workspaceId : input.workspaceId;
    const row = this.upload(auth, workspaceId, input.uploadId);
    if ("scratch" in input) {
      requireThat(
        input.lease.leaseId === row.request.lease.leaseId &&
          input.commitId === row.request.commitId &&
          (await manifestDigest(input.manifest)) === row.status.manifestHash,
        "conflict",
        "Scratch result scope mismatch",
      );
      const allocationId = this.state.get<string>(`allocation-child:${input.scratch.scratchId}`);
      const scratch = this.state.get<AllocationRecord>(`allocation:${allocationId}`);
      requireThat(
        scratch &&
          scratch.state.allocation.role === "scratch" &&
          scratch.state.allocation.workspaceId === workspaceId &&
          scratch.state.allocation.baseRevision === input.scratch.revision,
        "unauthorized",
        "Scratch membership required",
      );
      for (const entry of row.request.manifest.entries)
        if (
          entry.type === "file" &&
          row.request.mutations.some(
            (mutation) => mutation.kind === "put" && mutation.sha256 === entry.sha256,
          )
        ) {
          const source = await this.childFetch(auth, scratch.state.allocation, "/scratch-read", {
            entry,
          });
          requireThat(source.ok && source.body, "interrupted", "Scratch bytes unavailable");
          const written = await this.childFetch(auth, row.allocation, "/blob", {
            method: "PUT",
            entry,
            body: source.body,
          });
          requireThat(written.ok, "interrupted", "Scratch upload failed");
        }
    } else {
      // Same-process stream format: concatenated changed files in manifest order, exact declared lengths.
      requireThat(request.body, "invalid_request", "Upload stream required");
      const reader = request.body.getReader();
      let pending = new Uint8Array(0);
      try {
        for (const entry of row.request.manifest.entries)
          if (
            entry.type === "file" &&
            row.request.mutations.some(
              (mutation) => mutation.kind === "put" && mutation.sha256 === entry.sha256,
            )
          ) {
            let remaining = entry.size;
            const stream = new ReadableStream<Uint8Array>({
              pull: async (controller) => {
                if (remaining === 0) {
                  controller.close();
                  return;
                }
                if (pending.length === 0) {
                  const next = await reader.read();
                  requireThat(!next.done, "invalid_request", "Truncated upload stream");
                  pending = next.value;
                }
                const count = Math.min(remaining, pending.length, chunkBytes);
                controller.enqueue(pending.slice(0, count));
                pending = pending.slice(count);
                remaining -= count;
              },
            });
            const response = await this.childFetch(auth, row.allocation, "/blob", {
              method: "PUT",
              entry,
              body: stream,
            });
            requireThat(
              response.ok && remaining === 0,
              "interrupted",
              "Streamed file validation failed",
            );
          }
        requireThat(
          pending.length === 0 && (await reader.read()).done,
          "invalid_request",
          "Trailing upload bytes",
        );
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
    const validated = unwrap(
      await this.validateUpload(auth, {
        operationId: "validateUpload",
        path: { workspaceId, uploadId: input.uploadId },
        query: {},
        body: undefined,
      }),
    );
    requireThat(validated.status === 200, "interrupted", "Stage not validated");
    const stage = this.upload(auth, workspaceId, input.uploadId).stage;
    requireThat(stage, "interrupted", "Seal evidence missing");
    return Response.json({
      uploadId: input.uploadId,
      manifestHash: stage.manifestHash,
      store: stage,
    } satisfies D.ValidatedStage);
  }
}
function awaitlessSorted(manifest: D.Manifest): D.Manifest {
  return {
    version: 1,
    entries: [...manifest.entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
}
function uploadEntries(request: D.UploadBegin): Extract<D.ManifestEntry, { type: "file" }>[] {
  const entries = new Map<string, Extract<D.ManifestEntry, { type: "file" }>>();
  for (const mutation of request.mutations)
    if (mutation.kind === "put") {
      const previous = entries.get(mutation.sha256);
      requireThat(
        !previous || previous.size === mutation.size,
        "invalid_request",
        "Conflicting upload sizes for one hash",
      );
      if (!previous)
        entries.set(mutation.sha256, {
          type: "file",
          path: mutation.path,
          mode: mutation.mode,
          size: mutation.size,
          sha256: mutation.sha256,
        });
    }
  return [...entries.values()];
}
function uploadGrid(request: D.UploadBegin, hash: string): number {
  return request.blobs?.find((blob) => blob.sha256 === hash)?.chunks.chunkBytes ?? chunkBytes;
}
function uploadStorageBytes(request: D.UploadBegin): number {
  const hashes = new Set(
    request.manifest.entries.filter((entry) => entry.type === "file").map((entry) => entry.sha256),
  );
  return (
    snapshotBytes(request.manifest) +
    uploadEntries(request)
      .filter((entry) => !hashes.has(entry.sha256))
      .reduce((total, entry) => total + entry.size, 0)
  );
}
function checkedRange(start: number, end: number, size: number): { start: number; end: number } {
  requireThat(
    Number.isSafeInteger(start) &&
      Number.isSafeInteger(end) &&
      start >= 0 &&
      end >= start &&
      end < size,
    "range_not_satisfiable",
    "Range outside committed file",
  );
  return { start, end };
}
async function byteResponse(
  request: Request,
  size: number,
  sha256: string,
  deadline: number,
  open: () => Promise<ReadableStream<Uint8Array>>,
): Promise<Response> {
  const range = requestRange(request, size);
  const length = range ? range.end - range.start + 1 : size;
  const hash = range
    ? await hashStream(sliceStream(await open(), range.start, length), length, deadline)
    : sha256;
  const stream = await open();
  return new Response(
    fixedLengthStream(range ? sliceStream(stream, range.start, length) : stream, length),
    {
      status: range ? 206 : 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(length),
        "X-Content-SHA256": hash,
        "Cache-Control": "no-store",
        ...(range ? { "Content-Range": `bytes ${range.start}-${range.end}/${size}` } : {}),
      },
    },
  );
}
function requestRange(request: Request, size: number): { start: number; end: number } | undefined {
  const url = new URL(request.url);
  const start = url.searchParams.get("range[start]");
  const end = url.searchParams.get("range[end]");
  let query: { start: number; end: number } | undefined;
  if (start !== null || end !== null) {
    requireThat(
      start !== null && /^\d+$/.test(start) && (end === null || /^\d+$/.test(end)),
      "invalid_request",
      "Invalid range query",
    );
    query = checkedRange(Number(start), end === null ? size - 1 : Number(end), size);
  }
  const header = request.headers.get("Range");
  if (!header) return query;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  requireThat(
    match && (match[1] || match[2]),
    "range_not_satisfiable",
    "A single byte range is required",
  );
  const range = checkedRange(
    match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2])),
    match[1] && match[2] ? Number(match[2]) : size - 1,
    size,
  );
  requireThat(!query || same(query, range), "invalid_request", "Header and query range disagree");
  return range;
}
export async function boundedJson<T>(
  request: Request,
  maximum: number = wireLimits.jsonBytes,
): Promise<T> {
  requireThat(request.body, "invalid_request", "Missing request body");
  const reader = request.body.getReader();
  const timer = setTimeout(() => {
    void reader.cancel();
  }, 30_000);
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      requireThat(length <= maximum, "payload_too_large", "Metadata too large");
      parts.push(next.value);
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) as T;
}

function dueKey(at: number, kind: string, id: string): string {
  return `due:${String(at).padStart(16, "0")}:${kind}:${id}`;
}
