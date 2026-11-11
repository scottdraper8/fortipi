import { DurableObject } from "cloudflare:workers";
import { createHash } from "node:crypto";
import type * as D from "../../../src/boundary/dto.js";
import type { Env } from "../../../src/boundary/env.js";
import { ControlPlane } from "../../../src/control/control-plane.js";
import { check, hash, id, json, outcome } from "../../../src/control/store.js";

/** Test-only state inspection. All admin behavior is the actual CP implementation. */
export class AdminFixtureControl extends ControlPlane {
  async inspect(): Promise<string> {
    const blobHash = createHash("sha256");
    for (const row of this.ctx.storage.sql
      .exec<{ data: ArrayBuffer }>(
        "SELECT data FROM cp_admin_chunks ORDER BY artifact_id,ordinal LIMIT 256",
      )
      .toArray())
      blobHash.update(new Uint8Array(row.data));
    return json({
      blobHash: blobHash.digest("hex"),
      jobs: this.store
        .page<{
          state: string;
          attempts: number;
          requestKey: string;
          copyUntil: number;
          expiresAt: number;
          forgetAt: number;
          actor: D.AuthContext;
          parts: {
            copied: number;
            source: D.AdminArtifactReference;
            reference: D.AdminArtifactReference;
          }[];
          peers: { exportId: string }[];
        }>("admin_job", 0, 64)
        .map((r) => ({
          id: r.key,
          state: r.value.state,
          attempts: r.value.attempts,
          copyUntil: r.value.copyUntil,
          expiresAt: r.value.expiresAt,
          forgetAt: r.value.forgetAt,
          requestDue:
            this.ctx.storage.sql
              .exec<{ due: number | null }>(
                "SELECT due FROM cp_records WHERE kind='admin_request' AND key=?",
                r.value.requestKey,
              )
              .toArray()[0]?.due ?? null,
          due: this.ctx.storage.sql
            .exec<{ due: number | null }>(
              "SELECT due FROM cp_records WHERE kind='admin_job' AND key=?",
              r.key,
            )
            .one().due,
          copied: r.value.parts.reduce((n, p) => n + p.copied, 0),
          peerIds: r.value.peers.map((p) => p.exportId),
          authenticatedAt: r.value.actor.authenticatedAt,
          credentialExpiresAt: r.value.actor.credentialExpiresAt,
          parts: r.value.parts.map((p) => ({
            sourceId: p.source.artifactId,
            publicId: p.reference.artifactId,
            sha256: p.source.sha256,
            size: p.source.size,
          })),
        })),
      chunks: this.ctx.storage.sql
        .exec<{ n: number; bytes: number }>(
          "SELECT count(*) n,COALESCE(SUM(length(data)),0) bytes FROM cp_admin_chunks",
        )
        .one(),
      indexes: this.ctx.storage.sql
        .exec<{ n: number }>("SELECT count(*) n FROM cp_records WHERE kind='admin_artifact'")
        .one().n,
      usage: this.capacity.usage(),
      physical: this.ctx.storage.sql.databaseSize,
      holds: this.store.page("repair_hold", 0, 16).map((row) => row.value),
    });
  }
  async nearFull(ctx: D.AuthContext): Promise<string> {
    const bounds = this.directory.policy().bounds,
      usage = this.capacity.usage(),
      bytes =
        Math.floor(bounds.installBytes * (1 - bounds.headroomFraction)) -
        this.ctx.storage.sql.databaseSize -
        usage.reserved -
        usage.consumed -
        98304;
    const reservation = this.capacity.reserve(ctx, {
      operationId: "existing-pending-work",
      ownerId: "existing-pending-owner",
      policyVersion: this.directory.policy().version,
      bytes,
      admissionSlots: 0,
    });
    return json({
      reservation,
      usage: this.capacity.usage(),
      physical: this.ctx.storage.sql.databaseSize,
    });
  }
  async expire(operationId: string, copyOnly = false): Promise<void> {
    const job = this.store.get<Record<string, unknown>>("admin_job", operationId);
    check(job, "not_found", "Fixture job absent");
    this.store.put(
      "admin_job",
      operationId,
      copyOnly
        ? { ...job, copyUntil: Date.now() - 1 }
        : { ...job, expiresAt: Date.now() - 1, forgetAt: Date.now() - 1 },
      "",
      "",
      copyOnly ? null : Date.now(),
    );
    if (copyOnly) {
      check(typeof job.requestKey === "string", "conflict", "Fixture request key missing");
      this.store.reschedule("admin_request", job.requestKey, Date.now());
    }
    await this.store.arm();
  }
}

