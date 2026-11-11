import type * as D from "./dto.js";
export interface AgentSessionRpc {
  readonly contractVersion: "1.0";
  handleApi<K extends D.AgentOperationId>(
    ctx: D.AuthContext,
    input: D.OperationRequest<K>,
  ): Promise<D.Outcome<D.OperationResponse<K>>>;
  receiveExecutorOutput(
    ctx: D.AuthContext,
    input: D.OutputDelivery,
  ): Promise<D.Outcome<D.DeliveryAck>>;
  receiveExecutorResult(
    ctx: D.AuthContext,
    input: D.ResultDelivery,
  ): Promise<D.Outcome<D.DeliveryAck>>;
  invalidateGeneration(
    ctx: D.RecoveryContext,
    input: D.Invalidation,
  ): Promise<D.Outcome<D.InvalidationAck>>;
  ingestFacts(ctx: D.FactDeliveryContext, input: D.FactBatch): Promise<D.Outcome<D.FactBatchAck>>;
  describeJob: D.ApiMethod<"describeJob">;
  describeTask: D.ApiMethod<"describeTask">;
  describeApproval: D.ApiMethod<"describeApproval">;
  exportData(ctx: D.AuthContext, input: D.ExportRequest): Promise<D.Outcome<D.ExportDescriptor>>;
  drainRecovery(ctx: D.AuthContext, input: D.DrainBudget): Promise<D.Outcome<D.DrainProgress>>;
  fetch(request: Request): Promise<Response>;
}
