import { publicCommitReceipt } from "fortipi-contract";
import type { Authority } from "../agent/authority.js";
import type { Sql, Store } from "../agent/store.js";
import { check, outcome, same, scope } from "../api/common.js";
import { validate } from "../api/validation.js";
import type * as D from "../boundary/dto.js";
import type { JobStore } from "../boundary/job-store.js";
import { sameExecutionIdentity, sameLeaseIdentity } from "./identity.js";

export interface JobState {
  job: D.Job;
  piTaskId: string;
  capacityReservationId: string;
  capacityRegistrationId?: string;
  auth: D.AuthContext;
  operation: D.ApprovalOperation;
  bindingVersion: number;
  deadline: number;
  rootBindingId?: string;
  reservation?: Extract<D.TargetReservation, { ownerKind: "job" }>;
  assignment?: D.Assignment;
  prepared?: D.PreparedExecution;
  approvalId?: string;
  cancel?: D.TaskControl;
  terminalSeq?: number;
  terminalConsumed?: boolean;
  localPreparation?: D.LocalPrepared;
  localIntent?: D.LocalCommitIntent;
  localRequest?: D.LocalWorkspaceRequest;
  renewal?: D.LeaseRenewal;
  resultLease?: D.Lease;
  standaloneTask?: boolean;
  poll: number;
  baseManifestHash?: string;
  executorEpoch?: number;
  executorTransferLimits?: D.ExecutorTransferLimits;
}
const terminal = new Set<D.JobState>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "expired",
  "requires_reconciliation",
  "workspace_conflict",
]);
export const isTerminal = (job: D.Job): boolean => terminal.has(job.state);
export class Jobs implements JobStore {
  readonly contractVersion = "1.0" as const;
  readonly store: Store;
  readonly authority: Authority;
  constructor(store: Store, authority: Authority) {
    this.store = store;
    this.authority = authority;
  }
  async state(jobId: string, tx?: Sql): Promise<JobState> {
    const state = await this.store.get<JobState>("job", jobId, tx);
    check(state, "not_found", "Job unavailable");
    return state;
  }
  /** Call only with the successful authoritative Workspace renewal response. */
  async retainLease(ctx: D.AuthContext, jobId: string, lease: D.Lease): Promise<void> {
    await this.store.transaction(async (tx) => {
      const state = await this.state(jobId, tx),
        original = state.assignment?.identity.lease;
      check(
        original &&
          sameLeaseIdentity(original, lease) &&
          Number.isSafeInteger(lease.leaseVersion) &&
          lease.leaseVersion > original.leaseVersion &&
          lease.expiresAt > original.expiresAt &&
          lease.expiresAt <= state.deadline,
        "conflict",
        "Renewal changed immutable execution authority",
      );
      await this.authority.current(
        ctx,
        scope({
          agentIds: [state.job.agentId],
          conversationIds: [state.job.conversationId],
          workspaceIds: [state.job.workspaceId],
          tools: [state.operation.tool],
          executorIds:
            state.operation.target.kind === "executor" ? [state.operation.target.executorId] : [],
          backendIds:
            state.operation.target.kind === "backend" ? [state.operation.target.backendId] : [],
          actions: ["jobs.dispatch", "workspace.write"],
        }),
        tx,
      );
      const key = `${jobId}:${lease.leaseVersion}`,
        prior = await this.store.get<D.Lease>("lease-history", key, tx),
        latest = await this.store.get<D.Lease>("lease-observation", jobId, tx);
      check(!prior || same(prior, lease), "conflict", "Renewal version changed");
      await this.store.put("lease-history", key, lease, tx);
      if (!latest || latest.leaseVersion < lease.leaseVersion)
        await this.store.put("lease-observation", jobId, lease, tx);
      else if (latest.leaseVersion === lease.leaseVersion)
        check(same(latest, lease), "conflict", "Renewal observation changed");
    });
  }
  async observationIdentity(state: JobState, tx?: Sql): Promise<D.ExecutionIdentity> {
    const original = state.assignment?.identity;
    check(original, "conflict", "Original execution required");
    const lease = await this.store.get<D.Lease>("lease-observation", state.job.jobId, tx);
    const observed = lease ? { ...original, lease } : original;
    await this.requireObservationIdentity(state, observed, tx);
    return observed;
  }
  async requireObservationIdentity(
    state: JobState,
    observed: D.ExecutionIdentity,
    tx?: Sql,
  ): Promise<void> {
    const original = state.assignment?.identity;
    check(
      original && sameExecutionIdentity(original, observed),
      "conflict",
      "Execution identity changed",
    );
    if (same(original.lease, observed.lease)) return;
    const retained = await this.store.get<D.Lease>(
      "lease-history",
      `${state.job.jobId}:${observed.lease.leaseVersion}`,
      tx,
    );
    check(
      retained && same(retained, observed.lease),
      "conflict",
      "Execution lease was never observed from Workspace",
    );
  }
  async #currentCompletion(ctx: D.AuthContext, state: JobState, tx?: Sql): Promise<void> {
    const owner = (auth: D.AuthContext) => ({
      principalId: auth.principalId,
      role: auth.role,
      deploymentId: auth.deploymentId,
      credentialId: auth.credentialId,
      generation: auth.generation,
      grantVersion: auth.grantVersion,
    });
    check(
      same(owner(ctx), owner(state.auth)) &&
        ctx.registrationId ===
          (state.reservation?.registrationIds.agent ?? state.auth.registrationId),
      "unauthorized",
      "Completion requires its retained registered owner",
    );
    await this.authority.current(
      ctx,
      scope({
        agentIds: [state.job.agentId],
        conversationIds: [state.job.conversationId],
        workspaceIds: [state.job.workspaceId],
        tools: [state.operation.tool],
        executorIds:
          state.operation.target.kind === "executor" ? [state.operation.target.executorId] : [],
        backendIds:
          state.operation.target.kind === "backend" ? [state.operation.target.backendId] : [],
        actions: [
          ...new Set([...(state.reservation?.actions ?? []), "jobs.dispatch", "workspace.write"]),
        ],
      }),
      tx,
    );
  }
  /** Recovery may record failure/uncertainty after expiry; it never grants new work or success. */
  async interrupt(jobId: string, reason: string): Promise<void> {
    await this.store.transaction(async (tx) => {
      const state = await this.state(jobId, tx);
      if (isTerminal(state.job)) return;
      await this.store.put(
        "job-disposition",
        jobId,
        { reason, possibleExternalEffects: !!state.assignment },
        tx,
      );
      await this.update(tx, state, {
        ...state.job,
        state: state.assignment ? "requires_reconciliation" : "expired",
        version: state.job.version + 1,
      } as D.Job);
    });
  }
  event(state: JobState): D.EventDraft {
    return {
      protocolVersion: "1.0",
      schemaVersion: "1.0.0",
      deploymentId: state.auth.deploymentId,
      conversationId: state.job.conversationId,
      durability: "durable",
      jobId: state.job.jobId,
      taskId: state.job.taskId,
      type: "job.state.changed",
      payload: this.public(state.job),
    };
  }
  public(job: D.Job): D.Job {
    const result = structuredClone(job);
    if (result.receipt) result.receipt = publicCommitReceipt(result.receipt);
    if (result.state === "completed" && result.evidence.kind === "committed")
      result.evidence = {
        kind: "committed",
        receipt: publicCommitReceipt(result.evidence.receipt),
      };
    return result;
  }
  async update(tx: Sql, state: JobState, next: D.Job): Promise<void> {
    check(next.version === state.job.version + 1, "conflict", "Job version changed");
    state.job = next;
    const waitReason: D.TaskState | undefined =
      next.state === "awaiting_approval"
        ? { state: "waiting", reason: "human-approval", supportedContinuations: [] }
        : next.state === "waiting_for_executor"
          ? { state: "waiting", reason: "local-device", supportedContinuations: [] }
          : next.state === "waiting_for_local_policy"
            ? { state: "waiting", reason: "local-policy", supportedContinuations: [] }
            : next.state === "workspace_conflict"
              ? {
                  state: "waiting",
                  reason: "workspace-conflict",
                  supportedContinuations: ["next-submit"],
                }
              : next.state === "requires_reconciliation"
                ? {
                    state: "waiting",
                    reason: "reconciliation",
                    supportedContinuations: ["next-submit"],
                  }
                : undefined;
    if (waitReason) await this.store.put("task-wait", next.taskId, waitReason, tx);
    else await this.store.remove("task-wait", next.taskId, tx);
    const task = await this.store.get<D.Task>("task", next.taskId, tx);
    const projected: D.TaskState | undefined =
      waitReason ??
      (["dispatch_attempted", "running", "result_pending_commit"].includes(next.state)
        ? { state: "running" }
        : undefined) ??
      (state.standaloneTask
        ? {
            state:
              next.state === "completed"
                ? "completed"
                : next.state === "cancelled"
                  ? "cancelled"
                  : next.state === "failed"
                    ? "failed"
                    : isTerminal(next)
                      ? "interrupted"
                      : "running",
          }
        : undefined);
    if (task && projected && !same(task.status, projected)) {
      const changed: D.Task = { ...task, status: projected, version: task.version + 1 };
      await this.store.put("task", task.taskId, changed, tx);
      await this.store.append(tx, `task:${task.taskId}:${changed.version}`, {
        ...this.event(state),
        type:
          projected.state === "waiting"
            ? "task.waiting"
            : projected.state === "completed"
              ? "task.completed"
              : projected.state === "running"
                ? "task.running"
                : "task.interrupted",
        payload: changed,
      });
    }
    const draft = this.event(state);
    const ack = await this.store.append(tx, `job:${next.jobId}:${next.version}`, draft);
    if (next.state === "completed") {
      state.terminalSeq = ack.eventSeq;
      const event = {
        ...draft,
        eventSeq: ack.eventSeq,
        eventId: ack.eventId,
        timestamp: Date.now(),
      } as D.KnownDurableEvent;
      // Retain the exact committed envelope, including its stored timestamp.
      const original = await tx.get<{ data: string }>(
        "SELECT data FROM fp_events_v1 WHERE conversation=? AND seq=?",
        next.conversationId,
        ack.eventSeq,
      );
      await this.store.put(
        "terminal-event",
        `${next.conversationId}:${ack.eventSeq}`,
        original ? JSON.parse(original.data) : event,
        tx,
      );
      if (next.execution?.target.kind === "executor" && next.state === "completed") {
        const job = this.public(next) as Extract<D.Job, { state: "completed" }>;
        const proof: D.JobCommitted = {
          identity: next.execution,
          evidence: job.evidence,
          terminalVersion: next.version,
          eventSeq: ack.eventSeq,
        };
        await this.store.put("terminal-notification", next.jobId, proof, tx, Date.now());
      }
    }
    await this.store.put("job", next.jobId, state, tx, isTerminal(next) ? null : Date.now());
    if (isTerminal(next))
      await this.store.put(
        "job-cleanup",
        next.jobId,
        { released: !state.assignment, settled: false },
        tx,
        Date.now(),
      );
  }
  async seed(
    ctx: D.AuthContext,
    seed: D.JobSeed,
    operation: D.ApprovalOperation,
    bindingVersion: number,
    deadline: number,
    initial: Partial<
      Pick<
        JobState,
        "standaloneTask" | "baseManifestHash" | "rootBindingId" | "executorTransferLimits"
      >
    > = {},
  ): Promise<D.Job> {
    return this.store.transaction(async (tx) => {
      const mapping = await this.store.get<{ jobId: string; digest: string }>(
        "job-task",
        seed.piTaskId,
        tx,
      );
      if (mapping) {
        check(
          mapping.digest === seed.job.operationDigest,
          "conflict",
          "Tool task arguments changed",
        );
        return (await this.state(mapping.jobId, tx)).job;
      }
      const state: JobState = {
        ...initial,
        job: seed.job,
        piTaskId: seed.piTaskId,
        capacityReservationId: seed.capacityReservationId,
        ...(ctx.registrationId ? { capacityRegistrationId: ctx.registrationId } : {}),
        auth: ctx,
        operation,
        bindingVersion,
        deadline,
        poll: 0,
      };
      await this.authority.current(
        ctx,
        scope({
          agentIds: [seed.job.agentId],
          conversationIds: [seed.job.conversationId],
          workspaceIds: [seed.job.workspaceId],
          tools: [operation.tool],
          actions: ["jobs.dispatch"],
          ...(operation.target.kind === "executor"
            ? { executorIds: [operation.target.executorId] }
            : { backendIds: [operation.target.backendId] }),
        }),
        tx,
      );
      await this.store.put(
        "job-task",
        seed.piTaskId,
        { jobId: seed.job.jobId, digest: seed.job.operationDigest },
        tx,
      );
      await this.store.put("job", seed.job.jobId, state, tx, Date.now());
      await this.store.put(
        "task-job",
        `${seed.job.taskId}:${seed.job.jobId}`,
        { jobId: seed.job.jobId },
        tx,
      );
      await this.store.append(tx, `job:${seed.job.jobId}:1`, seed.event);
      if (initial.standaloneTask) {
        const task: D.Task = {
          taskId: seed.job.taskId,
          conversationId: seed.job.conversationId,
          version: 1,
          status: { state: "queued" },
        };
        await this.store.put("task", task.taskId, task, tx);
        await this.store.put("standalone-task", task.taskId, { jobId: seed.job.jobId }, tx);
        await this.store.append(tx, `task:${task.taskId}:1`, {
          ...seed.event,
          type: "task.queued",
          payload: task,
        });
      }
      return seed.job;
    });
  }
  async insertIfAbsent(ctx: D.AuthContext, input: D.JobSeed): Promise<D.Outcome<D.Job>> {
    return outcome(ctx.requestId, async () => {
      await this.authority.authorize(ctx, "jobs.dispatch", input.job.conversationId);
      const existing = await this.store.get<{ jobId: string; digest: string }>(
        "job-task",
        input.piTaskId,
      );
      check(
        existing && existing.digest === input.job.operationDigest,
        "conflict",
        "Full operation seed required before child attachment",
      );
      return (await this.state(existing.jobId)).job;
    });
  }
  get(ctx: D.AuthContext, input: D.JobLookup): Promise<D.Outcome<D.Job>> {
    return outcome(ctx.requestId, async () => {
      const state = await this.state(input.jobId);
      await this.authority.authorize(ctx, "jobs.read", state.job.conversationId);
      return this.public(state.job);
    });
  }
  transition(ctx: D.AuthContext, input: D.JobTransition): Promise<D.Outcome<D.Job>> {
    return outcome(ctx.requestId, async () => {
      const old = await this.state(input.jobId);
      await this.authority.authorize(ctx, "jobs.dispatch", old.job.conversationId);
      return this.store.transaction(async (tx) => {
        const state = await this.state(input.jobId, tx);
        check(
          state.job.version === input.expectedVersion &&
            state.job.state === input.expectedState &&
            !isTerminal(state.job),
          "conflict",
          "Job compare-and-swap failed",
        );
        check(input.nextState !== "completed", "conflict", "Completion requires evidence");
        const next = {
          ...state.job,
          state: input.nextState,
          version: state.job.version + 1,
        } as D.Job;
        await this.update(tx, state, next);
        return next;
      });
    });
  }
  decideApproval(ctx: D.AuthContext, input: D.ApprovalDecision): Promise<D.Outcome<D.Approval>> {
    return outcome(ctx.requestId, async () => {
      const approval = await this.store.get<D.Approval>("approval", input.approvalId);
      check(approval, "not_found", "Approval unavailable");
      const resources = scope({
        agentIds: [approval.agentId],
        conversationIds: [approval.conversationId],
        workspaceIds: [approval.operation.workspaceId],
        tools: [approval.operation.tool],
        actions: ["approvals.decide"],
        executorIds:
          approval.operation.target.kind === "executor"
            ? [approval.operation.target.executorId]
            : [],
        backendIds:
          approval.operation.target.kind === "backend" ? [approval.operation.target.backendId] : [],
      });
      await this.authority.authorize(ctx, "approvals.decide", approval.conversationId, resources);
      const decided = await this.store.once(
        "approval-decision",
        `${ctx.principalId}:${input.approvalId}:${input.decision.requestId}`,
        { approvalId: input.approvalId, decision: input.decision },
        async (tx) => {
          const current = await this.store.get<D.Approval>("approval", input.approvalId, tx);
          check(current, "not_found", "Approval unavailable");
          await this.authority.current(ctx, resources, tx);
          check(
            current.operation.operationDigest === input.decision.operationDigest,
            "conflict",
            "Approval digest changed",
          );
          if (current.state === "approved" || current.state === "rejected") {
            check(
              current.state === (input.decision.decision === "approve" ? "approved" : "rejected"),
              "conflict",
              "Approval already decided",
            );
            return current;
          }
          check(
            current.state === "pending" &&
              current.version === input.decision.expectedVersion &&
              current.operation.expiresAt > Date.now(),
            "conflict",
            "Approval expired or changed",
          );
          const next: D.Approval = {
            ...current,
            state: input.decision.decision === "approve" ? "approved" : "rejected",
            version: current.version + 1,
            decidedBy: ctx.principalId,
            decidedAt: Date.now(),
          };
          await this.store.put("approval", next.approvalId, next, tx);
          const state = await this.state(next.jobId, tx);
          await this.store.append(tx, `approval:${next.approvalId}:${next.version}`, {
            ...this.event(state),
            type: "approval.resolved",
            payload: next,
          });
          await this.authority.current(ctx, resources, tx);
          return next;
        },
      );
      await this.authority.current(ctx, resources);
      return decided;
    });
  }
  savePreparedResult(ctx: D.AuthContext, input: D.ResultDelivery): Promise<D.Outcome<D.Job>> {
    return outcome(ctx.requestId, async () => {
      validate<D.PreparedResult>("PreparedResult", input.result);
      const before = await this.state(input.identity.jobId);
      await this.#currentCompletion(ctx, before);
      let quarantined = false;
      const saved = await this.store.transaction(async (tx) => {
        const state = await this.state(input.identity.jobId, tx);
        await this.#currentCompletion(ctx, state, tx);
        await this.requireObservationIdentity(state, input.identity, tx);
        check(
          state.assignment &&
            same(input.result.identity, input.identity) &&
            input.sequence === input.result.sequence,
          "conflict",
          "Result identity changed",
        );
        if (state.job.preparedResult) {
          check(same(state.job.preparedResult, input.result), "conflict", "Conflicting result");
          await this.#currentCompletion(ctx, state, tx);
          return state.job;
        }
        check(!isTerminal(state.job), "conflict", "Terminal job cannot adopt a late result");
        const renewed = await this.store.get<D.Lease>("lease-observation", state.job.jobId, tx);
        const effective =
          renewed &&
          renewed.leaseId === input.identity.lease.leaseId &&
          renewed.fence === input.identity.lease.fence &&
          renewed.executorGeneration === input.identity.lease.executorGeneration
            ? renewed
            : input.identity.lease;
        const expired =
          !!state.cancel ||
          effective.expiresAt <= Date.now() ||
          input.identity.deadline <= Date.now() ||
          input.identity.target.generation <
            ((await this.store.get<number>(
              "executor-floor",
              input.identity.target.kind === "executor"
                ? input.identity.target.executorId
                : input.identity.target.backendId,
              tx,
            )) ?? 0);
        if (expired) {
          await this.store.put("quarantine", input.deliveryId, input, tx);
          quarantined = true;
          return state.job;
        }
        const next = {
          ...state.job,
          preparedResult: input.result,
          state: "result_pending_commit",
          version: state.job.version + 1,
        } as D.Job;
        state.resultLease = input.identity.lease;
        await this.update(tx, state, next);
        await this.#currentCompletion(ctx, state, tx);
        return next;
      });
      check(!quarantined, "conflict", "Late result quarantined");
      return saved;
    });
  }
  finalize(ctx: D.AuthContext, input: D.FinalizeJob): Promise<D.Outcome<D.Job>> {
    return outcome(ctx.requestId, async () => {
      const before = await this.state(input.jobId);
      if (before.assignment && before.reservation) await this.#currentCompletion(ctx, before);
      else await this.authority.authorize(ctx, "jobs.dispatch", before.job.conversationId);
      return this.store.transaction(async (tx) => {
        const state = await this.state(input.jobId, tx);
        await this.#currentCompletion(ctx, state, tx);
        if (state.job.state === input.state && isTerminal(state.job)) {
          if (input.state === "completed")
            check(
              state.job.state === "completed" && same(state.job.evidence, input.evidence),
              "conflict",
              "Terminal evidence changed",
            );
          await this.#currentCompletion(ctx, state, tx);
          return state.job;
        }
        check(
          state.job.version === input.expectedVersion &&
            state.job.state === input.expectedState &&
            !isTerminal(state.job),
          "conflict",
          "Job compare-and-swap failed",
        );
        if (input.state === "completed") {
          const target = state.operation.target;
          check(
            target.generation >=
              ((await this.store.get<number>(
                "executor-floor",
                target.kind === "executor" ? target.executorId : target.backendId,
                tx,
              )) ?? 0),
            "conflict",
            "Completion target generation was revoked",
          );
          check(!state.cancel, "conflict", "Cancelled work cannot adopt success");
          check(
            state.job.preparedResult?.state === "succeeded" && state.job.execution,
            "conflict",
            "Verified prepared result required",
          );
          const evidence = input.evidence;
          check(
            evidence.kind === "committed"
              ? evidence.receipt.jobId === state.job.jobId &&
                  evidence.receipt.baseRevision === state.job.baseRevision &&
                  evidence.receipt.operationId === state.operation.operationId &&
                  evidence.receipt.workspaceId === state.job.workspaceId &&
                  evidence.receipt.commitId === state.job.preparedResult.commitId &&
                  evidence.receipt.manifestHash === state.job.preparedResult.manifestHash
              : evidence.executionId === state.job.execution.executionId &&
                  evidence.baseRevision === state.job.baseRevision &&
                  evidence.workspaceId === state.job.workspaceId &&
                  evidence.manifestHash === state.job.preparedResult.manifestHash &&
                  evidence.manifestHash === state.baseManifestHash,
            "conflict",
            "Evidence identity mismatch",
          );
        }
        const next =
          input.state === "completed"
            ? {
                ...state.job,
                state: input.state,
                evidence: input.evidence,
                version: state.job.version + 1,
              }
            : { ...state.job, state: input.state, version: state.job.version + 1 };
        await this.update(tx, state, next as D.Job);
        await this.#currentCompletion(ctx, state, tx);
        return state.job;
      });
    });
  }
  async terminalProof(ctx: D.AuthContext, jobId: string, input: unknown): Promise<D.JobCommitted> {
    validate<D.JobCommitted>("JobCommitted", input);
    const state = await this.state(jobId);
    const job = state.job;
    check(
      jobId === input.identity.jobId && job.agentId === this.authority.agentId,
      "conflict",
      "Terminal job owner mismatch",
    );
    const resources = scope({
      agentIds: [job.agentId],
      conversationIds: [job.conversationId],
      workspaceIds: [job.workspaceId],
      tools: [state.operation.tool],
      actions: ["jobs.dispatch"],
      ...(input.identity.target.kind === "executor"
        ? { executorIds: [input.identity.target.executorId] }
        : { backendIds: [input.identity.target.backendId] }),
    });
    await this.authority.current(ctx, resources);
    check(
      job.state === "completed" &&
        job.version === input.terminalVersion &&
        same(job.execution, input.identity) &&
        same(
          this.public(job).state === "completed"
            ? (this.public(job) as Extract<D.Job, { state: "completed" }>).evidence
            : null,
          input.evidence,
        ) &&
        state.terminalSeq === input.eventSeq,
      "conflict",
      "Job terminal proof differs from durable state",
    );
    const event = await this.store.exactEvent(job.conversationId, input.eventSeq);
    check(
      event?.type === "job.state.changed" &&
        event.jobId === jobId &&
        event.payload.state === "completed" &&
        event.payload.version === job.version &&
        same(event.payload, this.public(job)),
      "conflict",
      "Durable terminal event required",
    );
    await this.authority.current(ctx, resources);
    return input;
  }
  ingestFact(ctx: D.FactDeliveryContext, input: D.Fact): Promise<D.Outcome<D.FactAck>> {
    return outcome(input.factId, async () => {
      check(
        ctx.kind === "fact-delivery" &&
          ctx.deadline > Date.now() &&
          ctx.recipient.kind === "agent" &&
          ctx.recipient.id === this.authority.agentId &&
          same(ctx.source, input.source) &&
          input.recipients.some((r) => same(r, ctx.recipient)),
        "unauthorized",
        "Invalid fact authority",
      );
      return this.store.transaction(async (tx) => {
        const row = await this.store.get<{ deploymentId: string }>(
          "conversation",
          input.conversationId,
          tx,
        );
        check(
          row?.deploymentId === ctx.deploymentId && input.event.deploymentId === ctx.deploymentId,
          "unauthorized",
          "Fact deployment mismatch",
        );
        const ack = await this.store.append(tx, `fact:${input.factId}`, input.event);
        return { ...ack, factId: input.factId, recipient: ctx.recipient };
      });
    });
  }
  pageFacts(ctx: D.AuthContext, input: D.FactPageRequest): Promise<D.Outcome<D.FactPage>> {
    return outcome(ctx.requestId, async () => {
      await this.authority.authorize(ctx, "jobs.dispatch");
      const rows = await this.store.page<D.Fact>("outbox", input.limit, input.after);
      return {
        items: rows.map((r) => r.value),
        ...(rows.length === input.limit ? { nextPageToken: rows.at(-1)!.id } : {}),
      };
    });
  }
  ackFacts(ctx: D.AuthContext, input: D.FactAckRequest): Promise<D.Outcome<D.FactAck>> {
    return outcome(ctx.requestId, async () => {
      await this.authority.authorize(ctx, "jobs.dispatch");
      await this.store.remove("outbox", input.factId);
      return { ...input, persisted: true };
    });
  }
}
