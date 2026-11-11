import type * as D from "../boundary/dto.js";

export class WorkspaceError extends Error {
  readonly code: D.ErrorCode;
  readonly details: D.ErrorDetails | undefined;
  constructor(code: D.ErrorCode, message: string, details?: D.ErrorDetails) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
export function requireThat(
  value: unknown,
  code: D.ErrorCode,
  message: string,
  details?: D.ErrorDetails,
): asserts value {
  if (!value) throw new WorkspaceError(code, message, details);
}
export async function outcome<T>(
  work: () => T | Promise<T>,
  requestId = crypto.randomUUID(),
): Promise<D.Outcome<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    if (error instanceof WorkspaceError) return failure(error, requestId);
    if (
      error instanceof Error &&
      /SQLITE_FULL|database or disk is full|storage.*quota|exceeded.*storage/i.test(error.message)
    )
      return failure(
        new WorkspaceError(
          "quota_paused",
          "Provider storage is exhausted; retain existing operation identity and reclaim storage",
          {
            retryAfterMs: 1000,
            pressure: {
              resource: "storage",
              scope: { kind: "object" },
              source: "provider",
              measurement: "unknown",
              reason: "Provider rejected storage work",
              action: "reclaim-storage",
            },
          },
        ),
        requestId,
      );
    // Upstream errors can contain source/output/transport secrets. Never serialize them.
    return failure(
      new WorkspaceError(
        "interrupted",
        "Workspace operation interrupted; observe existing state before retrying",
      ),
      requestId,
    );
  }
}
function failure(error: WorkspaceError, requestId: string): D.Outcome<never> {
  const common = {
    ok: false as const,
    message: error.message,
    requestId,
    retryable: false,
  };
  if (
    error.code === "conflict" ||
    error.code === "workspace.conflict" ||
    error.code === "interrupted"
  )
    return {
      ...common,
      code: error.code,
      details: { ...error.details, reason: error.details?.reason ?? "uncertain_effects" },
    };
  if (error.code === "quota_exceeded" || error.code === "quota_paused")
    return {
      ...common,
      code: error.code,
      details: {
        ...error.details,
        retryAfterMs: error.details?.retryAfterMs ?? 1000,
        pressure: error.details?.pressure ?? {
          resource: "storage",
          scope: { kind: "object" },
          source: "policy",
          measurement: "estimated",
          reason: error.message,
          action: "reclaim-storage",
        },
      },
    };
  if (
    error.code === "unavailable" ||
    error.code === "unavailable_executor" ||
    error.code === "rate_limited"
  )
    return {
      ...common,
      code: error.code,
      details: { ...error.details, retryAfterMs: error.details?.retryAfterMs ?? 1000 },
    };
  return { ...common, code: error.code, ...(error.details ? { details: error.details } : {}) };
}
export function unwrap<T>(result: D.Outcome<T>): T {
  if (!result.ok) throw new WorkspaceError(result.code, result.message, result.details);
  return result.value;
}
