import { routeCatalog, schemaRegistry, validateBrowserOrigin, wireLimits } from "fortipi-contract";
import openapi from "../../../../packages/fortipi-contract/openapi.yaml" with { type: "json" };
import type * as D from "../boundary/dto.js";
import type { Env } from "../boundary/env.js";
import { check, errorResponse, id, resourceAgent, scope, unwrap } from "./common.js";
import { boundedJson, valid, validate } from "./validation.js";

export const implementedOperations = new Set(routeCatalog.map((r) => r.operationId));
const executorJobFetch = new Set<D.OperationId>([
  "getExecutorJobManifest",
  "getExecutorJobBlob",
  "beginExecutorJobUpload",
  "putExecutorJobUploadChunk",
  "validateExecutorJobUpload",
]);
export function matchRoute(
  method: string,
  pathname: string,
): { route: (typeof routeCatalog)[number]; path: Record<string, string | number> } | undefined {
  for (const route of routeCatalog) {
    if (route.method !== method) continue;
    const names: string[] = [];
    const pattern = route.path
      .replace(/[.*+?^$()|[\]\\]/g, "\\$&")
      .replace(/\{([^}]+)\}/g, (_all, name: string) => {
        names.push(name);
        return "([^/]+)";
      });
    const match = new RegExp(`^${pattern}$`).exec(pathname);
    if (!match) continue;
    const path: Record<string, string | number> = {};
    names.forEach((name, index) => {
      const value = decodeURIComponent(match[index + 1] ?? "");
      if (name === "chunkIndex") {
        check(/^\d+$/.test(value), "invalid_request", "Invalid chunk index");
        path[name] = Number(value);
      } else {
        check(
          name === "name" || /^[A-Za-z0-9_-]{1,128}$/.test(value),
          "invalid_request",
          "Invalid resource identifier",
        );
        path[name] = value;
      }
    });
    return { route, path };
  }
  return undefined;
}
function queryParameters(url: URL): Record<string, unknown> {
  const query: Record<string, unknown> = {};
  for (const [name, value] of url.searchParams) {
    check(
      !["__proto__", "prototype", "constructor"].includes(name),
      "invalid_request",
      "Invalid query parameter",
    );
    const range = /^range\[(start|end)\]$/.exec(name);
    if (range) {
      const key = range[1]!;
      query.range ??= {};
      const object = query.range as Record<string, unknown>;
      check(
        object[key] === undefined && /^\d+$/.test(value),
        "invalid_request",
        "Invalid or duplicate byte range",
      );
      object[key] = Number(value);
    } else {
      check(query[name] === undefined, "invalid_request", "Duplicate query parameter");
      query[name] = ["after", "through", "limit", "length", "connectionEpoch"].includes(name)
        ? /^\d+$/.test(value)
          ? Number(value)
          : NaN
        : value;
    }
  }
  return query;
}
function origins(env: Env): string[] {
  const values = env.FORTIPI_ALLOWED_ORIGINS ?? [];
  check(values.length <= 16, "invalid_request", "Too many allowed origins");
  for (const value of values) validateBrowserOrigin(value);
  return values;
}
function cors(request: Request, env: Env): Headers {
  const headers = new Headers({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  const origin = request.headers.get("Origin");
  if (origin) {
    validateBrowserOrigin(origin);
    check(origins(env).includes(origin), "unauthorized", "Origin is not allowed");
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
    headers.set(
      "Access-Control-Expose-Headers",
      "X-Request-Id,Content-Length,Content-Range,X-Content-SHA256,Accept-Ranges,ETag,Retry-After",
    );
  }
  return headers;
}
function discovery(
  route: (typeof routeCatalog)[number],
  path: Record<string, string | number>,
  env: Env,
): Response {
  if (route.operationId === "getHealth")
    return Response.json({ status: "ok", protocolVersion: "1.0" } satisfies D.Health);
  if (route.operationId === "getOpenApi") return Response.json(openapi);
  if (route.operationId === "getSchema") {
    const schema = Object.values(schemaRegistry).find((s) =>
      s.$id.endsWith(`/${String(path.name)}`),
    );
    check(schema, "not_found", "Schema unavailable");
    return Response.json(schema);
  }
  const policy = env.FORTIPI_CONFIG.infrastructure;
  const body: D.Protocol = {
    protocolVersion: "1.0",
    schemaVersion: "1.0.0",
    deploymentId: env.CONTROL_PLANE.idFromName("control").toString(),
    supportedVersions: ["1.0"],
    features: [
      "durable-events",
      "idempotent-admissions",
      "explicit-approval",
      "query-only-recovery",
    ],
    schemas: Object.values(schemaRegistry).map((s) => ({
      name: s.$id.split("/").at(-1)!,
      url: `/v1/schemas/${s.$id.split("/").at(-1)!}`,
    })),
    models: ("models" in env.FORTIPI_CONFIG ? env.FORTIPI_CONFIG.models : []).map((m) => ({
      providerId: m.providerId,
      modelId: m.modelId,
      capabilities: [],
      available:
        m.providerId === "cloudflare"
          ? !!env.AI
          : "auth" in m && m.auth.kind === "oauth"
            ? !!env.FORTIPI_MODEL_AUTH_KEY
            : "auth" in m &&
              m.auth.kind === "secretRef" &&
              (m.auth.secretRef === "OPENAI_API_KEY"
                ? !!env.OPENAI_API_KEY
                : !!env.ANTHROPIC_API_KEY),
    })),
    infrastructure: policy,
    limits: {
      jsonBytes: wireLimits.jsonBytes,
      outputFrameBytes: wireLimits.outputFrameBytes,
      chunkBytes: wireLimits.chunkBytes,
      uploadTtlMs: wireLimits.uploadTtlMs,
      ticketTtlMs: wireLimits.ticketMs,
      rpcDeadlineMs: 30000,
      replayPage: wireLimits.replayPage,
      socketBufferBytes: wireLimits.socketBytes,
      socketBufferFrames: wireLimits.socketFrames,
    },
    retention: { kind: "conversation-lifetime", retainedFloor: 0 },
    backends: [
      {
        kind: "cloud-js",
        confinement: "isolated",
        available:
          !!env.LOADER &&
          policy.capabilities.some((c) => c.capability === "loader" && c.state === "available"),
      },
      {
        kind: "linux",
        confinement: "isolated",
        available:
          !!env.LINUX_CONTAINERS &&
          policy.capabilities.some((c) => c.capability === "containers" && c.state === "available"),
      },
      { kind: "native", confinement: "host", available: true },
    ],
  };
  return Response.json(body);
}
/** Public entry accepts only the generated catalog; all private owner lanes are unreachable here. */
export async function routeRequest(request: Request, env: Env): Promise<Response> {
  const requestId = valid<string>("Id", request.headers.get("X-Request-Id"))
    ? request.headers.get("X-Request-Id")!
    : id();
  let exposed: Headers | undefined;
  try {
    exposed = cors(request, env);
    exposed.set("X-Request-Id", requestId);
    if (request.method === "OPTIONS") {
      check(request.headers.has("Origin"), "invalid_request", "Preflight Origin required");
      check(
        ["GET", "POST", "PATCH", "PUT", "DELETE"].includes(
          request.headers.get("Access-Control-Request-Method") ?? "",
        ),
        "invalid_request",
        "Unsupported method",
      );
      check(
        (request.headers.get("Access-Control-Request-Headers") ?? "")
          .split(",")
          .filter(Boolean)
          .every((h) =>
            ["authorization", "content-type", "x-request-id", "range"].includes(
              h.trim().toLowerCase(),
            ),
          ),
        "unauthorized",
        "Unsupported header",
      );
      exposed.set("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE");
      exposed.set("Access-Control-Allow-Headers", "Authorization,Content-Type,X-Request-Id,Range");
      return new Response(null, { status: 204, headers: exposed });
    }
    const url = new URL(request.url);
    const matched = matchRoute(request.method, url.pathname);
    check(matched, "not_found", "Route unavailable");
    const { route, path } = matched;
    const query = queryParameters(url);
    validate(route.query, query);
    if (route.owner === "discovery") return merge(discovery(route, path, env), exposed);
    const control = env.CONTROL_PLANE.getByName("control");
    if ("transport" in route && route.transport === "upgrade") {
      // CP owns the opaque ticket and its destination. It redeems exactly once and
      // forwards only the existing trusted SocketIdentity to the selected authority.
      check(
        request.headers.get("Upgrade")?.toLowerCase() === "websocket",
        "invalid_request",
        "WebSocket upgrade required",
      );
      check(
        !request.headers.has("Sec-WebSocket-Protocol"),
        "invalid_request",
        "Internal transports are not public",
      );
      const headers = new Headers({ Upgrade: "websocket" });
      const origin = request.headers.get("Origin");
      if (origin) headers.set("Origin", origin);
      const authorityUrl = new URL(url);
      authorityUrl.protocol = "https:";
      return control.fetch(new Request(authorityUrl, { headers, signal: request.signal }));
    }
    const bearer = request.headers.get("Authorization");
    check(bearer && bearer.startsWith("Bearer "), "unauthenticated", "Bearer credential required");
    let auth = unwrap(
      await control.authenticate({
        bearer: bearer.slice(7),
        deploymentId: env.CONTROL_PLANE.idFromName("control").toString(),
        requestId,
        deadline: Date.now() + 30000,
        ...(request.headers.has("Origin") ? { origin: request.headers.get("Origin")! } : {}),
      }),
    );
    // Audience is independent of action names shared by application and admin routes.
    check(
      route.audience !== "admin" || auth.role === "admin",
      "unauthorized",
      "Administrator audience required",
    );
    check(
      route.audience !== "executor" || auth.role === "executor",
      "unauthorized",
      "Executor audience required",
    );
    check(
      route.audience !== "application" ||
        auth.role !== "executor" ||
        route.operationId === "mintConnectionTicket",
      "unauthorized",
      "Application audience required",
    );
    const agentId =
      typeof path.agentId === "string"
        ? path.agentId
        : route.owner === "agent" && typeof path.id === "string"
          ? resourceAgent(path.id)
          : undefined;
    const resources = scope({
      agentIds: agentId ? [agentId] : [],
      workspaceIds: typeof path.workspaceId === "string" ? [path.workspaceId] : [],
      conversationIds:
        url.pathname.startsWith("/v1/conversations/") && typeof path.id === "string"
          ? [path.id]
          : [],
      actions: [route.action],
    });
    // The owner performs current role/scope checks. Resource registration below
    // also checks the exact original grants before any authority use. An extra
    // authorize RPC here would duplicate those checks and charge another request.
    if (route.owner === "agent" || route.owner === "workspace") {
      const recipient: D.Recipient =
        route.owner === "agent"
          ? { kind: "agent", id: agentId! }
          : { kind: "workspace", id: String(path.workspaceId) };
      const registration = unwrap(
        await control.registerAuthorityRecipient(auth, {
          credential: {
            credentialId: auth.credentialId,
            generation: auth.generation,
            grantVersion: auth.grantVersion,
          },
          recipient,
          resources,
        }),
      );
      auth = { ...auth, registrationId: registration.registrationId };
    }
    if (
      executorJobFetch.has(route.operationId) ||
      ("transport" in route && route.transport === "bytes") ||
      route.operationId === "getExecutorTransfer"
    ) {
      const headers = new Headers();
      for (const name of ["Range", "Content-Type", "Content-Length"])
        if (request.headers.has(name)) headers.set(name, request.headers.get(name)!);
      if (route.owner === "workspace")
        headers.set("x-fortipi-workspace-context", JSON.stringify({ auth }));
      else if (route.operationId === "getAdminArtifact")
        headers.set("X-Fortipi-Context", JSON.stringify(auth));
      else headers.set("Authorization", bearer);
      const authorityUrl = new URL(url);
      if (route.owner === "control") authorityUrl.protocol = "https:";
      let body = request.body;
      if (executorJobFetch.has(route.operationId) && route.body) {
        const input = await boundedJson(
          request,
          "bodyBytes" in route ? route.bodyBytes : wireLimits.jsonBytes,
        );
        validate(route.body, input);
        body = new Blob([JSON.stringify(input)], { type: "application/json" }).stream();
        headers.set("Content-Type", "application/json");
        headers.delete("Content-Length");
      }
      const forwarded = new Request(authorityUrl, {
        method: request.method,
        headers,
        body,
        signal: request.signal,
      });
      const response = await (route.owner === "workspace"
        ? env.WORKSPACES.getByName(String(path.workspaceId)).fetch(forwarded)
        : control.fetch(forwarded));
      return merge(response, exposed);
    }
    const body = route.body
      ? await boundedJson(request, "bodyBytes" in route ? route.bodyBytes : wireLimits.jsonBytes)
      : undefined;
    if (route.body) validate(route.body, body);
    const input = {
      operationId: route.operationId,
      path,
      query,
      body,
    } as D.OperationRequest<D.OperationId>;
    let response: { status: number; body: unknown };
    if (route.owner === "control")
      response = unwrap(
        await control.handleApi(auth, input as D.OperationRequest<D.ControlOperationId>),
      );
    else if (route.owner === "agent")
      return merge(
        await env.AGENT_SESSIONS.getByName(agentId!).fetch(
          new Request(url, {
            method: request.method,
            headers: {
              "X-Fortipi-Context": JSON.stringify(auth),
              "Content-Type": "application/json",
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: request.signal,
          }),
        ),
        exposed,
      );
    else
      response = unwrap(
        await workspaceApi(env, auth, input as D.OperationRequest<D.WorkspaceOperationId>),
      );
    return merge(Response.json(response.body, { status: response.status }), exposed);
  } catch (error) {
    return merge(errorResponse(error, requestId), exposed);
  }
}
function merge(response: Response, headers?: Headers): Response {
  if (response.status === 101) return response;
  const result = new Headers(response.headers);
  headers?.forEach((value, key) => {
    result.set(key, value);
  });
  return new Response(response.body, { status: response.status, headers: result });
}
async function workspaceApi(
  env: Env,
  ctx: D.AuthContext,
  input: D.OperationRequest<D.WorkspaceOperationId>,
): Promise<D.Outcome<{ status: number; body: unknown }>> {
  const owner = env.WORKSPACES.getByName(input.path.workspaceId);
  switch (input.operationId) {
    case "describeWorkspace":
      return owner.describe(ctx, input);
    case "getWorkspaceManifest":
      return owner.manifest(ctx, input);
    case "listWorkspaceFiles":
      return owner.list(ctx, input);
    case "statWorkspaceFile":
      return owner.stat(ctx, input);
    case "diffWorkspace":
      return owner.diff(ctx, input);
    case "snapshotWorkspace":
      return owner.snapshot(ctx, input);
    case "beginUpload":
      return owner.beginUpload(ctx, input);
    case "getUpload":
      return owner.getUpload(ctx, input);
    case "abortUpload":
      return owner.abortUpload(ctx, input);
    case "validateUpload":
      return owner.validateUpload(ctx, input);
    case "commitUpload":
      return owner.commitUpload(ctx, input);
    case "getCommitReceipt":
      return owner.getCommitReceipt(ctx, input);
    case "transactWorkspace":
      return owner.transactWorkspace(ctx, input);
    default:
      check(false, "invalid_request", "Byte operation requires byte transport");
  }
}
