import { createHash } from "node:crypto";
import type {
  AdminArtifactReference,
  OperationId,
  OperationRequest,
  OperationValue,
  RouteDefinition,
} from "fortipi-contract";
import { errorStatuses, routeCatalog, validateProviderAuthPut, wireLimits } from "fortipi-contract";
import { exactOrigin } from "./config.js";
import { CliError, check } from "./errors.js";
import type { Profile } from "./profiles.js";
import { reserveProtected } from "./profiles.js";
import { validate } from "./validation.js";

export async function boundedBytes(response: Response, maximum: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  check(reader, "missing_response_body", 1);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      check(size <= maximum, "response_too_large", 1);
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks, size);
}
export interface AdminOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  allowLoopback?: boolean;
  transport?: typeof fetch;
}
export class AdminClient {
  readonly #profile: Profile;
  readonly #options: AdminOptions;
  constructor(profile: Profile, options: AdminOptions = {}) {
    exactOrigin(profile.endpoint, options.allowLoopback);
    this.#profile = profile;
    this.#options = options;
  }
  async #request(
    route: RouteDefinition,
    path: Record<string, unknown>,
    query: object,
    body?: unknown,
  ): Promise<Response> {
    const names = [...route.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string);
    check(
      Object.keys(path).length === names.length &&
        names.every(
          (n) => typeof path[n] === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(path[n] as string),
        ),
      "invalid_resource_id",
    );
    validate(route.query, query);
    if (route.body) validate(route.body, body);
    else check(body === undefined, "unexpected_operation_body");
    if (route.operationId === "putProviderAuth")
      validateProviderAuthPut(body as OperationRequest<"putProviderAuth">["body"]);
    if (body !== undefined)
      check(
        Buffer.byteLength(JSON.stringify(body)) <= (route.bodyBytes ?? wireLimits.jsonBytes),
        "request_too_large",
      );
    const url = new URL(
      route.path.replace(/\{(\w+)\}/g, (_, name: string) =>
        encodeURIComponent(path[name] as string),
      ),
      this.#profile.endpoint,
    );
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    check(url.origin === this.#profile.endpoint, "credential_origin_mismatch", 3);
    const signal = AbortSignal.any([
      AbortSignal.timeout(this.#options.timeoutMs ?? 30000),
      ...(this.#options.signal ? [this.#options.signal] : []),
    ]);
    let response: Response;
    try {
      response = await (this.#options.transport ?? fetch)(url, {
        method: route.method,
        redirect: "error",
        signal,
        headers: {
          authorization: `Bearer ${this.#profile.token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new CliError(
        route.method === "GET" ? "transport_failed" : "mutation_uncertain_query_receipt",
      );
    }
    if (!route.success.includes(response.status)) {
      // Never echo a server message, URL, token, or arbitrary body into diagnostics.
      try {
        const error: unknown = JSON.parse(
          new TextDecoder().decode(await boundedBytes(response, 65536)),
        );
        validate("ErrorBody", error);
        const code = (error as { error: { code: keyof typeof errorStatuses } }).error.code;
        check(
          route.errors.includes(code) && errorStatuses[code] === response.status,
          "invalid_error_response",
          1,
        );
      } catch {
        throw new CliError("invalid_error_response");
      }
      throw new CliError(
        response.status === 409 ? "version_conflict" : `http_${response.status}`,
        response.status === 409 ? 4 : 1,
      );
    }
    return response;
  }
  async call<K extends OperationId>(
    operationId: K,
    request: Omit<OperationRequest<K>, "operationId">,
  ): Promise<OperationValue<K>> {
    const route: RouteDefinition | undefined = routeCatalog.find(
      (r) => r.operationId === operationId,
    );
    check(route?.response && !route.transport, "invalid_management_operation");
    const response = await this.#request(route, request.path, request.query, request.body);
    try {
      const value: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(await boundedBytes(response, 1048576)),
      );
      const name = route.successSchemas?.[response.status] ?? route.response;
      check(name, "missing_response_schema", 1);
      validate(name, value);
      return value as OperationValue<K>;
    } catch {
      throw new CliError(
        route.method === "GET" ? "invalid_response" : "mutation_uncertain_query_receipt",
      );
    }
  }
  async download(
    artifact: AdminArtifactReference,
    output: string,
    maximum: number,
  ): Promise<{ bytes: number; sha256: string }> {
    validate("AdminArtifactReference", artifact);
    check(artifact.size <= maximum, "artifact_exceeds_bound");
    const destination = await reserveProtected(output);
    let size = 0;
    const hash = createHash("sha256");
    try {
      const route = routeCatalog.find((r) => r.operationId === "getAdminArtifact");
      check(route, "missing_artifact_operation", 3);
      const response = await this.#request(route, { id: artifact.artifactId }, {});
      check(
        response.status === 200 && response.headers.get("content-length") === String(artifact.size),
        "artifact_length_mismatch",
        1,
      );
      const reader = response.body?.getReader();
      check(reader, "missing_artifact_stream", 1);
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          check(size <= artifact.size && size <= maximum, "artifact_exceeds_bound", 1);
          hash.update(chunk.value);
          await destination.writeFile(chunk.value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      const digest = hash.digest("hex");
      check(size === artifact.size && digest === artifact.sha256, "artifact_integrity_failed", 1);
      await destination.sync();
      return { bytes: size, sha256: digest };
    } catch {
      // Retain an empty protected reservation on failure, never a plausible partial export.
      await destination.truncate(0);
      await destination.sync();
      throw new CliError("artifact_download_incomplete");
    } finally {
      await destination.close();
    }
  }
}
