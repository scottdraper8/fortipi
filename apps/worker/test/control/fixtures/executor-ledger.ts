import { routeRequest } from "../../../src/api/router.js";
import type * as D from "../../../src/boundary/dto.js";
import type { ExecutorState } from "../../../src/control/tickets.js";
import { TestControlPlane as Base } from "./enforcer-races.js";

export { TestRecipient } from "./worker.js";
export default { fetch: routeRequest };
export class TestControlPlane extends Base {
  async ledgerState(executorId: string): Promise<string> {
    return JSON.stringify(this.store.get<ExecutorState>("executor", executorId) ?? null);
  }
  async legacyExecutor(executorId: string): Promise<void> {
    const row = this.store.get<ExecutorState>("executor", executorId);
    if (!row) throw new Error("Missing fixture executor");
    delete row.ledger;
    this.store.put("executor", executorId, row);
  }
  async raceTicket(
    admin: D.AuthContext,
    ctx: D.AuthContext,
    input: D.TicketInput,
  ): Promise<boolean> {
    const minting = this.tickets.mint(ctx, input).then(
      () => true,
      () => false,
    );
    const revocation = this.revocations.begin(admin, "credential", ctx.credentialId, {
      requestId: "mint-revoke",
      expectedGeneration: ctx.generation,
    });
    await this.revocations.publish(revocation);
    return minting;
  }
}
