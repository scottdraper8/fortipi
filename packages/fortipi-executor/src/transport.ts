import { randomUUID } from "node:crypto";
import type { ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import type {
  ExecutorFrame,
  TicketIdentity,
  TicketReceipt,
  TransferDescriptor,
  TransferStatus,
} from "fortipi-contract/executor";
import { canonicalJson, executorSchemaRegistry } from "fortipi-contract/executor";
import type { Limits, Profile } from "./config.js";
import { effectiveLimits, validateOrigin } from "./config.js";
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
export class HttpFailure extends Error {
  status: number;
  retryAt?: number;
  constructor(status: number, retryAt?: number) {
    super(`executor HTTPS request failed (${status})`);
    this.status = status;
    if (retryAt !== undefined) this.retryAt = retryAt;
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
  authority?: TicketIdentity;
  revoked = false;
  private activeTransfers = 0;
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
    if (now < this.pausedUntil) throw new HttpFailure(503, this.pausedUntil);
    const headers = new Headers(init.headers);
    if (authenticated) headers.set("Authorization", `Bearer ${this.profile.token}`);
    const response = await this.fetcher(new URL(path, this.profile.origin), {
      ...init,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(Math.min(30000, deadline - now)),
    });
    if (!response.ok) {
      const retry = response.headers.get("Retry-After");
      const seconds = retry === null ? undefined : Number(retry);
      const retryAt = Number.isFinite(seconds)
        ? now + Math.min(60000, Math.max(1000, (seconds as number) * 1000))
        : undefined;
      if (response.status === 429 || response.status === 503)
        this.pausedUntil = retryAt ?? now + 5000;
      await response.body?.cancel();
      throw new HttpFailure(response.status, retryAt);
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
    const size = Math.min(descriptor.chunkBytes, descriptor.size - index * descriptor.chunkBytes);
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= descriptor.chunkHashes.length ||
      descriptor.chunkBytes > this.chunkBytes
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
