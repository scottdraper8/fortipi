import { randomUUID } from "node:crypto";
import type { ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import type {
  ErrorBody,
  ExecutorFrame,
  ExecutorTransferLimits,
  TicketIdentity,
  TicketReceipt,
  TransferDescriptor,
  TransferStatus,
} from "fortipi-contract/executor";
import {
  canonicalJson,
  executorSchemaRegistry,
  validateExecutorTransferLimits,
  validateTransfer,
} from "fortipi-contract/executor";
import type { Limits, Profile } from "./config.js";
import { effectiveLimits, validateOrigin } from "./config.js";
import type { Ledger } from "./ledger.js";
import { hash } from "./policy.js";

const ajv = new Ajv2020({ strict: true, allErrors: false });
for (const schema of Object.values(executorSchemaRegistry)) ajv.addSchema(schema);
const validators = new Map<string, ValidateFunction>();
export function validate<T>(
  file: keyof typeof executorSchemaRegistry,
  name: string,
  data: unknown,
): T {
  const ref = `https://fortipi.dev/schemas/1.0.0/${file}#/$defs/${name}`;
  let validator = validators.get(ref);
  if (!validator) {
    validator = ajv.compile({ $ref: ref });
    validators.set(ref, validator);
  }
  if (!validator(data)) throw new Error(`invalid protocol ${name}`);
  return data as T;
}
export function frame(data: unknown): ExecutorFrame {
  return validate<ExecutorFrame>("executor-messages.schema.json", "ExecutorFrame", data);
}
type QuotaError = Extract<ErrorBody["error"], { code: "quota_exceeded" | "quota_paused" }>;
type Pressure = QuotaError["details"]["pressure"];
export class HttpFailure extends Error {
  status: number;
  retryAt?: number;
  pressure?: Pressure;
  constructor(status: number, retryAt?: number, pressure?: Pressure) {
    super(`executor HTTPS request failed (${status})`);
    this.status = status;
    if (retryAt !== undefined) this.retryAt = retryAt;
    if (pressure !== undefined) this.pressure = pressure;
  }
}
export async function readBounded(response: Response, maximum: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.byteLength;
      if (size > maximum) throw new Error("HTTPS body limit");
      chunks.push(r.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}
export class HttpTransport {
  profile: Profile;
  limits: Limits;
  readonly fetcher: typeof fetch;
  chunkBytes = 262144;
  jsonBytes = 1048576;
  outputFrameBytes = 16384;
  pausedUntil = 0;
  pressureHeld = false;
  pressure?: Pressure;
  private pressureStatus = 503;
  private ledger?: Ledger;
  authority?: TicketIdentity;
  revoked = false;
  bindLedger(ledger: Ledger): void {
    this.ledger = ledger;
    const saved = ledger.db.prepare("SELECT value FROM meta WHERE key='https_pressure'").get() as
      | { value: string }
      | undefined;
    if (!saved) return;
    const state = JSON.parse(saved.value) as {
      until: number;
      held: boolean;
      status: number;
      pressure?: Pressure;
    };
    if (
      !Number.isSafeInteger(state.until) ||
      state.until < 0 ||
      typeof state.held !== "boolean" ||
      ![429, 503].includes(state.status)
    )
      throw new Error("invalid persisted infrastructure pause");
    if (state.pressure)
      validate("infrastructure.schema.json", "InfrastructurePressure", state.pressure);
    this.pausedUntil = state.until;
    this.pressureHeld = state.held;
    this.pressureStatus = state.status;
    if (state.pressure) this.pressure = state.pressure;
  }
  private savePressure(): void {
    this.ledger?.transaction(() =>
      this.ledger?.db
        .prepare(
          "INSERT INTO meta VALUES ('https_pressure',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(
          canonicalJson({
            until: this.pausedUntil,
            held: this.pressureHeld,
            status: this.pressureStatus,
            ...(this.pressure ? { pressure: this.pressure } : {}),
          }),
        ),
    );
  }
  /** Explicit local recovery after the operator resolves the reported infrastructure pressure. */
  clearPressure(): void {
    const previous = { until: this.pausedUntil, held: this.pressureHeld, pressure: this.pressure };
    try {
      this.pausedUntil = 0;
      this.pressureHeld = false;
      delete this.pressure;
      this.savePressure();
    } catch (error) {
      this.pausedUntil = previous.until;
      this.pressureHeld = previous.held;
      if (previous.pressure) this.pressure = previous.pressure;
      throw error;
    }
  }
  private activeTransfers = 0;
  transferLimits(): ExecutorTransferLimits {
    const chunkBytes = Math.min(this.chunkBytes, this.limits.chunkBytes);
    const limits = {
      chunkBytes,
      fileBytes: Math.min(this.limits.fileBytes, chunkBytes * 256),
      snapshotBytes: this.limits.snapshotBytes,
      artifactBytes: Math.min(this.limits.artifactBytes, chunkBytes * 256),
      manifestEntries: this.limits.manifestEntries,
    };
    validate("administration.schema.json", "ExecutorTransferLimits", limits);
    validateExecutorTransferLimits(limits);
    return limits;
  }
  async withTransfer<T>(fn: () => Promise<T>): Promise<T> {
    if (this.activeTransfers >= this.limits.transferConcurrency)
      throw new Error("local transfer concurrency exhausted");
    this.activeTransfers++;
    try {
      return await fn();
    } finally {
      this.activeTransfers--;
    }
  }
  assertExecutorAuthority(): void {
    const a = this.authority;
    if (
      this.revoked ||
      a?.role !== "executor" ||
      a.deploymentId !== this.profile.deploymentId ||
      canonicalJson(a.credential) !== canonicalJson(this.profile.credential) ||
      (a.credentialExpiresAt !== null && Date.now() >= a.credentialExpiresAt)
    )
      throw new Error("current executor transport authority required");
  }
  constructor(profile: Profile, fetcher: typeof fetch = fetch, local = false) {
    validateOrigin(profile.origin, local);
    this.profile = profile;
    this.fetcher = fetcher;
    this.limits = effectiveLimits(profile.limits);
    this.chunkBytes = this.limits.chunkBytes;
    this.applyGridBounds();
  }
  private applyGridBounds(): void {
    this.limits.chunkBytes = this.chunkBytes;
    this.limits.fileBytes = Math.min(this.limits.fileBytes, this.chunkBytes * 256);
    this.limits.artifactBytes = Math.min(this.limits.artifactBytes, this.chunkBytes * 256);
  }
  async request(
    path: string,
    init: RequestInit = {},
    authenticated = true,
    deadline = Date.now() + 30000,
  ): Promise<Response> {
    if (
      !path.startsWith("/") ||
      path.startsWith("//") ||
      path.includes("\\") ||
      new URL(path, this.profile.origin).origin !== this.profile.origin
    )
      throw new Error("cross-origin request rejected");
    const now = Date.now();
    if (authenticated && this.revoked) throw new Error("executor transport revoked");
    if (deadline <= now) throw new Error("request deadline expired");
    if (this.pressureHeld || now < this.pausedUntil)
      throw new HttpFailure(
        this.pressureStatus,
        this.pressureHeld ? undefined : this.pausedUntil,
        this.pressure,
      );
    const headers = new Headers(init.headers);
    if (authenticated) headers.set("Authorization", `Bearer ${this.profile.token}`);
    const response = await this.fetcher(new URL(path, this.profile.origin), {
      ...init,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(Math.min(30000, deadline - now)),
    });
    if (!response.ok) {
      if (response.status !== 429 && response.status !== 503) {
        await response.body?.cancel();
        throw new HttpFailure(response.status);
      }
      let error: ErrorBody["error"] | undefined;
      try {
        error = validate<ErrorBody>(
          "common.schema.json",
          "ErrorBody",
          JSON.parse(Buffer.from(await readBounded(response, this.jsonBytes)).toString("utf8")),
        ).error;
      } catch {
        // Unstructured provider errors still receive bounded backoff, without fabricated quota data.
      }
      const times: number[] = [];
      const retry = response.headers.get("Retry-After");
      if (retry !== null) {
        const value = /^\d+(?:\.\d+)?$/.test(retry.trim())
          ? now + Number(retry) * 1000
          : Date.parse(retry);
        if (Number.isSafeInteger(value) && value > now) times.push(value);
      }
      let pressure: Pressure | undefined;
      if (error && "details" in error) {
        const details = error.details;
        if (details.retryAfterMs !== undefined) times.push(now + details.retryAfterMs);
        if (details.pressure) {
          pressure = details.pressure;
          if (details.pressure.retryAt !== undefined) times.push(details.pressure.retryAt);
          if (details.pressure.resetAt !== undefined) times.push(details.pressure.resetAt);
        }
      }
      const held =
          pressure?.resource === "storage" &&
          pressure.retryAt === undefined &&
          pressure.resetAt === undefined,
        until = Math.max(now + 1000, ...times, times.length ? 0 : now + 5000);
      // Requests already in flight may finish in either order. A later, shorter response
      // cannot release a storage hold or shorten another response's known retry bound.
      if (!this.pressureHeld && (held || until >= this.pausedUntil)) {
        this.pressureStatus = response.status;
        if (pressure) this.pressure = pressure;
        else delete this.pressure;
      }
      this.pressureHeld ||= held;
      this.pausedUntil = this.pressureHeld ? 0 : Math.max(this.pausedUntil, until);
      this.savePressure();
      throw new HttpFailure(
        response.status,
        this.pressureHeld ? undefined : this.pausedUntil,
        this.pressure,
      );
    }
    return response;
  }
  async json(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    deadline?: number,
  ): Promise<unknown> {
    const init: RequestInit = { method };
    if (body !== undefined) {
      const bytes = canonicalJson(body);
      if (Buffer.byteLength(bytes) > this.jsonBytes) throw new Error("JSON body limit");
      init.body = bytes;
      init.headers = { "Content-Type": "application/json" };
    }
    const response = await this.request(path, init, true, deadline);
    return JSON.parse(
      Buffer.from(await readBounded(response, this.jsonBytes)).toString("utf8"),
    ) as unknown;
  }
  async discover(): Promise<void> {
    const value = (await this.json("/v1/protocol")) as {
      protocolVersion?: string;
      schemaVersion?: string;
      deploymentId?: string;
      infrastructure?: { bounds: Partial<Limits> };
      limits?: { jsonBytes: number; chunkBytes: number; outputFrameBytes: number };
    };
    if (
      value.protocolVersion !== "1.0" ||
      value.schemaVersion !== "1.0.0" ||
      value.deploymentId !== this.profile.deploymentId ||
      !value.infrastructure ||
      !value.limits
    )
      throw new Error("incompatible deployment/protocol");
    // Validate the received policy with the public executor schema; discovery itself is outside this export.
    validate("infrastructure.schema.json", "InfrastructurePolicy", value.infrastructure);
    this.limits = effectiveLimits(this.profile.limits, value.infrastructure.bounds);
    for (const [key, maximum] of [
      ["jsonBytes", 1048576],
      ["chunkBytes", 262144],
      ["outputFrameBytes", 16384],
    ] as const) {
      const n = value.limits[key];
      if (!Number.isSafeInteger(n) || n < 1 || n > maximum)
        throw new Error("invalid negotiated wire bound");
      this[key] = Math.min(this[key], n);
    }
    this.chunkBytes = Math.min(this.chunkBytes, this.limits.chunkBytes);
    this.applyGridBounds();
  }
  async ticket(): Promise<{ ticket: string; expiresAt: number }> {
    const t = validate<TicketReceipt>(
      "administration.schema.json",
      "TicketReceipt",
      await this.json("/v1/connections/tickets", {
        requestId: randomUUID(),
        audience: "executor-session",
        resources: this.profile.resources,
        originMode: { kind: "native" },
        ttlMs: 30000,
        executor: {
          executorId: this.profile.executorId,
          generation: this.profile.executorGeneration,
        },
      }),
    );
    if (
      t.audience !== "executor-session" ||
      t.expiresAt <= Date.now() ||
      t.expiresAt > Date.now() + 60000
    )
      throw new Error("invalid executor ticket");
    this.authority = t.identity;
    try {
      this.assertExecutorAuthority();
    } catch (error) {
      delete this.authority;
      throw error;
    }
    return t;
  }
  async chunk(
    descriptor: TransferDescriptor,
    index: number,
    data?: Uint8Array,
  ): Promise<Uint8Array | undefined> {
    return this.withTransfer(() => this.chunkOnce(descriptor, index, data));
  }
  private async chunkOnce(
    descriptor: TransferDescriptor,
    index: number,
    data?: Uint8Array,
  ): Promise<Uint8Array | undefined> {
    validate("transfers.schema.json", "TransferDescriptor", descriptor);
    validateTransfer(descriptor, Date.now());
    const size = Math.min(descriptor.chunkBytes, descriptor.size - index * descriptor.chunkBytes);
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= descriptor.chunkHashes.length ||
      descriptor.chunkBytes > Math.min(this.chunkBytes, this.limits.chunkBytes) ||
      descriptor.size >
        (descriptor.purpose === "output" ? this.limits.artifactBytes : this.limits.fileBytes)
    )
      throw new Error("chunk index/bound");
    const base = `/v1/executor/transfers/${encodeURIComponent(descriptor.transferId)}`;
    const query = `?attemptId=${encodeURIComponent(descriptor.attemptId)}${descriptor.direction === "from-executor" ? `&length=${size}&sha256=${descriptor.chunkHashes[index]}` : ""}`;
    if (descriptor.direction === "from-executor") {
      if (!data || data.byteLength !== size || hash(data) !== descriptor.chunkHashes[index])
        throw new Error("output chunk integrity");
      const r = await this.request(
        `${base}/output/chunks/${index}${query}`,
        {
          method: "PUT",
          body: Buffer.from(data),
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(data.byteLength),
            "X-Content-SHA256": hash(data),
          },
        },
        true,
        Math.min(descriptor.deadline, descriptor.expiresAt),
      );
      if (r.status !== 204) throw new Error("missing chunk receipt");
      return undefined;
    }
    if (data) throw new Error("input direction");
    const r = await this.request(
      `${base}/input/chunks/${index}${query}`,
      {},
      true,
      Math.min(descriptor.deadline, descriptor.expiresAt),
    );
    const bytes = await readBounded(r, size);
    if (
      r.status !== 200 ||
      Number(r.headers.get("Content-Length")) !== size ||
      bytes.byteLength !== size ||
      hash(bytes) !== descriptor.chunkHashes[index] ||
      r.headers.get("X-Content-SHA256") !== descriptor.chunkHashes[index]
    )
      throw new Error("input chunk integrity");
    return bytes;
  }
  async transferStatus(descriptor: TransferDescriptor): Promise<TransferStatus> {
    return validate<TransferStatus>(
      "transfers.schema.json",
      "TransferStatus",
      await this.json(
        `/v1/executor/transfers/${encodeURIComponent(descriptor.transferId)}?attemptId=${encodeURIComponent(descriptor.attemptId)}`,
      ),
    );
  }
}

