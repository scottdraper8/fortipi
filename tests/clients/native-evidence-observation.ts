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
  "platform-installed-module",
  "platform-source-module",
  "platform-setup",
  "platform-directory",
  "platform-protection",
  "platform-roots",
  "platform-root-open",
  "platform-root-identity",
  "platform-binary",
  "platform-case",
  "platform-root-isolation",
  "platform-reserved-paths",
  "platform-link-escape",
  "platform-sqlite-guard",
  "platform-shell-environment",
  "platform-shell-spawn",
  "platform-shell-output",
  "platform-descendant-ready",
  "platform-start-marker",
  "platform-process-cancel",
  "platform-descendant-exit",
  "platform-filesystem",
  "platform-cleanup-stop",
  "platform-cleanup-descendant",
  "platform-cleanup-directory",
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
  "EBUSY",
  "EMFILE",
  "ENFILE",
  "ENOTEMPTY",
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

// Literal CLI errors reachable through deploy --dry-run; never accept arbitrary stderr.
const dryCliErrorCodes = new Set([
  "command_failed",
  "invalid_input_file",
  "input_too_large",
  "invalid_json",
  "invalid_operator_config",
  "invalid_deployment",
  "invalid_origin",
  "invalid_canonical_deployment_id_use_existing_public_protocol",
  "invalid_allowed_origins",
  "unknown_contract_schema",
  "invalid_contract_input",
  "free_policy_exceeds_canonical_bounds",
  "paid_deployment_id_required_bootstrap_native_then_reprepare",
  "paid_capability_required_for_canonical_deployment_id_reprepare",
  "inconsistent_capacity_bounds",
  "unsupported_model_provider",
  "oauth_provider_mismatch",
  "codex_requires_oauth",
  "custom_provider_endpoint_requires_review",
  "reserved_secret_reference",
  "unsupported_model_secret_binding",
  "linked_asset",
  "invalid_asset_type",
  "invalid_asset_manifest",
  "actual_service5_worker_assets_required",
  "noncanonical_asset_manifest",
  "incomplete_asset_manifest",
  "asset_closure_mismatch",
  "asset_integrity_failed",
  "image_provenance_changed",
  "canonical_worker_template_required",
  "unexpected_template_field",
  "invalid_free_template",
  "invalid_container_overlay",
  "reviewed_linux_image_digest_required",
  "image_context_changed",
  "migration_history_requires_explicit_repair",
  "invalid_prepare_receipt",
  "prepared_asset_identity_changed",
  "prepared_config_changed",
  "unexpected_prepared_file",
  "protected_acl_required",
  "unsafe_parent",
  "unsafe_protected_path",
  "protected_permissions_required",
  "protected_directory_failed",
  "untrusted_windows_system_root",
  "invalid_windows_user_home",
  "verified_node_26_13_required",
  "pinned_wrangler_required",
  "invalid_wrangler_bin",
  "explicit_wrangler_paths_required",
  "invalid_secret_input_mode",
  "wrangler_spawn_failed",
  "wrangler_cancelled_or_timed_out",
  "wrangler_failed_or_uncertain",
  "wrangler_dry_build_module_identity_failed",
]);

/** One dry child only: bounded transient bytes, then a literal code or null. */
export function collectDryCliErrorCode() {
  let bytes = Buffer.alloc(0);
  let closed = false;
  return {
    observe(chunk: Buffer): void {
      if (closed) return;
      if (bytes.length + chunk.length > 256) {
        bytes = Buffer.alloc(0);
        closed = true;
        return;
      }
      bytes = Buffer.concat([bytes, chunk]);
    },
    finish(): string | null {
      const text = closed ? "" : bytes.toString("utf8");
      bytes = Buffer.alloc(0);
      closed = true;
      return text.endsWith("\n") ? member(text.slice(0, -1), dryCliErrorCodes) : null;
    },
  };
}

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
  dryCliErrorCode?: unknown,
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
    ...(dryCliErrorCode !== undefined &&
    selected === "dry-build" &&
    resultObserved &&
    typeof code === "number" &&
    code !== 0 &&
    timedOut === false
      ? { dryCliErrorCode: member(dryCliErrorCode, dryCliErrorCodes) }
      : {}),
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
  dryCliErrorCode?: unknown,
): void {
  try {
    process.stderr.write(
      `${distributionInstallFailureLine(phase, packageName, error, result, dryCliErrorCode)}\n`,
    );
  } catch {}
}
