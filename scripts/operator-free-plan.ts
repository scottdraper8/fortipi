import assert from "node:assert/strict";
import { createHash } from "node:crypto";

/** Private release provenance, not runtime configuration or a provider billing observation. */
export interface OperatorConfirmedFreePlan {
  basis: "operator-confirmed";
  plan: "free";
  accountBindingSha256: string;
  accountBindingReference: string;
  accountBindingSourceCommit: string;
  accountBindingSourceSha256: string;
  statementReference: "docs/maintenance.md#operator-confirmed-workers-free-plan";
  statementSha256: string;
  statementAt: null;
  recordedAt: string;
}

// Normalized standing operator decision; the original assertion timestamp is unknown.
export const operatorFreeStatement = "Workers Free until the user announces an upgrade.";
export const operatorFreeStatementSha256 = createHash("sha256")
  .update(operatorFreeStatement)
  .digest("hex");

// Authenticated hash-only preflight: source/job/step identity and exactly one
// fixed hash record verified independently; this is not a provider plan read.
// Never derive this record from a target/config/CLI field or an environment flag.
// An announced upgrade supersedes it by removing/replacing it in trusted source.
const currentDecision: Readonly<OperatorConfirmedFreePlan> | null = Object.freeze({
  basis: "operator-confirmed",
  plan: "free",
  accountBindingSha256: "2125aa3db2573c8495564aba49d88f90980baaeae39c7a590eadacedd25c4d18",
  accountBindingReference:
    "https://github.com/scottdraper8/fortipi/actions/runs/43423152595/job/131877874565",
  accountBindingSourceCommit: "a92f24c742cc7b9ac3b8103db57d42d317d9480a",
  accountBindingSourceSha256: "fe61c1a0a87d727fa7fc64c9f9cc19ed26dff3160299852a73f2dd85ec5dae46",
  statementReference: "docs/maintenance.md#operator-confirmed-workers-free-plan",
  statementSha256: operatorFreeStatementSha256,
  statementAt: null,
  recordedAt: "2026-11-13T12:16:52Z",
});

/** Nonsecret source data only; callers cannot activate or replace the current decision. */
export function operatorFreeDecision(): OperatorConfirmedFreePlan | undefined {
  const decision = currentDecision;
  return decision ? { ...decision } : undefined;
}

export function operatorConfirmedFreePlan(
  accountBindingSha256: string,
): OperatorConfirmedFreePlan | undefined {
  assert.match(accountBindingSha256, /^[a-f0-9]{64}$/);
  const decision = operatorFreeDecision();
  if (!decision || decision.accountBindingSha256 !== accountBindingSha256) return undefined;
  assert.equal(decision.statementSha256, operatorFreeStatementSha256);
  assert.ok(Number.isFinite(Date.parse(decision.recordedAt)));
  return { ...decision };
}

/** Exact current source record, on the intended account only. Serialized claims grant no authority. */
export function assertOperatorConfirmedFreePlan(
  value: unknown,
  accountBindingSha256: string,
): asserts value is OperatorConfirmedFreePlan {
  const expected = operatorConfirmedFreePlan(accountBindingSha256);
  assert.ok(expected, "No current operator-confirmed Free plan for this account");
  assert.deepEqual(value, expected, "Missing, foreign or superseded Free plan provenance");
}
