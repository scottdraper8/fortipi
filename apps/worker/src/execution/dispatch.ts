import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  assignmentDigest,
  commitDigest,
  operationDigest,
  operationForAssignment,
  publicCommitReceipt,
} from "fortipi-contract";
import { check, id, resourceId, ServiceError, same, scope, unwrap } from "../api/common.js";
import { validate } from "../api/validation.js";
import type * as D from "../boundary/dto.js";
import type { Env } from "../boundary/env.js";
import { isTerminal, type JobState, type Jobs } from "./jobs.js";
import { operationalMetadata } from "./metadata.js";
import { nativeContext, nativeProof } from "./native-proof.js";

export class Dispatch {
  readonly jobs: Jobs;
  readonly env: Env;
  constructor(jobs: Jobs, env: Env) {
    this.jobs = jobs;
    this.env = env;
  }
  auth(state: JobState): D.AuthContext {
    return { ...state.auth, deadline: Date.now() + 30000 };
  }
  workspace(state: JobState) {
    return this.env.WORKSPACES.getByName(state.job.workspaceId);
  }
  private async active(state: JobState): Promise<void> {
    const current = await this.jobs.state(state.job.jobId);
    check(
      current.job.version === state.job.version &&
        !current.cancel &&
        !isTerminal(current.job) &&
        current.deadline > Date.now(),
      "conflict",
      "Dispatch authority or phase changed",
    );
    await this.jobs.authority.current(
      this.auth(current),
      scope({
        agentIds: [current.job.agentId],
        conversationIds: [current.job.conversationId],
        workspaceIds: [current.job.workspaceId],
        tools: [current.operation.tool],
        actions: ["jobs.dispatch", "workspace.write"],
        ...(current.operation.target.kind === "executor"
          ? { executorIds: [current.operation.target.executorId] }
          : { backendIds: [current.operation.target.backendId] }),
      }),
    );
  }
  async cloudCall<T>(
    state: JobState,
    auth: D.AuthContext,
    action: string,
    input: D.ExecutionRequest | D.PreparedExecution | D.ExecutionIdentity,
  ): Promise<D.Outcome<T>> {
    const response = await this.workspace(state).fetch(
      new Request(`https://workspace.internal/__fortipi/authority/${action}`, {
        method: "POST",
        headers: { "x-fortipi-workspace-context": JSON.stringify({ auth }) },
        body: JSON.stringify(input),
      }),
    );
    check(
      response.ok,
      "interrupted",
      "Execution transport interrupted; query the existing identity",
    );
    return response.json<D.Outcome<T>>();
  }
  async save(state: JobState): Promise<void> {
    await this.jobs.store.transaction(async (tx) => {
      const current = await this.jobs.state(state.job.jobId, tx);
      check(
        current.job.version === state.job.version,
        "conflict",
        "Job changed during remote work",
      );
      if (current.cancel) state.cancel = current.cancel;
      await this.jobs.store.put(
        "job",
        state.job.jobId,
        state,
        tx,
        isTerminal(state.job) ? null : Date.now(),
      );
    });
  }
  async cleanup(state: JobState): Promise<void> {
    const pending = await this.jobs.store.get<{ released: boolean; settled: boolean }>(
      "job-cleanup",
      state.job.jobId,
    );
    if (!pending) return;
    const auth = this.auth(state);
    let failed: unknown;
    if (!pending.released && state.assignment && state.reservation) {
      const released = await this.workspace(state).releaseLease(
        { ...auth, registrationId: state.reservation.registrationIds.workspace },
        {
          requestId: `release_${state.job.jobId}`,
          lease: (await this.jobs.observationIdentity(state)).lease,
          reason:
            state.job.state === "completed"
              ? "completed"
              : state.job.state === "cancelled"
                ? "cancelled"
                : state.job.state === "expired"
                  ? "expired"
                  : "reconciled",
        },
      );
      if (released.ok) pending.released = true;
      else failed = new ServiceError(released.code, released.message, released.details);
    }
    if (!pending.settled) {
      const settled = await this.jobs.authority.control.settleCapacity(
        {
          ...auth,
          ...(state.capacityRegistrationId ? { registrationId: state.capacityRegistrationId } : {}),
        },
        { reservationId: state.capacityReservationId, disposition: "consumed" },
      );
      if (settled.ok) pending.settled = true;
      else failed = new ServiceError(settled.code, settled.message, settled.details);
    }
    if (pending.released && pending.settled)
      await this.jobs.store.remove("job-cleanup", state.job.jobId);
    else
      await this.jobs.store.put(
        "job-cleanup",
        state.job.jobId,
        pending,
        undefined,
        Date.now() + 30000,
      );
    if (failed) throw failed;
  }
  async repair(budget: D.DrainBudget): Promise<D.DrainProgress> {
    let processed = 0;
    for (const kind of ["terminal-notification", "job-cleanup"]) {
      for (const row of await this.jobs.store.page(
        kind,
        Math.min(4, Math.max(1, budget.maxItems - processed)),
        "",
        Date.now(),
      )) {
        if (processed >= budget.maxItems || Date.now() >= budget.deadline) break;
        try {
          const state = await this.jobs.state(row.id);
          if (kind === "terminal-notification") await this.sendTerminal(state);
          else await this.cleanup(state);
        } catch (error) {
          const permanent =
            error instanceof ServiceError &&
            (error.code === "unauthorized" || error.code === "unauthenticated");
          const latest = await this.jobs.store.get(kind, row.id);
          if (latest !== undefined)
            await this.jobs.store.put(
              kind,
              row.id,
              latest,
              undefined,
              permanent ? null : Date.now() + 30000,
            );
          await this.jobs.store.put("repair-pressure", `${kind}:${row.id}`, {
            code: error instanceof ServiceError ? error.code : "interrupted",
            requiresCurrentAuthority: permanent,
          });
        }
        processed++;
      }
    }
    const due = await this.jobs.store.db.get<{ due: number | null }>(
      "SELECT MIN(due) AS due FROM fp_records_v1 WHERE kind IN ('terminal-notification','job-cleanup') AND due IS NOT NULL",
    );
    return {
      processed,
      remaining: due?.due != null,
      ...(due?.due != null ? { nextWakeAt: Math.max(Date.now() + 5000, due.due) } : {}),
    };
  }
  async change(state: JobState, status: Exclude<D.JobState, "completed">): Promise<void> {
    await this.jobs.store.transaction(async (tx) => {
      const current = await this.jobs.state(state.job.jobId, tx);
      check(current.job.version === state.job.version, "conflict", "Concurrent job change");
      if (current.cancel) state.cancel = current.cancel;
      await this.jobs.update(tx, state, {
        ...state.job,
        state: status,
        version: state.job.version + 1,
      } as D.Job);
    });
  }
  async #nativePhase(
    state: JobState,
    observation: Extract<
      D.ExecutionObservation,
      { state: "waiting_for_local_policy" | "preparing" }
    >,
  ): Promise<void> {
    check(
      state.assignment?.identity.target.kind === "executor" &&
        same(observation.operation, state.operation),
      "conflict",
      "Native phase operation differs from the retained job",
    );
    await this.jobs.store.transaction(async (tx) => {
      const current = await this.jobs.state(state.job.jobId, tx);
      await this.jobs.requireObservationIdentity(current, observation.identity, tx);
      const auth = this.auth(current),
        resources = scope({
          agentIds: [current.job.agentId],
          conversationIds: [current.job.conversationId],
          workspaceIds: [current.job.workspaceId],
          tools: [current.operation.tool],
          executorIds:
            current.operation.target.kind === "executor"
              ? [current.operation.target.executorId]
              : [],
          actions: [
            ...new Set([
              ...(current.reservation?.actions ?? []),
              "jobs.dispatch",
              "workspace.write",
            ]),
          ],
        });
      await this.jobs.authority.current(auth, resources, tx);
      // A delayed peer response cannot reverse a newer phase/version, running
      // claim, prepared result or terminal outcome that arrived during the RPC.
      if (
        current.job.version !== state.job.version ||
        current.cancel ||
        current.deadline <= Date.now() ||
        !["dispatch_attempted", "waiting_for_local_policy"].includes(current.job.state)
      )
        return;
      const next =
        observation.state === "waiting_for_local_policy"
          ? "waiting_for_local_policy"
          : "dispatch_attempted";
      if (current.job.state !== next)
        await this.jobs.update(tx, current, {
          ...current.job,
          state: next,
          version: current.job.version + 1,
        } as D.Job);
      await this.jobs.authority.current(auth, resources, tx);
    });
  }
  async finish(
    state: JobState,
    status: Exclude<D.FinalizeJob["state"], "completed">,
    reason: string,
  ): Promise<void> {
    const ctx = this.auth(state);
    unwrap(
      await this.jobs.finalize(ctx, {
        jobId: state.job.jobId,
        expectedVersion: state.job.version,
        expectedState: state.job.state,
        state: status,
        reason,
        possibleExternalEffects: !!state.assignment,
        event: this.jobs.event(state),
      }),
    );
  }
  private async prepareNative(
    state: JobState,
    auth: D.AuthContext,
    wsAuth: D.AuthContext,
  ): Promise<void> {
    check(
      state.executorTransferLimits,
      "unavailable_executor",
      "Validated executor transfer limits required",
    );
    validate<D.ExecutorTransferLimits>("ExecutorTransferLimits", state.executorTransferLimits);
    check(
      state.assignment?.identity.target.kind === "executor" &&
        state.reservation &&
        state.rootBindingId &&
        state.baseManifestHash,
      "conflict",
      "Local execution binding unavailable",
    );
    const identity = state.assignment.identity;
    check(identity.target.kind === "executor", "conflict", "Native target required");
    if (!state.localRequest) {
      state.localRequest = {
        kind: "prepare",
        operationId: state.operation.operationId,
        operationDigest: state.operation.operationDigest,
        workspaceId: state.job.workspaceId,
        bindingVersion: state.bindingVersion,
        rootBindingId: state.rootBindingId,
        executorId: identity.target.executorId,
        executorGeneration: identity.target.generation,
        credential: {
          credentialId: auth.credentialId,
          generation: auth.generation,
          grantVersion: auth.grantVersion,
        },
        baseRevision: state.job.baseRevision,
        lease: identity.lease,
        deadline: state.deadline,
        commitId: `commit_${state.job.jobId}`,
        expectedManifestHash: state.baseManifestHash,
        mode: {
          kind: "native-execution",
          jobId: state.job.jobId,
          executionId: identity.executionId,
          assignmentDigest: identity.assignmentDigest,
        },
      };
      await this.save(state);
    }
    check(state.localRequest.kind === "prepare", "conflict", "Preparation identity changed");
    if (!state.localPreparation) {
      await this.active(state);
      const prepared: unknown = unwrap(
        await this.jobs.authority.control.requestLocalWorkspace(auth, state.localRequest),
      );
      validate<D.LocalPrepared>("LocalPrepared", prepared);
      check(
        prepared.operationId === state.operation.operationId &&
          prepared.operationDigest === identity.operationDigest &&
          prepared.preManifestHash === state.baseManifestHash &&
          prepared.expiresAt > Date.now(),
        "conflict",
        "Local preparation proof differs",
      );
      state.localPreparation = prepared;
      await this.save(state);
    }
    if (!state.localIntent) {
      await this.active(state);
      const {
        kind: _kind,
        mode: _mode,
        commitId,
        expectedManifestHash: _hash,
        ...scope
      } = state.localRequest;
      state.localIntent = unwrap(
        await this.workspace(state).prepareLocalCommit(wsAuth, {
          scope,
          commitId,
          preparation: state.localPreparation,
        }),
      );
      await this.save(state);
    }
  }
  async tick(jobId: string): Promise<{ done: boolean; wakeAt?: number }> {
    let state = await this.jobs.state(jobId);
    if (isTerminal(state.job)) {
      if (
        state.job.state === "completed" &&
        (await this.jobs.store.get("terminal-notification", jobId))
      ) {
        if (Date.now() >= state.deadline) return { done: true };
        await this.sendTerminal(state);
        return { done: true };
      }
      return { done: true };
    }
    const auth = this.auth(state);
    if (state.cancel) {
      if (state.assignment) {
        const input = {
          identity: state.assignment.identity,
          requestId: state.cancel.requestId,
          reason: state.cancel.reason ?? "Cancelled",
        };
        const result =
          state.assignment.identity.target.kind === "executor"
            ? await this.jobs.authority.control.cancelExecution(auth, input)
            : await this.workspace(state).cancelExecution(auth, input);
        if (!result.ok || result.value.possibleExternalEffects) {
          await this.finish(
            state,
            "requires_reconciliation",
            "Cancellation may leave external effects",
          );
          return { done: true };
        }
      }
      await this.finish(state, "cancelled", "Cancelled");
      return { done: true };
    }
    if (state.deadline <= Date.now()) {
      await this.jobs.interrupt(jobId, "Operation deadline reached");
      return { done: true };
    }
    const operation = state.operation;
    const resources = scope({
      agentIds: [state.job.agentId],
      conversationIds: [state.job.conversationId],
      workspaceIds: [state.job.workspaceId],
      tools: [operation.tool],
      actions: ["jobs.dispatch", "workspace.write"],
      ...(operation.target.kind === "executor"
        ? { executorIds: [operation.target.executorId] }
        : { backendIds: [operation.target.backendId] }),
    });
    const nativeRecovery =
      state.assignment?.identity.target.kind === "executor" &&
      !!state.reservation &&
      [
        "dispatch_attempted",
        "running",
        "waiting_for_local_policy",
        "result_pending_commit",
      ].includes(state.job.state);
    // These existing-execution owners check current authority themselves:
    // CP validates the retained query/observation/receipt claim; Workspace
    // validates any NEW publication against its current lease/floors/CAS.
    if (nativeRecovery) await this.jobs.authority.current(auth, resources);
    else
      await this.jobs.authority.authorize(
        auth,
        "jobs.dispatch",
        state.job.conversationId,
        resources,
      );
    if (state.job.state === "created") {
      // Human authorization precedes all target/lease acquisition. Local consent remains independent.
      const approval: D.Approval = {
        approvalId: state.approvalId ?? resourceId("a", state.job.agentId),
        jobId,
        agentId: state.job.agentId,
        conversationId: state.job.conversationId,
        requestingPrincipalId: state.auth.principalId,
        operation,
        version: 1,
        state: "pending",
      };
      state.approvalId = approval.approvalId;
      await this.jobs.store.transaction(async (tx) => {
        await this.jobs.store.put("approval", approval.approvalId, approval, tx);
        await this.jobs.store.append(tx, `approval:${approval.approvalId}:1`, {
          ...this.jobs.event(state),
          type: "approval.requested",
          payload: approval,
        });
        await this.jobs.update(tx, state, {
          ...state.job,
          state: "awaiting_approval",
          version: state.job.version + 1,
        } as D.Job);
      });
    } else if (state.job.state === "awaiting_approval") {
      const approval = await this.jobs.store.get<D.Approval>("approval", state.approvalId ?? "");
      check(
        approval && same(approval.operation, operation),
        "conflict",
        "Approval context changed",
      );
      if (approval.state === "rejected" || approval.state === "cancelled") {
        await this.finish(state, "cancelled", "Approval denied");
        return { done: true };
      }
      if (approval.state === "approved") {
        check(
          approval.operation.grantVersion === auth.grantVersion && operation.expiresAt > Date.now(),
          "conflict",
          "Approval context expired",
        );
        await this.change(state, "authorized");
      } else if (operation.expiresAt <= Date.now()) {
        await this.jobs.store.transaction(async (tx) => {
          await this.jobs.store.put(
            "approval",
            approval.approvalId,
            { ...approval, state: "expired", version: approval.version + 1 },
            tx,
          );
          await this.jobs.store.append(tx, `approval:${approval.approvalId}:expired`, {
            ...this.jobs.event(state),
            type: "approval.expired",
            payload: { ...approval, state: "expired", version: approval.version + 1 },
          });
        });
        await this.finish(state, "expired", "Approval expired");
        return { done: true };
      }
    } else if (state.job.state === "authorized" || state.job.state === "waiting_for_executor") {
      if (!state.reservation) {
        const reservation = unwrap(
          await this.jobs.authority.control.reserveTarget(auth, {
            ownerKind: "job",
            jobId,
            executionId: `exec_${jobId}`,
            agentId: state.job.agentId,
            conversationId: state.job.conversationId,
            operationId: operation.operationId,
            operationDigest: operation.operationDigest,
            workspaceId: state.job.workspaceId,
            bindingVersion: state.bindingVersion,
            target: operation.target,
            actions: resources.actions,
            deadline: state.deadline,
            expiresAt: Math.min(state.deadline, Date.now() + 30000),
          }),
        );
        check(reservation.ownerKind === "job", "conflict", "Wrong reservation owner");
        state.reservation = reservation;
        await this.save(state);
      }
      const wsAuth = { ...auth, registrationId: state.reservation.registrationIds.workspace };
      await this.active(state);
      const lease = unwrap(await this.workspace(state).acquireLease(wsAuth, state.reservation));
      const preimage: D.OperationDigestInput = {
        deploymentId: auth.deploymentId,
        agentId: state.job.agentId,
        conversationId: state.job.conversationId,
        tool: operation.tool,
        arguments: operation.arguments,
        workspaceId: state.job.workspaceId,
        baseRevision: state.job.baseRevision,
        target: operation.target,
        policyVersion: operation.policyVersion,
        grantVersion: operation.grantVersion,
        deadline: state.deadline,
      };
      check(
        (await operationDigest(preimage)) === operation.operationDigest,
        "conflict",
        "Operation digest changed",
      );
      const identity: D.ExecutionIdentity = {
        jobId,
        executionId: state.reservation.executionId,
        operationDigest: operation.operationDigest,
        assignmentDigest: await assignmentDigest({
          operation: preimage,
          executionId: state.reservation.executionId,
          reservationId: state.reservation.reservationId,
          leaseId: lease.leaseId,
          fence: lease.fence,
          executorGeneration: lease.executorGeneration,
        }),
        target: operation.target,
        lease,
        baseRevision: state.job.baseRevision,
        deadline: state.deadline,
      };
      const assignment: D.Assignment = {
        identity,
        reservationId: state.reservation.reservationId,
        tool: operation.tool,
        arguments: operation.arguments,
        workspaceId: state.job.workspaceId,
        bindingVersion: state.bindingVersion,
        ...(state.rootBindingId ? { rootBindingId: state.rootBindingId } : {}),
        approval: operation,
        operationContext: {
          deploymentId: auth.deploymentId,
          agentId: state.job.agentId,
          conversationId: state.job.conversationId,
          policyVersion: operation.policyVersion,
        },
      };
      state.assignment = assignment;
      state.job = { ...state.job, execution: identity };
      // Retain the authority registration issued for this exact target before any effects.
      state.auth = { ...state.auth, registrationId: state.reservation.registrationIds.agent };
      await this.change(state, "leased");
    } else if (state.job.state === "leased") {
      check(state.assignment && state.reservation, "conflict", "Lease identity missing");
      const assignment = state.assignment;
      const wsAuth = { ...auth, registrationId: state.reservation.registrationIds.workspace };
      if (state.rootBindingId && !state.localIntent) await this.prepareNative(state, auth, wsAuth);
      if (assignment.identity.target.kind === "backend" && !state.prepared) {
        await this.active(state);
        state.prepared = unwrap(
          await this.cloudCall<D.PreparedExecution>(state, wsAuth, "prepare", {
            operationContext: assignment.operationContext,
            reservation: state.reservation,
            identity: assignment.identity,
            tool: assignment.tool,
            arguments: assignment.arguments,
            workspaceId: assignment.workspaceId,
            bindingVersion: assignment.bindingVersion,
            capabilities: operation.capabilities,
            approval: operation,
          }),
        );
        await this.save(state);
      }
      // The app record is the durable attempt barrier. Reentry beyond it is query-only.
      await this.active(state);
      await this.change(state, "dispatch_attempted");
      await this.active(state);
      if (assignment.identity.target.kind === "executor") {
        unwrap(
          await this.jobs.authority.control.recordDispatchIntent(this.auth(state), {
            reservation: state.reservation,
            assignment,
            expectedJobVersion: state.job.version,
          }),
        );
        await this.active(state);
        await this.jobs.authority.control.assignOnce(this.auth(state), assignment);
      } else {
        check(state.prepared, "conflict", "Preparation missing");
        await this.cloudCall<D.ExecutionObservation>(state, wsAuth, "start", state.prepared);
      }
    } else if (
      state.job.state === "dispatch_attempted" ||
      state.job.state === "running" ||
      state.job.state === "waiting_for_local_policy"
    ) {
      check(state.assignment && state.reservation, "conflict", "Dispatch identity missing");
      const identity = await this.jobs.observationIdentity(state);
      const wsAuth = { ...auth, registrationId: state.reservation.registrationIds.workspace };
      const response =
        identity.target.kind === "executor"
          ? await this.jobs.authority.control.queryExecution(auth, identity)
          : await this.cloudCall<D.ExecutionObservation>(state, wsAuth, "query", identity);
      if (response.ok) {
        const observation = response.value;
        validate<D.ExecutionObservation>("ExecutionObservation", observation);
        await this.jobs.requireObservationIdentity(state, observation.identity);
        if (observation.state === "waiting_for_local_policy" || observation.state === "preparing")
          await this.#nativePhase(state, observation);
        if (
          observation.state === "not_started" ||
          observation.state === "unknown" ||
          observation.state === "lost"
        ) {
          // Even durable absence never licenses a second automatic start.
          await this.finish(
            state,
            "requires_reconciliation",
            "Existing dispatch has uncertain effects",
          );
          return { done: true };
        }
        if (observation.state === "terminal") {
          let result = observation.result;
          if (!result && identity.target.kind === "backend")
            result = unwrap(
              await this.cloudCall<D.PreparedResult>(state, wsAuth, "collect", identity),
            );
          if (result)
            unwrap(
              await this.jobs.savePreparedResult(auth, {
                identity: result.identity,
                sequence: result.sequence,
                result,
                deliveryId: `result_${identity.executionId}`,
              }),
            );
        } else if (observation.state === "running" && state.job.state !== "running")
          await this.change(state, "running");
      }
      state = await this.jobs.state(jobId);
      if (
        state.assignment &&
        state.reservation &&
        (
          (await this.jobs.store.get<D.Lease>("lease-observation", state.job.jobId)) ??
          state.assignment.identity.lease
        ).expiresAt -
          Date.now() <=
          15000 &&
        !isTerminal(state.job)
      ) {
        const lease =
          (await this.jobs.store.get<D.Lease>("lease-observation", state.job.jobId)) ??
          state.assignment.identity.lease;
        state.renewal ??= {
          requestId: `renew_${lease.leaseId}_${lease.leaseVersion}`,
          lease,
          expectedLeaseVersion: lease.leaseVersion,
          expiresAt: Math.min(state.deadline, Date.now() + 30000),
        };
        await this.save(state);
        const renewed = unwrap(await this.workspace(state).renewLease(wsAuth, state.renewal));
        check(renewed.leaseVersion > lease.leaseVersion, "conflict", "Renewal failed");
        await this.jobs.retainLease(auth, state.job.jobId, renewed);
        // Renewal is an observation, never a rewrite of the original assignment/digest.
        if (identity.target.kind === "executor")
          unwrap(
            await this.jobs.authority.control.deliverExecutorFrame(auth, {
              executorId: identity.target.executorId,
              generation: identity.target.generation,
              ...this.epoch(state),
              frame: {
                type: "job.lease_update",
                requestId: state.renewal.requestId,
                payload: {
                  identity: state.assignment.identity,
                  leaseVersion: renewed.leaseVersion,
                  expiresAt: renewed.expiresAt,
                },
              },
            }),
          );
        delete state.renewal;
        await this.save(state);
      }
    } else if (state.job.state === "result_pending_commit") {
      await this.commitResult(state);
      return { done: isTerminal((await this.jobs.state(jobId)).job) };
    }
    state = await this.jobs.state(jobId);
    state.poll = Math.min(state.poll + 1, 6);
    await this.save(state);
    const waiting =
      state.job.state === "awaiting_approval" || state.job.state === "waiting_for_executor";
    let cadence = waiting ? Math.min(30000, 5000 * 2 ** Math.min(state.poll - 1, 3)) : 5000;
    if (
      state.assignment &&
      ["dispatch_attempted", "running", "waiting_for_local_policy"].includes(state.job.state)
    ) {
      const lease =
        (await this.jobs.store.get<D.Lease>("lease-observation", jobId)) ??
        state.assignment.identity.lease;
      // Result delivery is durable/pushed. Coalesce query with the next renewal
      // rather than charging a separate query/authorization every five seconds.
      cadence = Math.min(30000, Math.max(250, lease.expiresAt - Date.now() - 15000));
    }
    return { done: false, wakeAt: Math.min(state.deadline, Date.now() + cadence) };
  }
  async commitResult(state: JobState): Promise<void> {
    const result = state.job.preparedResult;
    check(result && state.assignment && state.reservation, "conflict", "Prepared result missing");
    if (result.state !== "succeeded") {
      await this.finish(
        state,
        result.state === "unknown"
          ? "requires_reconciliation"
          : result.state === "cancelled"
            ? "cancelled"
            : "failed",
        "Execution did not succeed",
      );
      return;
    }
    const auth = this.auth(state);
    const wsAuth = { ...auth, registrationId: state.reservation.registrationIds.workspace };
    const workspace = this.workspace(state);
    const identity = state.assignment.identity;
    let evidence: D.FinalizeJob & { state: "completed" };
    let receipt = await this.jobs.store.get<D.CommitReceipt>("receipt", state.job.jobId);
    const nativeLookup = state.rootBindingId
      ? await this.jobs.store.get<D.CommitLookup>("native-commit-intent", state.job.jobId)
      : undefined;
    let historicalNative: D.CommitReceipt | undefined;
    if (state.rootBindingId && (nativeLookup || receipt)) {
      const known = await nativeContext(state);
      const lookup =
        nativeLookup ??
        (receipt
          ? {
              workspaceId: receipt.workspaceId,
              commitId: receipt.commitId,
              commitDigest: receipt.commitDigest,
            }
          : undefined);
      check(
        lookup &&
          lookup.workspaceId === state.job.workspaceId &&
          lookup.commitId === known.intent.commitId,
        "conflict",
        "Retained native lookup differs from the job",
      );
      const recovered = await workspace.getReceipt(wsAuth, lookup);
      if (recovered.ok) {
        const actual = recovered.value;
        check(
          actual.providerKind === "local" &&
            actual.jobId === state.job.jobId &&
            actual.operationId === state.operation.operationId &&
            actual.workspaceId === state.job.workspaceId &&
            actual.baseRevision === state.job.baseRevision &&
            actual.manifestHash === result.manifestHash &&
            actual.commitId === known.intent.commitId &&
            actual.preparationId === known.prepared.preparationId &&
            actual.commitDigest === lookup.commitDigest &&
            actual.committedAt <= state.deadline,
          "conflict",
          "Historical native receipt differs from admitted execution",
        );
        const expected = await commitDigest({
          commitId: actual.commitId,
          operationId: actual.operationId,
          jobId: state.job.jobId,
          workspaceId: actual.workspaceId,
          baseRevision: actual.baseRevision,
          manifestHash: actual.manifestHash,
          leaseIdentity: identity.lease,
          storage: {
            kind: "local",
            preparationId: actual.preparationId,
            observationSeq: actual.observationSeq,
            preManifestHash: known.intent.preManifestHash,
            postManifestHash: actual.manifestHash,
          },
        });
        check(
          expected === actual.commitDigest,
          "conflict",
          "Historical native receipt digest differs",
        );
        historicalNative = actual;
        await this.jobs.store.put("receipt", state.job.jobId, actual);
      } else
        check(recovered.code === "not_found", recovered.code, recovered.message, recovered.details);
    }
    if (historicalNative) {
      evidence = {
        jobId: state.job.jobId,
        expectedVersion: state.job.version,
        expectedState: state.job.state,
        state: "completed",
        evidence: { kind: "committed", receipt: historicalNative },
        event: this.jobs.event(state),
      };
    } else if (state.rootBindingId) {
      check(
        state.localRequest?.kind === "prepare" && state.localIntent && state.localPreparation,
        "conflict",
        "Native preparation intent missing",
      );
      const {
        kind: _kind,
        mode: _mode,
        expectedManifestHash: _hash,
        ...scope
      } = state.localRequest;
      const observation: unknown = unwrap(
        await this.jobs.authority.control.requestLocalWorkspace(auth, {
          ...scope,
          kind: "observe",
          preparationId: state.localPreparation.preparationId,
        }),
      );
      const verified = await nativeProof(state, observation, this.jobs.store.policy);
      await this.jobs.store.put("local-observation", state.job.jobId, verified.observation);
      if (verified.observation.postManifestHash !== state.baseManifestHash) {
        check(
          verified.manifest,
          "unavailable",
          "Retained complete native post-manifest handoff required",
        );
        const intent = state.localIntent;
        const digest = await commitDigest({
          commitId: intent.commitId,
          operationId: scope.operationId,
          jobId: state.job.jobId,
          workspaceId: state.job.workspaceId,
          baseRevision: state.job.baseRevision,
          manifestHash: verified.observation.postManifestHash,
          leaseIdentity: identity.lease,
          storage: {
            kind: "local",
            preparationId: intent.preparationId,
            observationSeq: verified.observation.observationSeq,
            preManifestHash: intent.preManifestHash,
            postManifestHash: verified.observation.postManifestHash,
          },
        });
        const lookup = {
          workspaceId: state.job.workspaceId,
          commitId: intent.commitId,
          commitDigest: digest,
        };
        if (!receipt) {
          const retained = await workspace.getReceipt(wsAuth, lookup);
          if (retained.ok) receipt = retained.value;
          else {
            check(retained.code === "not_found", retained.code, retained.message, retained.details);
            await this.active(state);
            await this.jobs.store.put("native-commit-intent", state.job.jobId, lookup);
            receipt = unwrap(
              await workspace.commitLocal(wsAuth, {
                intent,
                observation: verified.observation,
                manifest: verified.manifest,
              }),
            );
          }
        }
        check(
          receipt.providerKind === "local" &&
            receipt.commitId === intent.commitId &&
            receipt.commitDigest === digest &&
            receipt.operationId === scope.operationId &&
            receipt.jobId === state.job.jobId &&
            receipt.workspaceId === state.job.workspaceId &&
            receipt.baseRevision === state.job.baseRevision &&
            receipt.manifestHash === verified.observation.postManifestHash &&
            receipt.preparationId === intent.preparationId &&
            receipt.observationSeq === verified.observation.observationSeq,
          "conflict",
          "Native receipt differs from the actual effect",
        );
        await this.jobs.store.put("receipt", state.job.jobId, receipt);
        evidence = {
          jobId: state.job.jobId,
          expectedVersion: state.job.version,
          expectedState: state.job.state,
          state: "completed",
          evidence: { kind: "committed", receipt },
          event: this.jobs.event(state),
        };
      } else
        evidence = {
          jobId: state.job.jobId,
          expectedVersion: state.job.version,
          expectedState: state.job.state,
          state: "completed",
          evidence: {
            kind: "verified-unchanged",
            workspaceId: state.job.workspaceId,
            baseRevision: state.job.baseRevision,
            manifestHash: verified.observation.postManifestHash,
            executionId: identity.executionId,
            observedAt: Date.now(),
          },
          event: this.jobs.event(state),
        };
    } else if (result.uploadId && result.commitId && result.manifestHash) {
      const pending = await this.jobs.store.get<D.UploadCommit>("commit-intent", state.job.jobId);
      if (!receipt && pending) {
        // A lost commit reply is repaired from authority facts, then its exact receipt is queried.
        const cursor = await this.jobs.store.get<{ after: string }>(
          "commit-fact-cursor",
          state.job.jobId,
        );
        const response = await workspace.fetch(
          new Request("https://workspace.internal/__fortipi/facts", {
            method: "POST",
            headers: { "x-fortipi-workspace-context": JSON.stringify({ auth: wsAuth }) },
            body: JSON.stringify({
              recipient: { kind: "agent", id: state.job.agentId },
              limit: 100,
              ...(cursor ? { after: cursor.after } : {}),
            }),
          }),
        );
        check(response.ok, "interrupted", "Authority facts unavailable");
        const facts = unwrap(await response.json<D.Outcome<D.FactPage>>());
        const fact = facts.items.find(
          (f) =>
            f.event.type === "workspace.revision.committed" &&
            f.event.payload.commitId === result.commitId,
        );
        if (fact?.event.type === "workspace.revision.committed") {
          const actual = unwrap(
            await workspace.getReceipt(wsAuth, {
              workspaceId: state.job.workspaceId,
              commitId: result.commitId,
              commitDigest: fact.event.payload.commitDigest,
            }),
          );
          receipt = actual;
          await this.jobs.store.remove("commit-fact-cursor", state.job.jobId);
        } else if (facts.nextPageToken) {
          check(
            facts.nextPageToken !== cursor?.after,
            "conflict",
            "Authority fact cursor did not advance",
          );
          await this.jobs.store.put("commit-fact-cursor", state.job.jobId, {
            after: facts.nextPageToken,
          });
          return;
        } else {
          await this.finish(
            state,
            "requires_reconciliation",
            "Commit acknowledgment uncertain; recover the existing receipt",
          );
          return;
        }
      }
      if (!receipt) {
        await this.active(state);
        const validated = unwrap(
          await workspace.validateUpload(wsAuth, {
            operationId: "validateUpload",
            path: { workspaceId: state.job.workspaceId, uploadId: result.uploadId },
            query: {},
            body: undefined,
          }),
        );
        check(validated.status === 200, "conflict", "Stage not validated");
        const input: D.UploadCommit = {
          requestId: `commit_${state.job.jobId}`,
          stageId: validated.body.stageId,
          commitId: result.commitId,
          uploadId: result.uploadId,
          operationId: state.operation.operationId,
          jobId: state.job.jobId,
          workspaceId: state.job.workspaceId,
          lease: identity.lease,
          manifestHash: result.manifestHash,
          baseRevision: state.job.baseRevision,
        };
        await this.jobs.store.put("commit-intent", state.job.jobId, input);
        await this.active(state);
        const committed = unwrap(
          await workspace.commitUpload(wsAuth, {
            operationId: "commitUpload",
            path: { workspaceId: state.job.workspaceId, uploadId: result.uploadId },
            query: {},
            body: input,
          }),
        );
        check(committed.status === 200, "conflict", "Commit not acknowledged");
        // Public receipt is intentionally insufficient to invent a private seal. Query the real receipt.
        receipt = unwrap(
          await workspace.getReceipt(wsAuth, {
            workspaceId: state.job.workspaceId,
            commitId: result.commitId,
            commitDigest: committed.body.commitDigest,
          }),
        );
      }
      check(
        receipt.jobId === state.job.jobId &&
          receipt.manifestHash === result.manifestHash &&
          receipt.baseRevision === state.job.baseRevision,
        "conflict",
        "Receipt differs from prepared result",
      );
      await this.jobs.store.put("receipt", state.job.jobId, receipt);
      evidence = {
        jobId: state.job.jobId,
        expectedVersion: state.job.version,
        expectedState: state.job.state,
        state: "completed",
        evidence: { kind: "committed", receipt },
        event: this.jobs.event(state),
      };
    } else {
      const manifest = await operationalMetadata(workspace, wsAuth, {
        agentId: state.job.agentId,
        conversationId: state.job.conversationId,
        workspaceId: state.job.workspaceId,
        baseRevision: state.job.baseRevision,
      });
      check(
        result.manifestHash === manifest.manifestHash &&
          result.manifestHash === state.baseManifestHash,
        "conflict",
        "Unchanged-base proof missing",
      );
      evidence = {
        jobId: state.job.jobId,
        expectedVersion: state.job.version,
        expectedState: state.job.state,
        state: "completed",
        evidence: {
          kind: "verified-unchanged",
          workspaceId: state.job.workspaceId,
          baseRevision: state.job.baseRevision,
          manifestHash: manifest.manifestHash,
          executionId: identity.executionId,
          observedAt: Date.now(),
        },
        event: this.jobs.event(state),
      };
    }
    if (
      evidence.evidence.kind === "committed" &&
      evidence.evidence.receipt.providerKind === "local"
    )
      await this.#acknowledgeNativeReceipt(state, evidence.evidence.receipt);
    unwrap(await this.jobs.finalize(auth, evidence));
    const final = await this.jobs.state(state.job.jobId);
    if (identity.target.kind === "executor") {
      check(
        final.job.state === "completed" && final.terminalSeq,
        "conflict",
        "Terminal event missing",
      );
      // Actual persisted Agent proof exists before CP verifies both authorities and sends this notification.
      await this.sendTerminal(final);
    }
    await this.cleanup(final);
  }
  async #acknowledgeNativeReceipt(state: JobState, receipt: D.CommitReceipt): Promise<void> {
    const known = await nativeContext(state);
    check(
      receipt.providerKind === "local" &&
        receipt.commitId === known.intent.commitId &&
        receipt.preparationId === known.prepared.preparationId,
      "conflict",
      "Native receipt acknowledgment identity changed",
    );
    const key = state.job.jobId,
      prior = await this.jobs.store.get<{
        commitId: string;
        commitDigest: string;
        acknowledged: boolean;
      }>("native-receipt-ack", key);
    if (prior) {
      check(
        prior.commitId === receipt.commitId && prior.commitDigest === receipt.commitDigest,
        "conflict",
        "Native receipt acknowledgment changed",
      );
      if (prior.acknowledged) return;
    }
    await this.jobs.store.put("native-receipt-ack", key, {
      commitId: receipt.commitId,
      commitDigest: receipt.commitDigest,
      acknowledged: false,
    });
    const auth = this.auth(state);
    const response: unknown = unwrap(
      await this.jobs.authority.control.requestLocalWorkspace(auth, {
        ...known.scope,
        kind: "receipt",
        preparationId: known.prepared.preparationId,
        receipt: publicCommitReceipt(receipt),
      }),
    );
    validate<D.TransportAck>("TransportAck", response);
    check(
      response.persisted &&
        response.deliveryId === receipt.commitId &&
        response.sequence === receipt.observationSeq,
      "conflict",
      "Native receipt acknowledgment lacks matching retained proof",
    );
    await this.jobs.authority.current(
      auth,
      scope({
        agentIds: [state.job.agentId],
        conversationIds: [state.job.conversationId],
        workspaceIds: [state.job.workspaceId],
        executorIds: [known.scope.executorId],
        tools: [state.operation.tool],
        actions: ["jobs.dispatch", "workspace.write"],
      }),
    );
    await this.jobs.store.put("native-receipt-ack", key, {
      commitId: receipt.commitId,
      commitDigest: receipt.commitDigest,
      acknowledged: true,
    });
  }
  private epoch(state: JobState): { connectionEpoch?: number } {
    check(
      state.executorEpoch === undefined ||
        (Number.isSafeInteger(state.executorEpoch) && state.executorEpoch > 0),
      "conflict",
      "Invalid retained executor epoch",
    );
    return state.executorEpoch === undefined ? {} : { connectionEpoch: state.executorEpoch };
  }
  private async sendTerminal(state: JobState): Promise<void> {
    const proof = await this.jobs.store.get<D.JobCommitted>(
      "terminal-notification",
      state.job.jobId,
    );
    if (!proof) return;
    check(proof.identity.target.kind === "executor", "conflict", "Wrong terminal target");
    const frame: D.ExecutorDelivery = {
      executorId: proof.identity.target.executorId,
      generation: proof.identity.target.generation,
      ...this.epoch(state),
      frame: { type: "job.committed", requestId: `terminal_${state.job.jobId}`, payload: proof },
    };
    unwrap(await this.jobs.authority.control.deliverExecutorFrame(this.auth(state), frame));
    await this.jobs.store.remove("terminal-notification", state.job.jobId);
  }
}
