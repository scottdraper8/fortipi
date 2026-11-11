import type * as D from "./dto.js";
export interface WorkspaceProvider {
  readonly contractVersion: "1.0";
  readonly capabilities: readonly ("read" | "write" | "snapshot" | "diff")[];
  describe: D.ApiMethod<"describeWorkspace">;
  list: D.ApiMethod<"listWorkspaceFiles">;
  stat: D.ApiMethod<"statWorkspaceFile">;
  read(
    ctx: D.AuthContext,
    input: D.OperationRequest<"readWorkspaceFile">,
  ): Promise<D.Outcome<D.ByteReference>>;
  write(ctx: D.AuthContext, input: D.WorkspaceTransaction): Promise<D.Outcome<D.CommitReceipt>>;
  delete(ctx: D.AuthContext, input: D.WorkspaceTransaction): Promise<D.Outcome<D.CommitReceipt>>;
  mkdir(ctx: D.AuthContext, input: D.WorkspaceTransaction): Promise<D.Outcome<D.CommitReceipt>>;
  snapshot: D.ApiMethod<"snapshotWorkspace">;
  diff: D.ApiMethod<"diffWorkspace">;
}
export interface WorkspaceTransfer {
  readonly contractVersion: "1.0";
  materialize(ctx: D.AuthContext, input: D.SnapshotPlan): Promise<D.Outcome<D.ScratchHandle>>;
  upload(ctx: D.AuthContext, input: D.ScratchResult): Promise<D.Outcome<D.ValidatedStage>>;
  commit(ctx: D.AuthContext, input: D.CommitInput): Promise<D.Outcome<D.CommitReceipt>>;
  abort(ctx: D.AuthContext, input: D.UploadLookup): Promise<D.Outcome<D.CleanupReceipt>>;
}
/** Same-process transport only. These streams/signals cannot appear in RPC DTOs. */
export interface WorkspaceStreams {
  read(
    ctx: D.AuthContext,
    input: D.ByteReference,
    signal?: AbortSignal,
  ): Promise<D.Outcome<ReadableStream<Uint8Array>>>;
  upload(
    ctx: D.AuthContext,
    input: D.UploadLookup,
    bytes: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<D.Outcome<D.ValidatedStage>>;
}
