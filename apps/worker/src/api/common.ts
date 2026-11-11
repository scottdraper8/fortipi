import { canonicalJson, errorStatuses } from "fortipi-contract";
import type * as D from "../boundary/dto.js";

export class ServiceError extends Error {
  readonly code: D.ErrorCode;
  readonly details: D.ErrorDetails | undefined;
  constructor(code: D.ErrorCode, message: string, details?: D.ErrorDetails) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
export function check(
  value: unknown,
  code: D.ErrorCode,
  message: string,
  details?: D.ErrorDetails,
): asserts value {
  if (!value) throw new ServiceError(code, message, details);
}
export function unwrap<T>(result: D.Outcome<T>): T {
  if (!result.ok) throw new ServiceError(result.code, result.message, result.details);
  return result.value;
}
export function failure(error: unknown, requestId: string): D.Outcome<never> & { ok: false } {
  const known =
    error instanceof ServiceError
      ? error
      : new ServiceError("interrupted", "Operation interrupted; recover the existing identity", {
          reason: "uncertain_effects",
        });
  const details =
    known.details ??
    (["conflict", "workspace.conflict", "interrupted"].includes(known.code)
      ? { reason: "uncertain_effects" as const }
      : ["unavailable", "unavailable_executor", "rate_limited"].includes(known.code)
        ? { retryAfterMs: 1000 }
        : undefined);
  return {
    ok: false,
    code: known.code,
    message: known.message,
    requestId,
    retryable: false,
    ...(details ? { details } : {}),
  } as D.Outcome<never> & { ok: false };
}
export async function outcome<T>(
  requestId: string,
  fn: () => T | Promise<T>,
): Promise<D.Outcome<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return failure(error, requestId);
  }
}
export function errorResponse(error: unknown, requestId: string): Response {
  const { ok: _ok, ...body } = failure(error, requestId);
  return Response.json(
    { error: body },
    { status: errorStatuses[body.code], headers: { "Cache-Control": "no-store" } },
  );
}
export const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
export const id = (): string => crypto.randomUUID().replaceAll("-", "");
export function pressure(
  resource: D.InfrastructurePressure["resource"],
  limit: number,
  reason: string,
): D.ErrorDetails {
  return {
    pressure: {
      resource,
      scope: { kind: "object" },
      source: "policy",
      measurement: "observed",
      limit,
      remaining: 0,
      reason,
      action: "reduce-work",
    },
  };
}
export function resourceId(kind: string, agentId: string): string {
  const result = `${kind}${agentId.length.toString(16).padStart(3, "0")}${agentId}${id()}`;
  check(result.length <= 128, "invalid_request", "Agent identifier too long");
  return result;
}
export function resourceAgent(value: string): string {
  check(/^[cmtja][0-9a-f]{3}[A-Za-z0-9_-]+$/.test(value), "not_found", "Unknown resource");
  const length = Number.parseInt(value.slice(1, 4), 16);
  check(length > 0 && value.length === length + 36, "not_found", "Unknown resource");
  return value.slice(4, 4 + length);
}
export async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(value)),
  );
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}
export function scope(input: Partial<D.ResourceScope> = {}): D.ResourceScope {
  return {
    agentIds: [],
    conversationIds: [],
    workspaceIds: [],
    executorIds: [],
    backendIds: [],
    actions: [],
    tools: [],
    ...input,
  };
}
export function permits(grants: readonly D.Grant[], resources: D.ResourceScope): boolean {
  return grants.some(
    (g) =>
      (g.expiresAt === undefined || g.expiresAt > Date.now()) &&
      (Object.keys(resources) as (keyof D.ResourceScope)[]).every((k) =>
        resources[k].every((v) => g.resources[k].includes(v) || g.resources[k].includes("*")),
      ),
  );
}
/** A per-key lane outside both Pi's commit line and the shared SQL queue. */
export class Lanes {
  private readonly tails = new Map<string, Promise<unknown>>();
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const old = this.tails.get(key) ?? Promise.resolve();
    const next = old.catch(() => {}).then(fn);
    this.tails.set(key, next);
    try {
      return await next;
    } finally {
      if (this.tails.get(key) === next) this.tails.delete(key);
    }
  }
}
