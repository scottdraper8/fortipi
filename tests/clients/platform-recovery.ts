import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { FortiPiClient } from "../../packages/fortipi-client/dist/node.js";
import {
  type AdmissionReceipt,
  type Approval,
  type BackendRef,
  canonicalJson,
  type DurableEvent,
  type ResourceScope,
  type WorkspaceBinding,
} from "../../packages/fortipi-contract/dist/index.js";
import type {
  ArtifactReference,
  DeploymentIdentity,
  FileRecord,
} from "../../scripts/verify-release-gates.ts";
import {
  assertDeployment,
  regularBytes,
  saveJson,
  sha256,
} from "../../scripts/verify-release-gates.ts";
import type { Installed } from "../distribution/install.ts";
import type { RoleContext } from "./roles.ts";

/** Internal trusted9/application-child handoff, never a public product DTO.
 * Checkpoints contain only public IDs/hashes; credentials stay in RoleContext. */
export interface RecoveryWorkspaceCanary {
  binding: WorkspaceBinding;
  files: { path: string; size: number; sha256: string }[];
}
export interface ApplicationRecoveryBefore extends PublicRecoveryCanary {
  schemaVersion: 1;
  candidateSha256: string;
  sourceCommit: string;
  deploymentId: string;
  workerVersionId: string;
  capturedAt: string;
}
export interface ConfirmedPlatformRecovery {
  status: "operation-confirmed";
  before: DeploymentIdentity;
  after: DeploymentIdentity;
  requestedStrategy: "immediate";
  strategyReadBack: false;
  reset: "inferred-from-provider-contract";
  incarnation: "not-observed";
  eviction: "not-observed";
  physicalHostLoss: "not-observed";
  operationEvidenceSha256: string;
}
export interface ApplicationRecoveryAfter {
  schemaVersion: 1;
  candidateSha256: string;
  sourceCommit: string;
  beforeCheckpointSha256: string;
  workerVersionId: string;
  originalTaskId: string;
  originalJobId: string;
  originalReceiptRetained: boolean;
  originalEventPrefixSha256: string;
  actualWorkspaceHashes: { path: string; size: number; sha256: string }[];
  continuation: "public-approval-rejection";
  taskState: string;
  executionIdentityAbsentBeforeAndAfter: boolean;
  checkedAt: string;
}
/** Parent derives the prepared-manifest hash and target from its authenticated
 * installation, verifies these exact files, and owns provider writes/lineage.
 * operation-confirmed is not a qualified recovery before after-checkpoint proof. */
export interface ApplicationRecoveryBridge {
  perform(
    before: FileRecord,
  ): Promise<ConfirmedPlatformRecovery | { status: "unavailable"; reason: string }>;
  finish(
    after: FileRecord,
  ): Promise<
    | { status: "qualified"; operationEvidenceSha256: string }
    | { status: "unavailable"; reason: string }
  >;
}
/** Prebound by trusted9 after authenticating the original run/job/attempt and
 * artifact. This operation cannot upload/deploy or create a new interruption. */
export interface ExistingApplicationRecoveryBridge {
  verifyExisting(): Promise<
    | {
        status: "lineage-confirmed";
        operation: ConfirmedPlatformRecovery;
        before: FileRecord;
        after: FileRecord;
        evidence: ArtifactReference;
        current: DeploymentIdentity;
      }
    | { status: "unavailable"; reason: string }
  >;
}

