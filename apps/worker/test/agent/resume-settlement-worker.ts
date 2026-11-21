import type { Admission } from "../../src/agent/conversations.js";
import { scope } from "../../src/api/common.js";
import { routeRequest } from "../../src/api/router.js";
import type * as D from "../../src/boundary/dto.js";
import type { Env } from "../../src/boundary/env.js";
import {
  TestAgentSession as BaseAgent,
  ControlPlane as BaseControlPlane,
} from "./runtime-worker.js";

export {
  LinuxContainerHost,
  StorageGuardProbe,
  WorkspaceObject,
  WorkspaceProxy,
} from "./runtime-worker.js";

/** Test-only lost response AFTER the real CP has durably consumed the original claim. */
export class ControlPlane extends BaseControlPlane {
  #armed = false;
  #original: string | undefined;
  #hold = false;
  #drops = 0;
  armLostConsumed() {
    this.#armed = true;
    this.#hold = true;
  }
  releaseLostConsumed() {
    this.#hold = false;
  }
  override async settleCapacity(
    ctx: D.AuthContext,
    input: { reservationId: string; disposition: "consumed" | "unused"; observedBytes?: number },
  ) {
    const result = await super.settleCapacity(ctx, input);
    if (
      result.ok &&
      input.disposition === "consumed" &&
      this.#hold &&
      (this.#armed || input.reservationId === this.#original)
    ) {
      this.#armed = false;
      this.#original = input.reservationId;
      this.#drops++;
      return {
        ok: false as const,
        code: "unavailable" as const,
        message: "Synthetic lost accepted consumed reply",
        requestId: ctx.requestId,
        retryable: true,
        // Synthetic reply loss, not real principal rate pressure. Keep its
        // retry window short so the normal due/repair path is exercised.
        details: { retryAfterMs: 100 },
      };
    }
    return result;
  }
  capacityTrace(cid: string) {
    return {
      calls: this.ingressCounts(),
      droppedReservationId: this.#original,
      drops: this.#drops,
      holding: this.#hold,
      rows: this.store
        .page<{
          reservation: D.CapacityReservation;
          settlement?: { disposition: string };
          growthBytes?: number;
          covered?: boolean;
        }>("capacity_reservation", 0, 100)
        .filter((row) => row.value.reservation.ownerId === cid)
        .map((row) => ({
          reservationId: row.value.reservation.reservationId,
          operationId: row.value.reservation.operationId,
          bytes: row.value.reservation.bytes,
          settlement: row.value.settlement?.disposition ?? null,
          growthBytes: row.value.growthBytes ?? null,
          covered: row.value.covered ?? false,
        })),
    };
  }
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__resume-settlement/arm") {
      this.armLostConsumed();
      return Response.json(true);
    }
    if (url.pathname === "/__resume-settlement/release") {
      this.releaseLostConsumed();
      return Response.json(true);
    }
    if (url.pathname === "/__resume-settlement/trace")
      return Response.json(this.capacityTrace(url.searchParams.get("cid") ?? ""));
    return super.fetch(request);
  }
}
export class TestAgentSession extends BaseAgent {
  #controlError = "";
  #loseContinue = false;
  #continueCalls = 0;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const session = this.pi.session.bind(this.pi);
    this.pi.session = (...args) => {
      const current = session(...args);
      const resume = current.continue.bind(current);
      current.continue = async (...args) => {
        this.#continueCalls++;
        const result = await resume(...args);
        if (this.#loseContinue) {
          this.#loseContinue = false;
          throw new Error("Synthetic lost reply after actual Pi continuation commit");
        }
        return result;
      };
      return current;
    };
    const apply = this.controls.apply.bind(this.controls);
    this.controls.apply = async (id) => {
      try {
        return await apply(id);
      } catch (error) {
        this.#controlError = error instanceof Error ? error.message : "unknown";
        throw error;
      }
    };
  }
  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__resume-settlement/lose-continue") {
      this.#loseContinue = true;
      return Response.json(true);
    }
    if (url.pathname === "/__resume-settlement/trace")
      return Response.json(
        await this.resumeTrace(
          url.searchParams.get("cid") ?? "",
          url.searchParams.get("sample") === "true",
        ),
      );
    return super.onRequest(request);
  }
  async resumeTrace(cid: string, sample: boolean) {
    await this.lifecycle.start();
    const rows = (await this.store.page<Admission>("admission", 100)).filter(
      (row) => row.value.conversationId === cid,
    );
    if (sample && rows[0]) {
      const admission = rows[0].value;
      await this.authority.physical.beforeGrowth(
        { ...(admission.continuation?.auth ?? admission.auth), deadline: Date.now() + 30000 },
        scope({
          agentIds: [this.agentId],
          conversationIds: [cid],
          actions: [admission.continuation ? "tasks.resume" : "messages.submit"],
        }),
      );
    }
    return {
      continueCalls: this.#continueCalls,
      controlError: this.#controlError,
      controls: (
        await this.store.page<{ receipt: D.ControlReceipt; capacity?: D.CapacityReservation }>(
          "control",
          100,
        )
      ).map((row) => ({
        id: row.id,
        receipt: row.value.receipt,
        capacityId: row.value.capacity?.reservationId,
      })),
      inspection: JSON.parse(await this.inspectionJson(cid)),
      admissions: rows.map((row) => ({
        state: row.value.state,
        operationId: row.value.operationId,
        reservationId: row.value.capacity.reservationId,
        continuationOperationId: row.value.continuation?.operationId,
        continuationReservationId: row.value.continuation?.capacity.reservationId,
      })),
      growth: await this.growthReport(),
      completed: (
        await this.store.page<{ reservationId: string; operationId?: string }>(
          "storage-completed",
          100,
        )
      ).map((row) => row.value),
      report: JSON.parse(await this.lastPhysicalSample()),
    };
  }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const control = env.CONTROL_PLANE.getByName("control");
    if (url.pathname === "/__resume-settlement/arm") {
      return control.fetch(request);
    }
    if (url.pathname === "/__resume-settlement/release") {
      return control.fetch(request);
    }
    if (url.pathname === "/__resume-settlement/trace") {
      const local = await (
        await env.AGENT_SESSIONS.getByName(url.searchParams.get("agent") ?? "").fetch(
          request.clone(),
        )
      ).json();
      const currentControl = await (await control.fetch(request)).json();
      return Response.json({ control: currentControl, local });
    }
    if (url.pathname === "/__resume-settlement/lose-continue")
      return env.AGENT_SESSIONS.getByName(url.searchParams.get("agent") ?? "").fetch(request);
    return routeRequest(request, env);
  },
};
