import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, defineDoc } from "@earendil-works/pi-durable";
import { operationDigest } from "fortipi-contract";
import type { Conversations } from "../agent/conversations.js";
import type { ConversationRow } from "../agent/store.js";
import {
  check,
  digest,
  Lanes,
  permits,
  resourceAgent,
  resourceId,
  ServiceError,
  same,
  scope,
  unwrap,
} from "../api/common.js";
import type * as D from "../boundary/dto.js";
import type { Env } from "../boundary/env.js";
import type { Dispatch } from "./dispatch.js";
import { isTerminal, type JobState, type Jobs } from "./jobs.js";
import { operationalMetadata } from "./metadata.js";
import type { DispatchTask } from "./registry.js";

export const FreshJobDoc = defineDoc({
  kind: "fortipi.fresh-job-children",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: (): { children: Record<string, { jobId: string; child: number }> } => ({ children: {} }),
  checkpointWhen: () => true,
});
interface Authorization {
  key: string;
  payload: unknown;
  auth: D.AuthContext;
  grant: { grantId: string; version: number };
  oldJobId: string;
  expectedVersion: number;
  claimedVersion: number;
  newJobId: string;
  taskId: string;
  operation: D.ApprovalOperation;
  receipt: D.ReconcileReceipt;
}
/** A new explicit business authorization, never a retry of the old dispatch. */
export class FreshJobs {
  readonly jobs: Jobs;
  readonly dispatch: Dispatch;
  readonly conversations: Conversations;
  readonly env: Env;
  readonly token: () => DispatchTask;
  readonly #lanes = new Lanes();
  constructor(
    jobs: Jobs,
    dispatch: Dispatch,
    conversations: Conversations,
    env: Env,
    token: () => DispatchTask,
  ) {
    this.jobs = jobs;
    this.dispatch = dispatch;
    this.conversations = conversations;
    this.env = env;
    this.token = token;
  }
  #resources(state: JobState): D.ResourceScope {
    return scope({
      agentIds: [state.job.agentId],
      conversationIds: [state.job.conversationId],
      workspaceIds: [state.job.workspaceId],
      tools: [state.operation.tool],
      executorIds:
        state.operation.target.kind === "executor" ? [state.operation.target.executorId] : [],
      backendIds:
        state.operation.target.kind === "backend" ? [state.operation.target.backendId] : [],
      actions: [
        ...new Set([
          ...(state.reservation?.actions ?? []),
          "jobs.reconcile",
          "jobs.dispatch",
          "workspace.write",
        ]),
      ],
    });
  }
  async #current(auth: D.AuthContext, record: Authorization, state: JobState): Promise<void> {
    const ref = (ctx: D.AuthContext) => ({
      credentialId: ctx.credentialId,
      generation: ctx.generation,
      grantVersion: ctx.grantVersion,
      principalId: ctx.principalId,
      role: ctx.role,
      deploymentId: ctx.deploymentId,
    });
    const grant = auth.grants.find(
      (candidate) =>
        candidate.grantId === record.grant.grantId && candidate.version === record.grant.version,
    );
    check(
      same(ref(auth), ref(record.auth)) && grant && permits([grant], this.#resources(state)),
      "unauthorized",
      "Fresh job needs the same current bound business grant",
    );
    await this.jobs.authority.current(auth, this.#resources(state));
    const target = record.operation.target;
    check(
      target.generation >=
        ((await this.jobs.store.get<number>(
          "executor-floor",
          target.kind === "executor" ? target.executorId : target.backendId,
        )) ?? 0),
      "conflict",
      "Fresh target generation was revoked",
    );
  }
  async request(
    auth: D.AuthContext,
    oldJobId: string,
    input: D.ReconcileInput,
  ): Promise<D.ReconcileReceipt> {
    check(input.action.kind === "new-job", "invalid_request", "New job action required");
    const { authorizationId } = input.action,
      old = await this.jobs.state(oldJobId),
      resources = this.#resources(old),
      key = await digest({ principalId: auth.principalId, authorizationId }),
      payload = {
        oldJobId,
        expectedVersion: input.expectedVersion,
        ...(input.action.newJobId === undefined ? {} : { newJobId: input.action.newJobId }),
        authorizationId,
        reason: input.reason,
      };
    await this.jobs.authority.authorize(auth, "jobs.reconcile", old.job.conversationId, resources);
    const known = await this.jobs.store.get<Authorization>("fresh-authorization", key);
    if (known) {
      check(same(known.payload, payload), "conflict", "Business authorization identity changed");
      await this.#current(auth, known, old);
      await this.apply(key);
      return known.receipt;
    }
    const newJobId = input.action.newJobId ?? resourceId("j", old.job.agentId);
    check(
      newJobId !== oldJobId && resourceAgent(newJobId) === old.job.agentId,
      "invalid_request",
      "New job ID must route to its actual Agent and differ from the original",
    );
    const grant = auth.grants.find((candidate) => permits([candidate], resources));
    check(grant, "unauthorized", "One current grant must cover the whole fresh operation");
    let deadline = Math.min(
      Date.now() + 300000,
      auth.credentialExpiresAt ?? Number.MAX_SAFE_INTEGER,
      grant.expiresAt ?? Number.MAX_SAFE_INTEGER,
    );
    if (deadline === old.deadline) deadline--;
    check(deadline > Date.now(), "unauthorized", "Fresh authorization expired");
    const operation: D.ApprovalOperation = {
      ...old.operation,
      operationId: resourceId("m", old.job.agentId),
      operationDigest: await operationDigest({
        deploymentId: auth.deploymentId,
        agentId: old.job.agentId,
        conversationId: old.job.conversationId,
        tool: old.operation.tool,
        arguments: old.operation.arguments,
        workspaceId: old.job.workspaceId,
        baseRevision: old.job.baseRevision,
        target: old.operation.target,
        policyVersion: this.jobs.store.policy.version,
        grantVersion: auth.grantVersion,
        deadline,
      }),
      policyVersion: this.jobs.store.policy.version,
      grantVersion: auth.grantVersion,
      expiresAt: deadline,
    };
    check(
      operation.operationDigest !== old.operation.operationDigest,
      "conflict",
      "Fresh operation digest must differ",
    );
    const candidate: Authorization = {
      key,
      payload,
      auth,
      grant: { grantId: grant.grantId, version: grant.version },
      oldJobId,
      expectedVersion: input.expectedVersion,
      claimedVersion: input.expectedVersion + 1,
      newJobId,
      taskId: resourceId("t", old.job.agentId),
      operation,
      receipt: {
        operationId: resourceId("m", old.job.agentId),
        durableIntent: true,
        disposition: "new-job-requested",
        newJobId,
      },
    };
    const retained = await this.jobs.store.transaction(async (tx) => {
      const existing = await this.jobs.store.get<Authorization>("fresh-authorization", key, tx);
      if (existing) {
        check(same(existing.payload, payload), "conflict", "Business authorization changed");
        return existing;
      }
      const current = await this.jobs.state(oldJobId, tx);
      await this.jobs.authority.current(auth, resources, tx);
      check(
        current.job.version === input.expectedVersion && isTerminal(current.job),
        "conflict",
        "Original job disposition changed",
      );
      check(
        !(await this.jobs.store.get("job", newJobId, tx)) &&
          !(await this.jobs.store.get("fresh-job-id", newJobId, tx)),
        "conflict",
        "New job identity is already in use",
      );
      await this.jobs.store.put("fresh-job-id", newJobId, { authorization: key }, tx);
      await this.jobs.update(tx, current, {
        ...current.job,
        version: candidate.claimedVersion,
      } as D.Job);
      await this.jobs.store.put("fresh-authorization", key, candidate, tx);
      await this.jobs.store.put("fresh-job", key, candidate, tx, Date.now());
      return candidate;
    });
    await this.conversations.host.arm();
    await this.apply(key);
    return retained.receipt;
  }
  async apply(key: string): Promise<void> {
    await this.#lanes.run(key, async () => {
      const { store, authority } = this.jobs,
        record = await store.get<Authorization>("fresh-job", key);
      if (!record) return;
      const old = await this.jobs.state(record.oldJobId),
        auth = { ...record.auth, deadline: Date.now() + 30000 },
        resources = this.#resources(old);
      await authority.authorize(auth, "jobs.reconcile", old.job.conversationId, resources);
      await this.#current(auth, record, old);
      check(
        record.operation.expiresAt > Date.now() && old.job.version === record.claimedVersion,
        "conflict",
        "Fresh job deadline or original disposition changed",
      );
      let state = await store.get<JobState>("job", record.newJobId);
      if (!state) {
        const registration = unwrap(
          await authority.control.registerAuthorityRecipient(auth, {
            credential: {
              credentialId: auth.credentialId,
              generation: auth.generation,
              grantVersion: auth.grantVersion,
            },
            recipient: { kind: "agent", id: old.job.agentId },
            resources: { ...resources, actions: ["jobs.dispatch"] },
          }),
        );
        const jobAuth = { ...auth, registrationId: registration.registrationId },
          ws = unwrap(
            await authority.control.registerAuthorityRecipient(auth, {
              credential: {
                credentialId: auth.credentialId,
                generation: auth.generation,
                grantVersion: auth.grantVersion,
              },
              recipient: { kind: "workspace", id: old.job.workspaceId },
              resources: { ...resources, actions: ["jobs.dispatch", "workspace.write"] },
            }),
          );
        const binding = await operationalMetadata(
          this.env.WORKSPACES.getByName(old.job.workspaceId),
          { ...auth, registrationId: ws.registrationId },
          {
            agentId: old.job.agentId,
            conversationId: old.job.conversationId,
            workspaceId: old.job.workspaceId,
            baseRevision: old.job.baseRevision,
          },
        );
        check(
          binding.bindingVersion === old.bindingVersion &&
            record.operation.policyVersion === store.policy.version,
          "workspace.conflict",
          "Fresh job binding or policy drifted",
        );
        if (binding.config.kind === "local")
          check(
            record.operation.target.kind === "executor" &&
              binding.config.executorId === record.operation.target.executorId &&
              binding.config.rootBindingId === old.rootBindingId,
            "workspace.conflict",
            "Fresh job local target drifted",
          );
        let limits: D.ExecutorTransferLimits | undefined;
        if (record.operation.target.kind === "executor") {
          const target = unwrap(
            await authority.control.resolveExecutorGeneration(jobAuth, {
              workspaceId: old.job.workspaceId,
              bindingVersion: binding.bindingVersion,
              executorId: record.operation.target.executorId,
            }),
          );
          check(
            target.executorGeneration === record.operation.target.generation &&
              target.transferLimits,
            "conflict",
            "Fresh job executor generation/limits changed",
          );
          limits = target.transferLimits;
        }
        await this.#current(auth, record, old);
        const capacity = unwrap(
          await authority.control.reserveCapacity(jobAuth, {
            operationId: record.operation.operationId,
            ownerId: old.job.conversationId,
            policyVersion: record.operation.policyVersion,
            bytes: 16384,
            admissionSlots: 0,
          }),
        );
        const job: D.Job = {
          jobId: record.newJobId,
          agentId: old.job.agentId,
          conversationId: old.job.conversationId,
          taskId: record.taskId,
          workspaceId: old.job.workspaceId,
          baseRevision: old.job.baseRevision,
          operationDigest: record.operation.operationDigest,
          state: "created",
          version: 1,
        };
        await this.jobs.seed(
          jobAuth,
          {
            job,
            piTaskId: `reconcile:${key}`,
            capacityReservationId: capacity.reservationId,
            event: {
              ...this.jobs.event(old),
              type: "job.state.changed",
              jobId: job.jobId,
              taskId: job.taskId,
              payload: job,
            },
          },
          record.operation,
          binding.bindingVersion,
          record.operation.expiresAt,
          {
            standaloneTask: true,
            baseManifestHash: binding.manifestHash,
            ...(limits ? { executorTransferLimits: limits } : {}),
            ...(binding.config.kind === "local"
              ? { rootBindingId: binding.config.rootBindingId }
              : {}),
          },
        );
        state = await this.jobs.state(record.newJobId);
      }
      const conversation = await store.get<ConversationRow>("conversation", old.job.conversationId);
      check(conversation, "not_found", "Conversation provenance unavailable");
      const harness = await this.conversations.host.pi.pi(),
        task = this.token(),
        cap = Math.min(100, store.policy.bounds.queuedAdmissions);
      await this.#current(auth, record, old);
      const child = await harness.commit(async (tx) => {
        const doc = await tx.doc(FreshJobDoc, Number(conversation.piId) as ConversationId),
          prior = doc.children[key];
        if (prior) {
          check(prior.jobId === record.newJobId, "conflict", "Fresh child reference changed");
          return prior.child;
        }
        check(
          Object.keys(doc.children).length < cap,
          "quota_paused",
          "Fresh job reference capacity exhausted",
          {
            retryAfterMs: 0,
            pressure: {
              resource: "concurrency",
              scope: { kind: "object" },
              source: "policy",
              measurement: "observed",
              limit: cap,
              remaining: 0,
              reason: "Fresh job reference capacity exhausted",
              action: "reduce-work",
            },
          },
        );
        const child = await tx.createTask(
          task,
          { jobId: record.newJobId },
          {
            conversationId: Number(conversation.piId) as ConversationId,
            ownership: { kind: "conversation" },
            abandonOnRestart: false,
          },
        );
        doc.children[key] = { jobId: record.newJobId, child };
        return child;
      }, BACKGROUND_CONTEXT);
      await this.#current(auth, record, old);
      await store.transaction(async (tx) => {
        await authority.current(auth, resources, tx);
        const current = await this.jobs.state(record.oldJobId, tx);
        check(
          current.job.version === record.claimedVersion,
          "conflict",
          "Original disposition changed during child allocation",
        );
        await store.put(
          "fresh-child",
          record.newJobId,
          { child, conversationId: conversation.piId, authorization: key },
          tx,
        );
        await store.append(tx, `reconciled:${record.receipt.operationId}`, {
          ...this.jobs.event(current),
          type: "job.reconciled",
          payload: record.receipt,
        });
        await store.remove("fresh-job", key, tx);
      });
      await this.conversations.host.notify(old.job.conversationId);
    });
  }
  async drain(budget: D.DrainBudget): Promise<D.DrainProgress> {
    let processed = 0;
    for (const row of await this.jobs.store.page<Authorization>(
      "fresh-job",
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
            "workspace.conflict",
            "unsupported",
          ].includes(error.code);
        await this.jobs.store.put("fresh-job-error", row.id, {
          code: error instanceof ServiceError ? error.code : "interrupted",
        });
        await this.jobs.store.put(
          "fresh-job",
          row.id,
          row.value,
          undefined,
          permanent ? null : Date.now() + 30000,
        );
      }
      processed++;
    }
    const due = await this.jobs.store.db.get<{ due: number | null }>(
      "SELECT MIN(due) AS due FROM fp_records_v1 WHERE kind='fresh-job' AND due IS NOT NULL",
    );
    return {
      processed,
      remaining: due?.due != null,
      ...(due?.due != null ? { nextWakeAt: Math.max(Date.now() + 5000, due.due) } : {}),
    };
  }
}
