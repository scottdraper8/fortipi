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

export class ControlPlane extends BaseControlPlane {
  #mode = "";
  #operationId = "";
  override async reserveCapacity(
    auth: D.AuthContext,
    input: {
      operationId: string;
      ownerId: string;
      policyVersion: number;
      bytes: number;
      admissionSlots: number;
    },
  ): Promise<D.Outcome<D.CapacityReservation>> {
    const result = await super.reserveCapacity(auth, input);
    if (result.ok && input.admissionSlots === 0 && this.#mode === "capacity") {
      this.#operationId = input.operationId;
      return this.#lost(auth);
    }
    return result;
  }
  override async settleCapacity(
    auth: D.AuthContext,
    input: {
      reservationId: string;
      disposition: "consumed" | "unused";
      observedBytes?: number;
    },
  ): Promise<D.Outcome<D.CapacityReservation>> {
    const result = await super.settleCapacity(auth, input);
    if (result.ok && result.value.admissionSlots === 0 && this.#mode === "settlement") {
      this.#operationId = result.value.operationId;
      return this.#lost(auth);
    }
    return result;
  }
  #lost(auth: D.AuthContext): D.Outcome<never> {
    return {
      ok: false,
      code: "unavailable",
      message: "Synthetic lost committed export reply",
      requestId: auth.requestId,
      retryable: true,
      details: { retryAfterMs: 100 },
    };
  }
  override async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/__export-growth/mode") {
      this.#mode = url.searchParams.get("mode") ?? "";
      return Response.json(true);
    }
    if (url.pathname === "/__export-growth/trace")
      return Response.json(
        this.store
          .page<{
            reservation: D.CapacityReservation;
            settlement?: { disposition: string };
            covered?: boolean;
          }>("capacity_reservation", 0, 100)
          .filter((row) => row.value.reservation.operationId === this.#operationId)
          .map((row) => ({
            reservation: row.value.reservation,
            disposition: row.value.settlement?.disposition,
            covered: row.value.covered ?? false,
          })),
      );
    return super.fetch(request);
  }
}
export class TestAgentSession extends BaseAgent {
  override async onRequest(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/__export-growth/trace") {
      await this.lifecycle.start();
      if (url.searchParams.get("drain") === "true")
        await this.exports.drain({ maxItems: 1, deadline: Date.now() + 10000 });
      if (url.searchParams.get("sample") === "true") {
        const auth = JSON.parse(request.headers.get("X-Fortipi-Context") ?? "{}") as D.AuthContext;
        await this.authority.physical.beforeGrowth(
          auth,
          scope({
            agentIds: [this.agentId],
            conversationIds: [url.searchParams.get("cid") ?? ""],
            actions: ["exports.create"],
          }),
        );
      }
      return Response.json({
        growth: await this.growthReport(),
        physical: this.store.physicalBytes(),
        report: JSON.parse(await this.lastPhysicalSample()),
        works: (
          await this.store.page<{ operationId: string; capacity?: D.CapacityReservation }>(
            "export-work",
            100,
          )
        ).map((row) => ({ operationId: row.value.operationId, capacity: row.value.capacity })),
      });
    }
    return super.onRequest(request);
  }
}
export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname === "/__export-growth/mode")
      return env.CONTROL_PLANE.getByName("control").fetch(request);
    if (url.pathname === "/__export-growth/trace") {
      const local = await (
        await env.AGENT_SESSIONS.getByName(url.searchParams.get("agent") ?? "").fetch(
          request.clone(),
        )
      ).json();
      const control = await (await env.CONTROL_PLANE.getByName("control").fetch(request)).json();
      return Response.json({ local, control });
    }
    return routeRequest(request, env);
  },
};
