import type * as D from "./dto.js";
import type { InfrastructureReservations } from "./infrastructure.js";
export interface ControlPlaneRpc extends InfrastructureReservations {
  readonly contractVersion: "1.0";
  authenticate(input: D.CredentialProof): Promise<D.Outcome<D.AuthContext>>;
  authorize(input: D.AuthorizationRequest): Promise<D.Outcome<D.GrantDecision>>;
  /** Keyed current binding/executor lookup; null limits means no validated numeric registration observation. */
  resolveExecutorGeneration(
    ctx: D.AuthContext,
    input: { workspaceId: string; bindingVersion: number; executorId: string },
  ): Promise<
    D.Outcome<{
      executorId: string;
      executorGeneration: number;
      transferLimits: D.ExecutorTransferLimits | null;
    }>
  >;
  handleApi<K extends D.ControlOperationId>(
    ctx: D.AuthContext,
    input: D.OperationRequest<K>,
  ): Promise<D.Outcome<D.OperationResponse<K>>>;
  listAgents: D.ApiMethod<"listAgents">;
  createAgent: D.ApiMethod<"createAgent">;
  describeAgent: D.ApiMethod<"describeAgent">;
  configureAgent: D.ApiMethod<"configureAgent">;
  acquireWorkspaceLease: D.ApiMethod<"acquireWorkspaceLease">;
  renewWorkspaceLease: D.ApiMethod<"renewWorkspaceLease">;
  releaseWorkspaceLease: D.ApiMethod<"releaseWorkspaceLease">;
  mintCredential: D.ApiMethod<"mintCredential">;
  revokeCredential: D.ApiMethod<"revokeCredential">;
  rotateCredential: D.ApiMethod<"rotateCredential">;
  revokeExecutor: D.ApiMethod<"revokeExecutor">;
  mintTicket: D.ApiMethod<"mintConnectionTicket">;
  getProviderAuthStatus: D.ApiMethod<"getProviderAuthStatus">;
  putProviderAuth: D.ApiMethod<"putProviderAuth">;
  deleteProviderAuth: D.ApiMethod<"deleteProviderAuth">;
  resolveProviderAuth(
    ctx: D.ModelResolutionContext,
    input: { providerId: string; modelId: string; expectedGeneration?: number; deadline: number },
  ): Promise<D.Outcome<D.ResolvedProviderAuth>>;
  consumeTicket(input: D.TicketRedemption): Promise<D.Outcome<D.SocketIdentity>>;
  registerAuthorityRecipient(
    ctx: D.AuthContext,
    input: D.AuthorityRecipientRequest,
  ): Promise<D.Outcome<D.AuthorityRegistration>>;
  reserveTarget(
    ctx: D.AuthContext,
    input: D.TargetRequest,
  ): Promise<D.Outcome<D.TargetReservation>>;
  recordDispatchIntent(
    ctx: D.AuthContext,
    input: D.DispatchIntent,
  ): Promise<D.Outcome<D.DispatchReceipt>>;
  assignOnce(ctx: D.AuthContext, input: D.Assignment): Promise<D.Outcome<D.DispatchAck>>;
  queryExecution(
    ctx: D.AuthContext,
    input: D.ExecutionIdentity,
  ): Promise<D.Outcome<D.ExecutionObservation>>;
  cancelExecution(
    ctx: D.AuthContext,
    input: D.CancelRequest,
  ): Promise<D.Outcome<D.CancelDisposition>>;
  deliverExecutorFrame(
    ctx: D.AuthContext,
    input: D.ExecutorDelivery,
  ): Promise<D.Outcome<D.DeliveryAck>>;
  requestLocalWorkspace(
    ctx: D.AuthContext,
    input: D.LocalWorkspaceRequest,
  ): Promise<D.Outcome<D.LocalWorkspaceResponse>>;
  openTransfer(
    ctx: D.AuthContext,
    input: Omit<D.TransferDescriptor, "transferId" | "attemptId">,
  ): Promise<D.Outcome<D.TransferDescriptor>>;
  observeTransfer(
    ctx: D.AuthContext,
    input: { transferId: string; attemptId: string },
  ): Promise<D.Outcome<D.TransferStatus>>;
  pageFacts(ctx: D.AuthContext, input: D.FactPageRequest): Promise<D.Outcome<D.FactPage>>;
  ackFacts(ctx: D.AuthContext, input: D.FactAckRequest): Promise<D.Outcome<D.FactAck>>;
  fetch(request: Request): Promise<Response>;
}
