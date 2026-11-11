import type {
  AdmissionReceipt,
  ClientCommand,
  ClientEvent,
  TicketIdentity,
  TicketReceipt,
} from "fortipi-contract/client";
import {
  type Assignment,
  type ExecutionIdentity,
  type ExecutorFrame,
  type LocalPrepare,
  localStageDigest,
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
  Mutation,
  OperationRequest,
  OperationResponse,
  ProviderAuthPut,
  ProviderAuthStatus,
} from "fortipi-contract";
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
