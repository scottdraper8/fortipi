import { ServiceError } from "../api/common.js";

/** Retained application work: null is a durable hold, not a guessed reset. */
export function repairRetryAt(error: unknown): number | null {
  if (
    error instanceof ServiceError &&
    (error.retryable === false ||
      error.details?.retryAfterMs === 0 ||
      error.code === "unauthorized" ||
      error.code === "unauthenticated")
  )
    return null;
  const delay = error instanceof ServiceError ? error.details?.retryAfterMs : undefined;
  return (
    Date.now() +
    (typeof delay === "number" && Number.isSafeInteger(delay) && delay > 0 ? delay : 30000)
  );
}