type RecoveryInstalled = Pick<Installed, "candidate" | "resolveExport">;
export interface PublicRecoveryCanary {
  agentId: string;
  conversationId: string;
  admission: AdmissionReceipt;
  requestId: string;
  jobId: string;
  approval: Approval;
  target: BackendRef;
  eventThrough: number;
  eventPrefixSha256: string;
  snapshotSha256: string;
  workspace: RecoveryWorkspaceCanary;
}
const emptyResources: ResourceScope = {
  agentIds: [],
  conversationIds: [],
  workspaceIds: [],
  executorIds: [],
  backendIds: [],
  tools: [],
  actions: [],
};
async function until(read: () => boolean, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (read()) return;
    await new Promise<void>((accept) => setTimeout(accept, 50));
  }
  throw new Error("Public recovery canary did not reach its required durable boundary");
}
function submission(
  conversationId: string,
  workspace: RecoveryWorkspaceCanary,
  target: BackendRef,
  requestId: string,
) {
  const dispatch = {
    tool: "shell",
    arguments: { command: "echo seed1010-recovery-no-start" },
    workspaceId: workspace.binding.workspaceId,
    baseRevision: workspace.binding.revision,
    target,
    capabilities: ["shell"],
  };
  return {
    conversationId,
    dispatch,
    body: {
      clientRequestId: requestId,
      content: `Call fortipi_dispatch exactly once with these exact arguments: ${canonicalJson(dispatch)}. Wait for the human decision. If rejected, report that rejection briefly; do not call any further tool.`,
      busyBehavior: "followUp" as const,
    },
  };
}
async function prefix(client: FortiPiClient, conversationId: string, through: number) {
  assert.ok(Number.isSafeInteger(through) && through >= 0 && through <= 1000);
  const events: DurableEvent[] = [];
  let after = 0;
  while (after < through) {
    const previous = after;
    const page = await client.conversations.events(conversationId, { after });
    assert.ok(page.retainedFloor <= 1, "Recovery canary prefix was reclaimed");
    for (const event of page.events.filter((event) => event.eventSeq <= through)) {
      assert.equal(
        event.eventSeq,
        after + 1,
        "Recovery prefix must retain every original envelope",
      );
      events.push(event);
      after = event.eventSeq;
    }
    assert.ok(events.length <= 1000, "Recovery canary exceeded its bounded event allocation");
    assert.ok(after > previous, "Recovery prefix made no progress");
    assert.ok(
      after >= through || (page.hasMore && page.nextAfter > page.after),
      "Recovery prefix is incomplete",
    );
  }
  return { events, hash: sha256(canonicalJson(events)) };
}
async function workspaceHashes(client: FortiPiClient, canary: RecoveryWorkspaceCanary) {
  assert.ok(canary.files.length > 0 && canary.files.length <= 3);
  assert.equal(canary.binding.config.kind, "computer");
  assert.equal(new Set(canary.files.map((file) => file.path)).size, canary.files.length);
  const binding = await client.workspaces.get(canary.binding.workspaceId);
  assert.deepEqual(binding, canary.binding, "Rollout cannot rebind or publish the workspace");
  const hashes: RecoveryWorkspaceCanary["files"] = [];
  for (const expected of canary.files) {
    const bytes = await client.workspaces.read(binding.workspaceId, {
      revision: binding.revision,
      path: expected.path,
    });
    const actual = { path: expected.path, size: bytes.byteLength, sha256: sha256(bytes) };
    assert.deepEqual(actual, expected, "Actual public Computer bytes changed across recovery");
    hashes.push(actual);
  }
  return hashes;
}
/** Trusted application coordinator prepares an offline identity, not a running
 * executor. Human approval is the supported durable wait before any assignment.
 * No provider/deployment observation is fabricated by this public-only port. */
