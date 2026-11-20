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
  "public-role-cleanup",
  "cleanup",
  "complete",
]);
const publicPhases = new Set([
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
]);
const errorClasses = new Set([
  "Error",
  "AssertionError",
  "TimeoutError",
  "FortiPiError",
  "UnknownFailure",
  "CleanupFailure",
  "IncompleteRevocation",
]);
const codes = new Set([
  "quota_exceeded",
  "quota_paused",
  "rate_limited",
  "unauthorized",
  "unauthenticated",
  "handshake_failed",
  "smoke_deadline",
]);
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
const boolean = (value: unknown) => (typeof value === "boolean" ? value : null);
const integer = (value: unknown, min: number, max: number) =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null;
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
