const phases = new Set([
  "candidate-metadata",
  "candidate-environment",
  "candidate-checkout",
  "candidate-checkout-head",
  "candidate-checkout-status",
  "candidate-workflow",
  "candidate-reference",
  "candidate-authentication",
  "candidate-producer-authentication",
  "candidate-zip-authentication",
  "candidate-staging-protection",
  "candidate-package-archive",
  "candidate-payload",
  "payload-protection",
  "payload-bytes",
  "evidence-producer",
  "evidence-fixture",
  "evidence-coordinator",
  "evidence-receipt",
  "native-output-protection",
  "daemon-isolation",
  "daemon-installed-module",
  "daemon-service-module",
  "daemon-service-setup",
  "daemon-directory",
  "daemon-protection",
  "daemon-profile",
  "daemon-init",
  "daemon-disclosure",
  "daemon-start",
  "daemon-confinement-dispatch",
  "daemon-confinement-remote-approval",
  "daemon-confinement-local-approval",
  "daemon-confinement-policy",
  "daemon-confinement-refusal",
  "daemon-confinement-settlement",
  "daemon-execution-policy",
  "daemon-execution-dispatch",
  "daemon-execution-remote-approval",
  "daemon-execution-local-approval",
  "daemon-execution-marker",
  "daemon-execution-completion",
  "daemon-output",
  "daemon-artifact",
  "daemon-duplicate",
  "daemon-retained-ledger",
  "daemon-abrupt-stop",
  "daemon-offline",
  "daemon-reopen",
  "daemon-reopen-retention",
  "daemon-installed-integrity",
  "daemon-cleanup-stop",
  "daemon-cleanup-service",
  "daemon-cleanup-directory",
  "service-native-setup",
  "service-listen",
  "service-seed-reject",
  "service-seed-settle",
  "service-seed-disconnect",
  "service-seed-shutdown",
  "service-executor-enroll",
  "service-client-issue",
  "service-dispatch-binding",
  "service-dispatch-queue",
  "service-dispatch-submit",
  "service-dispatch-approval",
  "service-cleanup-roles",
  "service-cleanup-runtime",
]);
const errorClasses = new Set([
  "Error",
  "AssertionError",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "TimeoutError",
  "AbortError",
  "FortiPiError",
]);
const errorCodes = new Set([
  "ERR_ASSERTION",
  "ERR_MODULE_NOT_FOUND",
  "MODULE_NOT_FOUND",
  "ERR_INVALID_ARG_TYPE",
  "ERR_INVALID_ARG_VALUE",
  "ERR_DLOPEN_FAILED",
  "ERR_SQLITE_ERROR",
  "ENOENT",
  "EACCES",
  "EPERM",
  "EEXIST",
  "ENOSPC",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ABORT_ERR",
  "UND_ERR_CONNECT_TIMEOUT",
]);
function own(value: unknown, key: string): unknown {
  try {
    return value && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, key)?.value
      : undefined;
  } catch {
    return undefined;
  }
}
function errorName(error: unknown): unknown {
  try {
    if (!error || typeof error !== "object") return null;
    const descriptor = Object.getOwnPropertyDescriptor(error, "name");
    // An accessor or unknown own name cannot fall through to another label.
    return descriptor ? descriptor.value : own(Object.getPrototypeOf(error), "name");
  } catch {
    return null;
  }
}
const member = (value: unknown, allowed: Set<string>) =>
  typeof value === "string" && allowed.has(value) ? value : null;

/** Failure metadata only: no messages, stacks, assertion values or nested causes.
 * Read data descriptors without invoking accessors or coercing thrown values. */
export function nativeEvidenceFailureLine(phase: unknown, error: unknown): string {
  return JSON.stringify({
    diagnostic: "native-evidence-failure",
    phase: member(phase, phases),
    errorClass: member(errorName(error), errorClasses),
    errorCode: member(own(error, "code"), errorCodes),
  });
}

/** Best effort only; callers rethrow the identical original error. */
export function observeNativeEvidenceFailure(phase: unknown, error: unknown): void {
  try {
    process.stderr.write(`${nativeEvidenceFailureLine(phase, error)}\n`);
  } catch {}
}