export async function openRecoveryCanary(input: {
  installed: RecoveryInstalled;
  roles: RoleContext;
  agentId: string;
  workspace: RecoveryWorkspaceCanary;
}) {
  const { roles, agentId, workspace } = input;
  const executorId = randomUUID();
  await roles.issue({
    requestId: randomUUID(),
    role: "executor",
    executorId,
    expiresAt: Date.now() + 900000,
    grants: [
      {
        grantId: randomUUID(),
        version: 1,
        resources: {
          ...emptyResources,
          executorIds: [executorId],
          actions: ["tickets.mint", "executors.register"],
        },
      },
    ],
  });
  const conversation = await roles.call({
    operationId: "createConversation",
    path: { agentId },
    query: {},
    body: { requestId: randomUUID(), title: "seed1010-controlled-recovery" },
  });
  const role = await roles.issue({
    requestId: randomUUID(),
    role: "client",
    expiresAt: Date.now() + 900000,
    grants: [
      {
        grantId: randomUUID(),
        version: 1,
        resources: {
          ...emptyResources,
          agentIds: [agentId],
          conversationIds: [conversation.conversationId],
          workspaceIds: [workspace.binding.workspaceId],
          executorIds: [executorId],
          tools: ["shell"],
          actions: [
            "conversations.read",
            "messages.submit",
            "events.read",
            "tasks.read",
            "tickets.mint",
            "jobs.dispatch",
            "jobs.read",
            "approvals.read",
            "approvals.decide",
            "workspaces.read",
            "workspace.read",
            "workspace.write",
          ],
        },
      },
    ],
  });
  const module = (await import(
    pathToFileURL(
      input.installed.resolveExport(`@${input.installed.candidate.scope}/fortipi-client/node`),
    ).href
  )) as typeof import("../../packages/fortipi-client/dist/node.js");
  const client = new module.FortiPiClient({
    endpoint: roles.endpoint,
    credentials: async () => role.token,
    ...(new URL(roles.endpoint).protocol === "http:" ? { allowLoopbackHttp: true } : {}),
  });
  const target: BackendRef = { kind: "executor", executorId, generation: 1 };
  const requestId = randomUUID();
  const message = submission(conversation.conversationId, workspace, target, requestId);
  return {
    client,
    conversation,
    dispatch: message.dispatch,
    async seed(): Promise<PublicRecoveryCanary> {
      await workspaceHashes(client, workspace);
      const events: DurableEvent[] = [];
      const subscription = client.conversations.subscribe(conversation.conversationId, {
        agentId,
        maxReconnects: 0,
        onSnapshot() {},
        onEvent(event) {
          if (event.durability === "durable") events.push(event);
        },
      });
      try {
        await subscription.ready;
        const admission = await client.conversations.send(
          conversation.conversationId,
          message.body,
        );
        await until(() =>
          events.some(
            (event) => event.type === "approval.requested" && event.taskId === admission.taskId,
          ),
        );
        const requested = events.filter((event) => event.type === "approval.requested");
        assert.equal(
          requested.length,
          1,
          "The actual model must create exactly one supported unfinished dispatch",
        );
        const approval = requested[0]!.payload as unknown as Approval;
        assert.equal(approval.state, "pending");
        assert.equal(approval.operation.tool, message.dispatch.tool);
        assert.deepEqual(approval.operation.arguments, message.dispatch.arguments);
        assert.deepEqual(approval.operation.target, target);
        assert.equal(approval.operation.workspaceId, workspace.binding.workspaceId);
        assert.equal(approval.operation.baseRevision, workspace.binding.revision);
        const job = await client.jobs.get(approval.jobId);
        assert.equal(job.taskId, admission.taskId);
        assert.equal(job.state, "awaiting_approval");
        assert.equal(job.execution, undefined);
        const task = await client.tasks.get(admission.taskId);
        assert.equal(task.status.state, "waiting");
        if (task.status.state === "waiting") assert.equal(task.status.reason, "human-approval");
        const snapshot = await client.conversations.get(conversation.conversationId);
        const history = await prefix(client, conversation.conversationId, snapshot.lastEventSeq);
        const result: PublicRecoveryCanary = {
          agentId,
          conversationId: conversation.conversationId,
          admission,
          requestId,
          jobId: job.jobId,
          approval,
          target,
          eventThrough: snapshot.lastEventSeq,
          eventPrefixSha256: history.hash,
          snapshotSha256: sha256(canonicalJson(snapshot)),
          workspace,
        };
        roles.assertSanitized(result);
        return result;
      } finally {
        subscription.close();
        await subscription.done.catch(() => {});
      }
    },
  };
}

/** Fresh reads must establish survival before releasing the original wait. */
export async function assertRecoveryCanaryRetained(
  client: FortiPiClient,
  before: PublicRecoveryCanary,
) {
  const history = await prefix(client, before.conversationId, before.eventThrough);
  assert.equal(history.hash, before.eventPrefixSha256);
  const snapshot = await client.conversations.get(before.conversationId);
  assert.equal(sha256(canonicalJson(snapshot)), before.snapshotSha256);
  const task = await client.tasks.get(before.admission.taskId);
  assert.equal(task.taskId, before.admission.taskId);
  assert.equal(task.status.state, "waiting");
  if (task.status.state === "waiting") assert.equal(task.status.reason, "human-approval");
  const job = await client.jobs.get(before.jobId);
  assert.equal(job.taskId, before.admission.taskId);
  assert.equal(job.state, "awaiting_approval");
  assert.equal(job.execution, undefined);
  assert.deepEqual(await client.approvals.get(before.approval.approvalId), before.approval);
  return workspaceHashes(client, before.workspace);
}

