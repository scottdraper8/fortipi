import type {
  OperationId,
  OperationRequest,
  OperationResponse,
  Protocol,
  RouteDefinition,
} from "fortipi-contract";
import {
  canonicalJson,
  errorStatuses,
  routeCatalog,
  validateBrowserOrigin,
  wireLimits,
} from "fortipi-contract";
import { abortable, checkAbort, FortiPiError, failure } from "./errors.js";
import type { ClientOptions, RequestOptions } from "./types.js";
import { Validation } from "./validation.js";

export function normalizeEndpoint(value: string, allowLoopbackHttp = false): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new FortiPiError("invalid_endpoint");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(
        allowLoopbackHttp &&
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw new FortiPiError("invalid_endpoint");
  return url.origin;
}
export function sameOrigin(origin: string, reference: string): URL {
  let url: URL;
  try {
    url = new URL(reference, `${origin}/`);
  } catch {
    throw new FortiPiError("unsafe_reference");
  }
  if (url.origin !== origin || url.username || url.password || url.hash)
    throw new FortiPiError("unsafe_reference");
  return url;
}
export async function readBounded(
  response: Response,
  maximum: number,
  signal: AbortSignal,
  verifyLength = false,
): Promise<Uint8Array> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) {
    void response.body?.cancel().catch(() => {});
    throw new FortiPiError("payload_too_large");
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > maximum) throw new FortiPiError("payload_too_large");
      chunks.push(value);
    }
    // Fetch decodes compressed JSON; its Content-Length describes encoded wire bytes.
    // Raw byte routes retain the contract's exact decoded length/hash verification.
    if (verifyLength && length !== null && total !== Number(length))
      throw new FortiPiError("truncated_bytes");
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, "0")).join("");
}
function retryDelay(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const ms = /^\d+(?:\.\d+)?$/.test(header)
    ? Number(header) * 1000
    : Date.parse(header) - Date.now();
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 86400000) : undefined;
}
export class Http {
  readonly origin: string;
  readonly validation: Validation;
  readonly options: ClientOptions;
  protocol: Protocol | undefined;
  #credential: string | undefined;
  authenticationEpoch = 0;
  private negotiating: Promise<Protocol> | undefined;
  constructor(options: ClientOptions) {
    this.origin = normalizeEndpoint(options.endpoint, options.allowLoopbackHttp);
    this.validation = new Validation();
    if (options.originMode?.kind === "browser") validateBrowserOrigin(options.originMode.origin);
    this.options = options;
  }
  async negotiate(signal?: AbortSignal): Promise<Protocol> {
    if (this.protocol) return this.protocol;
    // A caller's abort must not poison another caller's negotiation.
    if (signal) return this.discover(signal);
    this.negotiating ??= this.discover().finally(() => {
      this.negotiating = undefined;
    });
    return this.negotiating;
  }
  private async discover(signal?: AbortSignal): Promise<Protocol> {
    const result = await this.request(
      { operationId: "getProtocol", path: {}, query: {}, body: undefined },
      signal ? { signal } : {},
    );
    if (result.status !== 200) throw new FortiPiError("incompatible_protocol");
    const protocol = result.body;
    if (
      protocol.protocolVersion !== "1.0" ||
      protocol.schemaVersion !== "1.0.0" ||
      !protocol.supportedVersions.includes("1.0") ||
      this.options.requiredFeatures?.some((feature) => !protocol.features.includes(feature))
    )
      throw new FortiPiError("incompatible_protocol");
    for (const schema of protocol.schemas) sameOrigin(this.origin, schema.url);
    this.protocol = protocol;
    return protocol;
  }
  async request<K extends OperationId>(
    input: OperationRequest<K>,
    options: RequestOptions = {},
  ): Promise<OperationResponse<K>> {
    const route = routeCatalog.find((r) => r.operationId === input.operationId) as
      | RouteDefinition
      | undefined;
    if (!route || route.transport === "upgrade")
      throw new FortiPiError("use_subscription_transport");
    this.validation.request(route, input);
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(this.options.timeoutMs ?? 30000)])
      : AbortSignal.timeout(this.options.timeoutMs ?? 30000);
    try {
      if (route.audience !== "public") await this.negotiate(signal);
      checkAbort(signal);
      const url = sameOrigin(
        this.origin,
        route.path.replace(/\{(\w+)\}/g, (_, key: string) =>
          encodeURIComponent(String((input.path as Record<string, unknown>)[key])),
        ),
      );
      for (const [key, value] of Object.entries(input.query))
        if (value !== undefined) {
          if (typeof value === "object" && value !== null)
            for (const [sub, item] of Object.entries(value))
              url.searchParams.set(`${key}[${sub}]`, String(item));
          else url.searchParams.set(key, String(value));
        }
      const headers = new Headers({
        accept: route.transport === "bytes" ? "application/octet-stream" : "application/json",
      });
      if (options.range) {
        if (route.transport !== "bytes" || !route.success.includes(206))
          throw new FortiPiError("invalid_range");
        const { start, end } = options.range;
        if (
          !Number.isSafeInteger(start) ||
          start < 0 ||
          (end !== undefined && (!Number.isSafeInteger(end) || end < start))
        )
          throw new FortiPiError("invalid_range");
        headers.set("range", `bytes=${start}-${end ?? ""}`);
      }
      let body: string | Uint8Array<ArrayBuffer> | undefined;
      if (input.body instanceof Uint8Array) {
        const query = input.query as { length?: number; sha256?: string };
        if (
          input.body.length >
            Math.min(
              route.bodyBytes ?? wireLimits.chunkBytes,
              this.protocol?.limits.chunkBytes ?? wireLimits.chunkBytes,
            ) ||
          query.length !== input.body.length ||
          query.sha256 !== (await sha256(input.body))
        )
          throw new FortiPiError("invalid_chunk");
        body = new Uint8Array(input.body);
        headers.set("content-type", "application/octet-stream");
      } else if (input.body !== undefined) {
        body = canonicalJson(input.body);
        if (
          new TextEncoder().encode(body).length >
          Math.min(
            route.bodyBytes ?? wireLimits.jsonBytes,
            this.protocol?.limits.jsonBytes ?? wireLimits.jsonBytes,
          )
        )
          throw new FortiPiError("payload_too_large");
        headers.set("content-type", "application/json");
      }
      const fetcher = this.options.fetch ?? globalThis.fetch;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (route.audience !== "public" && (this.#credential === undefined || attempt !== 0)) {
          const credential = await abortable(
            this.options.credentials({
              endpoint: this.origin,
              signal,
              reason: attempt === 0 ? "initial" : "unauthenticated",
            }),
            signal,
          );
          if (typeof credential !== "string" || !credential || /[\r\n]/.test(credential))
            throw new FortiPiError("invalid_credential");
          this.#credential = credential;
          this.authenticationEpoch++;
        }
        if (route.audience !== "public") headers.set("authorization", `Bearer ${this.#credential}`);
        const response = await abortable(
          fetcher(url.href, {
            method: route.method,
            headers,
            redirect: "manual",
            credentials: "omit",
            cache: "no-store",
            referrerPolicy: "no-referrer",
            signal,
            ...(body === undefined ? {} : { body }),
          }),
          signal,
        );
        if (
          response.redirected ||
          (response.status >= 300 && response.status < 400) ||
          response.type === "opaqueredirect"
        ) {
          void response.body?.cancel().catch(() => {});
          throw new FortiPiError("redirect_rejected");
        }
        if (response.status === 401 && attempt === 0 && route.audience !== "public") {
          void response.body?.cancel().catch(() => {});
          continue;
        }
        if (route.success.includes(response.status)) {
          if (response.status === 204) {
            void response.body?.cancel().catch(() => {});
            return { status: 204, body: undefined } as OperationResponse<K>;
          }
          const byteLimit =
            route.operationId === "getWorkspaceArtifact" || route.operationId === "getAdminArtifact"
              ? Math.min(
                  wireLimits.artifactBytes,
                  this.protocol?.infrastructure.bounds.artifactBytes ?? wireLimits.artifactBytes,
                )
              : route.operationId === "getExecutorTransferInputChunk"
                ? Math.min(
                    wireLimits.chunkBytes,
                    this.protocol?.limits.chunkBytes ?? wireLimits.chunkBytes,
                  )
                : Math.min(
                    wireLimits.fileBytes,
                    this.protocol?.infrastructure.bounds.fileBytes ?? wireLimits.fileBytes,
                  );
          const bytes = await readBounded(
            response,
            route.transport === "bytes"
              ? byteLimit
              : Math.min(
                  wireLimits.jsonBytes,
                  this.protocol?.limits.jsonBytes ?? wireLimits.jsonBytes,
                ),
            signal,
            route.transport === "bytes",
          );
          if (route.transport === "bytes") {
            const hash = response.headers.get("x-content-sha256");
            if (
              !response.headers.has("content-length") ||
              !hash ||
              !/^[a-f0-9]{64}$/.test(hash) ||
              hash !== (await sha256(bytes))
            )
              throw new FortiPiError("checksum_mismatch");
            const range =
              options.range ?? (input.query as { range?: { start: number; end?: number } }).range;
            if (response.status === 206) {
              const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
                response.headers.get("content-range") ?? "",
              );
              if (!match || !range) throw new FortiPiError("invalid_range");
              const start = Number(match[1]),
                end = Number(match[2]),
                total = Number(match[3]);
              if (
                ![start, end, total].every(Number.isSafeInteger) ||
                start !== range.start ||
                end < start ||
                end >= total ||
                bytes.length !== end - start + 1 ||
                end !== Math.min(range.end ?? total - 1, total - 1)
              )
                throw new FortiPiError("invalid_range");
            } else if (range) throw new FortiPiError("invalid_range");
            return { status: response.status, body: bytes } as OperationResponse<K>;
          }
          let value: unknown;
          try {
            value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
          } catch {
            throw new FortiPiError("invalid_wire");
          }
          if (
            input.operationId === "getProtocol" &&
            value &&
            typeof value === "object" &&
            ((value as Protocol).protocolVersion !== "1.0" ||
              (value as Protocol).schemaVersion !== "1.0.0")
          )
            throw new FortiPiError("incompatible_protocol");
          if (route.response)
            this.validation.assert(
              route.successSchemas?.[response.status] ?? route.response,
              value,
            );
          return { status: response.status, body: value } as OperationResponse<K>;
        }
        const bytes = await readBounded(
          response,
          Math.min(wireLimits.jsonBytes, this.protocol?.limits.jsonBytes ?? wireLimits.jsonBytes),
          signal,
        );
        let value: unknown;
        try {
          value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
          this.validation.assert("ErrorBody", value);
        } catch {
          throw new FortiPiError("transport", {
            status: response.status,
            retryable: response.status >= 500,
          });
        }
        const error = (value as { error: import("fortipi-contract").ProtocolError }).error;
        if (!route.errors.includes(error.code) || errorStatuses[error.code] !== response.status)
          throw new FortiPiError("invalid_wire");
        throw FortiPiError.remote(error, response.status, retryDelay(response));
      }
      throw new FortiPiError("unauthenticated");
    } catch (error) {
      if (signal.aborted) {
        const timeout =
          signal.reason instanceof DOMException && signal.reason.name === "TimeoutError";
        throw new FortiPiError(timeout ? "timeout" : "aborted", { retryable: timeout });
      }
      throw failure(error);
    }
  }
}
