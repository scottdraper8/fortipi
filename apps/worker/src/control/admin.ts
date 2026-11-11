import { createHash } from "node:crypto";
import Ajv from "ajv/dist/2020.js";
import { schemaRegistry } from "fortipi-contract";
import type * as D from "../boundary/dto.js";
import type { Env } from "../boundary/env.js";
import { emptyScope, requireGrant } from "./authorization.js";
import type { Capacity } from "./capacity.js";
import type { Directory } from "./directory.js";
import type { Identities } from "./identity.js";
import { postponeRepair, repairAccepted } from "./repair.js";
import { ControlError, check, hash, id, json, ref, type Store, same, within } from "./store.js";
import type { Tickets } from "./tickets.js";

const chunkBytes = 65536;
const pageRows = 16;
const validation = new Ajv({ strict: true, validateFormats: false });
for (const schema of Object.values(schemaRegistry)) validation.addSchema(schema);
const validators = (() => {
  const input = validation.getSchema(
      "https://fortipi.dev/schemas/1.0.0/administration.schema.json#/$defs/ExportInput",
    ),
    reference = validation.getSchema(
      "https://fortipi.dev/schemas/1.0.0/administration.schema.json#/$defs/AdminArtifactReference",
    ),
    legacy = validation.getSchema(
      "https://fortipi.dev/schemas/1.0.0/common.schema.json#/$defs/ByteReference",
    ),
    error = validation.getSchema<D.ProtocolError>(
      "https://fortipi.dev/schemas/1.0.0/common.schema.json#/$defs/ProtocolError",
    );
  if (!input || !reference || !legacy || !error) throw new Error("Missing fixed admin schemas");
  return { input, reference, legacy, error };
})();
const isProtocolError = (value: unknown): value is D.ProtocolError =>
  validators.error(value) === true;

type Chunk = {
  ordinal: number;
  data: ArrayBuffer;
};

/** Bounded export bytes live in SQLite BLOBs, never in Store's JSON documents. */
export class AdminChunks {
  readonly #store: Store;
  readonly #bounds: () => D.InfrastructurePolicy["bounds"];
  readonly #capacity: Capacity;

  constructor(store: Store, bounds: () => D.InfrastructurePolicy["bounds"], capacity: Capacity) {
    this.#store = store;
    this.#bounds = bounds;
    this.#capacity = capacity;
    store.storage.sql.exec(`CREATE TABLE IF NOT EXISTS cp_admin_chunks (
      artifact_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal>=0),
      data BLOB NOT NULL CHECK(typeof(data)='blob' AND length(data)>0 AND length(data)<=65536),
      PRIMARY KEY(artifact_id,ordinal)) WITHOUT ROWID`);
  }