export async function continueRecoveryCanary(client: FortiPiClient, before: PublicRecoveryCanary) {
  await assertRecoveryCanaryRetained(client, before);
  assert.ok(
    before.approval.operation.expiresAt > Date.now() + 15000,
    "The actual approval expired before supported continuation",
  );
  const seen: DurableEvent[] = [];
  const subscription = client.conversations.subscribe(before.conversationId, {
    agentId: before.agentId,
    maxReconnects: 0,
    onSnapshot() {},
    onEvent(event) {
      if (event.durability === "durable") seen.push(event);
    },
  });
  try {
    await subscription.ready;
    await client.approvals.decide(before.approval.approvalId, {
      requestId: randomUUID(),
      expectedVersion: before.approval.version,
      operationDigest: before.approval.operation.operationDigest,
      decision: "reject",
    });
    await until(() =>
      seen.some(
        (event) => event.type === "task.completed" && event.taskId === before.admission.taskId,
      ),
    );
    const task = await client.tasks.get(before.admission.taskId);
    assert.equal(task.status.state, "completed");
    const job = await client.jobs.get(before.jobId);
    assert.equal(job.state, "cancelled");
    assert.equal(job.execution, undefined);
    const approval = await client.approvals.get(before.approval.approvalId);
    assert.equal(approval.state, "rejected");
    assert.equal(approval.operation.operationDigest, before.approval.operation.operationDigest);
    const retry = await client.conversations.send(
      before.conversationId,
      submission(before.conversationId, before.workspace, before.target, before.requestId).body,
    );
    assert.deepEqual(
      retry,
      before.admission,
      "Original admitted task/receipt cannot be replaced after recovery",
    );
    const snapshot = await client.conversations.get(before.conversationId);
    const history = await prefix(client, before.conversationId, snapshot.lastEventSeq);
    const original = history.events.filter((event) => event.eventSeq <= before.eventThrough);
    assert.equal(sha256(canonicalJson(original)), before.eventPrefixSha256);
    assert.equal(
      history.events.filter(
        (event) => event.type === "task.completed" && event.taskId === before.admission.taskId,
      ).length,
      1,
    );
    assert.deepEqual(
      [...new Set(history.events.flatMap((event) => (event.jobId ? [event.jobId] : [])))],
      [before.jobId],
    );
    const actualWorkspaceHashes = await workspaceHashes(client, before.workspace);
    return {
      taskState: task.status.state,
      originalReceiptRetained: true,
      originalEventPrefixSha256: before.eventPrefixSha256,
      actualWorkspaceHashes,
      executionIdentityAbsentBeforeAndAfter: true,
      continuation: "public-approval-rejection" as const,
    };
  } finally {
    subscription.close();
    await subscription.done.catch(() => {});
  }
}

/** Read-only application verification of retained original IDs. It never sends
 * a new model input, rejects another approval, or claims another interruption. */
export async function verifyCompletedRecoveryCanary(
  client: FortiPiClient,
  before: PublicRecoveryCanary,
) {
  const snapshot = await client.conversations.get(before.conversationId);
  assert.equal(snapshot.conversation.agentId, before.agentId);
  assert.ok(
    snapshot.messages.some(
      (message) => message.messageId === before.admission.messageId && message.role === "user",
    ),
  );
  const history = await prefix(client, before.conversationId, snapshot.lastEventSeq);
  assert.equal(
    sha256(canonicalJson(history.events.filter((event) => event.eventSeq <= before.eventThrough))),
    before.eventPrefixSha256,
  );
  assert.equal(
    history.events.filter(
      (event) => event.type === "task.completed" && event.taskId === before.admission.taskId,
    ).length,
    1,
  );
  assert.deepEqual(
    [...new Set(history.events.flatMap((event) => (event.jobId ? [event.jobId] : [])))],
    [before.jobId],
  );
  const task = await client.tasks.get(before.admission.taskId);
  assert.equal(task.taskId, before.admission.taskId);
  assert.equal(task.conversationId, before.conversationId);
  assert.equal(task.status.state, "completed");
  const job = await client.jobs.get(before.jobId);
  assert.equal(job.taskId, before.admission.taskId);
  assert.equal(job.state, "cancelled");
  assert.equal(job.execution, undefined);
  const approval = await client.approvals.get(before.approval.approvalId);
  assert.equal(approval.state, "rejected");
  assert.equal(approval.operation.operationDigest, before.approval.operation.operationDigest);
  return {
    originalTaskId: task.taskId,
    originalJobId: job.jobId,
    originalEventPrefixSha256: before.eventPrefixSha256,
    actualWorkspaceHashes: await workspaceHashes(client, before.workspace),
    executionIdentityAbsent: true,
    freshInterruption: false,
    checkedAt: new Date().toISOString(),
  };
}

