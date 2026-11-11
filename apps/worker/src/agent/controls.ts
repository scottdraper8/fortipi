import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { check, resourceId, ServiceError, scope, unwrap } from "../api/common.js";
import type * as D from "../boundary/dto.js";
import { isTerminal, type Jobs } from "../execution/jobs.js";
import type { Admission, Conversations } from "./conversations.js";
import type { ConversationRow } from "./store.js";

type Input = D.OperationRequest<"cancelTask" | "resumeTask">;
interface ControlIntent {
  auth: D.AuthContext;
  input: Input;
  admission: string;
  standaloneJobId?: string;
  receipt: D.ControlReceipt;
  after: string;
  capacity?: D.CapacityReservation;
  growthBytes?: number;
}
/** Persisted control intent; Lifecycle/Pi retain sole ownership of wake/execution. */
export class Controls {
  readonly conversations: Conversations;
  readonly jobs: Jobs;
  constructor(conversations: Conversations, jobs: Jobs) {
    this.conversations = conversations;
    this.jobs = jobs;
  }
  async request(auth: D.AuthContext, input: Input): Promise<D.ControlReceipt> {
    const { store, agentId } = this.conversations.host;
    const mapped = await store.get<{ key: string }>("task-admission", input.path.id);
    if (!mapped) {
      const standalone = await store.get<{ jobId: string }>("standalone-task", input.path.id);
      if (standalone) return this.#standaloneRequest(auth, input, standalone.jobId);
    }
    check(mapped, "not_found", "Task admission unavailable");
    const key = `${auth.principalId}:${input.path.id}:${input.body.requestId}`;
    const receipt = await store.once("task-control", key, input, async (tx) => {
      if (input.operationId === "resumeTask") {
        const task = await store.get<D.Task>("task", input.path.id, tx);
        check(
          input.body.continuation === "resume" &&
            task?.status.state === "waiting" &&
            task.status.supportedContinuations?.includes("resume"),
          "unsupported",
          "Requested continuation is unavailable",
          {
            supportedContinuations:
              task?.status.state === "waiting" ? task.status.supportedContinuations : [],
          },
        );
      }
      const receipt: D.ControlReceipt = {
        operationId: resourceId("m", agentId),
        durableIntent: true,
        disposition: {
          state: "unknown",
          possibleExternalEffects: input.operationId === "cancelTask",
        },
      };
      const growthBytes = input.operationId === "resumeTask" ? store.modelGrowth() : undefined;
      if (growthBytes !== undefined) {
        const admission = await store.get<Admission>("admission", mapped.key, tx);
        check(admission, "not_found", "Task admission unavailable");
        await this.conversations.host.authority.current(
          auth,
          scope({
            agentIds: [agentId],
            conversationIds: [admission.conversationId],
            actions: ["tasks.resume"],
          }),
          tx,
        );
        await store.claimGrowth(receipt.operationId, growthBytes, tx);
      }
      await store.put(
        "control",
        receipt.operationId,
        {
          auth,
          input,
          admission: mapped.key,
          receipt,
          after: "",
          ...(growthBytes === undefined ? {} : { growthBytes }),
        } satisfies ControlIntent,
        tx,
        Date.now(),
      );
      return receipt;
    });
    await this.conversations.host.arm();
    // A failed/delayed delivery does not revoke the acknowledged durable intent.
    await this.apply(receipt.operationId).catch(() => {});
    return receipt;
  }
  async apply(id: string): Promise<void> {
    const { store, authority, pi } = this.conversations.host;
    const pending = await store.get<ControlIntent>("control", id);
    if (!pending) return;
    if (pending.standaloneJobId) return this.#standaloneApply(id, pending);
    const admission = await store.get<Admission>("admission", pending.admission);
    check(admission, "not_found", "Task admission unavailable");
    await this.conversations.lanes.run(admission.conversationId, async () => {
      const intent = await store.get<ControlIntent>("control", id);
      if (!intent) return;
      const auth = { ...intent.auth, deadline: Date.now() + 30000 };
      const action = intent.input.operationId === "cancelTask" ? "tasks.cancel" : "tasks.resume";
      await authority.authorize(auth, action, admission.conversationId);
      const row = await store.get<ConversationRow>("conversation", admission.conversationId);
      check(row, "not_found", "Conversation unavailable");
      if (intent.input.operationId === "cancelTask") {
        const cancel = intent.input.body;
        const lower = `${intent.input.path.id}:`,
          upper = `${intent.input.path.id};`;
        const batch = await store.db.all<{ id: string; data: string }>(
          "SELECT id,data FROM fp_records_v1 WHERE kind='task-job' AND id>? AND id<? ORDER BY id LIMIT 16",
          intent.after || lower,
          upper,
        );
        await store.transaction(async (tx) => {
          await authority.current(
            auth,
            scope({
              agentIds: [authority.agentId],
              conversationIds: [admission.conversationId],
              actions: [action],
            }),
            tx,
          );
          for (const ref of batch) {
            const job = await this.jobs.state(
              (JSON.parse(ref.data) as { jobId: string }).jobId,
              tx,
            );
            if (!isTerminal(job.job)) {
              job.cancel = { requestId: id, ...(cancel.reason ? { reason: cancel.reason } : {}) };
              await store.put("job", job.job.jobId, job, tx, Date.now());
            }
          }
          if (batch.at(-1)) intent.after = batch.at(-1)!.id;
          await store.put("control", id, intent, tx, Date.now());
        });
        if (batch.length === 16) return;
        await pi
          .session(row.piId)
          .abort(admission.continuation?.operationId ?? admission.operationId);
      } else {
        const model = await this.conversations.host.selectModel(
          auth,
          action,
          admission.conversationId,
        );
        if (!intent.capacity) {
          await authority.physical.beforeGrowth(
            auth,
            scope({
              agentIds: [authority.agentId],
              conversationIds: [admission.conversationId],
              actions: [action],
            }),
          );
          intent.capacity = unwrap(
            await authority.control.reserveCapacity(auth, {
              operationId: id,
              ownerId: admission.conversationId,
              policyVersion: 1,
              bytes: intent.growthBytes ?? 8192,
              admissionSlots: 1,
            }),
          );
          await store.transaction(async (tx) => {
            await authority.current(
              auth,
              scope({
                agentIds: [authority.agentId],
                conversationIds: [admission.conversationId],
                actions: [action],
              }),
              tx,
            );
            await store.bindGrowth(id, intent.capacity!.reservationId, tx);
            await store.put("control", id, intent, tx, Date.now());
          });
        }
        const harness = await pi.pi();
        const submission = await harness.commit(
          (tx) => tx.submissionByRequest(Number(row.piId) as ConversationId, id),
          BACKGROUND_CONTEXT,
        );
        // Associate resumed tool authority before Pi can run it. No new user input.
        await store.transaction(async (tx) => {
          await authority.current(
            auth,
            scope({
              agentIds: [authority.agentId],
              conversationIds: [admission.conversationId],
              actions: [action],
            }),
            tx,
          );
          const current = await store.get<Admission>("admission", intent.admission, tx);
          check(current, "not_found", "Task admission unavailable");
          current.continuation = { operationId: id, auth: intent.auth, capacity: intent.capacity! };
          current.state = "accepted";
          current.model = model;
          await store.put("admission", current.key, current, tx, Date.now());
          await store.put("operation-admission", id, { key: current.key }, tx);
        });
        if (!submission) {
          await pi.session(row.piId).setModel({ provider: model.providerId, id: model.modelId });
          await this.conversations.configureRun(auth, row.piId, admission.conversationId, action);
          await pi.session(row.piId).continue({ operationId: id });
        }
      }
      await store.remove("control", id);
      await store.put("dirty", admission.conversationId, { piId: row.piId }, undefined, Date.now());
    });
  }
  async #standaloneRequest(
    auth: D.AuthContext,
    input: Input,
    jobId: string,
  ): Promise<D.ControlReceipt> {
    check(
      input.operationId === "cancelTask",
      "unsupported",
      "A fresh standalone job has no message continuation",
    );
    const { store, authority } = this.conversations.host,
      state = await this.jobs.state(jobId),
      resources = scope({
        agentIds: [state.job.agentId],
        conversationIds: [state.job.conversationId],
        workspaceIds: [state.job.workspaceId],
        tools: [state.operation.tool],
        actions: ["tasks.cancel"],
        executorIds:
          state.operation.target.kind === "executor" ? [state.operation.target.executorId] : [],
        backendIds:
          state.operation.target.kind === "backend" ? [state.operation.target.backendId] : [],
      });
    await authority.authorize(auth, "tasks.cancel", state.job.conversationId, resources);
    const receipt = await store.once(
      "task-control",
      `${auth.principalId}:${input.path.id}:${input.body.requestId}`,
      input,
      async (tx) => {
        const current = await this.jobs.state(jobId, tx);
        await authority.current(auth, resources, tx);
        const receipt: D.ControlReceipt = {
          operationId: resourceId("m", authority.agentId),
          durableIntent: true,
          disposition: { state: "unknown", possibleExternalEffects: !!current.assignment },
        };
        if (!isTerminal(current.job)) {
          current.cancel = {
            requestId: receipt.operationId,
            ...(input.body.reason ? { reason: input.body.reason } : {}),
          };
          await store.put("job", jobId, current, tx, Date.now());
        }
        await store.put(
          "control",
          receipt.operationId,
          {
            auth,
            input,
            admission: "",
            standaloneJobId: jobId,
            receipt,
            after: "",
          } satisfies ControlIntent,
          tx,
          Date.now(),
        );
        return receipt;
      },
    );
    await this.conversations.host.arm();
    await this.apply(receipt.operationId).catch(() => {});
    return receipt;
  }
  async #standaloneApply(id: string, pending: ControlIntent): Promise<void> {
    check(pending.standaloneJobId, "conflict", "Standalone job mapping missing");
    const { store, authority, pi } = this.conversations.host,
      state = await this.jobs.state(pending.standaloneJobId),
      auth = { ...pending.auth, deadline: Date.now() + 30000 },
      resources = scope({
        agentIds: [state.job.agentId],
        conversationIds: [state.job.conversationId],
        workspaceIds: [state.job.workspaceId],
        tools: [state.operation.tool],
        actions: ["tasks.cancel"],
        executorIds:
          state.operation.target.kind === "executor" ? [state.operation.target.executorId] : [],
        backendIds:
          state.operation.target.kind === "backend" ? [state.operation.target.backendId] : [],
      });
    await authority.authorize(auth, "tasks.cancel", state.job.conversationId, resources);
    await store.transaction(async (tx) => {
      const current = await this.jobs.state(state.job.jobId, tx);
      await authority.current(auth, resources, tx);
      if (!isTerminal(current.job)) {
        check(
          !current.assignment,
          "unsupported",
          "Dispatched standalone cancellation still needs execution reconciliation",
        );
        await this.jobs.update(tx, current, {
          ...current.job,
          state: "cancelled",
          version: current.job.version + 1,
        } as D.Job);
      }
      await authority.current(auth, resources, tx);
    });
    const child = await store.get<{ child: number }>("fresh-child", state.job.jobId);
    if (child) {
      const harness = await pi.pi();
      await authority.current(auth, resources);
      await harness.abortTask(
        child.child as import("@earendil-works/pi-durable").TaskId,
        BACKGROUND_CONTEXT,
      );
      await authority.current(auth, resources);
    }
    await store.remove("control", id);
  }
  async drain(budget: D.DrainBudget): Promise<D.DrainProgress> {
    const { store } = this.conversations.host;
    let processed = 0;
    for (const row of await store.page<ControlIntent>(
      "control",
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
          ["unauthorized", "unauthenticated", "unsupported", "conflict"].includes(error.code);
        await store.put("control-pressure", row.id, {
          code: error instanceof ServiceError ? error.code : "interrupted",
        });
        await store.put(
          "control",
          row.id,
          row.value,
          undefined,
          permanent ? null : Date.now() + 30000,
        );
      }
      processed++;
    }
    const due = await store.db.get<{ due: number | null }>(
      "SELECT MIN(due) AS due FROM fp_records_v1 WHERE kind='control' AND due IS NOT NULL",
    );
    return {
      processed,
      remaining: due?.due != null,
      ...(due?.due != null ? { nextWakeAt: Math.max(Date.now() + 5000, due.due) } : {}),
    };
  }
}
