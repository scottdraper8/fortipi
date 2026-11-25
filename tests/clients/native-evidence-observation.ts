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
  "daemon-confinement-job",
  "daemon-confinement-reconcile",
  "daemon-confinement-cancel",
  "daemon-confinement-task",
  "daemon-confinement-retention",
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

const installPhaseNames = [
  "candidate",
  "directory",
  "install-one",
  "install-together",
  "inventory-before",
  "runtime-imports",
  "declarations",
  "prepare",
  "dry-build",
  "integrity",
] as const;
export type DistributionInstallPhase = (typeof installPhaseNames)[number];
const installPhases = new Set<string>(installPhaseNames);
const installPackages = new Set([
  "fortipi-contract",
  "fortipi-client",
  "fortipi-tui",
  "fortipi-executor",
  "fortipi-cli",
]);

const inventoryCheckNames = [
  "root-realpath",
  "expected-paths",
  "expected-unique",
  "manifest-link",
  "manifest-read",
  "manifest-size",
  "manifest-hash",
  "manifest-json",
  "bin-shape",
  "bin-name",
  "bin-entry",
  "bin-confined",
  "bin-authenticated-target",
  "bin-unique",
  "root-stat",
  "member-namespace",
  "member-stat",
  "link-declaration",
  "link-count",
  "link-owner",
  "link-read",
  "link-target",
  "link-realpath",
  "bin-link-required",
  "readonly",
  "directory-namespace",
  "directory-read",
  "regular-file",
  "file-size",
  "file-executable",
  "file-read",
  "file-hash",
  "complete-files",
  "complete-bins",
] as const;
export type DistributionInventoryCheck = (typeof inventoryCheckNames)[number];
const inventoryChecks = new Set<string>(inventoryCheckNames);

/** Invocation-local checkpoint only; no stack, message, path or assertion values. */
export function distributionInventoryFailureLine(
  check: unknown,
  packageName: unknown,
  error: unknown,
): string {
  return JSON.stringify({
    diagnostic: "distribution-inventory-failure",
    check: member(check, inventoryChecks),
    package: member(packageName, installPackages),
    errorClass: member(errorName(error), errorClasses),
    errorCode: member(own(error, "code"), errorCodes),
  });
}

/** Best effort only; inventory rethrows the identical original error. */
export function observeDistributionInventoryFailure(
  check: unknown,
  packageName: unknown,
  error: unknown,
): void {
  try {
    process.stderr.write(`${distributionInventoryFailureLine(check, packageName, error)}\n`);
  } catch {}
}

export function distributionInstallPhaseLine(phase: unknown, packageName: unknown): string {
  const selected = member(phase, installPhases);
  return JSON.stringify({
    diagnostic: "distribution-install-phase",
    phase: selected,
    package: selected === "install-one" ? member(packageName, installPackages) : null,
  });
}

/** Current direct execute result only; outer coordinator outcomes are separate. */
export function distributionInstallFailureLine(
  phase: unknown,
  packageName: unknown,
  error: unknown,
  result: unknown,
): string {
  const selected = member(phase, installPhases);
  const command = selected === "declarations" || selected === "prepare" || selected === "dry-build";
  const code = command ? own(result, "code") : undefined;
  const timedOut = command ? own(result, "timedOut") : undefined;
  const firstLimit = command ? own(result, "firstLimit") : undefined;
  const resultObserved =
    (code === null ||
      (typeof code === "number" && Number.isSafeInteger(code) && Math.abs(code) <= 255)) &&
    typeof timedOut === "boolean" &&
    (firstLimit === null || firstLimit === "deadline" || firstLimit === "stdout") &&
    (timedOut ? firstLimit !== null : firstLimit === null);
  return JSON.stringify({
    diagnostic: "distribution-install-failure",
    phase: selected,
    package: selected === "install-one" ? member(packageName, installPackages) : null,
    errorClass: member(errorName(error), errorClasses),
    errorCode: member(own(error, "code"), errorCodes),
    resultObserved,
    code: resultObserved ? code : null,
    timedOut: resultObserved ? timedOut : null,
    firstLimit: resultObserved ? firstLimit : null,
  });
}

export function observeDistributionInstallPhase(phase: unknown, packageName: unknown): void {
  try {
    process.stderr.write(`${distributionInstallPhaseLine(phase, packageName)}\n`);
  } catch {}
}

export function observeDistributionInstallFailure(
  phase: unknown,
  packageName: unknown,
  error: unknown,
  result: unknown,
): void {
  try {
    process.stderr.write(`${distributionInstallFailureLine(phase, packageName, error, result)}\n`);
  } catch {}
}
