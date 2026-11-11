import type { CreateModelsOptions, Models } from "@earendil-works/pi-ai/models";
import type * as T from "fortipi-contract";

export type * from "fortipi-contract";
/** Internal seal evidence stays at the authority; project it before returning a wire receipt. */
export type CommitReceipt =
  | (Omit<Extract<T.CommitReceipt, { providerKind: "computer" }>, "storeRef"> & {
      storeRef: T.SealedStore;
    })
  | Extract<T.CommitReceipt, { providerKind: "local" }>;
export type WorkspaceTransaction = Omit<T.WorkspaceTransaction, "commit"> & {
  commit: T.CommitInput;
};
export type StoreAllocationRequest =
  | Omit<Extract<T.StoreAllocation, { role: "revision-store" }>, "allocationId" | "childId">
  | Omit<Extract<T.StoreAllocation, { role: "scratch" }>, "allocationId" | "childId">;
export type Outcome<TValue> = { ok: true; value: TValue } | ({ ok: false } & T.ProtocolError);
export type ApiMethod<K extends T.OperationId> = (
  ctx: AuthContext,
  input: T.OperationRequest<K>,
) => Promise<Outcome<T.OperationResponse<K>>>;
export interface AuthContext extends T.CredentialRef {
  principalId: string;
  role: "client" | "executor" | "admin";
  deploymentId: string;
  grants: T.Grant[];
  requestId: string;
  authenticatedAt: number;
  credentialExpiresAt: number | null;
  deadline: number;
  /** Required on resource calls; CP registration must precede first authority use. */
  registrationId?: string;
}
export type ResourceAuthContext = AuthContext & { registrationId: string };
/** CP persists the pending request/registration first; authority checks CAS, digest and floors before acknowledging. */
export interface WorkspaceBindingApplication {
  requestId: string;
  binding: Pick<T.WorkspaceBinding, "workspaceId" | "bindingVersion" | "config">;
  /** Null is permitted only when initializing an authority without a prior binding. */
  expectedVersion: number | null;
  /** Required on rebind. */
  import?: T.WorkspaceBindingPatch["import"];
  /** Required iff config.kind is local, with exactly matching executorId; authority validates it. */
  executor?: { executorId: string; generation: number };
}
export interface RecoveryContext {
  kind: "control-recovery";
  deploymentId: string;
  revocationId: string;
  recipient: T.Recipient;
  actions: ["invalidate"];
  deadline: number;
}
export interface FactDeliveryContext {
  kind: "fact-delivery";
  deploymentId: string;
  source: T.Recipient;
  recipient: T.Recipient;
  actions: ["ingest-facts"];
  deadline: number;
}
export interface ModelResolutionContext {
  kind: "model-resolution";
  deploymentId: string;
  agentId: string;
  factoryId: string;
  providerId: string;
  modelId: string;
  action: "resolve-provider-auth";
  deadline: number;
}
export interface CredentialProof {
  bearer: string;
  deploymentId: string;
  requestId: string;
  origin?: string;
  deadline: number;
}
export interface AuthorizationRequest {
  principal: AuthContext;
  resources: T.ResourceScope;
  action: string;
}
export type GrantDecision =
  | { allowed: true; grants: T.Grant[]; grantVersion: number }
  | { allowed: false; reason: "scope" | "expired" | "generation" };
export interface AuthorityRecipientRequest {
  credential: T.CredentialRef;
  recipient: T.Recipient;
  resources: T.ResourceScope;
  executor?: { executorId: string; generation: number };
}
export interface AuthorityRegistration extends AuthorityRecipientRequest {
  registrationId: string;
}
export interface TicketRedemption {
  ticket: string;
  deploymentId: string;
  audience: "client-stream" | "executor-session";
  origin: T.OriginMode;
  destination: T.Recipient | { kind: "control" };
}
export interface SocketIdentity extends T.CredentialRef {
  deploymentId: string;
  principalId: string;
  role: "client" | "executor" | "admin";
  resources: T.ResourceScope;
  originMode: T.OriginMode;
  registrationId: string;
  expiresAt: number;
  executor?: { executorId: string; generation: number };
}
interface TargetScope {
  operationId: string;
  operationDigest: string;
  workspaceId: string;
  bindingVersion: number;
  target: T.BackendRef;
  actions: string[];
  deadline: number;
  expiresAt: number;
}
export type TargetRequest = TargetScope &
  (
    | {
        ownerKind: "job";
        jobId: string;
        executionId: string;
        agentId: string;
        conversationId: string;
      }
    | {
        ownerKind: "workspace-operation";
        baseRevision: string;
        agentId?: string;
        conversationId?: string;
      }
  );
