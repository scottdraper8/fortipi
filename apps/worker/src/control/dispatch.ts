import { operationForAssignment, validateAssignment, workspaceLeaseDigest } from "fortipi-contract";
import type * as D from "../boundary/dto.js";
import { contains, emptyScope, requireGrant } from "./authorization.js";
import { type Directory, valid } from "./directory.js";
import type { Executors } from "./executors.js";
import type { Identities } from "./identity.js";
import { ControlError, check, id, ref, type Store, same } from "./store.js";
import type { ExecutorState, Tickets } from "./tickets.js";

export interface DispatchRecord {
  intent: D.DispatchIntent;
  receipt: D.DispatchReceipt;
  attempted: boolean;
  observation?: D.ExecutionObservation;
  cancel?: { requestId: string; reason: string; disposition?: D.CancelDisposition };
}
export function sameExecution(a: D.ExecutionIdentity, b: D.ExecutionIdentity): boolean {
  const stable = (value: D.ExecutionIdentity): unknown => {
    const { leaseVersion: _version, expiresAt: _expiry, ...lease } = value.lease;
    return { ...value, lease };
  };
  return same(stable(a), stable(b));
}
export class Dispatch {
  readonly store: Store;
  readonly identities: Identities;
  readonly tickets: Tickets;
  readonly executors: Executors;
  readonly directory: Directory;
  constructor(
    store: Store,
    identities: Identities,
    tickets: Tickets,
    executors: Executors,
    directory: Directory,
  ) {
    this.store = store;
    this.identities = identities;
    this.tickets = tickets;
    this.executors = executors;
    this.directory = directory;
  }
  async reserve(ctx: D.AuthContext, input: D.TargetRequest): Promise<D.TargetReservation> {
    this.identities.current(ctx);
    if (input.ownerKind === "workspace-operation")
      check(
        input.operationDigest ===
          (await workspaceLeaseDigest({
            deploymentId: ctx.deploymentId,
            operationId: input.operationId,
            workspaceId: input.workspaceId,
            bindingVersion: input.bindingVersion,
            baseRevision: input.baseRevision,
            target: input.target,
            credential: ref(ctx),
            deadline: input.deadline,
          })),
        "conflict",
        "Workspace lease operation digest mismatch",
      );
    const resources = {
      ...emptyScope(),
      workspaceIds: [input.workspaceId],
      agentIds: input.agentId ? [input.agentId] : [],
      conversationIds: input.conversationId ? [input.conversationId] : [],
      actions: input.actions,
      ...(input.target.kind === "executor"
        ? { executorIds: [input.target.executorId] }
        : {
            backendIds: input.ownerKind === "workspace-operation" ? [] : [input.target.backendId],
          }),
    };
    check(input.actions.length > 0, "invalid_request", "Reservation needs explicit actions");
    for (const action of input.actions) requireGrant(ctx, action, resources);
    const covering = ctx.grants.find(
      (grant) =>
        (grant.expiresAt === undefined || grant.expiresAt > Date.now()) &&
        contains(grant.resources, resources),
    );
    check(
      covering &&
        input.expiresAt <=
          Math.min(
            ctx.credentialExpiresAt ?? Number.MAX_SAFE_INTEGER,
            covering.expiresAt ?? Number.MAX_SAFE_INTEGER,
          ),
      "unauthorized",
      "Reservation outlives current authority",
    );
    return this.store.tx(() => {
      this.identities.current(ctx);
      const key = `${ctx.principalId}:${input.operationId}`;
      if (input.target.kind === "executor") {
        const e = this.store.get<ExecutorState>("executor", input.target.executorId);
        check(
          e && e.generation === input.target.generation && e.status !== "revoked",
          "conflict",
          "Executor generation changed",
        );
      }
      const old = this.store.get<D.TargetReservation>("reservation", key);
      if (old) {
        const { reservationId: _id, credential: _c, registrationIds: _r, ...request } = old;
        check(same(request, input), "conflict", "Target reservation changed");
        check(same(old.credential, ref(ctx)), "unauthorized", "Reservation credential changed");
        return old;
      }
      check(
        input.expiresAt > Date.now() &&
          input.expiresAt <= Date.now() + 30000 &&
          input.expiresAt <= input.deadline &&
          input.deadline <= Date.now() + 86400000,
        "invalid_request",
        "Invalid reservation deadline",
      );
      if (input.ownerKind === "workspace-operation") {
        requireGrant(ctx, "workspace.write", resources);
        const binding = this.store.get<D.WorkspaceBinding>("binding", input.workspaceId);
        check(
          binding && binding.bindingVersion === input.bindingVersion,
          "conflict",
          "Workspace binding changed",
        );
        check(
          binding.config.kind === "local"
            ? input.target.kind === "executor" &&
                input.target.executorId === binding.config.executorId
            : input.target.kind === "backend" &&
                input.target.backendId === binding.workspaceId &&
                input.target.generation === binding.bindingVersion,
          "conflict",
          "Workspace operation target does not match its storage authority",
        );
      }
      const executor =
        input.target.kind === "executor"
          ? { executorId: input.target.executorId, generation: input.target.generation }
          : undefined;
      const registration = { credential: ref(ctx), resources, ...(executor ? { executor } : {}) };
      const workspace = this.tickets.register(ctx, {
        ...registration,
        recipient: { kind: "workspace", id: input.workspaceId },
      }).registrationId;
      const agent = input.agentId
        ? this.tickets.register(ctx, {
            ...registration,
            recipient: { kind: "agent", id: input.agentId },
          }).registrationId
        : undefined;
      const reservation =
        input.ownerKind === "job"
          ? {
              ...input,
              reservationId: id(),
              credential: ref(ctx),
              registrationIds: { workspace, agent: agent ?? "" },
            }
          : {
              ...input,
              reservationId: id(),
              credential: ref(ctx),
              registrationIds: { workspace, ...(agent ? { agent } : {}) },
            };
      this.store.put("reservation", key, reservation);
      this.store.put("reservation_id", reservation.reservationId, reservation, key);
      return reservation;
    });
  }
  async intent(ctx: D.AuthContext, input: D.DispatchIntent): Promise<D.DispatchReceipt> {
    this.identities.current(ctx);
    const a = input.assignment;
    const r = input.reservation;
    const identity = a.identity;
    check(valid("executor-messages", "Assignment", a), "invalid_request", "Invalid assignment");
    await validateAssignment(a);
    const op = operationForAssignment(a);
    check(
      new TextEncoder().encode(
        JSON.stringify({ type: "job.assign", requestId: "x".repeat(32), payload: a }),
      ).length <= 1048576,
      "payload_too_large",
      "Assignment frame exceeds transport bound",
    );
    check(
      op.deploymentId === ctx.deploymentId &&
        op.agentId === r.agentId &&
        op.conversationId === r.conversationId &&
        op.grantVersion === ctx.grantVersion &&
        identity.operationDigest === r.operationDigest,
      "conflict",
      "Operation digest mismatch",
    );
    return this.store.tx(() => {
      this.identities.current(ctx);
      check(
        same(this.store.get("reservation_id", r.reservationId), r) && same(r.credential, ref(ctx)),
        "unauthorized",
        "Unknown target reservation",
      );
      if (r.target.kind === "executor") {
        const executor = this.store.get<ExecutorState>("executor", r.target.executorId);
        check(
          executor && executor.status !== "revoked" && executor.generation === r.target.generation,
          "unavailable_executor",
          "Dispatch target generation is no longer current",
        );
      }
      const grantResources = {
        ...emptyScope(),
        workspaceIds: [r.workspaceId],
        agentIds: [r.agentId],
        conversationIds: [r.conversationId],
        tools: [a.tool],
        ...(r.target.kind === "executor"
          ? { executorIds: [r.target.executorId] }
          : { backendIds: [r.target.backendId] }),
      };
      requireGrant(ctx, "jobs.dispatch", grantResources);
      for (const action of r.actions) requireGrant(ctx, action, grantResources);
      check(
        r.ownerKind === "job" &&
          r.jobId === identity.jobId &&
          r.executionId === identity.executionId &&
          r.workspaceId === a.workspaceId &&
          r.bindingVersion === a.bindingVersion &&
          a.reservationId === r.reservationId &&
          same(r.target, identity.target) &&
          identity.lease.operationId === r.operationId &&
          identity.lease.ownerKind === "job" &&
          identity.lease.jobId === r.jobId &&
          same(identity.lease.credential, r.credential) &&
          identity.lease.registrationId === r.registrationIds.workspace &&
          identity.lease.workspaceId === r.workspaceId &&
          identity.lease.baseRevision === identity.baseRevision &&
          identity.deadline <= r.deadline,
        "conflict",
        "Assignment scope mismatch",
      );
      check(
        Date.now() < Math.min(r.expiresAt, identity.lease.expiresAt, identity.deadline),
        "conflict",
        "Dispatch authority expired",
      );
      const old = this.store.get<DispatchRecord>("dispatch", identity.executionId);
      if (old) {
        check(
          old.receipt.assignmentDigest === identity.assignmentDigest,
          "conflict",
          "Execution identity changed",
        );
        return old.receipt;
      }
      const receipt: D.DispatchReceipt = {
        dispatchId: id(),
        jobId: identity.jobId,
        assignmentDigest: identity.assignmentDigest,
        state: "dispatch_attempted",
        persisted: true,
      };
      this.store.put("dispatch", identity.executionId, {
        intent: input,
        receipt,
        attempted: false,
      } satisfies DispatchRecord);
      return receipt;
    });
  }
  record(
    ctx: D.AuthContext,
    identity: D.ExecutionIdentity,
    action: "jobs.read" | "jobs.dispatch" | "jobs.cancel" = "jobs.read",
  ): DispatchRecord {
    this.identities.current(ctx);
    const record = this.store.get<DispatchRecord>("dispatch", identity.executionId);
    check(
      record && sameExecution(record.intent.assignment.identity, identity),
      "conflict",
      "Execution identity mismatch",
    );
    const assignment = record.intent.assignment;
    if (action !== "jobs.read") {
      const credential = record.intent.reservation.credential;
      const owner = this.store.get<import("./identity.js").CredentialRecord>(
        "credential",
        credential.credentialId,
      );
      check(
        owner?.status === "active" &&
          owner.generation === credential.generation &&
          owner.grantVersion === credential.grantVersion &&
          (owner.expiresAt === null || Date.now() < owner.expiresAt),
        "unauthenticated",
        "Execution owner authority is no longer current",
      );
      if (identity.target.kind === "executor") {
        const executor = this.store.get<ExecutorState>("executor", identity.target.executorId);
        check(
          executor &&
            executor.status !== "revoked" &&
            executor.generation === identity.target.generation,
          "unavailable_executor",
          "Execution target generation is no longer current",
        );
      }
    }
    requireGrant(ctx, action, {
      ...emptyScope(),
      agentIds: [record.intent.reservation.agentId],
      conversationIds: [record.intent.reservation.conversationId],
      workspaceIds: [record.intent.reservation.workspaceId],
      tools: [assignment.tool],
      ...(identity.target.kind === "executor"
        ? { executorIds: [identity.target.executorId] }
        : { backendIds: [identity.target.backendId] }),
    });
    return record;
  }
  assign(ctx: D.AuthContext, input: D.Assignment): D.DispatchAck {
    const record = this.record(ctx, input.identity, "jobs.dispatch");
    check(same(record.intent.assignment, input), "conflict", "Assignment changed");
    const identity = input.identity;
    check(
      identity.target.kind === "executor",
      "unsupported",
      "Cloud backend dispatch belongs to workspace",
    );
    const target = identity.target;
    const executor = this.store.get<ExecutorState>("executor", target.executorId);
    const config = this.directory.config();
    if (executor?.description?.confinement === "host")
      check(
        ("execution" in config &&
          config.execution.kind === "native" &&
          config.execution.executorId === target.executorId &&
          config.execution.trust === "host") ||
          input.approval?.trust === "host",
        "unauthorized",
        "Native host execution requires explicit trust",
      );
    if (input.approval) {
      const approval = input.approval;
      check(
        approval.operationDigest === identity.operationDigest &&
          approval.tool === input.tool &&
          same(approval.arguments, input.arguments) &&
          approval.workspaceId === input.workspaceId &&
          approval.baseRevision === identity.baseRevision &&
          same(approval.target, identity.target) &&
          approval.grantVersion === ctx.grantVersion &&
          approval.policyVersion === input.operationContext.policyVersion &&
          approval.expiresAt > Date.now() &&
          (approval.trust !== "isolated" || executor?.description?.confinement === "isolated"),
        "unauthorized",
        "Approval does not authorize this assignment",
      );
    }
    let first = false;
    this.store.tx(() => {
      this.identities.current(ctx);
      const current = this.store.get<DispatchRecord>("dispatch", identity.executionId);
      check(current, "conflict", "Missing dispatch");
      if (current.attempted) return;
      check(
        Date.now() <
          Math.min(
            identity.lease.expiresAt,
            identity.deadline,
            record.intent.reservation.expiresAt,
          ),
        "conflict",
        "Assignment lease expired",
      );
      this.executors.channel(target.executorId, target.generation);
      current.attempted = true;
      this.store.put("dispatch", identity.executionId, current);
      first = true;
    });
    let disposition: D.DispatchAck["disposition"] = first ? "accepted" : "duplicate";
    if (first)
      try {
        this.executors.send(target.executorId, target.generation, {
          type: "job.assign",
          requestId: record.receipt.dispatchId,
          payload: input,
        });
      } catch {
        disposition = "uncertain";
      }
    return {
      identity,
      receipt: { deliveryId: record.receipt.dispatchId, sequence: 0, persisted: true },
      disposition,
    };
  }
  #recoveryRecord(
    ctx: D.AuthContext,
    identity: D.ExecutionIdentity,
    requireAttempted = true,
  ): DispatchRecord {
    check(
      valid("executor-messages", "ExecutorFrame", {
        type: "job.query",
        requestId: ctx.requestId,
        payload: identity,
      }),
      "invalid_request",
      "Invalid execution query",
    );
    const record = this.record(ctx, identity, "jobs.dispatch");
    const reservation = record.intent.reservation;
    const original = record.intent.assignment.identity;
    const currentLease = this.store.get<{ lease: D.Lease }>("lease", original.lease.leaseId)?.lease;
    const registration = this.store.get<D.AuthorityRegistration>(
      "recipient",
      ctx.registrationId ?? "",
    );
    const resources = {
      ...emptyScope(),
      agentIds: [reservation.agentId],
      conversationIds: [reservation.conversationId],
      workspaceIds: [reservation.workspaceId],
      tools: [record.intent.assignment.tool],
      executorIds: identity.target.kind === "executor" ? [identity.target.executorId] : [],
      actions: [...new Set([...reservation.actions, "jobs.dispatch"])],
    };
    requireGrant(ctx, "jobs.dispatch", resources);
    check(
      (!requireAttempted || record.attempted) &&
        identity.target.kind === "executor" &&
        same(reservation.credential, ref(ctx)) &&
        same(this.store.get("reservation_id", reservation.reservationId), reservation) &&
        (same(original, identity) ||
          (currentLease && same({ ...original, lease: currentLease }, identity))) &&
        registration?.recipient.kind === "agent" &&
        registration.recipient.id === reservation.agentId &&
        registration.registrationId === ctx.registrationId &&
        same(registration.credential, ref(ctx)) &&
        contains(registration.resources, {
          ...resources,
          actions: ["jobs.dispatch"],
          // Target reservation precedes the assignment, which supplies the retained tool.
          ...(registration.registrationId === reservation.registrationIds.agent &&
          registration.resources.tools.length === 0
            ? { tools: [] }
            : {}),
        }) &&
        ctx.grants.some(
          (grant) =>
            (grant.expiresAt === undefined || Date.now() < grant.expiresAt) &&
            contains(grant.resources, resources) &&
            contains(grant.resources, registration.resources),
        ),
      "unauthorized",
      "Query requires its current registered execution owner",
    );
    // A command exists only after current Agent/Workspace durable terminal proof.
    // Its retained receipt closes recovery eligibility even if transport ACK is lost.
    const prefix = `${identity.executionId}:job.committed`;
    check(
      this.store.storage.sql
        .exec<{ n: number }>(
          "SELECT 1 n FROM cp_records WHERE kind='command' AND key>=? AND key<? LIMIT 1",
          `${prefix}:`,
          `${prefix};`,
        )
        .toArray().length === 0,
      "conflict",
      "Execution already has durable terminal proof",
    );
    return record;
  }
  completion(ctx: D.AuthContext, identity: D.ExecutionIdentity): boolean {
    try {
      this.#recoveryRecord(ctx, identity);
      return true;
    } catch (error) {
      if (!(error instanceof ControlError)) throw error;
      return false;
    }
  }
  async query(ctx: D.AuthContext, identity: D.ExecutionIdentity): Promise<D.ExecutionObservation> {
    const completion = this.completion(ctx, identity);
    const current = () => {
      if (completion) return this.#recoveryRecord(ctx, identity);
      try {
        // A retained, unsent intent permits its registered owner's query only.
        // completion() still requires an attempt before granting repair capacity.
        return this.#recoveryRecord(ctx, identity, false);
      } catch (error) {
        if (!(error instanceof ControlError)) throw error;
        return this.record(ctx, identity);
      }
    };
    const record = current();
    // No assignment was sent through this authority. Do not ask the executor to
    // attest to an assignment it never received or manufacture a closed ledger.
    if (!record.attempted) return { identity, state: "unknown" };
    if (record.observation?.state === "terminal") return record.observation;
    const late = this.store.page<{ result: D.PreparedResult }>("late_result", 0, 1, {
      subject: identity.executionId,
    })[0]?.value;
    if (late) return { identity, state: "unknown", result: late.result };
    check(identity.target.kind === "executor", "unsupported", "Backend query belongs to workspace");
    let frame: D.ExecutorFrame | undefined;
    try {
      frame = await this.executors.exchange(
        identity.target.executorId,
        identity.target.generation,
        { type: "job.query", requestId: id(), payload: identity },
        ctx.deadline,
      );
    } catch {}
    current();
    if (frame?.type === "job.query_result" && same(frame.payload.identity, identity))
      return frame.payload;
    return { identity, state: "unknown" };
  }
  async cancel(ctx: D.AuthContext, input: D.CancelRequest): Promise<D.CancelDisposition> {
    const record = this.record(ctx, input.identity, "jobs.cancel");
    if (record.cancel) {
      check(
        record.cancel.requestId === input.requestId && record.cancel.reason === input.reason,
        "conflict",
        "Cancellation identity changed",
      );
      if (record.cancel.disposition) return record.cancel.disposition;
    } else
      this.store.put("dispatch", input.identity.executionId, {
        ...record,
        cancel: { requestId: input.requestId, reason: input.reason },
      });
    check(
      input.identity.target.kind === "executor",
      "unsupported",
      "Backend cancellation belongs to workspace",
    );
    try {
      const frame = await this.executors.exchange(
        input.identity.target.executorId,
        input.identity.target.generation,
        {
          type: "job.cancel",
          requestId: input.requestId,
          payload: { identity: input.identity, reason: input.reason },
        },
        ctx.deadline,
      );
      if (frame.type === "job.cancel_ack" && same(frame.payload.identity, input.identity))
        return frame.payload.disposition;
    } catch {}
    return { state: "unknown", possibleExternalEffects: true };
  }
}
