import type * as D from "./dto.js";
import type { InfrastructureReservations } from "./infrastructure.js";
import type { RevisionStoreRpc } from "./revision-store.js";
export interface WorkspaceObjectRpc extends RevisionStoreRpc, InfrastructureReservations {
  readonly contractVersion: "1.0";
  describe: D.ApiMethod<"describeWorkspace">;
  list: D.ApiMethod<"listWorkspaceFiles">;
  stat: D.ApiMethod<"statWorkspaceFile">;
  manifest: D.ApiMethod<"getWorkspaceManifest">;
  snapshot: D.ApiMethod<"snapshotWorkspace">;
  diff: D.ApiMethod<"diffWorkspace">;
  read(
    ctx: D.AuthContext,
    input: D.OperationRequest<"readWorkspaceFile">,
  ): Promise<D.Outcome<D.ByteReference>>;
  acquireLease(ctx: D.AuthContext, input: D.TargetReservation): Promise<D.Outcome<D.Lease>>;
  renewLease(ctx: D.AuthContext, input: D.LeaseRenewal): Promise<D.Outcome<D.Lease>>;
  releaseLease(ctx: D.AuthContext, input: D.LeaseRelease): Promise<D.Outcome<D.ReleaseReceipt>>;
  invalidateGeneration(
    ctx: D.RecoveryContext,
    input: D.Invalidation,
  ): Promise<D.Outcome<D.InvalidationAck>>;
  beginUpload: D.ApiMethod<"beginUpload">;
  getUpload: D.ApiMethod<"getUpload">;
  putChunk: D.ApiMethod<"putUploadChunk">;
  validateUpload: D.ApiMethod<"validateUpload">;
  abortUpload: D.ApiMethod<"abortUpload">;
  commitUpload: D.ApiMethod<"commitUpload">;
  getCommitReceipt: D.ApiMethod<"getCommitReceipt">;
  transactWorkspace: D.ApiMethod<"transactWorkspace">;
  commit(ctx: D.AuthContext, input: D.CommitInput): Promise<D.Outcome<D.CommitReceipt>>;
  getReceipt(ctx: D.AuthContext, input: D.CommitLookup): Promise<D.Outcome<D.CommitReceipt>>;
  transact(ctx: D.AuthContext, input: D.WorkspaceTransaction): Promise<D.Outcome<D.CommitReceipt>>;
  prepareLocalCommit(
    ctx: D.AuthContext,
    input: {
      scope: D.LocalScope;
      commitId: string;
      preparation: D.LocalPrepared;
      expectedPostManifestHash?: string;
    },
  ): Promise<D.Outcome<D.LocalCommitIntent>>;
  commitLocal(
    ctx: D.AuthContext,
    input: { intent: D.LocalCommitIntent; observation: D.LocalObservation; manifest: D.Manifest },
  ): Promise<D.Outcome<D.CommitReceipt>>;
  prepareExecution(
    ctx: D.AuthContext,
    input: D.ExecutionRequest,
  ): Promise<D.Outcome<D.PreparedExecution>>;
  startOnce(
    ctx: D.AuthContext,
    input: D.PreparedExecution,
  ): Promise<D.Outcome<D.ExecutionObservation>>;
  queryExecution(
    ctx: D.AuthContext,
    input: D.ExecutionIdentity,
  ): Promise<D.Outcome<D.ExecutionObservation>>;
  cancelExecution(
    ctx: D.AuthContext,
    input: D.CancelRequest,
  ): Promise<D.Outcome<D.CancelDisposition>>;
  collectResult(
    ctx: D.AuthContext,
    input: D.ExecutionIdentity,
  ): Promise<D.Outcome<D.PreparedResult>>;
  exportData(ctx: D.AuthContext, input: D.ExportRequest): Promise<D.Outcome<D.ExportDescriptor>>;
  pageFacts(ctx: D.AuthContext, input: D.FactPageRequest): Promise<D.Outcome<D.FactPage>>;
  ackFacts(ctx: D.AuthContext, input: D.FactAckRequest): Promise<D.Outcome<D.FactAck>>;
  fetch(request: Request): Promise<Response>;
}
