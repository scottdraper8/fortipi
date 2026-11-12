import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import { check, ServiceError, same } from "../api/common.js";
import type * as D from "../boundary/dto.js";
import type { Admission, AdmissionIntent, Conversations, CreationIntent } from "./conversations.js";
import { repairRetryAt } from "./repair-retry.js";
import type { ConversationRow } from "./store.js";

export class Projection {
  readonly conversations: Conversations;
  constructor(conversations: Conversations) {
    this.conversations = conversations;
  }
  async entries(cid: string): Promise<boolean> {
    const { store, pi } = this.conversations.host;
    const row = await store.get<ConversationRow>("conversation", cid);
    check(row, "not_found", "Conversation unavailable");
    // Pi may publish its user entry before the app receives the admission reply.
    // Preserve causal order until every earlier placed input has its canonical ID.
    const unmapped = await store.db.get<{ id: string }>(
      "SELECT id FROM fp_records_v1 WHERE kind='input-pending' AND id>=? AND id<? LIMIT 1",
      `${cid}:`,
      `${cid};`,
    );
    if (unmapped) return true;
    const page = await pi.session(row.piId).entries(
      {
        order: "ascending",
        ...(row.bookmark ? { minEntryId: Number(row.bookmark) as EntryId } : {}),
      },
      100,
      BACKGROUND_CONTEXT,
    );
    for (const entry of page.items)
      if (!row.bookmark || entry.id > Number(row.bookmark))
        await this.conversations.projectEntry(row, entry);
    return !!page.next;
  }
  async admission(admission: Admission): Promise<boolean> {
    const { store, pi } = this.conversations.host;
    if (admission.state === "pending" || admission.state === "rejection_pending")
      await this.conversations.finishAdmission(admission);
    admission = (await store.get<Admission>("admission", admission.key))!;
    const row = await store.get<ConversationRow>("conversation", admission.conversationId);
    check(row, "not_found", "Conversation unavailable");
    const harness = await pi.pi();
    const record = await harness.commit(
      (tx) =>
        tx.submissionByRequest(
          Number(row.piId) as ConversationId,
          admission.continuation?.operationId ?? admission.operationId,
        ),
      BACKGROUND_CONTEXT,
    );
    check(record, "interrupted", "Committed admission missing");
    if (record.entry || record.status === "unanswered") {
      await store.transaction(async (tx) => {
        if (record.entry) {
          await store.put(
            "input-entry",
            `${row.piId}:${record.entry}`,
            { messageId: admission.messageId },
            tx,
          );
          const message = await tx.get<{ data: string }>(
            "SELECT data FROM fp_messages_v1 WHERE conversation=? AND id=?",
            admission.conversationId,
            admission.messageId,
          );
          if (message)
            await store.put(
              "entry-public",
              `${row.piId}:${record.entry}`,
              JSON.parse(message.data),
              tx,
            );
          if (admission.receipt)
            await store.put(
              "entry-event",
              `${admission.conversationId}:${admission.receipt.eventSeq}`,
              { entry: record.entry },
              tx,
            );
        }
        await store.remove(
          "input-pending",
          `${admission.conversationId}:${admission.operationId}`,
          tx,
        );
      });
    }
    const more = await this.entries(admission.conversationId);
    let status: D.TaskState =
      record.status === "done"
        ? { state: "completed" }
        : record.status === "unanswered"
          ? record.reason === "aborted" || record.reason === "withdrawn"
            ? { state: "cancelled" }
            : {
                state: "waiting",
                reason: "kept-input",
                supportedContinuations: ["resume", "next-submit"],
              }
          : record.status === "queued"
            ? { state: "queued" }
            : { state: "running" };
    if (record.status === "placed")
      status = (await store.get<D.TaskState>("task-wait", admission.taskId)) ?? status;
    await store.transaction(async (tx) => {
      const current = await store.get<D.Task>("task", admission.taskId, tx);
      check(current, "interrupted", "Task projection missing");
      if (!same(status, current.status)) {
        const task: D.Task = { ...current, status, version: current.version + 1 };
        await store.put("task", task.taskId, task, tx);
        const type =
          status.state === "completed"
            ? "task.completed"
            : status.state === "running"
              ? "task.running"
              : status.state === "queued"
                ? "task.queued"
                : status.state === "waiting"
                  ? "task.waiting"
                  : "task.interrupted";
        await store.append(tx, `task:${task.taskId}:${task.version}`, {
          ...this.conversations.draft(admission.conversationId),
          deploymentId: admission.auth.deploymentId,
          type,
          payload: task,
          taskId: task.taskId,
        });
      }
      if ((record.status === "done" || record.status === "unanswered") && !more) {
        admission.state = "settlement_pending";
        await store.put("admission", admission.key, admission, tx, Date.now());
      }
    });
    if (admission.state === "settlement_pending") {
      const settled = await this.conversations.host.authority.control.settleCapacity(
        { ...(admission.continuation?.auth ?? admission.auth), deadline: Date.now() + 30000 },
        {
          reservationId: (admission.continuation?.capacity ?? admission.capacity).reservationId,
          disposition: "consumed",
        },
      );
      if (settled.ok) {
        admission.state = "settled";
        await store.transaction(async (tx) => {
          await store.put("admission", admission.key, admission, tx);
          await this.conversations.host.authority.physical.completed(
            (admission.continuation?.capacity ?? admission.capacity).reservationId,
            tx,
            admission.continuation?.operationId ?? admission.operationId,
          );
        });
      } else {
        const retryAt = Date.now() + (settled.details?.retryAfterMs ?? 30000);
        await store.put("settlement-pressure", admission.key, {
          code: settled.code,
          details: settled.details ?? null,
        });
        await store.put("admission", admission.key, admission, undefined, retryAt);
      }
    }
    await this.conversations.host.notify(admission.conversationId);
    return admission.state !== "settled" || more;
  }
  async drain(budget: D.DrainBudget): Promise<D.DrainProgress> {
    const { store } = this.conversations.host;
    let processed = 0,
      remaining = false;
    const cap = Math.min(100, budget.maxItems);
    for (const row of await store.page<AdmissionIntent>(
      "admission-intent",
      Math.min(4, cap),
      "",
      Date.now(),
    )) {
      if (processed >= cap || Date.now() >= budget.deadline) {
        remaining = true;
        break;
      }
      try {
        await this.conversations.lanes.run(row.value.conversationId, async () => {
          const current = await store.db.get<{ data: string }>(
            "SELECT data FROM fp_records_v1 WHERE kind='admission-intent' AND id=? AND due<=?",
            row.id,
            Date.now(),
          );
          if (current)
            await this.conversations.finishSubmission(JSON.parse(current.data) as AdmissionIntent);
        });
      } catch (error) {
        const permanent =
          error instanceof ServiceError &&
          (error.code === "unauthorized" || error.code === "unauthenticated");
        const retryAt = repairRetryAt(error);
        await store.put("admission-pressure", row.id, {
          code: error instanceof ServiceError ? error.code : "interrupted",
          requiresCurrentAuthority: permanent,
          retryAt,
        });
        if (retryAt !== null) remaining = true;
      }
      processed++;
    }
    for (const row of await store.page<CreationIntent>(
      "creation",
      Math.min(4, Math.max(0, cap - processed)),
      "",
      Date.now(),
    )) {
      if (Date.now() >= budget.deadline) {
        remaining = true;
        break;
      }
      try {
        await this.conversations.lanes.run("creation", async () => {
          const current = await store.db.get<{ data: string }>(
            "SELECT data FROM fp_records_v1 WHERE kind='creation' AND id=? AND due<=?",
            row.id,
            Date.now(),
          );
          if (current)
            await this.conversations.finishCreation(JSON.parse(current.data) as CreationIntent);
        });
      } catch (error) {
        const retryAt = repairRetryAt(error);
        if (retryAt !== null) remaining = true;
      }
      processed++;
    }
    for (const row of await store.page<Admission>(
      "admission",
      Math.max(1, cap - processed),
      "",
      Date.now(),
    )) {
      if (processed >= cap || Date.now() >= budget.deadline) {
        remaining = true;
        break;
      }
      try {
        remaining =
          (await this.conversations.lanes.run(row.value.conversationId, () =>
            this.admission(row.value),
          )) || remaining;
      } catch {
        remaining = true;
      }
      processed++;
    }
    for (const row of await store.page<{ piId: string }>(
      "dirty",
      Math.max(1, cap - processed),
      "",
      Date.now(),
    )) {
      if (processed >= cap || Date.now() >= budget.deadline) {
        remaining = true;
        break;
      }
      try {
        const more = await this.entries(row.id);
        if (more) remaining = true;
        else await store.remove("dirty", row.id);
        remaining = (await store.retain(row.id)) || remaining;
        await this.conversations.host.notify(row.id);
      } catch {
        remaining = true;
      }
      processed++;
    }
    const due = await store.db.get<{ due: number | null }>(
      "SELECT MIN(due) AS due FROM fp_records_v1 WHERE kind IN ('admission-intent','admission','creation','dirty') AND due IS NOT NULL",
    );
    if (due?.due !== null && due?.due !== undefined) remaining = true;
    return {
      processed,
      remaining,
      ...(remaining ? { nextWakeAt: Math.max(Date.now() + 5000, due?.due ?? 0) } : {}),
    };
  }
}
