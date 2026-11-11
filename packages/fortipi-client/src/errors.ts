import type { ErrorDetails, ProtocolError } from "fortipi-contract";

/** Deliberately contains no URL, raw response, bearer, ticket or transport cause. */
export class FortiPiError extends Error {
  readonly code: string;
  readonly requestId: string | undefined;
  readonly retryable: boolean;
  readonly status: number | undefined;
  readonly details: ErrorDetails | undefined;
  readonly retryAfterMs: number | undefined;
  constructor(
    code: string,
    options: {
      requestId?: string;
      retryable?: boolean;
      status?: number;
      details?: ErrorDetails;
      retryAfterMs?: number;
    } = {},
  ) {
    super(`FortiPi: ${code}`);
    this.name = "FortiPiError";
    this.code = code;
    this.requestId = options.requestId;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
    this.details = options.details;
    this.retryAfterMs = options.retryAfterMs;
  }
  static remote(error: ProtocolError, status?: number, retryAfterMs?: number): FortiPiError {
    return new FortiPiError(error.code, {
      requestId: error.requestId,
      retryable: error.retryable,
      ...(status === undefined ? {} : { status }),
      ...(error.details ? { details: error.details } : {}),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }
}
export function failure(error: unknown): FortiPiError {
  if (error instanceof FortiPiError) return error;
  return new FortiPiError(
    error instanceof DOMException && error.name === "AbortError" ? "aborted" : "transport",
    { retryable: true },
  );
}
export function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new FortiPiError("aborted");
}
/** Bounds providers and injected transports that do not implement cancellation themselves. */
export async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  checkAbort(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      reject(new FortiPiError("aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(failure(error));
      },
    );
  });
}
export async function delay(ms: number, signal: AbortSignal): Promise<void> {
  checkAbort(signal);
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new FortiPiError("aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