async function checkpoint(path: string, value: unknown): Promise<FileRecord> {
  await saveJson(path, value);
  const bytes = await regularBytes(path),
    stat = await lstat(path);
  return { path, size: bytes.byteLength, mode: stat.mode & 0o777, sha256: sha256(bytes) };
}
function assertTransition(operation: ConfirmedPlatformRecovery, before: DeploymentIdentity) {
  assert.equal(operation.status, "operation-confirmed");
  assertDeployment(operation.before);
  assertDeployment(operation.after);
  assert.deepEqual(operation.before, before);
  assert.notEqual(operation.after.workerVersionId, before.workerVersionId);
  assert.notEqual(operation.after.deploymentId, before.deploymentId);
  for (const key of [
    "candidateSha256",
    "sourceCommit",
    "accountBindingSha256",
    "origin",
    "workerName",
    "slot",
    "configSha256",
    "runtimeConfigSha256",
    "assetManifestSha256",
    "publicConfigurationVersion",
    "capabilities",
    "backend",
    "imageDigest",
  ] as const)
    assert.deepEqual(operation.after[key], before[key]);
  assert.deepEqual(operation.after.versions, [
    { versionId: operation.after.workerVersionId, percentage: 100 },
  ]);
  assert.equal(operation.requestedStrategy, "immediate");
  assert.equal(operation.strategyReadBack, false);
  assert.equal(operation.reset, "inferred-from-provider-contract");
  for (const key of ["incarnation", "eviction", "physicalHostLoss"] as const)
    assert.equal(operation[key], "not-observed");
  assert.match(operation.operationEvidenceSha256, /^[a-f0-9]{64}$/);
}
/** Only real provider-confirmed identities may enter this wrapper. The source
 * port above can be exercised independently without inventing a cloud rollout. */
export async function runApplicationRecovery(input: {
  deployment: DeploymentIdentity;
  canary: PublicRecoveryCanary;
  client: FortiPiClient;
  out: string;
  bridge: ApplicationRecoveryBridge;
}) {
  const { deployment, canary, client, bridge } = input;
  assertDeployment(deployment);
  assert.ok(
    canary.approval.operation.expiresAt > Date.now() + 90000,
    "Insufficient original approval lifetime for a genuine rollout",
  );
  await assertRecoveryCanaryRetained(client, canary);
  const before: ApplicationRecoveryBefore = {
    ...canary,
    schemaVersion: 1,
    candidateSha256: deployment.candidateSha256,
    sourceCommit: deployment.sourceCommit,
    deploymentId: deployment.deploymentId,
    workerVersionId: deployment.workerVersionId,
    capturedAt: new Date().toISOString(),
  };
  const beforeFile = await checkpoint(resolve(input.out, "application-before.json"), before);
  const operation = await bridge.perform(beforeFile);
  assert.equal(
    operation.status,
    "operation-confirmed",
    "Real provider recovery operation is required",
  );
  if (operation.status !== "operation-confirmed") throw new Error("Recovery operation unavailable");
  assertTransition(operation, deployment);
  const continuation = await continueRecoveryCanary(client, canary);
  const after: ApplicationRecoveryAfter = {
    ...continuation,
    schemaVersion: 1,
    candidateSha256: deployment.candidateSha256,
    sourceCommit: deployment.sourceCommit,
    beforeCheckpointSha256: beforeFile.sha256,
    workerVersionId: operation.after.workerVersionId,
    originalTaskId: canary.admission.taskId,
    originalJobId: canary.jobId,
    checkedAt: new Date().toISOString(),
  };
  const afterFile = await checkpoint(resolve(input.out, "application-after.json"), after);
  const result = await bridge.finish(afterFile);
  assert.equal(
    result.status,
    "qualified",
    "Both actual application checkpoints and provider lineage must qualify",
  );
  if (result.status !== "qualified") throw new Error("Recovery qualification unavailable");
  assert.equal(result.operationEvidenceSha256, operation.operationEvidenceSha256);
  return {
    operation,
    before: beforeFile,
    after: afterFile,
    continuation,
    limitation:
      "Actual application survival and a human-approval continuation; no effectful running-task, executor-host loss, observed incarnation/eviction/physical host or paid backend proof",
  };
}

