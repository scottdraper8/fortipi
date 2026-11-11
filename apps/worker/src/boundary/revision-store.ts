import type * as D from "./dto.js";
/** Registry lookups on authority never call the child. Child verifies registry outside its FIFO. */
export interface RevisionStoreRpc {
  allocateStore(
    ctx: D.AuthContext,
    input: D.StoreAllocationRequest,
  ): Promise<D.Outcome<D.StoreAllocation>>;
  describeStore(ctx: D.AuthContext, input: D.StoreLookup): Promise<D.Outcome<D.StoreState>>;
  initializeStore(ctx: D.AuthContext, input: D.StoreAllocation): Promise<D.Outcome<D.StoreState>>;
  sealStore(ctx: D.AuthContext, input: D.StoreSeal): Promise<D.Outcome<D.SealedStore>>;
  retireStore(ctx: D.AuthContext, input: D.StoreLookup): Promise<D.Outcome<D.StoreRetirement>>;
  deleteStore(ctx: D.AuthContext, input: D.StoreRetirement): Promise<D.Outcome<D.CleanupReceipt>>;
}
export type WorkspaceRole =
  | { kind: "authority"; workspaceId: string }
  | {
      kind: "revision-store";
      workspaceId: string;
      storeId: string;
      uploadId: string;
      authorityId: string;
    }
  | {
      kind: "scratch";
      workspaceId: string;
      scratchId: string;
      jobId: string;
      executionId: string;
      authorityId: string;
    };
