import type { AdmissionIntent } from "../../src/agent/conversations.js";
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

/** Canonical typed receiver failures, injected BEFORE any capacity effect.
 * Actual CP authentication/registration/model selection/sampling remain real.
 */
export class ControlPlane extends BaseControlPlane {
  #mode = "";
  #calls = 0;
  #lastFailureAt = 0;
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
    if (!input.admissionSlots || !this.#mode) return super.reserveCapacity(auth, input);
    this.#calls++;
    this.#lastFailureAt = Date.now();
    return this.#mode === "hold"
      ? {
          ok: false,
          code: "quota_paused",
          message: "Storage observation unavailable; operator action required",
          retryable: false,
          requestId: auth.requestId,
          details: {
            retryAfterMs: 0,
            pressure: {
              resource: "storage",
              scope: { kind: "install" },
              source: "policy",
              measurement: "unknown",
              reason: "No trustworthy storage observation",
              action: "reclaim-storage",
            },
          },
        }
      : {
          ok: false,
          code: "rate_limited",
          message: "Known receiver retry window",
          retryable: true,
          requestId: auth.requestId,
          details: { retryAfterMs: 120000 },
        };
  }
  override async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/__admission-backoff/mode") {
      this.#mode = url.searchParams.get("mode") ?? "";
      return Response.json(true);
    }
    if (url.pathname === "/__admission-backoff/trace")
      return Response.json({ calls: this.#calls, lastFailureAt: this.#lastFailureAt });
    return super.fetch(request);
  }
}
export class TestAgentSession extends BaseAgent {
  override async onRequest(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/__admission-backoff/trace") {
      await this.lifecycle.start();
      const progress =
        url.searchParams.get("drain") === "true"
          ? await this.projection.drain({ maxItems: 16, deadline: Date.now() + 10000 })
          : undefined;
      const intents = await this.store.db.all<{ data: string; due: number | null }>(
        "SELECT data,due FROM fp_records_v1 WHERE kind='admission-intent' ORDER BY id LIMIT 100",
      );
      return Response.json({
        progress,
        intents: intents.map((row) => ({
          ...(JSON.parse(row.data) as AdmissionIntent),
          due: row.due,
        })),
        growth: await this.growthReport(),
        inspection: JSON.parse(await this.inspectionJson(url.searchParams.get("cid") ?? "")),
      });
    }
    return super.onRequest(request);
  }
}
export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    const cp = env.CONTROL_PLANE.getByName("control");
    if (url.pathname === "/__admission-backoff/mode") return cp.fetch(request);
    if (url.pathname === "/__admission-backoff/trace") {
      const local = await (
        await env.AGENT_SESSIONS.getByName(url.searchParams.get("agent") ?? "").fetch(
          request.clone(),
        )
      ).json();
      const control = await (await cp.fetch(request)).json();
      return Response.json({ local, control });
    }
    return routeRequest(request, env);
  },
};
