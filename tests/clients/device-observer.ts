import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  type CredentialRef,
  canonicalJson,
  type RevocationReceipt,
} from "../../packages/fortipi-contract/dist/index.js";
import type { ArtifactReference, DeploymentIdentity } from "../../scripts/verify-release-gates.ts";
import type { Installed } from "../distribution/install.ts";
import type { ScenarioEvidence } from "./evidence.ts";
import {
  type DeviceContinuityA,
  type DeviceContinuityBObservation,
  type DeviceContinuitySeed,
  type DeviceReadClient,
  deviceCanonicalBytes,
  deviceEventPrefix,
  deviceExpectedFiles,
  deviceReadRequests,
} from "./live-device.ts";
import type { RoleContext } from "./roles.ts";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export interface DeviceCleanup {
  credential: CredentialRef;
  requestId: string;
  receipt: RevocationReceipt;
}
/** Data only. Parent authenticates completed jobs and exact phase payloads
 * before constructing this projection, and reauthenticates before retention.
 * References/hash links are not archive, GitHub, provider or role authority. */
export interface DeviceEvidenceData {
  schemaVersion: 1;
  initial: { deployment: DeploymentIdentity; seed: DeviceContinuitySeed };
  a: DeviceContinuityA;
  b: DeviceContinuityBObservation;
  cleanup: readonly DeviceCleanup[];
  references: {
    initial: ArtifactReference;
    a: ArtifactReference;
    b: ArtifactReference;
    cleanup: ArtifactReference;
  };
}
function id(value: string) {
  assert.ok(
    typeof value === "string" && value.length > 0 && value.length <= 256 && value !== "*",
    "Exact bounded resource identity required",
  );
}
function sha(value: string) {
  assert.match(value, /^[a-f0-9]{64}$/);
}
function closed(value: object, fields: readonly string[]) {
  assert.ok(value && Object.getPrototypeOf(value) === Object.prototype);
  assert.deepEqual(Reflect.ownKeys(value).sort(), [...fields].sort());
}
function credential(ref: CredentialRef) {
  closed(ref, ["credentialId", "generation", "grantVersion"]);
  id(ref.credentialId);
  assert.ok(Number.isSafeInteger(ref.generation) && ref.generation > 0);
  assert.ok(Number.isSafeInteger(ref.grantVersion) && ref.grantVersion > 0);
}
/** Consistency checks for public data, not proof of a job or provider action. */
export function assertDeviceEvidenceData(data: DeviceEvidenceData, current: DeploymentIdentity) {
  closed(data, ["schemaVersion", "initial", "a", "b", "cleanup", "references"]);
  assert.equal(data.schemaVersion, 1);
  assert.ok(Buffer.byteLength(canonicalJson(data)) <= 1048576);
  closed(data.initial, ["deployment", "seed"]);
  closed(data.references, ["initial", "a", "b", "cleanup"]);
  const { a, b } = data,
    { seed, deployment } = data.initial;
  for (const key of [
    "sourceCommit",
    "candidateSha256",
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
    assert.deepEqual(current[key], deployment[key], `Current target changed immutable ${key}`);
  assert.equal(a.schemaVersion, 1);
  assert.equal(a.phase, "a");
  assert.equal(b.phase, "b");
  assert.equal(a.sourceCommit, deployment.sourceCommit);
  assert.equal(b.sourceCommit, a.sourceCommit);
  assert.equal(a.candidateSha256, deployment.candidateSha256);
  assert.equal(b.candidateSha256, a.candidateSha256);
  assert.equal(a.deploymentId, deployment.deploymentId);
  assert.equal(b.deploymentId, deployment.deploymentId);
  assert.equal(a.workerVersionId, deployment.workerVersionId);
  assert.equal(b.workerVersionId, deployment.workerVersionId);
  for (const value of [
    a.agentId,
    a.conversationId,
    a.logicalApplicationId,
    a.jobId,
    a.executionId,
    a.requestId,
    a.retirementId,
    a.revocationId,
    b.replacement.jobId,
    b.replacement.executionId,
    b.replacement.requestId,
    b.retirementId,
    b.revocationId,
    seed.workspace.binding.workspaceId,
    seed.a.executorId,
    seed.b.executorId,
  ])
    id(value);
  assert.equal(a.agentId, seed.agentId);
  assert.equal(a.conversationId, seed.conversationId);
  assert.deepEqual(a.executor, seed.a);
  assert.notEqual(seed.a.executorId, seed.b.executorId);
  assert.deepEqual(a.initialWorkspace, seed.workspace);
  assert.deepEqual(b.originalWorkspace, a.workspace);
  closed(a.admission, ["operationId", "messageId", "taskId", "revision", "eventSeq"]);
  assert.deepEqual(b.originalAdmission, a.admission);
  assert.equal(b.originalJobId, a.jobId);
  assert.equal(b.originalExecutionId, a.executionId);
  assert.equal(b.originalReceiptSha256, a.receiptSha256);
  assert.equal(b.originalEventPrefixSha256, a.eventPrefixSha256);
  assert.notEqual(b.replacement.jobId, a.jobId);
  assert.notEqual(b.replacement.admission.taskId, a.admission.taskId);
  assert.deepEqual(b.hosts[0], a.host);
  for (const host of b.hosts) {
    closed(host, ["runId", "runAttempt", "jobId", "runnerId", "bootSha256"]);
    for (const value of [host.runId, host.runAttempt, host.jobId, host.runnerId])
      assert.ok(Number.isSafeInteger(value) && value > 0);
    sha(host.bootSha256);
  }
  assert.equal(b.hosts.length, 2);
  assert.notEqual(a.host.jobId, b.hosts[1].jobId);
  assert.notEqual(a.host.bootSha256, b.hosts[1].bootSha256);
  assert.equal(a.host.runId, b.hosts[1].runId);
  assert.equal(a.host.runAttempt, b.hosts[1].runAttempt);
  assert.equal(b.originalStarts, 1);
  assert.equal(b.replacementStarts, 1);
  assert.equal(b.aRootAbsentBeforeB, true);
  assert.equal(b.bMaterializedOriginalHashes, true);
  assert.equal(b.physicalHostLoss, "not-observed");
  assert.equal(b.staleLease.leaseId, a.oldLease.leaseId);
  assert.equal(b.staleLease.fence, a.oldLease.fence);
  assert.equal(b.staleLease.jobId, a.jobId);
  assert.equal(b.staleLease.operationId, a.oldLease.operationId);
  assert.equal(b.staleLease.originalBaseRevision, a.oldLease.baseRevision);
  assert.equal(b.staleLease.currentRevision, b.replacement.workspace.binding.revision);
  assert.ok(
    (b.staleLease.status === 403 && b.staleLease.code === "unauthorized") ||
      (b.staleLease.status === 409 &&
        ["conflict", "workspace.conflict", "interrupted"].includes(b.staleLease.code)) ||
      (b.staleLease.status === 503 && b.staleLease.code === "unavailable_executor"),
  );
  assert.equal(b.staleLease.positiveControl.aborted, true);
  assert.equal(b.staleLease.positiveControl.released, true);
  id(b.staleLease.positiveControl.leaseId);
  assert.ok(b.staleLease.positiveControl.uploadId);
  id(b.staleLease.positiveControl.uploadId);
  assert.ok(
    ["acknowledged", "reconciled-public-status"].includes(
      b.staleLease.positiveControl.abortConfirmation ?? "",
    ),
  );
  for (const [workspace, note] of [
    [a.initialWorkspace, "old-v1"],
    [a.workspace, "R1-on-A"],
    [b.replacement.workspace, "R2-on-B"],
  ] as const) {
    assert.equal(workspace.binding.workspaceId, seed.workspace.binding.workspaceId);
    assert.equal(workspace.binding.bindingVersion, seed.workspace.binding.bindingVersion);
    assert.deepEqual(workspace.binding.config, { kind: "computer" });
    assert.deepEqual(workspace.files, deviceExpectedFiles(note));
    sha(workspace.binding.manifestHash);
  }
  assert.notEqual(a.workspace.binding.revision, a.initialWorkspace.binding.revision);
  assert.notEqual(b.replacement.workspace.binding.revision, a.workspace.binding.revision);
  for (const phase of [a, b.replacement]) {
    sha(phase.receiptSha256);
    sha(phase.eventPrefixSha256);
    sha(phase.promptSha256);
    id(phase.admission.taskId);
    id(phase.admission.messageId);
    id(phase.admission.operationId);
    assert.ok(
      Number.isSafeInteger(phase.eventThrough) &&
        phase.eventThrough > 0 &&
        phase.eventThrough <= 1000,
    );
    assert.equal(phase.oldLease.ownerKind, "job");
    assert.equal(phase.oldLease.jobId, phase.jobId);
    assert.equal(phase.oldLease.workspaceId, seed.workspace.binding.workspaceId);
    credential(phase.oldLease.credential);
  }
  assert.equal(a.oldLease.executorId, seed.a.executorId);
  assert.equal(a.oldLease.executorGeneration, seed.a.generation);
  assert.equal(b.replacement.oldLease.executorId, seed.b.executorId);
  assert.equal(b.replacement.oldLease.executorGeneration, seed.b.generation);
  for (const reference of Object.values(data.references)) {
    closed(reference, [
      "runId",
      "runAttempt",
      "artifactId",
      "artifactName",
      "artifactDigest",
      "candidateSha256",
    ]);
    assert.equal(reference.candidateSha256, a.candidateSha256);
    assert.equal(reference.runId, a.host.runId);
    assert.equal(reference.runAttempt, a.host.runAttempt);
    assert.ok(Number.isSafeInteger(reference.artifactId) && reference.artifactId > 0);
    assert.match(reference.artifactDigest, /^sha256:[a-f0-9]{64}$/);
    id(reference.artifactName);
  }
  assert.ok(data.cleanup.length >= 3 && data.cleanup.length <= 100);
  const credentials = new Set<string>(),
    requests = new Set<string>();
  for (const cleanup of data.cleanup) {
    closed(cleanup, ["credential", "requestId", "receipt"]);
    credential(cleanup.credential);
    closed(cleanup.receipt, ["operationId", "revocationId", "state", "pendingRecipients"]);
    id(cleanup.requestId);
    assert.ok(
      !credentials.has(cleanup.credential.credentialId) && !requests.has(cleanup.requestId),
    );
    credentials.add(cleanup.credential.credentialId);
    requests.add(cleanup.requestId);
    assert.equal(cleanup.receipt.state, "complete");
    assert.deepEqual(cleanup.receipt.pendingRecipients, []);
    id(cleanup.receipt.operationId);
    id(cleanup.receipt.revocationId);
  }
  credential(a.clientCredential);
  const required = [a.clientCredential, a.oldLease.credential, b.replacement.oldLease.credential];
  assert.equal(new Set(required.map((ref) => ref.credentialId)).size, 3);
  for (const ref of required)
    assert.deepEqual(
      data.cleanup.find((item) => item.credential.credentialId === ref.credentialId)?.credential,
      ref,
      "Original client and both executors require complete cleanup",
    );
}

/** This surface has no send/cancel/dispatch/upload/executor operation. */
export async function observeDeviceContinuation(input: {
  client: DeviceReadClient;
  devices: DeviceEvidenceData;
  deployment: DeploymentIdentity;
  credential: CredentialRef;
}): Promise<ScenarioEvidence> {
  const { client, devices, deployment, credential: freshCredential } = input;
  assertDeviceEvidenceData(devices, deployment);
  credential(freshCredential);
  for (const original of [
    devices.a.clientCredential,
    devices.a.oldLease.credential,
    devices.b.replacement.oldLease.credential,
  ])
    assert.notEqual(
      freshCredential.credentialId,
      original.credentialId,
      "Verification requires a new read credential",
    );
  const { a, b } = devices,
    request = deviceReadRequests();
  const protocol = await request(() => client.negotiate());
  assert.equal(protocol.deploymentId, a.logicalApplicationId);
  const ticket = await request(() => client.tickets.mint(a.agentId, a.conversationId));
  assert.equal(ticket.identity.role, "client");
  assert.equal(ticket.identity.deploymentId, protocol.deploymentId);
  assert.deepEqual(ticket.identity.credential, freshCredential);
  const projection = await request(() => client.conversations.get(a.conversationId));
  assert.equal(projection.conversation.agentId, a.agentId);
  assert.equal(projection.conversation.conversationId, a.conversationId);
  const observed: {
    taskId: string;
    jobId: string;
    executionId: string;
    receiptSha256: string;
    eventPrefixSha256: string;
  }[] = [];
  for (const phase of [a, b.replacement]) {
    const task = await request(() => client.tasks.get(phase.admission.taskId));
    assert.equal(task.taskId, phase.admission.taskId);
    assert.equal(task.status.state, "completed");
    assert.equal(task.conversationId, a.conversationId);
    const job = await request(() => client.jobs.get(phase.jobId));
    assert.equal(job.jobId, phase.jobId);
    assert.equal(job.taskId, phase.admission.taskId);
    assert.equal(job.agentId, a.agentId);
    assert.equal(job.conversationId, a.conversationId);
    assert.equal(job.workspaceId, phase.workspace.binding.workspaceId);
    assert.equal(job.state, "completed");
    if (job.state !== "completed" || job.evidence.kind !== "committed")
      throw new Error("Original device commit is not retained");
    assert.ok(job.execution && job.preparedResult);
    assert.equal(job.execution.executionId, phase.executionId);
    assert.deepEqual(job.execution.lease, phase.oldLease);
    const receipt = job.evidence.receipt;
    assert.equal(receipt.providerKind, "computer");
    assert.equal(receipt.jobId, phase.jobId);
    assert.equal(receipt.workspaceId, phase.workspace.binding.workspaceId);
    assert.equal(receipt.baseRevision, phase.oldLease.baseRevision);
    assert.equal(receipt.operationId, phase.oldLease.operationId);
    assert.equal(receipt.commitId, job.preparedResult.commitId);
    assert.equal(receipt.manifestHash, job.preparedResult.manifestHash);
    assert.equal(receipt.revision, phase.workspace.binding.revision);
    assert.equal(receipt.manifestHash, phase.workspace.binding.manifestHash);
    assert.equal(hash(canonicalJson(receipt)), phase.receiptSha256);
    const eventPrefixSha256 = await deviceEventPrefix(
      client,
      a.conversationId,
      phase.eventThrough,
      request,
    );
    assert.equal(eventPrefixSha256, phase.eventPrefixSha256);
    observed.push({
      taskId: task.taskId,
      jobId: job.jobId,
      executionId: phase.executionId,
      receiptSha256: phase.receiptSha256,
      eventPrefixSha256,
    });
  }
  const currentBinding = await request(() =>
    client.workspaces.get(a.workspace.binding.workspaceId),
  );
  assert.equal(currentBinding.workspaceId, a.workspace.binding.workspaceId);
  assert.equal(currentBinding.bindingVersion, a.workspace.binding.bindingVersion);
  assert.deepEqual(currentBinding.config, { kind: "computer" });
  for (const workspace of [a.initialWorkspace, a.workspace, b.replacement.workspace])
    await deviceCanonicalBytes(client, workspace, request);
  return {
    observation: {
      historicalProviderDeploymentId: devices.initial.deployment.deploymentId,
      historicalWorkerVersionId: devices.initial.deployment.workerVersionId,
      currentProviderDeploymentId: deployment.deploymentId,
      currentWorkerVersionId: deployment.workerVersionId,
      logicalApplicationId: protocol.deploymentId,
      historicalHosts: structuredClone(b.hosts),
      historicalStarts: { a: b.originalStarts, b: b.replacementStarts },
      originalAdmission: structuredClone(a.admission),
      originalEventPrefixSha256: a.eventPrefixSha256,
      freshReads: observed,
      originalRevisions: [
        a.initialWorkspace.binding.revision,
        a.workspace.binding.revision,
        b.replacement.workspace.binding.revision,
      ],
      observedCurrentRevision: currentBinding.revision,
      canonicalFiles: structuredClone(b.replacement.workspace.files),
      references: structuredClone(devices.references),
      historicalCleanup: structuredClone(devices.cleanup),
      checkedAt: new Date().toISOString(),
      freshReplacement: false,
      freshInterruption: false,
      physicalHostLoss: "not-observed",
    },
    oracle:
      "Fresh scoped public reads retain original A/B task/job/receipt/event prefix and R0/R1/R2 bytes; they create no admission, executor, effect or replacement",
    sensitivity: [
      "Wrong source/candidate/logical identity, missing cleanup, foreign receipt, changed prefix or canonical byte fails; no mutation method is available in this read port",
    ],
    limitations: [
      "Completed job/artifact/provider lineage is authenticated by parent; the descriptor is data only",
      "Host/start/loss facts are historical; fresh reads observe no new loss or interruption",
      "No Paid backend, physical host loss, provider eviction, account ceiling or release clearance",
    ],
  };
}

/** Trusted coordinator issues/revokes only a NEW read role. Old shared-role
 * custody is never decrypted, renewed, reminted or used to retry an admission. */
export async function runDeviceContinuation(input: {
  installed: Installed;
  roles: RoleContext;
  deployment: DeploymentIdentity;
  devices: DeviceEvidenceData;
}): Promise<ScenarioEvidence> {
  const { installed, roles, deployment, devices } = input;
  assertDeviceEvidenceData(devices, deployment);
  assert.equal(roles.endpoint, deployment.origin);
  assert.equal(new URL(roles.endpoint).protocol, "https:");
  assert.equal(installed.hash, deployment.candidateSha256);
  assert.equal(installed.candidate.sourceCommit, deployment.sourceCommit);
  const configuration = await roles.call({
    operationId: "getConfiguration",
    path: {},
    query: {},
    body: undefined,
  });
  assert.equal(configuration.version, deployment.publicConfigurationVersion);
  assert.equal(hash(canonicalJson(configuration)), deployment.runtimeConfigSha256);
  const role = await roles.issue({
    requestId: randomUUID(),
    role: "client",
    expiresAt: Date.now() + 12 * 60000,
    grants: [
      {
        grantId: randomUUID(),
        version: 1,
        resources: {
          agentIds: [devices.a.agentId],
          conversationIds: [devices.a.conversationId],
          workspaceIds: [devices.a.workspace.binding.workspaceId],
          executorIds: [devices.initial.seed.a.executorId, devices.initial.seed.b.executorId],
          backendIds: [],
          tools: ["shell"],
          actions: [
            "tickets.mint",
            "conversations.read",
            "events.read",
            "tasks.read",
            "jobs.read",
            "workspace.read",
            "workspaces.read",
          ],
        },
      },
    ],
  });
  let result: ScenarioEvidence;
  let revocation: RevocationReceipt;
  try {
    const module = (await import(
      pathToFileURL(installed.resolveExport(`@${installed.candidate.scope}/fortipi-client/node`))
        .href
    )) as typeof import("../../packages/fortipi-client/dist/node.js");
    const client = new module.FortiPiClient({
      endpoint: roles.endpoint,
      credentials: async () => role.token,
    });
    const reader: DeviceReadClient = Object.freeze({
      negotiate: (signal?: AbortSignal) => client.negotiate(signal),
      tickets: Object.freeze({ mint: client.tickets.mint }),
      conversations: Object.freeze({
        get: client.conversations.get,
        events: client.conversations.events,
      }),
      tasks: Object.freeze({ get: client.tasks.get }),
      jobs: Object.freeze({ get: client.jobs.get }),
      workspaces: Object.freeze({
        get: client.workspaces.get,
        manifest: client.workspaces.manifest,
        read: client.workspaces.read,
      }),
    });
    result = await observeDeviceContinuation({
      client: reader,
      devices,
      deployment,
      credential: role.credential,
    });
    await installed.verifyUnchanged();
  } finally {
    revocation = await roles.revokeAndWait(role.credential.credentialId);
    assert.equal(revocation.state, "complete");
    assert.deepEqual(revocation.pendingRecipients, []);
  }
  result.observation.freshReaderCleanup = { credential: role.credential, receipt: revocation };
  roles.assertSanitized(result, [role.token]);
  return result;
}