export interface FrameHandler {
  receive(frame: ExecutorFrame): Promise<void>;
  disconnected(): Promise<void>;
  reconnectFrames(): ExecutorFrame[];
}
export class SessionTransport {
  http: HttpTransport;
  handler: FrameHandler;
  socket?: WebSocket;
  registered = false;
  connectionEpoch = -1;
  lastHeard = 0;
  queueBytes = 0;
  queue: Promise<void> = Promise.resolve();
  deliveries = new Map<string, number>();
  constructor(http: HttpTransport, handler: FrameHandler) {
    this.http = http;
    this.handler = handler;
  }
  send(value: ExecutorFrame): boolean {
    frame(value);
    const data = canonicalJson(value);
    if (Buffer.byteLength(data) > this.http.jsonBytes)
      throw new Error("frame exceeds negotiated limit");
    const socket = this.socket;
    const durable = value.type === "job.output" || value.type === "job.prepared_result";
    if (durable && Date.now() - (this.deliveries.get(value.requestId) ?? 0) < 5000) return false;
    if (
      !this.registered ||
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      socket.bufferedAmount + Buffer.byteLength(data) > 1048576
    )
      return false;
    socket.send(data);
    if (durable) this.deliveries.set(value.requestId, Date.now());
    return true;
  }
  async connect(
    signal: AbortSignal,
    registration: Extract<ExecutorFrame, { type: "executor.register" }>,
  ): Promise<void> {
    await this.http.discover();
    registration = {
      ...registration,
      payload: { ...registration.payload, transferLimits: this.http.transferLimits() },
    };
    if (Buffer.byteLength(canonicalJson(frame(registration))) > this.http.jsonBytes)
      throw new Error("registration exceeds negotiated control limit");
    const ticket = await this.http.ticket();
    const url = new URL("/v1/executor/session", this.http.profile.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("ticket", ticket.ticket);
    const socket = new WebSocket(url);
    this.socket = socket;
    this.registered = false;
    this.deliveries.clear();
    this.lastHeard = Date.now();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const abort = () => socket.close(1000, "stopping");
    signal.addEventListener("abort", abort, { once: true });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.close(1008, "register timeout");
        }, 15000);
        socket.addEventListener("open", () => socket.send(canonicalJson(frame(registration))));
        socket.addEventListener("message", (event) => {
          const data: unknown = event.data;
          if (
            typeof data !== "string" ||
            Buffer.byteLength(data) > this.http.jsonBytes ||
            this.queueBytes + Buffer.byteLength(data) > 1048576
          ) {
            socket.close(1009, "frame bound");
            return;
          }
          this.queueBytes += Buffer.byteLength(data);
          this.queue = this.queue
            .then(async () => {
              const value = frame(JSON.parse(data));
              this.lastHeard = Date.now();
              if (!this.registered) {
                if (
                  value.type !== "executor.registered" ||
                  value.requestId !== registration.requestId ||
                  value.payload.executorId !== this.http.profile.executorId ||
                  value.payload.generation !== this.http.profile.executorGeneration ||
                  value.payload.connectionEpoch <= this.connectionEpoch
                )
                  throw new Error("registration identity");
                this.connectionEpoch = value.payload.connectionEpoch;
                this.registered = true;
                clearTimeout(timer);
                await this.handler.receive(value);
                for (const pending of this.handler.reconnectFrames()) this.send(pending);
                heartbeat = setInterval(() => {
                  if (Date.now() - this.lastHeard >= 45000) {
                    socket.close(1001, "heartbeat timeout");
                    return;
                  }
                  this.send({
                    type: "executor.heartbeat",
                    requestId: randomUUID(),
                    payload: {
                      executorId: this.http.profile.executorId,
                      generation: this.http.profile.executorGeneration,
                      connectionEpoch: this.connectionEpoch,
                      timestamp: Date.now(),
                    },
                  });
                  for (const pending of this.handler.reconnectFrames()) this.send(pending);
                }, 15000);
              } else await this.handler.receive(value);
            })
            .catch(() => {
              socket.close(1007, "invalid executor protocol");
            })
            .finally(() => {
              this.queueBytes -= Buffer.byteLength(data);
            });
        });
        socket.addEventListener(
          "close",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
        socket.addEventListener(
          "error",
          () => {
            clearTimeout(timer);
            reject(new Error("executor session transport failed"));
          },
          { once: true },
        );
        if (signal.aborted) abort();
      });
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      signal.removeEventListener("abort", abort);
      this.registered = false;
      await this.queue;
      await this.handler.disconnected();
    }
  }
}
