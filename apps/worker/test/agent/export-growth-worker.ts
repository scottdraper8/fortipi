import { scope } from "../../src/api/common.js";
import type * as D from "../../src/boundary/dto.js";
import type { Env } from "../../src/boundary/env.js";
import base, {
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
  readonly #held = new Set<() => void>();
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
    if (result.ok && result.value.admissionSlots === 0 && this.#mode === "held-settlement") {
      this.#operationId = result.value.operationId;
      await new Promise<void>((accept) => {
        this.#held.add(accept);
      });
    }
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
      const releases = [...this.#held];
      this.#held.clear();
      for (const release of releases) release();
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
          .filter(
            (row) =>
              row.value.reservation.operationId ===
              (url.searchParams.get("operation") ?? this.#operationId),
          )
          .map((row) => ({
            reservation: row.value.reservation,
            disposition: row.value.settlement?.disposition,
            covered: row.value.covered ?? false,
            held: this.#held.size > 0,
          })),
      );
    return super.fetch(request);
  }
}
export class TestAgentSession extends BaseAgent {
  #failArm = false;
  #armFailures = 0;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const prepare = this.exports.prepare.bind(this.exports);
    this.exports.prepare = async (...args) => {
      const descriptor = await prepare(...args);
      if ((await this.store.get("fixture", "fault")) === "export-after-ready") {
        await this.store.transaction(async (tx) => {
          await this.store.remove("fixture", "fault", tx);
          await this.store.put("fixture", "barrier", "export-after-ready", tx);
        });
        await new Promise<void>((accept) => setTimeout(accept, 300000));
      }
      return descriptor;
    };
    const arm = this.conversations.host.arm;
    this.conversations.host.arm = async () => {
      if (this.#failArm) {
        this.#armFailures++;
        throw new Error("Synthetic unwritable own application wake intent");
      }
      await arm();
    };
  }
  override async onRequest(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/__export-growth/arm-failure") {
      this.#failArm = true;
      return Response.json(true);
    }
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
        barrier: (await this.store.get("fixture", "barrier")) ?? null,
        armFailures: this.#armFailures,
        retainedExports: (await this.store.page("export", 100)).map((row) => row.id),
        retainedMetadata: (
          await this.store.page<{
            exportId: string;
            sha256: string;
            size: number;
            createdAt: number;
          }>("export", 100)
        ).map(({ value }) => ({
          exportId: value.exportId,
          sha256: value.sha256,
          size: value.size,
          createdAt: value.createdAt,
        })),
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
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/__export-growth/mode")
      return env.CONTROL_PLANE.getByName("control").fetch(request);
    if (url.pathname === "/__export-growth/arm-failure")
      return env.AGENT_SESSIONS.getByName(url.searchParams.get("agent") ?? "").fetch(request);
    if (url.pathname === "/__export-growth/trace") {
      const local = await (
        await env.AGENT_SESSIONS.getByName(url.searchParams.get("agent") ?? "").fetch(
          request.clone(),
        )
      ).json();
      const control = await (await env.CONTROL_PLANE.getByName("control").fetch(request)).json();
      return Response.json({ local, control });
    }
    return base.fetch(request, env);
  },
} satisfies ExportedHandler<Env>;