interface ReservationAuthority {
  reservationId: string;
  credential: T.CredentialRef;
}
export type TargetReservation = ReservationAuthority &
  (
    | (Extract<TargetRequest, { ownerKind: "job" }> & {
        registrationIds: { agent: string; workspace: string };
      })
    | (Extract<TargetRequest, { ownerKind: "workspace-operation" }> & {
        registrationIds: { agent?: string; workspace: string };
      })
  );
export interface DispatchIntent {
  reservation: Extract<TargetReservation, { ownerKind: "job" }>;
  assignment: T.Assignment;
  expectedJobVersion: number;
}
export interface DispatchReceipt {
  dispatchId: string;
  jobId: string;
  assignmentDigest: string;
  state: "dispatch_attempted";
  persisted: true;
}
export interface DispatchAck {
  identity: T.ExecutionIdentity;
  receipt: T.TransportAck;
  disposition: "accepted" | "duplicate" | "uncertain";
}
export interface CancelRequest {
  identity: T.ExecutionIdentity;
  requestId: string;
  reason: string;
}
export type CancelDisposition = T.CancellationDisposition;
export type ExecutorDelivery = {
  executorId: string;
  generation: number;
  connectionEpoch: number;
  frame: T.ExecutorFrame;
};
export type DeliveryAck = T.TransportAck;
export interface OutputDelivery {
  identity: T.ExecutionIdentity;
  sequence: number;
  stream: "stdout" | "stderr";
  text: string;
  deliveryId: string;
}
export interface ResultDelivery {
  identity: T.ExecutionIdentity;
  sequence: number;
  result: T.PreparedResult;
  deliveryId: string;
}
export interface LeaseRenewal {
  requestId: string;
  lease: T.Lease;
  expectedLeaseVersion: number;
  expiresAt: number;
}
export interface LeaseRelease {
  requestId: string;
  lease: T.Lease;
  reason: "completed" | "cancelled" | "expired" | "reconciled";
}
export interface ReleaseReceipt {
  leaseId: string;
  released: boolean;
  tombstoneId: string;
}
export interface ExecutionRequest {
  operationContext: T.OperationContext;
  reservation: Extract<TargetReservation, { ownerKind: "job" }>;
  identity: T.ExecutionIdentity;
  tool: string;
  arguments: T.JsonObject;
  workspaceId: string;
  bindingVersion: number;
  capabilities: string[];
  approval?: T.ApprovalOperation;
}
export interface PreparedExecution {
  preparationId: string;
  request: ExecutionRequest;
  scratchId?: string;
  preparedAt: number;
  expiresAt: number;
}
export interface DescribeBackend {
  target: T.BackendRef;
  workspace: T.WorkspaceBinding;
}
export interface BackendDescription {
  target: T.BackendRef;
  kind: "cloud-js" | "linux" | "native";
  capabilities: string[];
  workspaceKinds: ("computer" | "local")[];
  confinement: "host" | "isolated";
  available: boolean;
  reason?: string;
}
export type UncertaintyDisposition =
  | {
      action: "query-existing" | "recover-receipt" | "reconcile" | "observe-local";
      canStart: false;
      reason: string;
    }
  | {
      action: "eligible-first-start";
      proof: Extract<T.ExecutionObservation, { state: "not_started" }>;
      canStart: true;
    };
export interface Fact {
  factId: string;
  source: T.Recipient;
  recipients: T.Recipient[];
  conversationId: string;
  createdAt: number;
  /** Recipient assigns the public event ID/sequence once while atomically ingesting this fact. */
  event: EventDraft;
}
export interface FactPageRequest {
  recipient: T.Recipient;
  after?: string;
  limit: number;
}
export interface FactPage {
  items: Fact[];
  nextPageToken?: string;
}
export interface FactAckRequest {
  factId: string;
  recipient: T.Recipient;
  eventId: string;
  eventSeq: number;
}
export interface FactAck extends FactAckRequest {
  persisted: true;
}
export interface FactBatchAck {
  acks: FactAck[];
}
export interface FactBatch {
  facts: Fact[];
  recipient: T.Recipient;
}
export type JobRecord = T.Job;
export type ApprovalRecord = T.Approval;
export interface JobSeed {
  job: JobRecord;
  piTaskId: string;
  capacityReservationId: string;
  event: EventDraft;
}
export interface JobLookup {
  jobId: string;
}
type Draft<E> = E extends T.KnownDurableEvent
  ? Omit<E, "eventId" | "eventSeq" | "timestamp">
  : never;
