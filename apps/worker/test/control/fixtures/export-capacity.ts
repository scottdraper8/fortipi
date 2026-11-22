import type * as D from "../../../src/boundary/dto.js";
import worker, { TestControlPlane as BaseControl, type BudgetControl } from "./storage-budget.js";

export { TestRecipient } from "./storage-budget.js";

export class TestControlPlane extends BaseControl {
  async loseReservation(
    ctx: D.AuthContext,
    input: Parameters<BudgetControl["reserveCapacity"]>[1],
  ): Promise<D.Outcome<D.CapacityReservation>> {
    const result = await this.reserveCapacity(ctx, input);
    if (result.ok) throw new Error("Controlled lost reply after accepted reservation");
    return result;
  }
}
export type ExportControl = BudgetControl & Pick<TestControlPlane, "loseReservation">;
export default worker;
