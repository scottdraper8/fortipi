const stages = new Set([
  "distribution-install",
  "supply-chain",
  "compatibility-review",
  "image-security",
  "measurement-sensitivity",
  "admission-durability",
  "pi-lifecycle",
  "infrastructure-boundaries",
  "application-replay",
  "replay-live-race",
  "ticket-grants-revoke",
  "fence-generation",
  "workspace-atomicity",
  "local-apply-receipt",
  "device-replacement",
  "sealed-store-retirement",
  "local-infrastructure-details",
  "native-consent-and-receipt",
  "scoped-relay",
  "dispatch-safety",
  "approval-reconcile",
  "models-security",
  "installed-tui-pty",
  "installed-node-client",
  "installed-browser",
  "independent-python",
  "public-clients",
  "installed-integrity",
  "checkout-integrity",
  "producer-integrity",
  "write-evidence",
  "cli-return",
]);
const browserStages = new Set([
  "inputs",
  "serve-https-origins",
  "start-real-wrangler-https",
  "public-provision",
  "chromium-public-flow-cors-revoke",
  "chromium-launch",
  "allowed-https-navigation",
  "public-flow",
  "actual-preflight",
  "unallowlisted-https-navigation",
  "browser-cors-denial",
  "acknowledged-browser-revocation",
  "browser-revocation-arm",
  "browser-revocation-revoke",
  "browser-revocation-check",
  "browser-finalization",
  "browser-cleanup",
  "browser-postchecks",
  "browser-runtime-cleanup",
  "public-role-cleanup",
  "cleanup",
  "complete",
]);
export const browserDiagnosticPhases = [
  "negotiate",
  "original-snapshot",
  "first-subscribe",
  "first-send",
  "first-task-observe",
  "first-receipt-retry",
  "second-client-subscribe",
  "offline-send",
  "offline-observer-close",
  "offline-task-observe",
  "offline-stored-replay",
  "original-client-resume",
  "final-snapshot",
  "revocation-arm",
  "revocation-ready",
  "revocation-close-wait",
  "revocation-authority-refusal",
  "revocation-read",
  "revocation-read-status",
  "revocation-subscription-cleanup",
  "revocation-complete",
] as const;
export type BrowserDiagnosticPhase = (typeof browserDiagnosticPhases)[number];
const publicPhases = new Set<string>(browserDiagnosticPhases);
export function browserDiagnosticPhase(value: unknown): BrowserDiagnosticPhase | undefined {
  return typeof value === "string" && publicPhases.has(value)
    ? (value as BrowserDiagnosticPhase)
    : undefined;
}
const errorClasses = new Set([
  "Error",
  "AssertionError",
  "TimeoutError",
  "FortiPiError",
  "UnknownFailure",
  "CleanupFailure",
  "IncompleteRevocation",
]);
export const browserDiagnosticCodes = [
  "quota_exceeded",
  "quota_paused",
  "rate_limited",
  "unauthorized",
  "unauthenticated",
  "handshake_failed",
  "smoke_deadline",
  "invalid_endpoint",
  "unsafe_reference",
  "incompatible_protocol",
  "invalid_credential",
  "redirect_rejected",
  "payload_too_large",
  "transport",
  "timeout",
  "aborted",
  "invalid_ticket",
  "scope_mismatch",
  "handler_failed",
  "invalid_wire",
  "invalid_replay",
  "unstable_credential_scope",
  "cursor.expired",
  "resync_required",
  "event_gap",
  "cursor.invalid",
  "conflicting_event_identity",
  "handshake_timeout",
  "subscribe_timeout",
  "stream_overflow",
  "offline",
  "disconnected",
  "closed",
] as const;
export type BrowserDiagnosticCode = (typeof browserDiagnosticCodes)[number];
export interface BrowserDiagnostic {
  phase: BrowserDiagnosticPhase | null;
  code: BrowserDiagnosticCode | null;
  status: number | null;
  completionDeadline: boolean | null;
}
const codes = new Set<string>(browserDiagnosticCodes);
const outcomes = new Set(["pass", "fail", "timeout", "unavailable"]);
function own(value: unknown, key: string): unknown {
  try {
    return value && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, key)?.value
      : undefined;
  } catch {
    return undefined;
  }
}
const member = (value: unknown, set: Set<string>) =>
  typeof value === "string" && set.has(value) ? value : null;
