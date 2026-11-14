import { publicCommitReceipt } from "fortipi-contract";
import { check, Lanes, resourceId, ServiceError, same, scope, unwrap } from "../api/common.js";
import type * as D from "../boundary/dto.js";
import type { Env } from "../boundary/env.js";
import { isTerminal, type JobState, type Jobs } from "./jobs.js";

interface Intent {
  auth: D.AuthContext;
  jobId: string;
  input: D.ReconcileInput;
  receipt: D.ReconcileReceipt;
}
/** Reconciliation records new evidence; it never changes a consumed Pi outcome or repeats a dispatch. */
export class Reconciliation {
  readonly #lanes = new Lanes();
  readonly jobs: Jobs;
  readonly env: Env;
  readonly arm: () => Promise<void>;
  readonly notify: (cid: string) => Promise<void>;
  constructor(
    jobs: Jobs,
    env: Env,
    arm: () => Promise<void>,
    notify: (cid: string) => Promise<void>,
  ) {
    this.jobs = jobs;
    this.env = env;
    this.arm = arm;
    this.notify = notify;
  }
  #resources(state: JobState, write = false): D.ResourceScope {
    return scope({
      agentIds: [state.job.agentId],
      conversationIds: [state.job.conversationId],
      workspaceIds: [state.job.workspaceId],
      tools: [state.operation.tool],
      executorIds:
        state.operation.target.kind === "executor" ? [state.operation.target.executorId] : [],
      backendIds:
        state.operation.target.kind === "backend" ? [state.operation.target.backendId] : [],
      actions: write ? ["jobs.reconcile", "jobs.dispatch", "workspace.write"] : ["jobs.reconcile"],
    });
  }
  async request(
    auth: D.AuthContext,
    jobId: string,
    input: D.ReconcileInput,
  ): Promise<D.ReconcileReceipt> {
    check(
      input.action.kind !== "new-job",
      "unsupported",
      "Fresh job authorization contract is pending qualification",
    );
    const before = await this.jobs.state(jobId),
      write = ["accept-result", "discard-staging"].includes(input.action.kind);
    await this.jobs.authority.authorize(
      auth,
      "jobs.reconcile",
      before.job.conversationId,
      this.#resources(before, write),
    );
    const receipt = await this.jobs.store.once(
      "reconcile",
      `${auth.principalId}:${jobId}:${input.requestId}`,
      { jobId, input },
      async (tx) => {
        const state = await this.jobs.state(jobId, tx);
        await this.jobs.authority.current(auth, this.#resources(state, write), tx);
        check(
          state.job.version === input.expectedVersion &&
            isTerminal(state.job) &&
            state.job.state !== "completed",
          "conflict",
          "Reconciliation requires the expected unsettled terminal disposition",
        );
        if (input.action.kind === "acknowledge-failed")
          check(
            ["failed", "cancelled", "expired", "interrupted", "workspace_conflict"].includes(
              state.job.state,
            ),
            "conflict",
            "Unknown effects cannot be relabeled as a known failure",
          );
        if (input.action.kind === "acknowledge-unknown")
          check(
            ["requires_reconciliation", "interrupted"].includes(state.job.state),
            "conflict",
            "Job has no uncertain disposition",
          );
        if (input.action.kind === "discard-staging")
          check(
            state.job.preparedResult?.uploadId,
            "unsupported",
            "No retained upload to discard; native effects remain quarantined",
          );
        const receipt: D.ReconcileReceipt = {
          operationId: resourceId("m", state.job.agentId),
          durableIntent: true,
          disposition:
            input.action.kind === "accept-result"
              ? "result-verification-pending"
              : input.action.kind === "acknowledge-failed"
                ? "failed-acknowledged"
                : input.action.kind === "acknowledge-unknown"
                  ? "unknown-acknowledged"
                  : "staging-discarded",
        };
        await this.jobs.store.put(
          "reconciliation",
          receipt.operationId,
          { auth, input, jobId, receipt } satisfies Intent,
          tx,
          Date.now(),
        );
        return receipt;
      },
    );
    await this.arm();
    if (input.action.kind === "accept-result")
      await this.apply(receipt.operationId).catch(() => {});
    else {
      // This receipt names completed cleanup/acknowledgment. A durable pending
      // intent alone cannot advertise that an upload was actually discarded.
      await this.apply(receipt.operationId);
      check(
        await this.jobs.store.get("reconciled", receipt.operationId),
        "interrupted",
        "Reconciliation acknowledgment is still pending",
      );
    }
    return receipt;
  }
  async apply(operationId: string): Promise<void> {
    await this.#lanes.run(operationId, async () => {
      const { store, authority } = this.jobs,
        intent = await store.get<Intent>("reconciliation", operationId);
      if (!intent) return;
      const state = await this.jobs.state(intent.jobId),
        action = intent.input.action,
        auth = { ...intent.auth, deadline: Date.now() + 30000 },
        resources = this.#resources(
          state,
          action.kind === "accept-result" || action.kind === "discard-staging",
        );
      await authority.authorize(auth, "jobs.reconcile", state.job.conversationId, resources);
      check(
        state.job.version === intent.input.expectedVersion,
        "conflict",
        "Reconciliation disposition changed",
      );
      let verified: unknown;
      if (action.kind === "accept-result" || action.kind === "discard-staging") {
        const registration = unwrap(
          await authority.control.registerAuthorityRecipient(auth, {
            credential: {
              credentialId: auth.credentialId,
              generation: auth.generation,
              grantVersion: auth.grantVersion,
            },
            recipient: { kind: "workspace", id: state.job.workspaceId },
            resources: { ...resources, actions: ["workspace.write"] },
          }),
        );
        await authority.current(auth, resources);
        const wsAuth = { ...auth, registrationId: registration.registrationId },
          workspace = this.env.WORKSPACES.getByName(state.job.workspaceId);
        if (action.kind === "accept-result") {
          await this.jobs.requireObservationIdentity(state, action.result.identity);
          check(
            action.result.state === "succeeded" &&
              action.receipt.jobId === state.job.jobId &&
              action.receipt.operationId === state.operation.operationId &&
              action.receipt.workspaceId === state.job.workspaceId &&
              action.receipt.baseRevision === state.job.baseRevision &&
              action.receipt.commitId === action.result.commitId &&
              action.receipt.manifestHash === action.result.manifestHash,
            "conflict",
            "Reconciliation result and receipt differ",
          );
          const actual = unwrap(
            await workspace.getReceipt(wsAuth, {
              workspaceId: state.job.workspaceId,
              commitId: action.receipt.commitId,
              commitDigest: action.receipt.commitDigest,
            }),
          );
          check(
            same(publicCommitReceipt(actual), publicCommitReceipt(action.receipt)) &&
              actual.committedAt <= state.deadline &&
              (actual.providerKind !== "local" ||
                actual.preparationId === state.localPreparation?.preparationId) &&
              (actual.providerKind !== "computer" ||
                actual.storeRef.uploadId === action.result.uploadId),
            "conflict",
            "Reconciliation needs the actual matching retained Workspace receipt",
          );
          verified = { result: action.result, receipt: actual };
        } else {
          const uploadId = state.job.preparedResult?.uploadId;
          check(uploadId, "unsupported", "Retained upload unavailable");
          unwrap(
            await workspace.abortUpload(wsAuth, {
              operationId: "abortUpload",
              path: { workspaceId: state.job.workspaceId, uploadId },
              query: {},
              body: undefined,
            }),
          );
          verified = { uploadId, aborted: true };
        }
      }
      await store.transaction(async (tx) => {
        const current = await this.jobs.state(intent.jobId, tx);
        await authority.current(auth, resources, tx);
        check(
          current.job.version === intent.input.expectedVersion &&
            isTerminal(current.job) &&
            current.job.state !== "completed",
          "conflict",
          "Reconciliation changed during verification",
        );
        await store.put(
          "reconciled",
          operationId,
          {
            jobId: intent.jobId,
            input: intent.input,
            receipt: intent.receipt,
            ...(verified === undefined ? {} : { verified }),
            originalDisposition: current.job.state,
            piOutcomePreserved: true,
          },
          tx,
        );
        await this.jobs.update(tx, current, {
          ...current.job,
          version: current.job.version + 1,
        } as D.Job);
        await store.append(tx, `reconciled:${operationId}`, {
          ...this.jobs.event(current),
          type: "job.reconciled",
          payload: intent.receipt,
        });
        await store.remove("reconciliation", operationId, tx);
      });
      await this.notify(state.job.conversationId);
    });
  }
  async drain(budget: D.DrainBudget): Promise<D.DrainProgress> {
    const { store } = this.jobs;
    let processed = 0;
    for (const row of await store.page<Intent>(
      "reconciliation",
      Math.min(4, budget.maxItems),
      "",
      Date.now(),
    )) {
      if (Date.now() >= budget.deadline) break;
      try {
        await this.apply(row.id);
      } catch (error) {
        const permanent =
          error instanceof ServiceError &&
          [
            "unauthorized",
            "unauthenticated",
            "conflict",
            "unsupported",
            "invalid_request",
          ].includes(error.code);
        await store.put("reconciliation-error", row.id, {
          code: error instanceof ServiceError ? error.code : "interrupted",
        });
        await store.put(
          "reconciliation",
          row.id,
          row.value,
          undefined,
          permanent ? null : Date.now() + 30000,
        );
      }
      processed++;
    }
    const due = await store.db.get<{ due: number | null }>(
      "SELECT MIN(due) AS due FROM fp_records_v1 WHERE kind='reconciliation' AND due IS NOT NULL",
    );
    return {
      processed,
      remaining: due?.due != null,
      ...(due?.due != null ? { nextWakeAt: Math.max(Date.now() + 5000, due.due) } : {}),
    };
  }
}
