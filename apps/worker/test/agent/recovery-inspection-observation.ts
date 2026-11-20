const phases = new Set([
  "state-fetch",
  "pi-start",
  "host-start",
  "state-handler",
  "state-admissions",
  "state-creations",
  "state-admission-intents",
  "state-pi-open",
  "state-conversation-scan",
  "state-response",
  "pi-ready",
  "pi-last-close",
  "pi-session-store",
  "pi-harness-factory",
  "pi-root",
  "pi-resume",
  "pi-open-timer",
  "pi-open-wake",
  "pi-factory-store",
  "pi-factory-models",
  "pi-factory-harness",
  "recovery-job-drain",
  "drain-controls",
  "drain-reconciliation",
  "drain-fresh-jobs",
  "drain-dispatch",
  "drain-projection",
  "drain-exports",
  "chord-transaction-request",
  "chord-queue-operation",
  "chord-storage-callback",
  "pi-commit-transaction",
  "pi-commit-publication",
  "router-state-ingress",
  "api-state-fetch-enter",
  "api-state-headers",
  "storage-observation-limit",
]);

export function recoveryInspectionLine(phase: unknown, event: unknown): string | null {
  if (typeof phase !== "string" || !phases.has(phase) || (event !== "enter" && event !== "exit"))
    return null;
  return JSON.stringify({ diagnostic: "recovery-inspection", phase, event });
}

export function recoveryInspectionRecord(line: unknown): string | null {
  if (typeof line !== "string" || line.length > 128) return null;
  try {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(",") !== "diagnostic,event,phase" ||
      record.diagnostic !== "recovery-inspection"
    )
      return null;
    const projected = recoveryInspectionLine(record.phase, record.event);
    // Exact canonical bytes reject duplicate keys, whitespace and hidden fields.
    return projected === line ? projected : null;
  } catch {
    return null;
  }
}

export function observeRecoveryInspection(
  phase: unknown,
  event: unknown,
  emit: (line: string) => void = console.log,
): void {
  try {
    const line = recoveryInspectionLine(phase, event);
    if (line) emit(line);
  } catch {
    /* Observation cannot replace the original return or rejection. */
  }
}
