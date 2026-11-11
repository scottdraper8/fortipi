import type * as D from "./dto.js";
export interface ExecutionBackend {
  readonly contractVersion: "1.0";
  describe(ctx: D.AuthContext, input: D.DescribeBackend): Promise<D.Outcome<D.BackendDescription>>;
  prepare(ctx: D.AuthContext, input: D.ExecutionRequest): Promise<D.Outcome<D.PreparedExecution>>;
  startOnce(
    ctx: D.AuthContext,
    input: D.PreparedExecution,
  ): Promise<D.Outcome<D.ExecutionObservation>>;
  queryExisting(
    ctx: D.AuthContext,
    input: D.ExecutionIdentity,
  ): Promise<D.Outcome<D.ExecutionObservation>>;
  cancel(ctx: D.AuthContext, input: D.CancelRequest): Promise<D.Outcome<D.CancelDisposition>>;
  collectResult(
    ctx: D.AuthContext,
    input: D.ExecutionIdentity,
  ): Promise<D.Outcome<D.PreparedResult>>;
  classifyUncertainty(
    ctx: D.AuthContext,
    input: D.ExecutionObservation,
  ): Promise<D.Outcome<D.UncertaintyDisposition>>;
}
