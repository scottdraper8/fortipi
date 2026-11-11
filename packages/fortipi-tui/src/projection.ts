import type {
  Approval,
  ApprovalOperation,
  ByteReference,
  ClientEvent,
  ConversationProjection,
  DurableEvent,
  Job,
  KnownDurableEvent,
  KnownVolatileEvent,
  Task,
  WorkspaceBinding,
} from "fortipi-contract";
import { isKnownEventType } from "fortipi-contract";

export class Projection {
  snapshot: ConversationProjection | undefined;
  readonly tasks = new Map<string, Task>();
  readonly jobs = new Map<string, Job>();
  readonly approvals = new Map<string, Approval>();
  readonly tools = new Map<string, ApprovalOperation>();
  readonly output = new Map<string, string>();
  private readonly outputSequence = new Map<string, number>();
  readonly artifacts = new Map<string, ByteReference>();
  readonly workspaceState = new Map<string, string>();
  readonly appliedIds: string[] = [];
  readonly assistantTasks = new Set<string>();
  readonly generic: string[] = [];
  workspace: WorkspaceBinding | undefined;
  cursor = 0;
  readonly tailBytes: number;
  constructor(tailBytes = 32768) {
    this.tailBytes = tailBytes;
  }
  replace(snapshot: ConversationProjection): void {
    this.snapshot = structuredClone(snapshot);
    this.tasks.clear();
    this.jobs.clear();
    this.approvals.clear();
    this.tools.clear();
    this.output.clear();
    this.outputSequence.clear();
    this.artifacts.clear();
    this.workspaceState.clear();
    this.appliedIds.length = 0;
    this.assistantTasks.clear();
    this.generic.length = 0;
    this.cursor = snapshot.lastEventSeq;
  }
  apply(event: ClientEvent): void {
    if (event.durability === "volatile") {
      const volatile = event as KnownVolatileEvent;
      if (volatile.type === "message.delta")
        this.tail(volatile.payload.messageId, volatile.payload.text);
      if (
        volatile.type === "tool.execution.output" &&
        volatile.payload.sequence > (this.outputSequence.get(volatile.payload.jobId) ?? -1)
      ) {
        this.outputSequence.set(volatile.payload.jobId, volatile.payload.sequence);
        this.tail(volatile.payload.jobId, volatile.payload.text);
      }
      return;
    }
    this.cursor = event.eventSeq;
    if (this.snapshot) this.snapshot.lastEventSeq = this.cursor;
    this.appliedIds.push(event.eventId);
    if (this.appliedIds.length > 4096) this.appliedIds.shift();
    if (!isKnownEventType(event.type)) {
      this.generic.push(`${event.type} ${event.eventId}`);
      if (this.generic.length > 100) this.generic.shift();
      return;
    }
    this.applyKnown(event as KnownDurableEvent);
  }
  /** Rebuild metadata through a snapshot barrier without replaying its messages or cursor. */
  restoreContext(event: DurableEvent): void {
    if (
      event.type === "message.completed" &&
      event.taskId &&
      (event as KnownDurableEvent & { type: "message.completed" }).payload.role === "assistant"
    )
      this.recordAssistantTask(event.taskId);
    if (
      !isKnownEventType(event.type) ||
      event.type.startsWith("message.") ||
      event.type.startsWith("conversation.")
    )
      return;
    this.applyKnown(event as KnownDurableEvent);
  }
  private applyKnown(known: KnownDurableEvent): void {
    switch (known.type) {
      case "message.committed":
      case "message.completed": {
        if (known.payload.role === "assistant" && known.taskId)
          this.recordAssistantTask(known.taskId);
        if (!this.snapshot) break;
        const messages = this.snapshot.messages;
        const index = messages.findIndex(
          (message) => message.messageId === known.payload.messageId,
        );
        if (index < 0) messages.push(known.payload);
        else messages[index] = known.payload;
        if (messages.length > 100) messages.shift();
        this.output.delete(known.payload.messageId);
        break;
      }
      case "conversation.created":
      case "conversation.updated":
        if (this.snapshot) {
          this.snapshot.conversation = known.payload;
          this.snapshot.projectionRevision = known.payload.revision;
        }
        break;
      case "tool.execution.requested":
        this.tools.set(known.toolCallId ?? known.payload.operationId, known.payload);
        break;
      case "task.queued":
      case "task.running":
      case "task.waiting":
      case "task.completed":
      case "task.interrupted":
        this.tasks.set(known.payload.taskId, known.payload);
        if (this.snapshot) this.snapshot.conversation.taskState = known.payload.status;
        break;
      case "approval.requested":
      case "approval.resolved":
      case "approval.expired":
        this.approvals.set(known.payload.approvalId, known.payload);
        break;
      case "job.state.changed":
        this.jobs.set(known.payload.jobId, known.payload);
        break;
      case "tool.execution.completed":
        this.output.delete(known.payload.jobId);
        this.tail(known.payload.jobId, known.payload.result.output.tail);
        for (const ref of known.payload.result.output.artifacts)
          this.artifacts.set(ref.artifactId ?? ref.sha256, ref);
        this.workspaceState.set(
          known.payload.result.identity.lease.workspaceId,
          known.payload.receipt
            ? `committed ${known.payload.receipt.revision}`
            : "result_pending_commit",
        );
        break;
      case "workspace.revision.committed":
        this.workspaceState.set(known.payload.workspaceId, `committed ${known.payload.revision}`);
        break;
      case "workspace.sync.required":
        this.workspaceState.set(
          known.payload.workspaceId,
          `sync required ${known.payload.revision}`,
        );
        break;
      case "workspace.conflict":
        this.workspaceState.set(known.payload.workspaceId, `conflict ${known.payload.reason}`);
        break;
      default:
        this.generic.push(`${known.type} ${known.eventId}`);
        if (this.generic.length > 100) this.generic.shift();
    }
    for (const map of [
      this.tasks,
      this.jobs,
      this.approvals,
      this.tools,
      this.output,
      this.outputSequence,
      this.artifacts,
      this.workspaceState,
    ])
      while (map.size > 100) {
        const key = map.keys().next().value;
        if (key) map.delete(key);
        else break;
      }
  }
  private tail(id: string, text: string): void {
    const bytes = new TextEncoder().encode((this.output.get(id) ?? "") + text);
    this.output.set(id, new TextDecoder().decode(bytes.slice(-this.tailBytes)));
    while (this.output.size > 100) {
      const key = this.output.keys().next().value;
      if (!key) break;
      this.output.delete(key);
    }
  }
  private recordAssistantTask(taskId: string): void {
    this.assistantTasks.add(taskId);
    while (this.assistantTasks.size > 100) {
      const first = this.assistantTasks.values().next().value;
      if (!first) break;
      this.assistantTasks.delete(first);
    }
  }
}
