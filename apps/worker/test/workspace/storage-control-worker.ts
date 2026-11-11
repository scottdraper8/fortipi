export { WorkspaceObject as TestWorkspace } from "../../src/workspace/workspace-object.js";
export { TestRecipient } from "../control/fixtures/recipients.js";

import type * as D from "../../src/boundary/dto.js";
import { TestControlPlane as Base } from "../control/fixtures/worker.js";

export { default } from "../control/fixtures/worker.js";

/** Actual CP setup without serializing its recursive generic method over custom RPC. */
export class TestControlPlane extends Base {
  override async settleCapacity(
    ctx: D.AuthContext,
    input: Parameters<Base["settleCapacity"]>[1],
  ): ReturnType<Base["settleCapacity"]> {
    const result = await super.settleCapacity(ctx, input);
    if (
      result.ok &&
      ctx.requestId === "lost-settlement-ack" &&
      input.disposition === "consumed" &&
      !this.store.get("test_settlement_lost", input.reservationId)
    ) {
      this.store.put("test_settlement_lost", input.reservationId, true);
      return {
        ok: false,
        code: "interrupted",
        message: "Lost actual settlement acknowledgment",
        requestId: ctx.requestId,
        retryable: false,
        details: { reason: "uncertain_effects" },
      };
    }
    return result;
  }
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/__test/create-workspace") {
      const auth = JSON.parse(request.headers.get("X-Fortipi-Context") ?? "null") as D.AuthContext;
      return Response.json(
        await this.handleApi(auth, {
          operationId: "createWorkspace",
          path: {},
          query: {},
          body: (await request.json()) as D.OperationRequest<"createWorkspace">["body"],
        }),
      );
    }
    return super.fetch(request);
  }
}
