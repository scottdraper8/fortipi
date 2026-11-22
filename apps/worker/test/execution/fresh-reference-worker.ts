import type * as D from "../../src/boundary/dto.js";
import { TestAgentSession as BaseAgentSession } from "../agent/runtime-worker.js";

export * from "../agent/runtime-worker.js";
export { default } from "../agent/runtime-worker.js";

export class TestAgentSession extends BaseAgentSession {
  /** Advance an actual rejected approval, without waiting for the dispatch polling timer. */
  async settleRejectedJob(jobId: string) {
    const before = await this.jobs.state(jobId);
    const approval = before.approvalId
      ? await this.store.get<D.Approval>("approval", before.approvalId)
      : undefined;
    if (approval?.state !== "rejected" || before.job.execution)
      throw new Error("Actual rejected approval without execution required");
    const progress = await this.dispatch.tick(jobId);
    const after = await this.jobs.state(jobId);
    return { done: progress.done, state: after.job.state, hasExecution: !!after.job.execution };
  }
}