type Snapshot = { digest: string; request: D.ExportRequest; reference: D.AdminArtifactReference };
/** Controlled immutable producer backed by real SQLite; not an Agent/Pi implementation. */
export class AdminPeerFixture extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS peer_live(id INTEGER PRIMARY KEY CHECK(id=1),data BLOB NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS peer_export(id TEXT PRIMARY KEY,metadata TEXT NOT NULL,data BLOB NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS peer_control(id INTEGER PRIMARY KEY CHECK(id=1),mode TEXT NOT NULL,calls INTEGER NOT NULL,waiting INTEGER NOT NULL)",
    );
    ctx.storage.sql.exec("INSERT OR IGNORE INTO peer_control VALUES(1,'normal',0,0)");
  }
  get contractVersion(): "1.0" {
    return "1.0";
  }
  async seed(bytes: Uint8Array): Promise<void> {
    this.ctx.storage.sql.exec(
      "INSERT INTO peer_live(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      new Uint8Array(bytes).buffer,
    );
  }
  async mode(mode: string): Promise<void> {
    check(
      [
        "normal",
        "hold",
        "hold-tail",
        "corrupt",
        "offline",
        "overclaim",
        "quota-describe",
        "quota-fetch",
        "storage-fetch",
        "large-error",
      ].includes(mode),
      "invalid_request",
      "Unknown fixture mode",
    );
    this.ctx.storage.sql.exec("UPDATE peer_control SET mode=? WHERE id=1", mode);
  }
  #control() {
    return this.ctx.storage.sql
      .exec<{ mode: string; calls: number; waiting: number }>(
        "SELECT mode,calls,waiting FROM peer_control WHERE id=1",
      )
      .one();
  }
  async inspect(): Promise<string> {
    return json({
      exports: this.ctx.storage.sql.exec<{ n: number }>("SELECT count(*) n FROM peer_export").one()
        .n,
      ...this.#control(),
      quota: (await this.ctx.storage.get("quota")) ?? null,
    });
  }
  async exportData(
    ctx: D.AuthContext,
    input: D.ExportRequest,
  ): Promise<D.Outcome<D.ExportDescriptor>> {
    return outcome(ctx.requestId, async () => {
      await this.#authorized(ctx, input);
      if (this.#control().mode === "quota-describe") {
        const error = await this.#quota(ctx, false);
        check(false, error.code, error.message, error.details);
      }
      const digest = await hash(json(input));
      await this.#authorized(ctx, input);
      const old = this.ctx.storage.sql
        .exec<{ metadata: string }>("SELECT metadata FROM peer_export WHERE id=?", input.exportId)
        .toArray()[0];
      if (old) {
        const snapshot: Snapshot = JSON.parse(old.metadata);
        check(snapshot.digest === digest, "conflict", "Peer export intent changed");
        return this.#descriptor(snapshot);
      }
      const live = this.ctx.storage.sql
        .exec<{ data: ArrayBuffer }>("SELECT data FROM peer_live WHERE id=1")
        .toArray()[0];
      check(live, "unavailable", "Controlled source offline");
      const bytes = new Uint8Array(live.data);
      check(
        this.#control().mode === "overclaim" || bytes.length <= input.maxBytes,
        "payload_too_large",
        "Controlled source exceeds requested budget",
      );
      const sha256 = await hash(bytes);
      await this.#authorized(ctx, input);
      const artifactId = id(),
        agentId = input.resources.agentIds[0];
      check(agentId, "invalid_request", "Agent source missing");
      const snapshot: Snapshot = {
        digest,
        request: input,
        reference: {
          artifactId,
          sha256,
          size: bytes.length,
          endpoint: `/v1/admin/artifacts/${artifactId}`,
          scope: { kind: "agent", agentId, conversationIds: input.resources.conversationIds },
        },
      };
      this.ctx.storage.transactionSync(() => {
        check(
          !this.ctx.storage.sql
            .exec("SELECT id FROM peer_export WHERE id=?", input.exportId)
            .toArray().length,
          "conflict",
          "Concurrent peer cut",
        );
        this.ctx.storage.sql.exec(
          "INSERT INTO peer_export(id,metadata,data) VALUES(?,?,?)",
          input.exportId,
          json(snapshot),
          bytes.buffer,
        );
      });
      return this.#descriptor(snapshot);
    });
  }
  #descriptor(snapshot: Snapshot): D.ExportDescriptor {
    return {
      exportId: snapshot.request.exportId,
      state: "ready",
      artifacts: [snapshot.reference],
      unavailableWorkspaceIds: [],
      credentialsExcluded: true,
    };
  }
  async #quota(ctx: D.AuthContext, storage: boolean): Promise<D.ProtocolError> {
    const prior = await this.ctx.storage.get<{ calls: number; retryAt: number }>("quota");
    const quota = { calls: (prior?.calls ?? 0) + 1, retryAt: prior?.retryAt ?? Date.now() + 15000 };
    await this.ctx.storage.put("quota", quota);
    return {
      code: "quota_exceeded",
      message: "Synthetic receiver quota",
      requestId: ctx.requestId,
      retryable: true,
      details: storage
        ? {
            retryAfterMs: 0,
            pressure: {
              resource: "storage",
              scope: { kind: "object", id: "synthetic-peer" },
              source: "policy",
              measurement: "observed",
              reason: "Synthetic receiver storage",
              action: "reclaim-storage",
            },
          }
        : {
            retryAfterMs: 10000,
            pressure: {
              resource: "requests",
              scope: { kind: "install" },
              source: "provider",
              measurement: "unknown",
              reason: "Synthetic receiver quota",
              action: "retry-later",
              retryAt: quota.retryAt,
              resetAt: quota.retryAt,
            },
          },
    };
  }
  async #authorized(ctx: D.AuthContext, input: D.ExportRequest): Promise<void> {
    check(
      ctx.role === "admin" &&
        ctx.registrationId &&
        ctx.deadline > Date.now() &&
        input.deadline > Date.now(),
      "unauthorized",
      "Controlled source requires registered current admin",
    );
    const agentId = input.resources.agentIds[0];
    check(
      agentId && this.ctx.id.equals(this.env.AGENT_SESSIONS.idFromName(agentId)),
      "unauthorized",
      "Wrong controlled owner",
    );
    const result = await this.env.CONTROL_PLANE.getByName("control").authorize({
      principal: ctx,
      action: input.action,
      resources: input.resources,
    });
    check(result.ok && result.value.allowed, "unauthorized", "Source logical action denied");
  }
  async fetch(request: Request): Promise<Response> {
    const raw = request.headers.get("X-Fortipi-Context");
    check(raw, "unauthenticated", "Missing controlled source authority");
    const ctx: D.AuthContext = JSON.parse(raw),
      url = new URL(request.url),
      artifactId = url.pathname.split("/").at(-1);
    const rows = this.ctx.storage.sql
      .exec<{ metadata: string; data: ArrayBuffer }>("SELECT metadata,data FROM peer_export")
      .toArray();
    const row = rows.find((row) => {
      const snapshot: Snapshot = JSON.parse(row.metadata);
      return snapshot.reference.artifactId === artifactId;
    });
    check(row, "not_found", "Retained controlled source unavailable");
    const snapshot: Snapshot = JSON.parse(row.metadata);
    await this.#authorized(ctx, snapshot.request);
    this.ctx.storage.sql.exec("UPDATE peer_control SET calls=calls+1 WHERE id=1");
    if (this.#control().mode === "large-error")
      return new Response(
        JSON.stringify({ error: await this.#quota(ctx, false) }).padEnd(65537, " "),
        { status: 429 },
      );
    if (this.#control().mode === "quota-fetch" || this.#control().mode === "storage-fetch")
      return Response.json(
        { error: await this.#quota(ctx, this.#control().mode === "storage-fetch") },
        { status: 429 },
      );
    if (
      this.#control().mode === "hold" ||
      (this.#control().mode === "hold-tail" && this.#control().calls > 1)
    ) {
      this.ctx.storage.sql.exec("UPDATE peer_control SET waiting=1 WHERE id=1");
      const until = Date.now() + 3500;
      while (this.#control().mode.startsWith("hold") && Date.now() < until)
        await new Promise((resolve) => setTimeout(resolve, 25));
      this.ctx.storage.sql.exec("UPDATE peer_control SET waiting=0 WHERE id=1");
    }
    if (this.#control().mode === "offline") return new Response(null, { status: 503 });
    const bytes = new Uint8Array(row.data),
      rawRange = request.headers.get("Range"),
      match = rawRange === null ? null : /^bytes=(\d+)-(\d+)$/.exec(rawRange);
    check(rawRange === null || match, "invalid_request", "Finite source range required");
    const start = match ? Number(match[1]) : 0,
      end = match ? Number(match[2]) : bytes.length - 1;
    check(
      !match || (start >= 0 && end >= start && end < bytes.length),
      "range_not_satisfiable",
      "Source range invalid",
    );
    const selected = bytes.slice(start, end + 1);
    if (this.#control().mode === "corrupt" && selected.length) selected[0] = (selected[0] ?? 0) ^ 1;
    const digest = await hash(selected);
    const headers = new Headers({
      "Content-Type": "application/octet-stream",
      "Content-Length": String(selected.length),
      "X-Content-SHA256": digest,
    });
    if (match) headers.set("Content-Range", `bytes ${start}-${end}/${bytes.length}`);
    return new Response(selected, { status: match ? 206 : 200, headers });
  }
  async invalidateGeneration(
    ctx: D.RecoveryContext,
    input: D.Invalidation,
  ): Promise<D.Outcome<D.InvalidationAck>> {
    return outcome("fixture-invalidation", async () => {
      check(
        ctx.kind === "control-recovery" &&
          ctx.deadline > Date.now() &&
          ctx.recipient.kind === "agent" &&
          this.ctx.id.equals(this.env.AGENT_SESSIONS.idFromName(ctx.recipient.id)),
        "unauthorized",
        "Wrong fixture floor recipient",
      );
      const minimum = input.subject.minimumGeneration;
      await this.ctx.storage.put(`floor:${input.subject.kind}`, minimum);
      return {
        revocationId: input.revocationId,
        subject: input.subject,
        recipient: ctx.recipient,
        persistedFloor: minimum,
      };
    });
  }
}

type FixtureEnv = Omit<Env, "CONTROL_PLANE" | "AGENT_SESSIONS"> & {
  CONTROL_PLANE: DurableObjectNamespace<AdminFixtureControl>;
  AGENT_SESSIONS: DurableObjectNamespace<AdminPeerFixture>;
};
export default {
  async fetch(request: Request, env: FixtureEnv): Promise<Response> {
    const cp = env.CONTROL_PLANE.getByName("control"),
      url = new URL(request.url);
    if (url.pathname === "/ready") return Response.json({ ready: true });
    const authenticated = await cp.authenticate({
      bearer: (request.headers.get("Authorization") ?? "").replace(/^Bearer /, ""),
      deploymentId: env.CONTROL_PLANE.idFromName("control").toString(),
      requestId: id(),
      deadline: Date.now() + 30000,
    });
    if (!authenticated.ok) return Response.json(authenticated, { status: 401 });
    const ctx = authenticated.value;
    if (url.pathname === "/fixture/operation") {
      const input: D.OperationRequest<D.ControlOperationId> = await request.json();
      const result = await cp.handleApi(ctx, input);
      if (url.searchParams.get("drop") === "true" && result.ok)
        return new Response(null, { status: 503 });
      return Response.json(result);
    }
    if (url.pathname === "/fixture/mint") {
      const body: D.CredentialMint = await request.json();
      return Response.json(
        await cp.mintCredential(ctx, { operationId: "mintCredential", path: {}, query: {}, body }),
      );
    }
    if (url.pathname === "/fixture/inspect") {
      check(ctx.role === "admin", "unauthorized", "Fixture inspection requires admin");
      return new Response(await cp.inspect(), { headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname === "/fixture/near-full") {
      check(ctx.role === "admin", "unauthorized", "Fixture capacity requires admin");
      return new Response(await cp.nearFull(ctx), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname === "/fixture/expire") {
      check(ctx.role === "admin", "unauthorized", "Fixture expiry requires admin");
      await cp.expire(url.searchParams.get("id") ?? "", url.searchParams.get("copy") === "true");
      return new Response(null, { status: 204 });
    }
    const source = /^\/fixture\/source\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
    if (source) {
      check(ctx.role === "admin", "unauthorized", "Fixture seed requires admin");
      const peer = env.AGENT_SESSIONS.getByName(source[1] ?? "");
      const mode = url.searchParams.get("mode");
      if (mode) {
        await peer.mode(mode);
        return new Response(null, { status: 204 });
      }
      if (request.method === "PUT") {
        const data = new Uint8Array(await request.arrayBuffer());
        check(data.length <= 1048576, "payload_too_large", "Fixture payload too large");
        await peer.seed(data);
        return new Response(null, { status: 204 });
      }
      return new Response(await peer.inspect(), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname.startsWith("/v1/admin/artifacts/")) {
      const headers = new Headers({ "X-Fortipi-Context": json(ctx) }),
        range = request.headers.get("Range");
      if (range) headers.set("Range", range);
      return cp.fetch(
        new Request(`https://control.internal${url.pathname}${url.search}`, {
          method: request.method,
          headers,
          signal: request.signal,
        }),
        { signal: request.signal },
      );
    }
    return new Response(null, { status: 404 });
  },
};
