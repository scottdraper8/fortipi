import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { FortiPiClient } from "../../packages/fortipi-client/dist/node.js";
import {
  type Approval,
  type BackendRef,
  type Configuration,
  type ConversationProjection,
  canonicalJson,
  type DurableEvent,
  type Job,
} from "../../packages/fortipi-contract/dist/index.js";
import { sha256 } from "../../scripts/verify-release-gates.ts";
import type { ScenarioEvidence } from "./evidence.ts";
import type { RecoveryWorkspaceCanary } from "./platform-recovery.ts";

export const ordinaryToolsPrompt =
  "In one operation in the configured workspace, read notes.txt, append the line ordinary-tools-verified to that same file, and show the complete saved text. Leave every other file unchanged. Use the configured execution preference and finish after the file is saved.";
const suffix = Buffer.from("ordinary-tools-verified\n");
export type OrdinaryToolsClient = {
  conversations: Pick<FortiPiClient["conversations"], "get" | "send">;
  approvals: Pick<FortiPiClient["approvals"], "get" | "decide">;
  jobs: Pick<FortiPiClient["jobs"], "get">;
  tasks: Pick<FortiPiClient["tasks"], "get">;
  workspaces: Pick<FortiPiClient["workspaces"], "get" | "manifest" | "read">;
  uploads: Pick<FortiPiClient["uploads"], "receipt">;
};
interface ContextView {
  routing: Configuration["routing"];
  argumentContracts: Record<string, string>;
  targets: {
    target: BackendRef;
    argumentFormat: string;
    platform?: string;
    capabilities: string[];
  }[];
  workspaces: {
    workspaceId: string;
    bindingVersion: number;
    baseRevision: string;
    provider: string;
    configured: boolean;
    targets: BackendRef[];
  }[];
}
function contextResult(projection: ConversationProjection) {
  for (const message of projection.messages) {
    if (message.role !== "tool") continue;
    try {
      const value = JSON.parse(message.content);
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        value.routing &&
        value.argumentContracts &&
        Array.isArray(value.targets) &&
        value.targets.length > 0 &&
        Array.isArray(value.workspaces) &&
        value.workspaces.length > 0
      )
        return { message, value: value as ContextView };
    } catch {
      /* Other genuine tool outputs are not a context witness. */
    }
  }
}
function committedMessage(events: readonly DurableEvent[], messageId: string) {
  return events.find(
    (event) =>
      event.type === "message.committed" &&
      event.payload &&
      typeof event.payload === "object" &&
      !Array.isArray(event.payload) &&
      "messageId" in event.payload &&
      event.payload.messageId === messageId,
  );
}

/** Existing installed public protocol only. The caller supplies the same bounded
 * wait/refusal pacing and native consent used by live execution controls.
 * Controlled clients may exercise the oracle; they never constitute LIVE proof. */
