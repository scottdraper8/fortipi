import type { Ledger } from "./ledger.js";
export class Approvals {
  ledger: Ledger;
  constructor(ledger: Ledger) {
    this.ledger = ledger;
  }
  list() {
    return this.ledger.pending().map((row) => ({
      jobId: row.assignment.identity.jobId,
      operationDigest: row.assignment.identity.operationDigest,
      digest: row.approvalKey,
      assignment: row.assignment,
      decision: row.decision,
      hostTrust: "daemon-user-files-and-network",
    }));
  }
  decide(jobId: string, digest: string, decision: "allow" | "deny"): void {
    this.ledger.transaction(() => {
      const row = this.ledger.get(jobId);
      if (row?.state !== "pending" || row.approvalKey !== digest || row.cancelled)
        throw new Error("approval context no longer pending");
      if (row.decision !== "pending" && row.decision !== decision)
        throw new Error("conflicting approval");
      row.decision = decision;
      if (decision === "deny") {
        row.state = "closed";
        row.reason = "local rejection";
      }
      this.ledger.put(row);
    });
  }
}
