import { FortiPiClient, FortiPiError } from "fortipi-client/node";
import type { AdmissionReceipt, DurableEvent, Task } from "fortipi-contract";
import { canonicalJson } from "fortipi-contract";
import { Controller } from "./controller.js";

export interface SmokeOptions {
  agentId?: string;
  conversationId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  observe?(phase: string, ids?: Record<string, string | number>): void;
}
function terminal(task: Task): boolean {
  return ["completed", "failed", "cancelled", "interrupted"].includes(task.status.state);
}
async function until(
  controller: Controller,
  signal: AbortSignal,
  predicate: () => boolean,
): Promise<void> {
  if (predicate()) return;
  await new Promise<void>((resolve, reject) => {
    const clean = () => {
      remove();
      signal.removeEventListener("abort", abort);
    };
    const remove = controller.listen(() => {
      if (predicate()) {
        clean();
        resolve();
      }
    });
    const abort = () => {
      clean();
      reject(new FortiPiError("smoke_deadline"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
async function completed(
  controller: Controller,
  receipt: AdmissionReceipt,
  signal: AbortSignal,
): Promise<void> {
  await until(controller, signal, () => {
    const task = controller.projection.tasks.get(receipt.taskId);
    return (
      !!task &&
      terminal(task) &&
      (task.status.state !== "completed" ||
        controller.projection.assistantTasks.has(receipt.taskId))
    );
  });
  if (controller.projection.tasks.get(receipt.taskId)?.status.state !== "completed")
    throw new FortiPiError("smoke_task_failed");
}
/** Runs the interactive controller, including disconnect/reconnect. Requires a real usable service and grants. */
export async function smoke(controller: Controller, options: SmokeOptions = {}): Promise<void> {
  const deadline = AbortSignal.timeout(Math.min(120000, options.timeoutMs ?? 120000));
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const observe = options.observe ?? (() => {});
  let second: Controller | undefined;
  const stop = () => {
    controller.close();
    second?.close();
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    observe("discovery");
    await controller.client.negotiate(signal);
    if (options.conversationId) await controller.open(options.conversationId);
    else {
      await controller.browse("agents");
      controller.agentId = options.agentId ?? controller.choices[0]?.id;
      if (!controller.agentId) throw new FortiPiError("smoke_agent_required");
      await controller.create("FortiPi smoke");
    }
    const conversationId = controller.conversationId;
    if (!conversationId) throw new FortiPiError("smoke_conversation_required");
    observe("subscribed", { conversationId });
    controller.composer = "Reply briefly with the word ready.";
    const first = await controller.send();
    await completed(controller, first, signal);
    const saved = controller.projection.cursor;
    const before = [...controller.projection.appliedIds];
    await controller.disconnect();
    observe("offline", { cursor: saved, taskId: first.taskId });
    second = new Controller(new FortiPiClient(controller.client.http.options));
    await second.open(conversationId);
    second.composer = "Reply briefly with the word replay.";
    const other = await second.send();
    await completed(second, other, signal);
    if (controller.projection.cursor !== saved)
      throw new FortiPiError("smoke_offline_cursor_changed");
    await second.disconnect();
    const stored: DurableEvent[] = [];
    let after = saved;
    let through: number | undefined;
    do {
      const page = await controller.client.conversations.events(
        conversationId,
        { after, ...(through === undefined ? {} : { through }) },
        { signal },
      );
      through ??= page.through;
      for (const event of page.events) {
        if (event.eventSeq !== after + 1) throw new FortiPiError("smoke_stored_gap");
        stored.push(event);
        after = event.eventSeq;
      }
      if (page.nextAfter !== after || (page.hasMore && !page.events.length))
        throw new FortiPiError("smoke_stored_gap");
      if (!page.hasMore) break;
    } while (!signal.aborted);
    if (!stored.length) throw new FortiPiError("smoke_no_offline_activity");
    await controller.reconnect();
    await until(controller, signal, () => controller.projection.cursor >= after);
    const applied = controller.projection.appliedIds;
    if (
      JSON.stringify(applied.slice(0, before.length)) !== JSON.stringify(before) ||
      JSON.stringify(applied.slice(before.length, before.length + stored.length)) !==
        JSON.stringify(stored.map((event) => event.eventId)) ||
      new Set(applied).size !== applied.length
    )
      throw new FortiPiError("smoke_replay_mismatch");
    const snapshot = await controller.client.conversations.get(conversationId, { signal });
    const rendered = controller.projection.snapshot?.messages;
    if (
      canonicalJson(rendered) !== canonicalJson(snapshot.messages) ||
      canonicalJson(controller.projection.snapshot?.conversation.taskState) !==
        canonicalJson(snapshot.conversation.taskState) ||
      controller.projection.cursor !== snapshot.lastEventSeq
    )
      throw new FortiPiError("smoke_snapshot_mismatch");
    await controller.task(other.taskId);
    const cancellation = await controller.cancel(other.taskId);
    if (cancellation.disposition.state !== "already-terminal")
      throw new FortiPiError("smoke_terminal_cancel_mismatch");
    observe("passed", {
      conversationId,
      taskId: other.taskId,
      cursor: controller.projection.cursor,
    });
  } finally {
    signal.removeEventListener("abort", stop);
    second?.close();
    controller.close();
  }
}
