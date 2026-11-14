import type {
  AdmissionReceipt,
  ClientCommand,
  ClientEvent,
  ExecutorTransferLimits,
  TicketIdentity,
  TicketReceipt,
  WorkspaceLeaseAcquire,
  WorkspaceOperationLease,
} from "fortipi-contract/client";
import {
  type Assignment,
  type ExecutionIdentity,
  type ExecutorFrame,
  type LocalPrepare,
  localStageDigest,
  manifestDigest,
  type OperationContext,
  operationForAssignment,
  validateAssignment,
  validateLocalLease,
  validateLocalStage,
} from "fortipi-contract/executor";
// @ts-expect-error Executor publication has no client authority commands.
export type ExecutorClientAuthority = import("fortipi-contract/executor").ClientCommand;

import type {
  CommitReceipt,
  CredentialReceipt,
  Manifest,
  Mutation,
  OperationRequest,
  OperationResponse,
  ProviderAuthPut,
  ProviderAuthStatus,
  ReconcileInput,
  WorkspaceBinding,
} from "fortipi-contract";
export const serverAllocatedRetry: ReconcileInput = {
  requestId: "retry_request",
  expectedVersion: 1,
  reason: "Explicit fresh authorization",
  action: { kind: "new-job", authorizationId: "fresh_authorization" },
};
// @ts-expect-error A server-allocated identifier still needs explicit authorization identity.
export const retryWithoutAuthorization: ReconcileInput["action"] = { kind: "new-job" };
export function publicFlows(
  identity: ExecutionIdentity,
  receipt: CommitReceipt,
  admission: AdmissionReceipt,
) {
  const request: OperationRequest<"submitMessage"> = {
    operationId: "submitMessage",
    path: { id: "conversation_1" },
    query: {},
    body: { clientRequestId: "request_1", content: "hello", busyBehavior: "followUp" },
  };
  const command: ClientCommand = { type: "message.submit", requestId: "request_1", input: request };
  const frame: ExecutorFrame = { type: "job.query", requestId: "request_1", payload: identity };
  const response: OperationResponse<"submitMessage"> = { status: 202, body: admission };
  const oauth: ProviderAuthPut = {
    requestId: "request_2",
    expectedVersion: null,
    credential: {
      type: "oauth",
      refresh: "synthetic_refresh",
      access: "synthetic_access",
      expires: 1000,
      providerFields: { accountId: "synthetic" },
    },
  };
  // @ts-expect-error Unknown commands are forbidden.
  const unknown: ClientCommand = { type: "job.assign", requestId: "request_1", payload: identity };
  const get: OperationRequest<"getHealth"> = {
    operationId: "getHealth",
    path: {},
    query: {},
    // @ts-expect-error Absent HTTP bodies must be undefined.
    body: {},
  };
  // @ts-expect-error Wrong success status for admission.
  const wrongStatus: OperationResponse<"submitMessage"> = { status: 200, body: admission };
  const status: ProviderAuthStatus = {
    providerId: "openai",
    version: 1,
    generation: 1,
    state: "configured",
    // @ts-expect-error Redacted status cannot expose credentials.
    credential: oauth.credential,
  };
  const chunk: OperationRequest<"putUploadChunk"> = {
    operationId: "putUploadChunk",
    path: {
      workspaceId: "workspace_1",
      uploadId: "upload_1",
      sha256: "a".repeat(64),
      chunkIndex: 0,
    },
    query: { length: 1, sha256: "a".repeat(64) },
    body: new Uint8Array([0]),
  };
  // @ts-expect-error A binary PUT has bytes, rather than an absent HTTP body.
  const missingBytes: OperationRequest<"putUploadChunk"> = { ...chunk, body: undefined };
  // @ts-expect-error 200 revocation is complete, never a pending fanout.
  const premature: OperationResponse<"revokeCredential"> = {
    status: 200,
    body: {
      operationId: "operation_1",
      revocationId: "revoke_1",
      state: "pending",
      pendingRecipients: [{ kind: "agent", id: "agent_1" }],
    },
  };
  void [unknown, get, wrongStatus, status, missingBytes, premature];
  return { command, frame, response, oauth, receipt };
}
export function consumeEvent(event: ClientEvent): number | undefined {
  return event.durability === "durable" ? event.eventSeq : undefined;
}
export function ticketCursorScope(origin: string, receipt: TicketReceipt) {
  const identity: TicketIdentity = receipt.identity;
  // @ts-expect-error The old ticket-only shape cannot identify the authenticated principal.
  const incomplete: TicketReceipt = {
    ticket: receipt.ticket,
    audience: receipt.audience,
    expiresAt: receipt.expiresAt,
  };
  void incomplete;
  return {
    origin,
    deploymentId: identity.deploymentId,
    principalId: identity.principalId,
    credentialId: identity.credential.credentialId,
    generation: identity.credential.generation,
    grantVersion: identity.credential.grantVersion,
    credentialExpiresAt: identity.credentialExpiresAt,
    ticketExpiresAt: receipt.expiresAt,
  };
}
export async function receivedAssignment(input: Assignment) {
  const context: OperationContext = input.operationContext;
  await validateAssignment(input);
  const operation = operationForAssignment(input);
  const { operationContext: _context, ...missingContext } = input;
  // @ts-expect-error A received assignment must carry the complete four-field context.
  const incomplete: Assignment = missingContext;
  // @ts-expect-error Principal identity is not a field of the canonical operation context.
  const wrongContext: OperationContext = { ...context, principalId: "principal_1" };
  void [incomplete, wrongContext];
  return operation;
}
export async function receivedLocalPreparation(input: LocalPrepare, now: number) {
  validateLocalLease(input, "prepare", now);
  if (input.mode.kind === "staged-change") {
    await validateLocalStage(input.mode);
    const put: Mutation = {
      kind: "put",
      path: "result.txt",
      sha256: "a".repeat(64),
      size: 3,
      mode: 420,
    };
    // @ts-expect-error Puts use the enclosing upload; a per-put upload ID is forbidden.
    const otherUpload: Mutation = { ...put, uploadId: "other_upload" };
    void otherUpload;
    return localStageDigest(input.mode);
  }
  return undefined;
}
export function consumeCredentialIssuance(receipt: CredentialReceipt) {
  if (receipt.state === "issued") return receipt.token;
  // @ts-expect-error An identical retry carries only public metadata, never a recovered token.
  void receipt.token;
  return undefined;
}
export function executorRegistration(limits: ExecutorTransferLimits) {
  const frame: Extract<ExecutorFrame, { type: "executor.register" }> = {
    type: "executor.register",
    requestId: "registration-business-1",
    payload: {
      executorId: "executor_1",
      generation: 4,
      ledgerId: "fixture_ledger",
      ledgerInstanceId: "fixture_instance",
      protocolVersion: "1.0",
      schemaVersion: "1.0.0",
      capabilities: ["workspace"],
      platform: "linux",
      caseBehavior: "sensitive",
      rootBindingIds: ["root_1"],
      confinement: "host",
      transferLimits: limits,
    },
  };
  const { transferLimits: _limits, ...legacyPayload } = frame.payload;
  const legacy = { ...frame, payload: legacyPayload };
  // @ts-expect-error Numeric observations are mandatory; capability strings cannot replace them.
  const missingLimits: ExecutorFrame = legacy;
  void missingLimits;
  return frame;
}
/** Compile-only SDK route flow: every lease/stage value comes from typed public responses. */
export async function workspaceWriteRoutes(
  acquired: OperationResponse<"acquireWorkspaceLease">,
  validated: OperationResponse<"validateUpload">,
  renewed: OperationResponse<"renewWorkspaceLease">,
  manifest: Manifest,
  mutations: Mutation[],
  binding: WorkspaceBinding,
) {
  const body: WorkspaceLeaseAcquire = {
    requestId: "acquire-business-1",
    operationId: "workspace-operation-1",
    bindingVersion: binding.bindingVersion,
    baseRevision: binding.revision,
    deadline: 50000,
  };
  const acquire: OperationRequest<"acquireWorkspaceLease"> = {
    operationId: "acquireWorkspaceLease",
    path: { workspaceId: binding.workspaceId },
    query: {},
    body,
  };
  if (acquired.status !== 201 || validated.status !== 200 || renewed.status !== 200)
    return { acquire };
  const lease: WorkspaceOperationLease = acquired.body;
  const proposedManifestHash = await manifestDigest(manifest);
  const begin: OperationRequest<"beginUpload"> = {
    operationId: "beginUpload",
    path: { workspaceId: lease.workspaceId },
    query: {},
    body: {
      requestId: "begin-business-1",
      operationId: lease.operationId,
      commitId: "commit_1",
      baseRevision: lease.baseRevision,
      lease,
      manifestHash: proposedManifestHash,
      manifest,
      mutations,
    },
  };
  const snapshot: OperationRequest<"snapshotWorkspace"> = {
    operationId: "snapshotWorkspace",
    path: { workspaceId: lease.workspaceId },
    query: {},
    body: {
      requestId: "snapshot-business-1",
      baseRevision: lease.baseRevision,
      lease,
      manifestHash: validated.body.manifestHash,
    },
  };
  const transaction: OperationRequest<"transactWorkspace"> = {
    operationId: "transactWorkspace",
    path: { workspaceId: lease.workspaceId },
    query: {},
    body: {
      requestId: "transaction-business-1",
      mutations,
      commit: {
        requestId: "commit-business-1",
        stageId: validated.body.stageId,
        uploadId: validated.body.uploadId,
        commitId: "commit_1",
        operationId: lease.operationId,
        workspaceId: lease.workspaceId,
        baseRevision: lease.baseRevision,
        lease,
        manifestHash: validated.body.manifestHash,
      },
    },
  };
  const renew: OperationRequest<"renewWorkspaceLease"> = {
    operationId: "renewWorkspaceLease",
    path: { workspaceId: lease.workspaceId, leaseId: lease.leaseId },
    query: {},
    body: { requestId: "renew-business-1", lease },
  };
  const release: OperationRequest<"releaseWorkspaceLease"> = {
    operationId: "releaseWorkspaceLease",
    path: { workspaceId: renewed.body.workspaceId, leaseId: renewed.body.leaseId },
    query: {},
    body: { requestId: "release-business-1", lease: renewed.body, reason: "completed" },
  };
  const jobLease = { ...lease, ownerKind: "job" as const, jobId: "invented" };
  // @ts-expect-error The public route returns only the non-job Lease variant.
  const job: WorkspaceOperationLease = jobLease;
  const leaked: OperationResponse<"releaseWorkspaceLease"> = {
    status: 200,
    body: {
      leaseId: lease.leaseId,
      released: true,
      // @ts-expect-error A public release receipt cannot expose its private tombstone.
      tombstoneId: "internal",
    },
  };
  void [job, leaked];
  return { acquire, begin, snapshot, transaction, renew, release };
}