export async function runOrdinaryTools(input: {
  client: OrdinaryToolsClient;
  agentId: string;
  conversationId: string;
  workspace: RecoveryWorkspaceCanary;
  configuration: Configuration;
  target: Extract<BackendRef, { kind: "executor" }>;
  events: DurableEvent[];
  request: <T>(operation: () => Promise<T>) => Promise<T>;
  until: <T>(read: () => Promise<T>, accept: (value: T) => boolean) => Promise<T>;
  localConsent: (approval: Approval) => Promise<string>;
}): Promise<{ evidence: ScenarioEvidence; workspace: RecoveryWorkspaceCanary }> {
  const { client, request, until, workspace, target, configuration, events } = input;
  assert.equal(configuration.workspace.kind, "computer");
  assert.equal(workspace.binding.config.kind, "computer");
  assert.ok(
    configuration.routing.kind === "prefer-local" ||
      (configuration.routing.kind === "explicit" &&
        configuration.routing.targetIds.includes(target.executorId)),
    "Ordinary configured selection requires compatible initial routing; never PATCH the pinned deployment or supply an override",
  );
  const fresh = await request(() => client.conversations.get(input.conversationId));
  assert.equal(fresh.conversation.agentId, input.agentId);
  assert.equal(fresh.conversation.conversationId, input.conversationId);
  assert.equal(fresh.messages.length, 0, "Ordinary prompt requires a fresh conversation");
  assert.deepEqual(
    await request(() => client.workspaces.get(workspace.binding.workspaceId)),
    workspace.binding,
  );
  const note = workspace.files.find((file) => file.path === "notes.txt");
  assert.ok(note);
  const original = Buffer.from(
    await request(() =>
      client.workspaces.read(workspace.binding.workspaceId, {
        revision: workspace.binding.revision,
        path: note.path,
      }),
    ),
  );
  assert.equal(original.length, note.size);
  assert.equal(sha256(original), note.sha256);
  assert.match(original.toString("utf8"), /^ordinary-input:[a-f0-9-]{36}\n$/);
  assert.ok(!ordinaryToolsPrompt.includes(original.toString("utf8").trim()));
  const body = {
    clientRequestId: randomUUID(),
    content: ordinaryToolsPrompt,
    busyBehavior: "followUp" as const,
  };
  const admission = await request(() => client.conversations.send(input.conversationId, body));
  const pending = await until(
    async () =>
      events.find(
        (event) => event.type === "approval.requested" && event.taskId === admission.taskId,
      ),
    Boolean,
  );
  assert.ok(
    pending?.jobId &&
      pending.payload &&
      typeof pending.payload === "object" &&
      !Array.isArray(pending.payload) &&
      "approvalId" in pending.payload &&
      typeof pending.payload.approvalId === "string",
  );
  const approvalId = pending.payload.approvalId;
  const approval = await request(() => client.approvals.get(approvalId));
  assert.equal(approval.jobId, pending.jobId);
  assert.equal(approval.agentId, input.agentId);
  assert.equal(approval.conversationId, input.conversationId);
  assert.equal(approval.state, "pending");
  assert.equal(approval.operation.tool, "shell");
  assert.deepEqual(Object.keys(approval.operation.arguments), ["command"]);
  assert.equal(typeof approval.operation.arguments.command, "string");
  assert.ok((approval.operation.arguments.command as string).trim().length > 0);
  assert.deepEqual(approval.operation.target, target);
  assert.equal(approval.operation.workspaceId, workspace.binding.workspaceId);
  assert.equal(approval.operation.baseRevision, workspace.binding.revision);
  const waiting = await request(() => client.jobs.get(approval.jobId));
  function identity(job: Job) {
    assert.equal(job.jobId, approval.jobId);
    assert.equal(job.taskId, admission.taskId);
    assert.equal(job.agentId, input.agentId);
    assert.equal(job.conversationId, input.conversationId);
    assert.equal(job.workspaceId, workspace.binding.workspaceId);
    assert.equal(job.baseRevision, workspace.binding.revision);
    assert.equal(job.operationDigest, approval.operation.operationDigest);
  }
  identity(waiting);
  assert.equal(waiting.state, "awaiting_approval");
  assert.equal(waiting.execution, undefined);
  assert.equal(waiting.receipt, undefined);

  // Projection can lag dispatch seeding. Observe it before granting either
  // execution consent, rather than assuming its event precedes approval.requested.
  const observed = await until(async () => {
    const projection = await request(() => client.conversations.get(input.conversationId));
    const context = contextResult(projection);
    return context && committedMessage(events, context.message.messageId)
      ? { projection, ...context }
      : undefined;
  }, Boolean);
  assert.ok(observed, "A genuine public tool context result is required before consent");
  const users = observed.projection.messages.filter((message) => message.role === "user");
  assert.equal(users.length, 1);
  assert.equal(users[0]?.messageId, admission.messageId);
  assert.equal(users[0]?.content, ordinaryToolsPrompt);
  const witnessEvent = committedMessage(events, observed.message.messageId);
  assert.ok(witnessEvent);
  assert.equal(witnessEvent.conversationId, input.conversationId);
  assert.deepEqual(witnessEvent.payload, observed.message);
  const context = observed.value;
  assert.deepEqual(Object.keys(context).sort(), [
    "argumentContracts",
    "routing",
    "targets",
    "workspaces",
  ]);
  assert.deepEqual(context.routing, {
    ...configuration.routing,
    targetIds: configuration.routing.targetIds.filter((id) => id === target.executorId),
  });
  const nativeContract = context.argumentContracts["native-shell"];
  assert.equal(typeof nativeContract, "string");
  assert.ok(nativeContract?.includes("command"));
  assert.equal(context.targets.length, 1);
  assert.deepEqual(context.targets[0]?.target, target);
  assert.equal(context.targets[0]?.argumentFormat, "native-shell");
  assert.equal(context.targets[0]?.platform, "linux");
  assert.ok(context.targets[0]?.capabilities.includes("shell"));
  assert.deepEqual(context.workspaces, [
    {
      workspaceId: workspace.binding.workspaceId,
      bindingVersion: workspace.binding.bindingVersion,
      configured: true,
      provider: "computer",
      baseRevision: workspace.binding.revision,
      targets: [target],
    },
  ]);
  assert.deepEqual(
    await request(() => client.workspaces.get(workspace.binding.workspaceId)),
    workspace.binding,
  );
  assert.equal(events.filter((event) => event.type === "approval.requested").length, 1);
  const remoteDecision = {
    requestId: randomUUID(),
    expectedVersion: approval.version,
    operationDigest: approval.operation.operationDigest,
    decision: "approve" as const,
  };
  const remote = await request(() => client.approvals.decide(approvalId, remoteDecision));
  assert.equal(remote.state, "approved");
  const executionId = await input.localConsent(approval);
  await until(
    async () =>
      events.some(
        (event) =>
          event.type === "job.state.changed" &&
          event.jobId === approval.jobId &&
          event.payload &&
          typeof event.payload === "object" &&
          "state" in event.payload &&
          event.payload.state === "completed",
      ),
    Boolean,
  );
  const job = await request(() => client.jobs.get(approval.jobId));
  identity(job);
  assert.equal(job.state, "completed");
  if (job.state !== "completed" || job.evidence.kind !== "committed")
    throw new Error("Ordinary model operation must commit a changed Computer revision");
  const receipt = job.evidence.receipt;
  assert.ok(job.execution && job.preparedResult);
  assert.equal(job.execution.executionId, executionId);
  assert.equal(job.execution.jobId, job.jobId);
  assert.equal(job.execution.operationDigest, job.operationDigest);
  assert.equal(job.execution.baseRevision, job.baseRevision);
  assert.deepEqual(job.execution.target, target);
  assert.equal(job.execution.lease.ownerKind, "job");
  assert.equal(job.execution.lease.jobId, job.jobId);
  assert.equal(job.execution.lease.workspaceId, job.workspaceId);
  assert.equal(job.execution.lease.baseRevision, job.baseRevision);
  assert.equal(job.preparedResult.state, "succeeded");
  assert.equal(job.preparedResult.identity.executionId, executionId);
  assert.equal(job.preparedResult.identity.jobId, job.jobId);
  assert.equal(job.preparedResult.identity.operationDigest, job.operationDigest);
  assert.equal(job.preparedResult.identity.baseRevision, job.baseRevision);
  assert.equal(job.preparedResult.identity.assignmentDigest, job.execution.assignmentDigest);
  assert.deepEqual(job.preparedResult.identity.target, target);
  assert.equal(receipt.providerKind, "computer");
  assert.equal(receipt.operationId, approval.operation.operationId);
  assert.equal(receipt.operationId, job.execution.lease.operationId);
  assert.equal(receipt.workspaceId, job.workspaceId);
  assert.equal(receipt.baseRevision, job.baseRevision);
  assert.notEqual(receipt.revision, receipt.baseRevision);
  if (receipt.jobId !== undefined) assert.equal(receipt.jobId, job.jobId);
  assert.equal(job.preparedResult.commitId, receipt.commitId);
  assert.equal(job.preparedResult.manifestHash, receipt.manifestHash);
  assert.deepEqual(job.receipt, receipt);
  assert.deepEqual(
    await request(() =>
      client.uploads.receipt(receipt.workspaceId, receipt.commitId, {
        commitDigest: receipt.commitDigest,
      }),
    ),
    receipt,
  );
  const current = await request(() => client.workspaces.get(job.workspaceId));
  assert.equal(current.workspaceId, job.workspaceId);
  assert.deepEqual(current.config, workspace.binding.config);
  assert.equal(current.revision, receipt.revision);
  assert.equal(current.manifestHash, receipt.manifestHash);
  assert.equal(current.bindingVersion, workspace.binding.bindingVersion);
  const expected = Buffer.concat([original, suffix]);
  const files = workspace.files.map((file) =>
    file.path === note.path ? { ...file, size: expected.length, sha256: sha256(expected) } : file,
  );
  const manifest = await request(() =>
    client.workspaces.manifest(job.workspaceId, { revision: current.revision }),
  );
  assert.equal(manifest.workspaceId, job.workspaceId);
  assert.equal(manifest.revision, receipt.revision);
  assert.equal(manifest.manifestHash, receipt.manifestHash);
  assert.deepEqual(
    manifest.manifest.entries.map((entry) => {
      assert.equal(entry.type, "file");
      if (entry.type !== "file") throw new Error("Canonical file required");
      return { path: entry.path, size: entry.size, sha256: entry.sha256 };
    }),
    files,
  );
  for (const file of files) {
    const bytes: Uint8Array = await request(() =>
      client.workspaces.read(job.workspaceId, { revision: current.revision, path: file.path }),
    );
    assert.equal(bytes.length, file.size);
    assert.equal(
      sha256(bytes),
      file.sha256,
      "Committed nonce-bearing file and all original bytes must match independently",
    );
    if (file.path === note.path) assert.deepEqual(Buffer.from(bytes), expected);
  }
  assert.ok(
    job.preparedResult.output.tail.includes(expected.toString("utf8")),
    "Actual tool output must include the saved nonce-bearing text",
  );
  await until(
    async () =>
      events.some((event) => event.type === "task.completed" && event.taskId === admission.taskId),
    Boolean,
  );
  const task = await request(() => client.tasks.get(admission.taskId));
  assert.equal(task.taskId, admission.taskId);
  assert.equal(task.conversationId, input.conversationId);
  assert.equal(task.status.state, "completed");
  assert.deepEqual(
    await request(() => client.conversations.send(input.conversationId, body)),
    admission,
  );
  assert.deepEqual(await request(() => client.jobs.get(job.jobId)), job);
  assert.deepEqual(await request(() => client.workspaces.get(job.workspaceId)), current);
  assert.equal(events.filter((event) => event.type === "approval.requested").length, 1);
  const projection = await request(() => client.conversations.get(input.conversationId));
  assert.equal(projection.messages.filter((message) => message.role === "user").length, 1);
  return {
    workspace: { binding: current, files },
    evidence: {
      observation: {
        agentId: input.agentId,
        conversationId: input.conversationId,
        admission,
        task,
        prompt: ordinaryToolsPrompt,
        contextMessageId: observed.message.messageId,
        contextEventId: witnessEvent.eventId,
        contextSha256: sha256(canonicalJson(context)),
        routing: configuration.routing,
        selectedTarget: target,
        jobId: job.jobId,
        executionId,
        approvalId,
        operationDigest: job.operationDigest,
        remoteDecision: remote,
        receipt,
        originalInputSha256: note.sha256,
        canonicalFiles: files,
        toolOutputSha256: sha256(job.preparedResult.output.tail),
      },
      oracle:
        "One fresh ordinary natural-language intent obtains a genuine public tool context before consent, selects the configured eligible scoped native target, and commits the independently read nonce-bearing file under the same admission/job/execution/Computer receipt",
      sensitivity: [
        "Assistant-only context, absent job, wrong target, missing nonce or uncommitted local write cannot pass",
      ],
      limitations: [
        "Public tool-result provenance uses the canonical role:tool snapshot/event and pre-consent capture; the public projection exposes no read-tool name, task ID or call ID",
        "Resolved target agrees with unchanged configuration and the one eligible scope; raw model target omission, preference changes, explicit overrides and stale-authority deployment refusal require separate acceptance",
        "Controlled clients exercise this oracle only; the trusted LIVE wrapper must supply actual configured Workers AI, installed native consent and authenticated deployment provenance",
      ],
    },
  };
}
