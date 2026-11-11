import type * as D from "./dto.js";
export interface ToolPolicy {
  readonly contractVersion: "1.0";
  evaluate(input: D.PolicyInput): D.PolicyDecision;
}
export interface WorkerAuthenticator {
  readonly contractVersion: "1.0";
  authenticate(input: D.ExecutorProof): Promise<D.Outcome<D.ExecutorIdentity>>;
}
export interface RoutingStrategy {
  readonly contractVersion: "1.0";
  select(input: D.RoutingInput): D.RoutingDecision;
}
