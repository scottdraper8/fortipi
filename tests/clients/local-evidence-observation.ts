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
  "offline-completion",
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
export const offlineConnectionStatuses = [
  "connecting",
  "online",
  "offline",
  "reconnecting",
  "resyncing",
  "paused",
  "closed",
] as const;
export const offlineSettlements = ["pending", "fulfilled", "rejected"] as const;
export const offlineTaskStates = [
  "idle",
  "queued",
  "running",
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "waiting",
] as const;
export interface OfflineCompletionDiagnostic {
  // These seven facts are frozen at the failed wait, before reads or cleanup.
  status: (typeof offlineConnectionStatuses)[number] | null;
  settlement: (typeof offlineSettlements)[number] | null;
  statusError: boolean | null;
  snapshots: number | null;
  matched: boolean | null;
  lastErrorCode: string | null;
  lastErrorStatus: number | null;
  // These are later, non-atomic public reads, not facts at the cutoff.
  taskRead: boolean | null;
  taskState: (typeof offlineTaskStates)[number] | null;
  eventsRead: boolean | null;
  canonicalMatch: boolean | null;
  hasMore: boolean | null;
  complete: boolean | null;
  elapsedMs: number | null;
}
export interface BrowserDiagnostic {
  phase: BrowserDiagnosticPhase | null;
  code: BrowserDiagnosticCode | null;
  status: number | null;
  completionDeadline: boolean | null;
  offlineCompletion?: OfflineCompletionDiagnostic;
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
function projectOfflineCompletion(value: unknown): OfflineCompletionDiagnostic | undefined {
  if (!value || typeof value !== "object") return undefined;
  const status = own(value, "status"),
    settlement = own(value, "settlement"),
    taskState = own(value, "taskState");
  return {
    status:
      typeof status === "string" && offlineConnectionStatuses.some((v) => v === status)
        ? (status as OfflineCompletionDiagnostic["status"])
        : null,
    settlement:
      typeof settlement === "string" && offlineSettlements.some((v) => v === settlement)
        ? (settlement as OfflineCompletionDiagnostic["settlement"])
        : null,
    statusError: boolean(own(value, "statusError")),
    snapshots: integer(own(value, "snapshots"), 0, 1000),
    matched: boolean(own(value, "matched")),
    lastErrorCode: member(own(value, "lastErrorCode"), codes),
    lastErrorStatus: integer(own(value, "lastErrorStatus"), 100, 599),
    taskRead: boolean(own(value, "taskRead")),
    taskState:
      typeof taskState === "string" && offlineTaskStates.some((v) => v === taskState)
        ? (taskState as OfflineCompletionDiagnostic["taskState"])
        : null,
    eventsRead: boolean(own(value, "eventsRead")),
    canonicalMatch: boolean(own(value, "canonicalMatch")),
    hasMore: boolean(own(value, "hasMore")),
    complete: boolean(own(value, "complete")),
    elapsedMs: integer(own(value, "elapsedMs"), 0, 60000),
  };
}
export function projectBrowserDiagnostic(value: unknown): BrowserDiagnostic {
  const code = own(value, "code");
  const offlineCompletion = projectOfflineCompletion(own(value, "offlineCompletion"));
  return {
    phase: browserDiagnosticPhase(own(value, "phase")) ?? null,
    code: typeof code === "string" && codes.has(code) ? (code as BrowserDiagnosticCode) : null,
    status: integer(own(value, "status"), 100, 599),
    completionDeadline: boolean(own(value, "completionDeadline")),
    ...(offlineCompletion ? { offlineCompletion } : {}),
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
  const offlineCompletion = projectOfflineCompletion(own(diagnostic, "offlineCompletion"));
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
    ...(offlineCompletion ? { offlineCompletion } : {}),
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