  append(artifactId: string, ordinal: number, bytes: Uint8Array, persist?: () => void): void {
    check(
      artifactId.length > 0 &&
        artifactId.length <= 128 &&
        Number.isSafeInteger(ordinal) &&
        ordinal >= 0 &&
        ordinal < 256 &&
        bytes.length > 0 &&
        bytes.length <= chunkBytes,
      "invalid_request",
      "Invalid admin byte chunk",
    );
    this.#store.tx(() => {
      const previous = this.#store.storage.sql
        .exec<Chunk>(
          "SELECT ordinal,data FROM cp_admin_chunks WHERE artifact_id=? AND ordinal=?",
          artifactId,
          ordinal,
        )
        .toArray()[0];
      if (previous) {
        const stored = new Uint8Array(previous.data);
        check(
          stored.length === bytes.length && stored.every((value, index) => value === bytes[index]),
          "conflict",
          "Retained admin bytes cannot change",
        );
        persist?.();
        return;
      }
      const bounds = this.#bounds();
      const retained = this.#store.storage.sql
        .exec<{ size: number }>(
          "SELECT COALESCE(SUM(length(data)),0) size FROM cp_admin_chunks WHERE artifact_id=?",
          artifactId,
        )
        .one().size;
      check(
        retained + bytes.length <= Math.min(bounds.artifactBytes, 16 * 1024 * 1024),
        "payload_too_large",
        "Admin artifact exceeds effective byte cap",
      );
      this.admitGrowth(bytes.length);
      this.#store.storage.sql.exec(
        "INSERT INTO cp_admin_chunks(artifact_id,ordinal,data) VALUES(?,?,?)",
        artifactId,
        ordinal,
        new Uint8Array(bytes).buffer,
      );
      persist?.();
    });
  }

  admitGrowth(bytes: number): void {
    const budget = this.#capacity.directory.budget;
    // append checks and writes in one existing synchronous CP transaction.
    // Public physical size is sampled directly; the CP floor is counted once.
    budget.admit(budget.controlKey, bytes * 3 + 8192);
  }

  verify(
    artifactId: string,
    expectedSize: number,
    expectedSha256: string,
    current: () => void,
    range?: { start: number; end: number },
  ): { size: number; sha256: string; selectedSha256: string } {
    check(
      Number.isSafeInteger(expectedSize) &&
        expectedSize >= 0 &&
        expectedSize <= Math.min(this.#bounds().artifactBytes, 16 * 1024 * 1024) &&
        /^[a-f0-9]{64}$/.test(expectedSha256),
      "conflict",
      "Invalid retained admin byte metadata",
    );
    const start = range?.start ?? 0,
      end = range?.end ?? expectedSize - 1;
    if (range)
      check(
        Number.isSafeInteger(start) &&
          Number.isSafeInteger(end) &&
          start >= 0 &&
          end >= start &&
          end < expectedSize,
        "range_not_satisfiable",
        "Admin byte range outside retained bytes",
      );
    const whole = createHash("sha256"),
      selected = createHash("sha256");
    let ordinal = 0,
      size = 0;
    for (;;) {
      current();
      const rows = this.#store.storage.sql
        .exec<Chunk>(
          "SELECT ordinal,data FROM cp_admin_chunks WHERE artifact_id=? AND ordinal>=? ORDER BY ordinal LIMIT ?",
          artifactId,
          ordinal,
          pageRows,
        )
        .toArray();
      if (rows.length === 0) break;
      for (const row of rows) {
        current();
        const bytes = new Uint8Array(row.data);
        check(
          ordinal < 256 &&
            row.ordinal === ordinal &&
            bytes.length > 0 &&
            bytes.length <= chunkBytes,
          "conflict",
          "Admin byte sequence is incomplete",
        );
        const from = Math.max(0, start - size),
          to = Math.min(bytes.length, end + 1 - size);
        if (to > from) selected.update(bytes.subarray(from, to));
        whole.update(bytes);
        size += bytes.length;
        ordinal++;
        check(size <= expectedSize, "conflict", "Admin bytes exceed retained length");
      }
      if (rows.length < pageRows) break;
    }
    current();
    const sha256 = whole.digest("hex");
    check(
      size === expectedSize && sha256 === expectedSha256,
      "conflict",
      "Retained admin byte integrity mismatch",
    );
    return { size, sha256, selectedSha256: selected.digest("hex") };
  }

  stream(
    artifactId: string,
    size: number,
    current: () => void,
    signal: AbortSignal,
    range?: { start: number; end: number },
  ): ReadableStream<Uint8Array> {
    check(
      Number.isSafeInteger(size) &&
        size >= 0 &&
        size <= Math.min(this.#bounds().artifactBytes, 16 * 1024 * 1024),
      "conflict",
      "Invalid admin download size",
    );
    const start = range?.start ?? 0,
      end = range?.end ?? size - 1;
    let ordinal = 0,
      offset = 0,
      stopped = false;
    return new ReadableStream<Uint8Array>(
      {
        pull: (controller) => {
          try {
            current();
            check(!signal.aborted && !stopped, "interrupted", "Admin download cancelled");
            if (offset > end) {
              stopped = true;
              controller.close();
              return;
            }
            for (;;) {
              check(ordinal < 256, "interrupted", "Admin download chunk bound exceeded");
              const row = this.#store.storage.sql
                .exec<Chunk>(
                  "SELECT ordinal,data FROM cp_admin_chunks WHERE artifact_id=? AND ordinal=?",
                  artifactId,
                  ordinal++,
                )
                .toArray()[0];
              check(row, "interrupted", "Retained admin byte chunk unavailable");
              const bytes = new Uint8Array(row.data),
                from = Math.max(0, start - offset),
                to = Math.min(bytes.length, end + 1 - offset);
              offset += bytes.length;
              current();
              if (to > from) {
                controller.enqueue(bytes.slice(from, to));
                return;
              }
            }
          } catch (error) {
            stopped = true;
            controller.error(error);
          }
        },
        cancel: () => {
          stopped = true;
        },
      },
      { highWaterMark: 0 },
    );
  }

  remove(artifactId: string): void {
    this.#store.storage.sql.exec("DELETE FROM cp_admin_chunks WHERE artifact_id=?", artifactId);
  }
}

type Peer = {
  kind: "agent" | "workspace";
  id: string;
  exportId: string;
  resources: D.ResourceScope;
  described: boolean;
};
type Part = {
  peer: number;
  source: D.AdminArtifactReference;
  reference: D.AdminArtifactReference;
  copied: number;
  verified: boolean;
};
type AdminJob = {
  operationId: string;
  requestKey: string;
  digest: string;
  kind: "export" | "backup";
  action: D.ExportRequest["action"];
  actor: D.AuthContext;
  resources: D.ResourceScope;
  maxBytes: number;
  createdAt: number;
  copyUntil: number;
  expiresAt: number;
  forgetAt: number;
  state: D.AdminOperation["state"];
  reason?: string;
  peers: Peer[];
  parts: Part[];
  artifactIds: string[];
  attempts: number;
  gc: number;
};
type AdminIndex = {
  operationId: string;
  digest: string;
  reference: D.AdminArtifactReference;
  resources: D.ResourceScope;
  expiresAt: number;
};

/** One bounded continuation per existing CP alarm task. No byte is published before verification. */
export class AdminCoordinator {
  readonly #store: Store;
  readonly #identities: Identities;
  readonly #directory: Directory;
  readonly #tickets: Tickets;
  readonly #env: Env;
  readonly #chunks: AdminChunks;
  readonly #busy = new Set<string>();
  constructor(
    store: Store,
    identities: Identities,
    directory: Directory,
    tickets: Tickets,
    capacity: Capacity,
    env: Env,
  ) {
    this.#store = store;
    this.#identities = identities;
    this.#directory = directory;
    this.#tickets = tickets;
    this.#env = env;
    this.#chunks = new AdminChunks(store, () => directory.policy().bounds, capacity);
  }

  async create(
    ctx: D.AuthContext,
    kind: "export" | "backup",
    input: D.ExportInput,
  ): Promise<D.AdminOperation> {
    check(validators.input(input), "invalid_request", "Invalid admin export input");
    const resources = { ...input.resources, actions: [] },
      action = kind === "export" ? "exports.create" : "backups.create";
    this.#authorize(ctx, action, resources);
    check(
      resources.tools.length === 0 &&
        resources.executorIds.length === 0 &&
        resources.backendIds.length === 0,
      "invalid_request",
      "Admin export selects Agent or Workspace data only",
    );
    check(
      resources.agentIds.length + resources.workspaceIds.length > 0,
      "invalid_request",
      "Admin export must select a data owner",
    );
    check(
      resources.conversationIds.length === 0 || resources.agentIds.length > 0,
      "invalid_request",
      "Conversation exports require an actual selected Agent",
    );
    const digest = await hash(json({ kind, input }));
    this.#authorize(ctx, action, resources);
    await this.#store.arm();
    this.#authorize(ctx, action, resources);
    return this.#store.tx(() => {
      const requestKey = `${ctx.principalId}:${kind}:${input.requestId}`,
        old = this.#store.get<{ operationId: string; digest: string }>("admin_request", requestKey);
      if (old) {
        check(old.digest === digest, "conflict", "Admin request payload changed");
        const job = this.#store.get<AdminJob>("admin_job", old.operationId);
        check(job, "not_found", "Admin operation expired");
        return this.#view(job);
      }
      const existing = this.#store.page<AdminJob>("admin_job", 0, 65);
      check(existing.length < 64, "quota_exceeded", "Admin retention operation bound reached");
      check(
        existing.filter((r) => r.value.state === "pending" || r.value.state === "running").length <
          4,
        "quota_exceeded",
        "Admin copy concurrency bound reached",
      );
      const peers: Peer[] = [];
      for (const kind of ["agent", "workspace"] as const) {
        const requested = kind === "agent" ? resources.agentIds : resources.workspaceIds;
        const owners = requested.includes("*")
          ? this.#store.page(kind === "agent" ? "agent" : "binding", 0, 17).map((row) => row.key)
          : [...new Set(requested)].sort();
        for (const owner of owners)
          peers.push({
            kind,
            id: owner,
            exportId: id(),
            described: false,
            resources: {
              ...emptyScope(),
              agentIds: kind === "agent" ? [owner] : [],
              conversationIds: kind === "agent" ? resources.conversationIds : [],
              workspaceIds: kind === "workspace" ? [owner] : [],
              actions: [action],
            },
          });
      }
      const now = Date.now(),
        bounds = this.#directory.policy().bounds;
      const job: AdminJob = {
        operationId: id(),
        requestKey,
        digest,
        kind,
        action,
        actor: structuredClone(ctx),
        resources,
        maxBytes: Math.min(
          input.maxBytes,
          bounds.artifactBytes * 16,
          Math.floor(bounds.objectBytes * (1 - bounds.headroomFraction)),
        ),
        createdAt: now,
        copyUntil: now + 300000,
        expiresAt: now + 3600000,
        forgetAt: now + 7200000,
        state: "pending",
        peers: peers.slice(0, 17),
        parts: [],
        artifactIds: Array.from({ length: 16 }, () => id()),
        attempts: 0,
        gc: 0,
      };
      if (peers.length === 0 || peers.length > 16) {
        job.state = "unavailable";
        job.reason = "Selected data exceeds bounded owner enumeration or is unavailable";
      }
      this.#chunks.admitGrowth(new TextEncoder().encode(json(job)).length);
      // The existing request row is also a cleanup wake, independent of receiver repair holds.
      this.#store.put(
        "admin_request",
        requestKey,
        { operationId: job.operationId, digest },
        "",
        "",
        job.copyUntil,
      );
      this.#save(job);
      return this.#view(job);
    });
  }

  operation(ctx: D.AuthContext, operationId: string): D.AdminOperation | undefined {
    this.#authorize(ctx, "operations.read", emptyScope());
    const job = this.#store.get<AdminJob>("admin_job", operationId);
    if (!job) return undefined;
    this.#authorize(ctx, "operations.read", job.resources);
    return this.#view(job);
  }

  async fetch(ctx: D.AuthContext, request: Request, artifactId: string): Promise<Response> {
    this.#authorize(ctx, "artifacts.read", emptyScope());
    check(
      request.method === "GET" && new URL(request.url).search === "",
      "invalid_request",
      "Admin artifact requires query-free GET",
    );
    const index = this.#store.get<AdminIndex>("admin_artifact", artifactId);
    check(index && index.expiresAt > Date.now(), "not_found", "Admin artifact unavailable");
    const current = () => {
      this.#authorize(ctx, "artifacts.read", index.resources);
      const actual = this.#store.get<AdminIndex>("admin_artifact", artifactId);
      check(
        actual && actual.expiresAt > Date.now() && same(actual, index),
        "not_found",
        "Admin artifact unavailable",
      );
      check(!request.signal.aborted, "interrupted", "Admin download cancelled");
    };
    current();
    const raw = request.headers.get("Range"),
      match = raw === null ? null : /^bytes=(\d+)-(\d+)$/.exec(raw);
    check(
      raw === null || match,
      "invalid_request",
      "Admin download requires one finite byte range",
    );
    const range = match ? { start: Number(match[1]), end: Number(match[2]) } : undefined;
    const observed = this.#chunks.verify(
        artifactId,
        index.reference.size,
        index.reference.sha256,
        current,
        range,
      ),
      size = range ? range.end - range.start + 1 : observed.size;
    current();
    const body = this.#chunks
      .stream(artifactId, observed.size, current, request.signal, range)
      .pipeThrough(new FixedLengthStream(size));
    const headers = new Headers({
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store",
      "Content-Length": String(size),
      "X-Content-SHA256": observed.selectedSha256,
      "Accept-Ranges": "bytes",
    });
    if (range) headers.set("Content-Range", `bytes ${range.start}-${range.end}/${observed.size}`);
    return new Response(body, { status: range ? 206 : 200, headers });
  }

  async drain(operationId: string): Promise<void> {
    if (this.#busy.has(operationId)) return;
    const job = this.#store.get<AdminJob>("admin_job", operationId);
    if (!job) return;
    this.#busy.add(operationId);
    try {
      if (job.state !== "pending" && job.state !== "running") {
        this.#gc(job);
        return;
      }
      const deadline = Math.min(Date.now() + 5000, job.copyUntil);
      this.#current(job, deadline);
      job.state = "running";
      this.#save(job);
      const part = job.parts.find((p) => !p.verified),
        peerIndex = job.peers.findIndex((p) => !p.described);
      if (part) {
        await this.#copy(job, part, deadline);
        return;
      }
      if (peerIndex >= 0) {
        await this.#describe(job, peerIndex, deadline);
        return;
      }
      this.#publish(job, deadline);
    } catch (error) {
      let failure = error;
      try {
        this.#current(job, Math.min(Date.now() + 5000, job.copyUntil));
      } catch (currentError) {
        failure = currentError;
      }
      if (
        this.#store.tx(() =>
          postponeRepair(this.#store, "admin_job", operationId, failure, Date.now() + 2000),
        )
      )
        return;
      if (
        failure instanceof ControlError &&
        failure.code === "unavailable" &&
        job.attempts < 2 &&
        Date.now() < job.copyUntil
      ) {
        job.attempts++;
        this.#save(job, Date.now() + 1000 * 2 ** job.attempts);
      } else {
        repairAccepted(this.#store, "admin_job", operationId);
        job.state = "unavailable";
        job.reason =
          failure instanceof ControlError && failure.code === "quota_exceeded"
            ? "Admin copy unavailable under current object/install storage bounds"
            : "Selected source did not provide a verified authorized bounded copy";
        this.#save(job);
        this.#store.reschedule("admin_request", job.requestKey, null);
      }
    } finally {
      this.#busy.delete(operationId);
    }
  }

  /** Expiry only retires retained work; it never retries a receiver before its hold. */
  expire(requestKey: string): void {
    const request = this.#store.get<{ operationId: string }>("admin_request", requestKey);
    if (!request) return;
    const job = this.#store.get<AdminJob>("admin_job", request.operationId);
    if (!job) {
      this.#store.remove("admin_request", requestKey);
      return;
    }
    this.#store.tx(() => {
      if (Date.now() >= job.copyUntil && (job.state === "pending" || job.state === "running")) {
        job.state = "unavailable";
        job.reason = "Admin copy lifetime expired";
        repairAccepted(this.#store, "admin_job", job.operationId);
        this.#save(job);
      }
      this.#store.reschedule("admin_request", requestKey, job.forgetAt);
    });
  }

  #authorize(ctx: D.AuthContext, action: string, resources: D.ResourceScope): void {
    this.#identities.current(ctx);
    check(ctx.role === "admin", "unauthorized", "Admin audience requires an admin credential");
    requireGrant(ctx, action, resources);
  }
  #current(job: AdminJob, deadline: number): D.AuthContext {
    check(Date.now() < job.copyUntil, "unavailable", "Admin copy deadline expired");
    const ctx = { ...job.actor, deadline };
    this.#authorize(ctx, job.action, job.resources);
    return ctx;
  }
  #registered(job: AdminJob, peer: Peer, deadline: number): D.AuthContext {
    const ctx = this.#current(job, deadline),
      registration = this.#tickets.register(ctx, {
        credential: ref(ctx),
        recipient: { kind: peer.kind, id: peer.id },
        resources: peer.resources,
      });
    return { ...ctx, registrationId: registration.registrationId };
  }
  #save(job: AdminJob, due?: number): void {
    this.#store.put(
      "admin_job",
      job.operationId,
      job,
      "",
      "",
      due ??
        (job.state === "pending" || job.state === "running" ? Date.now() + 250 : job.expiresAt),
    );
  }
  #view(job: AdminJob): D.AdminOperation {
    return {
      operationId: job.operationId,
      kind: job.kind,
      state: job.state,
      artifacts: job.state === "completed" ? job.parts.map((p) => p.reference) : [],
      ...(job.reason ? { reason: job.reason } : {}),
    };
  }
  #dataScope(reference: D.AdminArtifactReference): D.ResourceScope {
    return {
      ...emptyScope(),
      agentIds: reference.scope.kind === "agent" ? [reference.scope.agentId] : [],
      conversationIds: reference.scope.kind === "agent" ? reference.scope.conversationIds : [],
      workspaceIds: reference.scope.kind === "workspace" ? [reference.scope.workspaceId] : [],
    };
  }

  async #describe(job: AdminJob, peerIndex: number, deadline: number): Promise<void> {
    const peer = job.peers[peerIndex];
    check(peer, "internal", "Admin peer missing");
    check(
      this.#store.get(peer.kind === "agent" ? "agent" : "binding", peer.id),
      "unavailable",
      "Selected data owner unavailable",
    );
    const ctx = this.#registered(job, peer, deadline),
      input: D.ExportRequest = {
        exportId: peer.exportId,
        action: job.action,
        resources: peer.resources,
        maxBytes: job.maxBytes,
        deadline: job.copyUntil,
      };
    const owner =
      peer.kind === "agent"
        ? this.#env.AGENT_SESSIONS.getByName(peer.id)
        : this.#env.WORKSPACES.getByName(peer.id);
    check(
      (await within(owner.contractVersion, Math.max(1, deadline - Date.now()))) === "1.0",
      "unsupported",
      "Admin peer contract mismatch",
    );
    this.#current(job, deadline);
    const result = await within<D.Outcome<D.ExportDescriptor>>(
      owner.exportData(ctx, input),
      Math.max(1, deadline - Date.now()),
    );
    this.#current(job, deadline);
    if (!result.ok) throw new ControlError(result.code, "Admin source unavailable", result.details);
    const descriptor = result.value;
    check(
      descriptor.exportId === peer.exportId &&
        descriptor.credentialsExcluded === true &&
        descriptor.state === "ready" &&
        descriptor.unavailableWorkspaceIds.length === 0 &&
        descriptor.artifacts.length > 0 &&
        descriptor.artifacts.length + job.parts.length <= 16,
      "unavailable",
      "Admin source is partial or exceeds retained artifact bound",
    );
    let total = job.parts.reduce((sum, p) => sum + p.source.size, 0);
    for (const source of descriptor.artifacts) {
      let selected: D.AdminArtifactReference;
      if ("scope" in source) {
        check(validators.reference(source), "conflict", "Invalid admin source reference");
        selected = source;
      } else {
        check(
          peer.kind === "workspace" &&
            validators.legacy(source) &&
            source.workspaceId === peer.id &&
            source.artifactId,
          "conflict",
          "Legacy reference does not belong to selected Workspace",
        );
        selected = {
          artifactId: source.artifactId,
          sha256: source.sha256,
          size: source.size,
          endpoint: `/v1/admin/artifacts/${source.artifactId}`,
          scope: { kind: "workspace", workspaceId: source.workspaceId, revision: source.revision },
        };
      }
      check(
        selected.endpoint === `/v1/admin/artifacts/${selected.artifactId}` &&
          selected.scope.kind === peer.kind,
        "conflict",
        "Admin source identity mismatch",
      );
      check(
        selected.scope.kind === "agent"
          ? selected.scope.agentId === peer.id &&
              selected.scope.conversationIds.every(
                (c) =>
                  peer.resources.conversationIds.includes("*") ||
                  peer.resources.conversationIds.includes(c),
              )
          : selected.scope.workspaceId === peer.id,
        "unauthorized",
        "Admin source scope exceeds selected owner",
      );
      check(
        selected.size <= Math.min(this.#directory.policy().bounds.artifactBytes, 16 * 1024 * 1024),
        "payload_too_large",
        "Admin source exceeds effective artifact cap",
      );
      total += selected.size;
      check(
        total <= job.maxBytes,
        "payload_too_large",
        "Admin copy exceeds requested or effective total byte cap",
      );
      const artifactId = job.artifactIds[job.parts.length];
      check(artifactId, "internal", "Admin artifact allocation missing");
      job.parts.push({
        peer: peerIndex,
        source: structuredClone(selected),
        reference: { ...selected, artifactId, endpoint: `/v1/admin/artifacts/${artifactId}` },
        copied: 0,
        verified: false,
      });
    }
    peer.described = true;
    job.attempts = 0;
    this.#current(job, deadline);
    this.#store.tx(() => {
      repairAccepted(this.#store, "admin_job", job.operationId);
      this.#save(job);
    });
  }

  async #copy(job: AdminJob, part: Part, deadline: number): Promise<void> {
    const peer = job.peers[part.peer];
    check(peer, "internal", "Admin part owner missing");
    const ctx = this.#registered(job, peer, deadline),
      start = part.copied,
      end = Math.min(part.source.size, start + chunkBytes) - 1,
      length = Math.max(0, end - start + 1);
    const headers = new Headers(
      peer.kind === "agent"
        ? { "X-Fortipi-Context": json(ctx) }
        : { "x-fortipi-workspace-context": json({ auth: ctx }) },
    );
    if (part.source.size > 0) headers.set("Range", `bytes=${start}-${end}`);
    const owner =
        peer.kind === "agent"
          ? this.#env.AGENT_SESSIONS.getByName(peer.id)
          : this.#env.WORKSPACES.getByName(peer.id),
      controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await within(
        owner.fetch(
          new Request(
            `https://${peer.kind === "agent" ? "agent" : "workspace"}.internal/v1/admin/artifacts/${encodeURIComponent(part.source.artifactId)}`,
            { headers, signal: controller.signal },
          ),
          { signal: controller.signal },
        ),
        Math.max(1, deadline - Date.now()),
      );
      this.#current(job, deadline);
      if (!response.ok && response.body) {
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const next = await within(reader.read(), Math.max(1, deadline - Date.now()));
          this.#current(job, deadline);
          if (next.done) break;
          size += next.value.length;
          check(size <= 65536, "payload_too_large", "Admin source error exceeds body bound");
          chunks.push(next.value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        let failure: unknown;
        try {
          failure = JSON.parse(new TextDecoder().decode(bytes));
        } catch {}
        if (
          failure &&
          typeof failure === "object" &&
          "error" in failure &&
          isProtocolError(failure.error)
        )
          throw new ControlError(
            failure.error.code,
            "Admin source byte request refused",
            failure.error.details,
          );
      }
      check(
        response.status === (part.source.size === 0 ? 200 : 206) &&
          response.headers.get("Content-Length") === String(length),
        "conflict",
        "Admin source byte length/status mismatch",
      );
      if (part.source.size > 0)
        check(
          response.headers.get("Content-Range") === `bytes ${start}-${end}/${part.source.size}`,
          "conflict",
          "Admin source range mismatch",
        );
      check(response.body, "interrupted", "Admin source body missing");
      reader = response.body.getReader();
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (;;) {
        const next = await within(reader.read(), Math.max(1, deadline - Date.now()));
        this.#current(job, deadline);
        if (next.done) break;
        check(
          offset + next.value.length <= length,
          "payload_too_large",
          "Admin source response exceeded announced range",
        );
        bytes.set(next.value, offset);
        offset += next.value.length;
      }
      check(
        offset === length &&
          createHash("sha256").update(bytes).digest("hex") ===
            response.headers.get("X-Content-SHA256"),
        "conflict",
        "Admin source actual range integrity mismatch",
      );
      this.#current(job, deadline);
      const persist = () => {
        part.copied += length;
        job.attempts = 0;
        this.#current(job, deadline);
        if (part.copied === part.source.size) {
          this.#chunks.verify(part.reference.artifactId, part.source.size, part.source.sha256, () =>
            this.#current(job, deadline),
          );
          part.verified = true;
        }
        repairAccepted(this.#store, "admin_job", job.operationId);
        this.#save(job);
      };
      const copied = part.copied,
        verified = part.verified;
      try {
        if (length > 0)
          this.#chunks.append(
            part.reference.artifactId,
            Math.floor(start / chunkBytes),
            bytes,
            persist,
          );
        else this.#store.tx(persist);
      } catch (error) {
        part.copied = copied;
        part.verified = verified;
        throw error;
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (reader) await within(reader.cancel(), 1000).catch(() => undefined);
    }
  }

  #publish(job: AdminJob, deadline: number): void {
    this.#current(job, deadline);
    check(
      job.parts.length > 0 && job.parts.every((p) => p.verified),
      "conflict",
      "Admin copy is incomplete",
    );
    const captured = new Set(
      job.parts.flatMap((p) =>
        p.source.scope.kind === "agent" ? p.source.scope.conversationIds : [],
      ),
    );
    check(
      job.resources.conversationIds.every((c) => c === "*" || captured.has(c)),
      "unavailable",
      "Requested conversations were not retained",
    );
    this.#store.tx(() => {
      this.#current(job, deadline);
      repairAccepted(this.#store, "admin_job", job.operationId);
      for (const part of job.parts) {
        const index: AdminIndex = {
          operationId: job.operationId,
          digest: job.digest,
          reference: part.reference,
          resources: this.#dataScope(part.reference),
          expiresAt: job.expiresAt,
        };
        const old = this.#store.get<AdminIndex>("admin_artifact", part.reference.artifactId);
        check(!old || same(old, index), "conflict", "Admin artifact index cannot change");
        this.#chunks.admitGrowth(new TextEncoder().encode(json(index)).length);
        this.#store.put("admin_artifact", part.reference.artifactId, index);
      }
      job.state = "completed";
      this.#save(job);
      this.#store.reschedule("admin_request", job.requestKey, null);
    });
  }

  #gc(job: AdminJob): void {
    if (Date.now() < job.expiresAt) {
      this.#save(job);
      return;
    }
    this.#store.tx(() => {
      const part = job.parts[job.gc];
      if (part) {
        this.#chunks.remove(part.reference.artifactId);
        this.#store.remove("admin_artifact", part.reference.artifactId);
        job.gc++;
        job.state = "unavailable";
        job.reason = "Retained admin copy expired";
        this.#save(job, Date.now() + 250);
        return;
      }
      if (Date.now() >= job.forgetAt) {
        repairAccepted(this.#store, "admin_job", job.operationId);
        this.#store.remove("admin_request", job.requestKey);
        this.#store.remove("admin_job", job.operationId);
        return;
      }
      job.state = "unavailable";
      job.reason = "Retained admin copy expired";
      job.parts = [];
      job.gc = 0;
      this.#save(job, job.forgetAt);
    });
  }
}
