import type * as D from "../boundary/dto.js";
import { contains, emptyScope, requireGrant } from "./authorization.js";
import type { Directory } from "./directory.js";
import type { Identities } from "./identity.js";
import { queueRepairResume } from "./repair.js";
import { ControlError, check, id, ref, type Store, same } from "./store.js";

interface Counters {
  reserved: number;
  consumed: number;
  slots: number;
}
interface Reservation {
  reservation: D.CapacityReservation;
  principal: string;
  workspaceId?: string;
  agentAuthority?: {
    registrationId: string;
    agentId: string;
    action: string;
    grantId: string;
    grantVersion: number;
  };
  settlement?: { disposition: "consumed" | "unused"; observedBytes?: number };
}
export class Capacity {
  private requestWindow = -1;
  private installRequests = 0;
  private applicationRequests = 0;
  private repairRequests = 0;
  private principalRequests = new Map<string, number>();
  readonly store: Store;
  readonly identities: Identities;
  readonly directory: Directory;
  constructor(store: Store, identities: Identities, directory: Directory) {
    this.store = store;
    this.identities = identities;
    this.directory = directory;
  }
  usage(): Counters {
    return (
      this.store.get<Counters>("capacity", "counters") ?? { reserved: 0, consumed: 0, slots: 0 }
    );
  }
  pressure(): D.InfrastructurePressure[] {
    const usage = this.usage();
    const policy = this.directory.policy();
    const bytes = this.store.storage.sql.databaseSize;
    const pressure: D.InfrastructurePressure[] = [];
    const installLimit = Math.floor(
      policy.bounds.installBytes * (1 - policy.bounds.headroomFraction),
    );
    if (
      usage.reserved + usage.consumed + bytes >= installLimit ||
      bytes >= this.store.admissionBytes
    )
      pressure.push({
        resource: "storage",
        scope: { kind: "install" },
        source: "policy",
        measurement: "estimated",
        limit: installLimit,
        remaining: Math.max(0, installLimit - usage.reserved - usage.consumed - bytes),
        reason: "Outstanding reservations and observed local storage reach admission headroom",
        action: "reclaim-storage",
      });
    if (usage.slots >= policy.bounds.activeMutatingJobs)
      pressure.push({
        resource: "concurrency",
        scope: { kind: "install" },
        source: "policy",
        measurement: "observed",
        limit: policy.bounds.activeMutatingJobs,
        remaining: Math.max(0, policy.bounds.activeMutatingJobs - usage.slots),
        reason: "Outstanding mutation claims occupy configured slots",
        action: "retry-later",
      });
    const overdue = this.store.storage.sql
      .exec<{ n: number }>(
        "SELECT 1 n FROM cp_records WHERE due<? AND kind IN ('fanout','inbox','fact','binding_request','command') LIMIT 1",
        Date.now() - 60000,
      )
      .toArray().length;
    if (overdue > 0)
      pressure.push({
        resource: "sql",
        scope: { kind: "object", id: this.identities.deploymentId },
        source: "policy",
        measurement: "observed",
        reason: "Durable repair work remains overdue; pending acknowledgments are not complete",
        action: "retry-later",
      });
    const paused = this.store.page<{ pressure: D.InfrastructurePressure }>("repair_hold", 0, 1)[0]
      ?.value;
    if (paused) pressure.push(paused.pressure);
    return pressure;
  }
  private requestMinute(): void {
    const window = Math.floor(Date.now() / 60000);
    if (this.requestWindow !== window) {
      this.requestWindow = window;
      this.installRequests = 0;
      this.applicationRequests = 0;
      this.repairRequests = 0;
      this.principalRequests.clear();
    }
  }
  admitRepair(): void {
    this.requestMinute();
    const bounds = this.directory.policy().bounds;
    check(
      this.repairRequests <
        Math.max(1, Math.floor(bounds.requestsPerInstallMinute * bounds.headroomFraction)) &&
        this.installRequests < bounds.requestsPerInstallMinute,
      "rate_limited",
      "Repair request window exhausted",
    );
    this.installRequests++;
    this.repairRequests++;
  }
  admitRequest(principalId: string): void {
    this.requestMinute();
    const bounds = this.directory.policy().bounds;
    const used = this.principalRequests.get(principalId) ?? 0;
    check(
      this.installRequests < bounds.requestsPerInstallMinute &&
        this.applicationRequests <
          Math.floor(bounds.requestsPerInstallMinute * (1 - bounds.headroomFraction)) &&
        used < bounds.requestsPerPrincipalMinute &&
        (this.principalRequests.has(principalId) || this.principalRequests.size < 1000),
      "rate_limited",
      "Control request admission rate exceeded",
    );
    this.installRequests++;
    this.applicationRequests++;
    this.principalRequests.set(principalId, used + 1);
  }
  private workspaceAuthority(ctx: D.AuthContext, workspaceId: string): boolean {
    const registration = this.store.get<D.AuthorityRegistration>(
      "recipient",
      ctx.registrationId ?? "",
    );
    if (registration?.recipient.kind !== "workspace" || registration.recipient.id !== workspaceId)
      return false;
    check(
      same(registration.credential, ref(ctx)),
      "unauthorized",
      "Capacity registration credential changed",
    );
    const resources = {
      ...emptyScope(),
      workspaceIds: [workspaceId],
      executorIds: registration.executor ? [registration.executor.executorId] : [],
      actions: ["workspace.write"],
    };
    requireGrant(ctx, "workspace.write", resources);
    check(
      contains(registration.resources, { ...resources, actions: [] }),
      "unauthorized",
      "Capacity registration lacks workspace authority",
    );
    check(
      this.store.get("binding", workspaceId) || this.store.get("binding_pending", workspaceId),
      "not_found",
      "Capacity workspace is unknown",
    );
    return true;
  }
  private agentAuthority(
    ctx: D.AuthContext,
    ownerId: string,
    admissionSlots: number,
  ): Reservation["agentAuthority"] {
    const authority = this.directory.registeredOperation(ctx);
    if (!authority) return undefined;
    const { registration, action, grant } = authority;
    const agentId = registration.recipient.id;
    const expectedOwner =
      action === "conversations.create" || action === "conversations.fork"
        ? agentId
        : registration.resources.conversationIds[0];
    const expectedSlots =
      action === "conversations.create" || action === "conversations.fork" ? 0 : 1;
    if (expectedOwner !== ownerId || admissionSlots !== expectedSlots) return undefined;
    return {
      registrationId: registration.registrationId,
      agentId,
      action,
      grantId: grant.grantId,
      grantVersion: grant.version,
    };
  }
  private settlement(
    ctx: D.AuthContext,
    input: {
      reservationId: string;
      disposition: "consumed" | "unused";
      observedBytes?: number;
    },
  ): Reservation {
    this.identities.current(ctx);
    const row = this.store.get<Reservation>("capacity_reservation", input.reservationId);
    check(row && row.principal === ctx.principalId, "not_found", "Reservation unavailable");
    if (row.workspaceId)
      check(
        this.workspaceAuthority(ctx, row.workspaceId),
        "unauthorized",
        "Capacity settlement requires its workspace registration",
      );
    else if (row.agentAuthority)
      check(
        same(
          this.agentAuthority(ctx, row.reservation.ownerId, row.reservation.admissionSlots),
          row.agentAuthority,
        ),
        "unauthorized",
        "Capacity settlement requires its original current Agent operation",
      );
    else requireGrant(ctx, "capacity.settle");
    const settlement = {
      disposition: input.disposition,
      ...(input.observedBytes === undefined ? {} : { observedBytes: input.observedBytes }),
    };
    if (row.settlement) check(same(row.settlement, settlement), "conflict", "Settlement changed");
    check(
      input.observedBytes !== undefined &&
        Number.isSafeInteger(input.observedBytes) &&
        input.observedBytes >= 0 &&
        input.observedBytes <= row.reservation.bytes,
      "invalid_request",
      "Settlement requires authoritative measured bytes",
    );
    check(
      input.disposition !== "unused" || input.observedBytes === 0,
      "conflict",
      "Unused capacity still holds bytes",
    );
    return row;
  }
  admitSettlement(
    ctx: D.AuthContext,
    input: {
      reservationId: string;
      disposition: "consumed" | "unused";
      observedBytes?: number;
    },
  ): void {
    let completion = false;
    try {
      const row = this.settlement(ctx, input);
      completion = row.workspaceId !== undefined || row.agentAuthority !== undefined;
    } catch (error) {
      if (!(error instanceof ControlError)) throw error;
    }
    // Each actual RPC, including idempotent retries, spends an install request.
    // Only an authenticated retained completion can use existing repair headroom.
    if (completion) this.admitRepair();
    else this.admitRequest(ctx.principalId);
  }
  reserve(
    ctx: D.AuthContext,
    input: {
      operationId: string;
      ownerId: string;
      policyVersion: number;
      bytes: number;
      admissionSlots: number;
    },
  ): D.CapacityReservation {
    this.identities.current(ctx);
    const workspace = input.admissionSlots === 0 && this.workspaceAuthority(ctx, input.ownerId);
    const agentAuthority = workspace
      ? undefined
      : this.agentAuthority(ctx, input.ownerId, input.admissionSlots);
    if (!workspace && !agentAuthority) requireGrant(ctx, "capacity.reserve");
    check(
      [input.bytes, input.admissionSlots].every((n) => Number.isSafeInteger(n) && n >= 0),
      "invalid_request",
      "Invalid reservation amount",
    );
    return this.store.tx(() => {
      this.identities.current(ctx);
      const key = `${ctx.principalId}:${input.operationId}:${input.ownerId}`;
      const old = this.store.get<Reservation>("capacity_request", key);
      if (old) {
        if (old.agentAuthority)
          check(
            same(old.agentAuthority, agentAuthority),
            "unauthorized",
            "Reservation operation authority changed",
          );
        check(
          same(
            {
              ...input,
              reservationId: old.reservation.reservationId,
              state: old.reservation.state,
            },
            old.reservation,
          ),
          "conflict",
          "Reservation request changed",
        );
        return old.reservation;
      }
      const policy = this.directory.policy();
      check(input.policyVersion === policy.version, "conflict", "Policy version changed");
      const totals = this.usage();
      const storage = this.store.storage.sql.databaseSize;
      check(
        totals.reserved + totals.consumed + storage + input.bytes <=
          Math.floor(policy.bounds.installBytes * (1 - policy.bounds.headroomFraction)) &&
          storage <= policy.bounds.objectBytes * (1 - policy.bounds.headroomFraction),
        "quota_exceeded",
        "Reserved storage exhausted",
      );
      check(
        totals.slots + input.admissionSlots <= policy.bounds.activeMutatingJobs,
        "quota_exceeded",
        "Active mutation capacity exhausted",
        {
          retryAfterMs: 5000,
          pressure: {
            resource: "concurrency",
            scope: { kind: "install" },
            source: "policy",
            measurement: "observed",
            limit: policy.bounds.activeMutatingJobs,
            remaining: Math.max(0, policy.bounds.activeMutatingJobs - totals.slots),
            reason: "Outstanding mutation claims consume the configured slots",
            action: "retry-later",
          },
        },
      );
      const reservation: D.CapacityReservation = {
        ...input,
        reservationId: id(),
        state: "reserved",
      };
      const row: Reservation = {
        reservation,
        principal: ctx.principalId,
        ...(workspace ? { workspaceId: input.ownerId } : {}),
        ...(agentAuthority ? { agentAuthority } : {}),
      };
      this.store.put("capacity_request", key, row);
      this.store.put("capacity_reservation", reservation.reservationId, row);
      this.store.put("capacity", "counters", {
        ...totals,
        reserved: totals.reserved + input.bytes,
        slots: totals.slots + input.admissionSlots,
      });
      return reservation;
    });
  }
  settle(
    ctx: D.AuthContext,
    input: { reservationId: string; disposition: "consumed" | "unused"; observedBytes?: number },
  ): D.CapacityReservation {
    this.identities.current(ctx);
    return this.store.tx(() => {
      const row = this.settlement(ctx, input);
      const settlement = {
        disposition: input.disposition,
        ...(input.observedBytes === undefined ? {} : { observedBytes: input.observedBytes }),
      };
      if (row.settlement) {
        check(same(row.settlement, settlement), "conflict", "Settlement changed");
        return row.reservation;
      }
      check(input.observedBytes !== undefined, "invalid_request", "Measured bytes required");
      const totals = this.usage();
      const reservation = { ...row.reservation, state: "settled" as const };
      const updated = { ...row, reservation, settlement };
      this.store.put("capacity_reservation", input.reservationId, updated);
      this.store.put(
        "capacity_request",
        `${row.principal}:${reservation.operationId}:${reservation.ownerId}`,
        updated,
      );
      this.store.put("capacity", "counters", {
        reserved: totals.reserved - reservation.bytes,
        consumed: totals.consumed + input.observedBytes,
        slots: totals.slots - reservation.admissionSlots,
      });
      if (input.observedBytes < reservation.bytes) queueRepairResume(this.store, "reclaimed");
      return reservation;
    });
  }
}