export type EventDraft = Draft<T.KnownDurableEvent>;
export interface JobTransition {
  jobId: string;
  expectedVersion: number;
  expectedState: T.JobState;
  nextState: T.JobState;
  event: EventDraft;
}
export interface ApprovalDecision {
  approvalId: string;
  decision: T.ApprovalDecision;
  event: EventDraft;
}
export type FinalizeJob = {
  jobId: string;
  expectedVersion: number;
  expectedState: T.JobState;
  event: EventDraft;
} & (
  | {
      state: "completed";
      evidence: { kind: "committed"; receipt: CommitReceipt } | T.UnchangedBase;
    }
  | {
      state: "failed" | "cancelled" | "interrupted" | "expired" | "requires_reconciliation";
      reason: string;
      possibleExternalEffects: boolean;
    }
);
export interface ExportRequest {
  exportId: string;
  resources: T.ResourceScope;
  maxBytes: number;
  deadline: number;
}
export interface ExportDescriptor {
  exportId: string;
  state: "ready" | "partial" | "unavailable";
  artifacts: T.ByteReference[];
  unavailableWorkspaceIds: string[];
  credentialsExcluded: true;
}
export interface DrainBudget {
  maxItems: number;
  deadline: number;
}
export interface DrainProgress {
  processed: number;
  remaining: boolean;
  nextWakeAt?: number;
}
export interface UploadLookup {
  workspaceId: string;
  uploadId: string;
}
export interface SnapshotPlan {
  workspaceId: string;
  revision: string;
  manifest: T.Manifest;
  scratchId: string;
  deadline: number;
}
export interface ScratchHandle {
  scratchId: string;
  workspaceId: string;
  revision: string;
  executionId?: string;
}
export interface ScratchResult {
  scratch: ScratchHandle;
  manifest: T.Manifest;
  uploadId: string;
  commitId: string;
  lease: T.Lease;
}
export interface ValidatedStage {
  uploadId: string;
  manifestHash: string;
  store: T.SealedStore;
}
export type PiAuthContext = NonNullable<CreateModelsOptions["authContext"]>;
export type CredentialStore = NonNullable<CreateModelsOptions["credentials"]>;
type ResolvedAuth = NonNullable<Awaited<ReturnType<Models["getAuth"]>>>;
export type ModelAuth = ResolvedAuth["auth"];
export type ProviderEnv = NonNullable<ResolvedAuth["env"]>;
/** Secret-bearing internal value: never log, export or project into public data. */
export interface ResolvedProviderAuth {
  providerId: string;
  version: number;
  generation: number;
  auth: ModelAuth;
  env?: ProviderEnv;
}
export interface ExecutorProof {
  bearer: string;
  executorId: string;
  generation: number;
  deploymentId: string;
  deadline: number;
}
export interface ExecutorIdentity extends T.CredentialRef {
  executorId: string;
  executorGeneration: number;
  resources: T.ResourceScope;
  deploymentId: string;
}
export interface PolicyInput {
  operation: T.ApprovalOperation;
  grants: T.Grant[];
  workspace: T.WorkspaceBinding;
  capabilities: string[];
  now: number;
  requireConfinement: boolean;
}
export type PolicyDecision =
  | { decision: "allow"; policyVersion: number }
  | { decision: "approval"; policyVersion: number; operation: T.ApprovalOperation }
  | { decision: "deny"; reason: string; policyVersion: number };
export interface RoutingInput {
  operation: T.ApprovalOperation;
  eligible: {
    target: T.BackendRef;
    grants: T.Grant[];
    capabilities: string[];
    reachable: boolean;
    revisionCompatible: boolean;
    confinement: "host" | "isolated";
  }[];
}
export type RoutingDecision =
  | { kind: "selected"; target: T.BackendRef }
  | { kind: "wait"; reason: "executor-unavailable" | "revision-unavailable" }
  | { kind: "deny"; reason: string };
