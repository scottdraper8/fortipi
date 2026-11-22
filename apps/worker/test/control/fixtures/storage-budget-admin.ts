import type { Env } from "../../../src/boundary/env.js";
import { check, id, ref } from "../../../src/control/store.js";
import baseWorker, { AdminFixtureControl, AdminPeerFixture as BasePeer } from "./admin.js";

export { AdminFixtureControl };
/** Actual peer database growth, not a declared byte count or a Pi substitution. */
export class AdminPeerFixture extends BasePeer {
  async growStorage(): Promise<{ bytes: number; observedAt: number }> {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS budget_pressure(id INTEGER PRIMARY KEY,data BLOB NOT NULL)",
    );
    this.ctx.storage.transactionSync(() => {
      for (let row = 0; row < 540; row++)
        this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO budget_pressure(id,data) VALUES(?,zeroblob(524288))",
          row,
        );
    });
    return { bytes: this.ctx.storage.sql.databaseSize, observedAt: Date.now() };
  }
}
type FixtureEnv = Omit<Env, "CONTROL_PLANE" | "AGENT_SESSIONS"> & {
  CONTROL_PLANE: DurableObjectNamespace<AdminFixtureControl>;
  AGENT_SESSIONS: DurableObjectNamespace<AdminPeerFixture>;
};
export default {
  async fetch(request: Request, env: FixtureEnv): Promise<Response> {
    const inspecting = /^\/fixture\/budget-state\/([A-Za-z0-9_-]+)$/.exec(
      new URL(request.url).pathname,
    );
    if (inspecting?.[1])
      return Response.json({
        control: JSON.parse(await env.CONTROL_PLANE.getByName("control").inspect()),
        peer: JSON.parse(await env.AGENT_SESSIONS.getByName(inspecting[1]).inspect()),
      });
    const inflating = /^\/fixture\/budget-inflate\/([A-Za-z0-9_-]+)$/.exec(
      new URL(request.url).pathname,
    );
    if (inflating?.[1])
      return Response.json(await env.AGENT_SESSIONS.getByName(inflating[1]).growStorage());
    const match = /^\/fixture\/storage-overrun\/([A-Za-z0-9_-]+)$/.exec(
      new URL(request.url).pathname,
    );
    if (!match) return baseWorker.fetch(request, env);
    const agentId = match[1];
    check(agentId, "invalid_request", "Fixture Agent required");
    const cp = env.CONTROL_PLANE.getByName("control");
    const auth = await cp.authenticate({
      bearer: (request.headers.get("Authorization") ?? "").replace(/^Bearer /, ""),
      deploymentId: env.CONTROL_PLANE.idFromName("control").toString(),
      requestId: id(),
      deadline: Date.now() + 30000,
    });
    check(auth.ok && auth.value.role === "admin", "unauthorized", "Fixture operator required");
    const registration = await cp.registerAuthorityRecipient(auth.value, {
      credential: ref(auth.value),
      recipient: { kind: "agent", id: agentId },
      resources: {
        agentIds: [agentId],
        conversationIds: [],
        workspaceIds: [],
        executorIds: [],
        backendIds: [],
        tools: [],
        actions: ["backups.create"],
      },
    });
    check(registration.ok, "unauthorized", "Fixture registration rejected");
    const measured = await env.AGENT_SESSIONS.getByName(agentId).growStorage();
    const response = await cp.fetch(
      new Request("https://control.internal/internal/storage-sample", {
        method: "POST",
        headers: {
          "X-Fortipi-Context": JSON.stringify({
            ...auth.value,
            registrationId: registration.value.registrationId,
          }),
        },
        body: JSON.stringify({
          sampleId: id(),
          policyVersion: 1,
          sampleSeq: 1,
          observedAt: measured.observedAt,
          coverage: { kind: "agent", bytes: measured.bytes },
          coveredReservationIds: [],
        }),
      }),
    );
    check(response.ok, "internal", "Actual overrun observation rejected");
    return Response.json(measured);
  },
};