export function browserFailure(error: unknown): { errorClass: string; errorCode?: string } {
  let errorClass = "UnknownFailure";
  let errorCode: string | undefined;
  try {
    if (error instanceof Error) {
      errorClass = member(own(error, "name"), errorClasses) ?? "Error";
      const message = own(error, "message");
      errorCode =
        typeof message === "string"
          ? message.match(
              /\b(?:quota_exceeded|quota_paused|rate_limited|unauthorized|unauthenticated|handshake_failed|smoke_deadline)\b/,
            )?.[0]
          : undefined;
    }
  } catch {}
  return { errorClass, ...(errorCode ? { errorCode } : {}) };
}
const boolean = (value: unknown) => (typeof value === "boolean" ? value : null);
const integer = (value: unknown, min: number, max: number) =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null;
export function projectBrowserDiagnostic(value: unknown): BrowserDiagnostic {
  const code = own(value, "code");
  return {
    phase: browserDiagnosticPhase(own(value, "phase")) ?? null,
    code: typeof code === "string" && codes.has(code) ? (code as BrowserDiagnosticCode) : null,
    status: integer(own(value, "status"), 100, 599),
    completionDeadline: boolean(own(value, "completionDeadline")),
  };
}
export function localEvidenceLine(
  stage: unknown,
  event: unknown,
  elapsedMs: unknown,
  outcome: unknown,
) {
  return JSON.stringify({
    diagnostic: "local-evidence-phase",
    stage: member(stage, stages),
    event: member(event, new Set(["enter", "exit"])),
    elapsedMs:
      typeof elapsedMs === "number" && Number.isFinite(elapsedMs)
        ? Math.min(900000, Math.max(0, Math.round(elapsedMs)))
        : 0,
    outcome: member(outcome, outcomes),
  });
}
export function localBrowserLine(event: unknown, result: unknown, observed: unknown) {
  const diagnostic = own(observed, "diagnostic");
  return JSON.stringify({
    diagnostic: "local-browser-observation",
    event: member(event, new Set(["coordinator-return", "report"])),
    code: integer(own(result, "code"), -255, 255),
    timedOut: boolean(own(result, "timedOut")),
    stage: member(own(observed, "stage"), browserStages),
    errorClass: member(own(observed, "errorClass"), errorClasses),
    errorCode: member(own(observed, "errorCode"), codes),
    cleanupComplete: boolean(own(observed, "cleanupComplete")),
    publicPhase: member(own(diagnostic, "phase"), publicPhases),
    publicCode: member(own(diagnostic, "code"), codes),
    publicStatus: integer(own(diagnostic, "status"), 100, 599),
    completionDeadline: boolean(own(diagnostic, "completionDeadline")),
  });
}
/** Diagnostic sinks never replace the original result, assertion or error. */
export function observeLocalEvidence(
  stage: unknown,
  event: unknown,
  elapsedMs: unknown,
  outcome: unknown = null,
  emit = (line: string) => {
    process.stderr.write(line);
  },
) {
  try {
    emit(`${localEvidenceLine(stage, event, elapsedMs, outcome)}\n`);
  } catch {}
}
export function observeLocalBrowser(
  event: unknown,
  result: unknown,
  observed: unknown = null,
  emit = (line: string) => {
    process.stderr.write(line);
  },
) {
  try {
    emit(`${localBrowserLine(event, result, observed)}\n`);
  } catch {}
}
