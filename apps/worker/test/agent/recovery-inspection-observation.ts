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
