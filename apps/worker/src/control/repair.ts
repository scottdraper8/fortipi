import type * as D from "../boundary/dto.js";
import { valid } from "./directory.js";
import { ControlError, json, type Store } from "./store.js";

interface Hold {
  kind: string;
  key: string;
  reason: "storage" | "configuration" | "retry";
  pressure: D.InfrastructurePressure;
  notBefore?: number;
  retryAfterMs: number;
}
const holdKey = (kind: string, key: string): string => json([kind, key]);

/** Only validated recipient pressure supplies timing. Storage never acquires an invented reset. */
export function postponeRepair(
  store: Store,
  kind: string,
  key: string,
  failure: unknown,
  backoffAt: number,
): boolean {
  let error: unknown = failure;
  if (failure instanceof ControlError)
    error = {
      code: failure.code,
      message: failure.message,
      requestId: "repair",
      retryable: true,
      details: failure.details,
    };
  else if (failure && typeof failure === "object" && "ok" in failure) {
    const { ok, ...body } = failure;
    if (ok !== false) return false;
    error = body;
  }
  if (!valid("common", "ProtocolError", error)) return false;
  const typed = error as D.ProtocolError;
  if (
    (typed.code !== "quota_paused" && typed.code !== "quota_exceeded") ||
    !typed.details?.pressure
  )
    return false;
  const pressure = typed.details.pressure;
  const reason =
    pressure.resource === "storage" || pressure.action === "reclaim-storage"
      ? "storage"
      : pressure.action === "configure-capability"
        ? "configuration"
        : "retry";
  const retryAfterMs = typed.details.retryAfterMs ?? 0;
  const prior = store.get<Hold>("repair_hold", holdKey(kind, key));
  const notBefore =
    reason === "retry"
      ? Math.min(
          Number.MAX_SAFE_INTEGER,
          Math.max(
            backoffAt,
            Date.now() + retryAfterMs,
            pressure.retryAt ?? 0,
            pressure.source === "provider" ? (pressure.resetAt ?? 0) : 0,
            prior?.notBefore ?? 0,
          ) + Math.floor(Math.random() * 250),
        )
      : undefined;
  const hold: Hold = {
    kind,
    key,
    reason,
    retryAfterMs,
    pressure: {
      ...pressure,
      reason:
        reason === "storage"
          ? "Recipient storage requires confirmed reclamation or configuration"
          : reason === "configuration"
            ? "Recipient requires configuration"
            : "Recipient reported bounded infrastructure pressure",
    },
    ...(notBefore === undefined ? {} : { notBefore }),
  };
  store.put("repair_hold", holdKey(kind, key), hold, kind);
  store.reschedule(kind, key, notBefore ?? null);
  return true;
}
export function repairEligible(store: Store, kind: string, key: string): boolean {
  const hold = store.get<Hold>("repair_hold", holdKey(kind, key));
  if (!hold) return true;
  if (hold.notBefore !== undefined && hold.notBefore <= Date.now()) return true;
  store.reschedule(kind, key, hold.notBefore ?? null);
  return false;
}
export function repairAccepted(store: Store, kind: string, key: string): void {
  store.remove("repair_hold", holdKey(kind, key));
}
export function queueRepairResume(store: Store, cause: "configuration" | "reclaimed"): void {
  store.put("repair_resume", "control", { cursor: 0, cause }, "", "", Date.now());
}
export function drainRepairResume(store: Store): void {
  const pending = store.get<{ cursor: number; cause: string }>("repair_resume", "control");
  if (!pending) return;
  const rows = store.page<Hold>("repair_hold", pending.cursor, 16);
  store.tx(() => {
    for (const row of rows) {
      if (row.value.reason !== "retry") {
        store.reschedule(row.value.kind, row.value.key, Date.now());
        store.remove("repair_hold", row.key);
      }
      pending.cursor = row.seq;
    }
    if (rows.length === 16)
      store.put("repair_resume", "control", pending, "", "", Date.now() + 250);
    else store.remove("repair_resume", "control");
  });
}
