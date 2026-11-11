import type * as D from "./dto.js";
/** CAS projection + event draft + recipient outbox are persisted in one queued transaction. */
export interface JobStore {
  readonly contractVersion: "1.0";
  insertIfAbsent(ctx: D.AuthContext, input: D.JobSeed): Promise<D.Outcome<D.JobRecord>>;
  get(ctx: D.AuthContext, input: D.JobLookup): Promise<D.Outcome<D.JobRecord>>;
  transition(ctx: D.AuthContext, input: D.JobTransition): Promise<D.Outcome<D.JobRecord>>;
  decideApproval(
    ctx: D.AuthContext,
    input: D.ApprovalDecision,
  ): Promise<D.Outcome<D.ApprovalRecord>>;
  savePreparedResult(ctx: D.AuthContext, input: D.ResultDelivery): Promise<D.Outcome<D.JobRecord>>;
  finalize(ctx: D.AuthContext, input: D.FinalizeJob): Promise<D.Outcome<D.JobRecord>>;
  ingestFact(ctx: D.FactDeliveryContext, input: D.Fact): Promise<D.Outcome<D.FactAck>>;
  pageFacts(ctx: D.AuthContext, input: D.FactPageRequest): Promise<D.Outcome<D.FactPage>>;
  ackFacts(ctx: D.AuthContext, input: D.FactAckRequest): Promise<D.Outcome<D.FactAck>>;
}