/** Existing provider/run/artifact lineage is authenticated by trusted9, not by
 * a child boolean or candidate.producer. Only fresh application reads run here. */
export async function runExistingApplicationRecovery(input: {
  deployment: DeploymentIdentity;
  client: FortiPiClient;
  bridge: ExistingApplicationRecoveryBridge;
}) {
  const verified = await input.bridge.verifyExisting();
  assert.equal(
    verified.status,
    "lineage-confirmed",
    "Retained original recovery lineage is required",
  );
  if (verified.status !== "lineage-confirmed")
    throw new Error("Existing recovery lineage unavailable");
  assertDeployment(input.deployment);
  assertDeployment(verified.current);
  assert.deepEqual(verified.current, input.deployment);
  const operation = verified.operation;
  assertTransition(operation, operation.before);
  const withoutTime = ({ checkedAt: _time, ...value }: DeploymentIdentity) => value;
  assert.deepEqual(withoutTime(verified.current), withoutTime(operation.after));
  assert.equal(verified.evidence.candidateSha256, input.deployment.candidateSha256);
  for (const key of ["runId", "runAttempt", "artifactId"] as const)
    assert.ok(Number.isSafeInteger(verified.evidence[key]) && verified.evidence[key] > 0);
  assert.match(verified.evidence.artifactDigest, /^sha256:[a-f0-9]{64}$/);
  async function retained(file: FileRecord) {
    assert.ok(file.size > 0 && file.size <= 1048576 && file.mode === 0o600);
    const bytes = await regularBytes(file.path);
    assert.equal((await lstat(file.path)).mode & 0o777, file.mode);
    assert.equal(bytes.byteLength, file.size);
    assert.equal(sha256(bytes), file.sha256);
    const value: unknown = JSON.parse(bytes.toString());
    assert.equal(`${canonicalJson(value)}\n`, bytes.toString());
    return value;
  }
  const before = (await retained(verified.before)) as ApplicationRecoveryBefore;
  const after = (await retained(verified.after)) as ApplicationRecoveryAfter;
  assert.equal(before.schemaVersion, 1);
  assert.equal(after.schemaVersion, 1);
  assert.equal(before.sourceCommit, input.deployment.sourceCommit);
  assert.equal(before.candidateSha256, input.deployment.candidateSha256);
  assert.equal(before.workerVersionId, operation.before.workerVersionId);
  assert.equal(before.deploymentId, operation.before.deploymentId);
  assert.equal(after.sourceCommit, before.sourceCommit);
  assert.equal(after.candidateSha256, before.candidateSha256);
  assert.equal(after.beforeCheckpointSha256, verified.before.sha256);
  assert.equal(after.workerVersionId, operation.after.workerVersionId);
  assert.equal(after.originalTaskId, before.admission.taskId);
  assert.equal(after.originalJobId, before.jobId);
  assert.equal(after.originalEventPrefixSha256, before.eventPrefixSha256);
  assert.equal(after.originalReceiptRetained, true);
  assert.equal(after.executionIdentityAbsentBeforeAndAfter, true);
  assert.equal(after.continuation, "public-approval-rejection");
  assert.equal(after.taskState, "completed");
  assert.deepEqual(after.actualWorkspaceHashes, before.workspace.files);
  const fresh = await verifyCompletedRecoveryCanary(input.client, before);
  return {
    operation,
    evidence: verified.evidence,
    historicalBefore: verified.before,
    historicalAfter: verified.after,
    current: verified.current,
    fresh,
    limitation:
      "Authenticated historical controlled rollout plus fresh public state checks; no new interruption/continuation or observed incarnation/eviction/physical host loss",
  };
}
