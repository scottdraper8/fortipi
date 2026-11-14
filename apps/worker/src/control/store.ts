import { canonicalJson, freeInfrastructurePolicy, incrementSafe } from "fortipi-contract";
import type * as D from "../boundary/dto.js";

export class ControlError extends Error {
  readonly code: D.ErrorCode;
  readonly details: D.ErrorDetails | undefined;
  constructor(code: D.ErrorCode, message: string, details?: D.ErrorDetails) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
export function fail(code: D.ErrorCode, message: string, details?: D.ErrorDetails): never {
  throw new ControlError(code, message, details);
}
export function check(
  value: unknown,
  code: D.ErrorCode,
  message: string,
  details?: D.ErrorDetails,
): asserts value {
  if (!value) fail(code, message, details);
}
export async function within<T>(work: Promise<T>, milliseconds = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new ControlError("unavailable", "Recipient deadline exceeded")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export const id = (): string => crypto.randomUUID().replaceAll("-", "");
export const json = (value: unknown): string => canonicalJson(value);
export async function hash(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
}
export const next = incrementSafe;
export function ref(ctx: D.CredentialRef): D.CredentialRef {
  return {
    credentialId: ctx.credentialId,
    generation: ctx.generation,
    grantVersion: ctx.grantVersion,
  };
}
export function same(a: unknown, b: unknown): boolean {
  return json(a) === json(b);
}
export function success<T>(value: T): D.Outcome<T> {
  return { ok: true, value };
}
export async function outcome<T>(requestId: string, fn: () => Promise<T>): Promise<D.Outcome<T>> {
  try {
    return success(await fn());
  } catch (e) {
    const known = e instanceof ControlError;
    const code = known ? e.code : "internal";
    const details = known ? e.details : undefined;
    // Quota envelopes have mandatory pressure fields; provider errors are sanitized.
    if (code === "quota_exceeded" || code === "quota_paused")
      return {
        ok: false,
        code,
        message: known ? e.message : "Capacity unavailable",
        requestId,
        retryable: details?.pressure?.action === "retry-later",
        details: {
          ...details,
          retryAfterMs: details?.retryAfterMs ?? 60000,
          pressure: details?.pressure ?? {
            resource: "storage",
            scope: { kind: "install" },
            source: "policy",
            measurement: "estimated",
            reason: "Reserved capacity including repair headroom exhausted",
            action: "reclaim-storage",
          },
        },
      };
    if (code === "rate_limited")
      return {
        ok: false,
        code,
        message: "Request rate exceeded",
        requestId,
        retryable: true,
        details: { retryAfterMs: 60000 },
      };
    const message = known ? e.message : "Control operation failed";
    if (code === "unavailable" || code === "unavailable_executor")
      return {
        ok: false,
        code,
        message,
        requestId,
        retryable: true,
        details: { ...details, retryAfterMs: details?.retryAfterMs ?? 5000 },
      };
    if (code === "conflict" || code === "workspace.conflict" || code === "interrupted")
      return {
        ok: false,
        code,
        message,
        requestId,
        retryable: false,
        details: {
          ...details,
          reason:
            details?.reason ?? (code === "interrupted" ? "uncertain_effects" : "digest_mismatch"),
        },
      };
    return {
      ok: false,
      code,
      message,
      requestId,
      retryable: false,
      ...(details ? { details } : {}),
    };
  }
}
export interface Stored<T> {
  seq: number;
  key: string;
  value: T;
  subject: string;
  recipient: string;
  due: number | null;
}
/** Indexed documents share one migration and synchronous SQLite transaction boundary. No bytes/secrets belong here. */
export class Store {
  private alarmVersion = 0;
  readonly storage: DurableObjectStorage;
  readonly admissionBytes: number;
  constructor(
    storage: DurableObjectStorage,
    admissionBytes = freeInfrastructurePolicy.bounds.objectBytes *
      (1 - freeInfrastructurePolicy.bounds.headroomFraction),
  ) {
    this.storage = storage;
    this.admissionBytes = admissionBytes;
    storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS cp_schema (version INTEGER PRIMARY KEY CHECK(version=1))`,
    );
    storage.sql.exec(`INSERT OR IGNORE INTO cp_schema VALUES (1)`);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS cp_records (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '', recipient TEXT NOT NULL DEFAULT '', due INTEGER,
      UNIQUE(kind,key))`);
    storage.sql.exec(`CREATE INDEX IF NOT EXISTS cp_kind_page ON cp_records(kind,seq)`);
    storage.sql.exec(`CREATE INDEX IF NOT EXISTS cp_subject_page ON cp_records(kind,subject,seq)`);
    storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS cp_recipient_page ON cp_records(kind,recipient,seq)`,
    );
    storage.sql.exec(`CREATE INDEX IF NOT EXISTS cp_due ON cp_records(due) WHERE due IS NOT NULL`);
  }
  tx<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }
  get<T>(kind: string, key: string): T | undefined {
    const row = this.storage.sql
      .exec<{ value: string }>("SELECT value FROM cp_records WHERE kind=? AND key=?", kind, key)
      .toArray()[0];
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  put(
    kind: string,
    key: string,
    value: unknown,
    subject = "",
    recipient = "",
    due: number | null = null,
  ): void {
    const encoded = json(value);
    const bytes = new TextEncoder().encode(encoded).length;
    check(bytes <= 1048576, "payload_too_large", "Record too large");
    const admissions = [
      "credential",
      "issuance",
      "agent",
      "ticket",
      "recipient",
      "executor_recipient",
      "registration_key",
      "reservation",
      "reservation_id",
      "workspace_lease_request",
      "lease",
      "capacity_request",
      "capacity_reservation",
      "storage_allocation",
      "storage_sample",
      "binding_request",
      "binding_pending",
      "provider_request",
      "transfer",
      "local_transport",
      "local_read",
      "local_prepared",
      "local_apply",
      "command",
      "admin_job",
      "admin_request",
      "admin_artifact",
    ];
    if (
      admissions.includes(kind) &&
      this.storage.sql
        .exec<{ present: number }>(
          "SELECT 1 present FROM cp_records WHERE kind=? AND key=?",
          kind,
          key,
        )
        .toArray().length === 0
    )
      check(
        this.storage.sql.databaseSize + bytes * 3 + 4096 <= this.admissionBytes,
        "quota_exceeded",
        "Control storage admission preserves repair headroom",
      );
    this.storage.sql.exec(
      `INSERT INTO cp_records(kind,key,value,subject,recipient,due) VALUES(?,?,?,?,?,?)
      ON CONFLICT(kind,key) DO UPDATE SET value=excluded.value,subject=excluded.subject,recipient=excluded.recipient,due=excluded.due`,
      kind,
      key,
      encoded,
      subject,
      recipient,
      due,
    );
  }
  remove(kind: string, key: string): void {
    this.storage.sql.exec("DELETE FROM cp_records WHERE kind=? AND key=?", kind, key);
  }
  reschedule(kind: string, key: string, due: number | null): void {
    this.storage.sql.exec("UPDATE cp_records SET due=? WHERE kind=? AND key=?", due, kind, key);
  }
  page<T>(
    kind: string,
    after = 0,
    limit = 16,
    filter?: { subject?: string; recipient?: string },
  ): Stored<T>[] {
    const field =
      filter?.subject !== undefined
        ? "subject"
        : filter?.recipient !== undefined
          ? "recipient"
          : undefined;
    const rows = this.storage.sql.exec<{
      seq: number;
      key: string;
      value: string;
      subject: string;
      recipient: string;
      due: number | null;
    }>(
      `SELECT seq,key,value,subject,recipient,due FROM cp_records WHERE kind=? AND seq>?${field ? ` AND ${field}=?` : ""} ORDER BY seq LIMIT ?`,
      kind,
      after,
      ...(field ? [filter?.[field] ?? ""] : []),
      Math.min(100, limit),
    );
    return rows.toArray().map((r) => ({ ...r, value: JSON.parse(r.value) as T }));
  }
  maxSeq(): number {
    return this.storage.sql
      .exec<{ n: number }>("SELECT COALESCE(MAX(seq),0) n FROM cp_records")
      .one().n;
  }
  due(now: number, limit = 16): { kind: string; key: string }[] {
    return this.storage.sql
      .exec<{ kind: string; key: string }>(
        "SELECT kind,key FROM cp_records WHERE due<=? ORDER BY due LIMIT ?",
        now,
        limit,
      )
      .toArray();
  }
  nextDue(): number | undefined {
    const due =
      this.storage.sql
        .exec<{ n: number | null }>("SELECT MIN(due) n FROM cp_records WHERE due IS NOT NULL")
        .one().n ?? undefined;
    return due === undefined
      ? undefined
      : Math.max(due, this.get<{ until: number }>("repair_pause", "control")?.until ?? 0);
  }
  async arm(at = Date.now() + 1000): Promise<number> {
    this.alarmVersion = next(this.alarmVersion);
    const version = this.alarmVersion;
    const current = await this.storage.getAlarm();
    if (current === null || current > at) await this.storage.setAlarm(at);
    return version;
  }
  async rearm(): Promise<void> {
    const due = this.nextDue();
    if (due !== undefined) await this.arm(Math.max(Date.now() + 250, due));
  }
  async finishAlarm(version = this.alarmVersion): Promise<void> {
    if (version !== this.alarmVersion) {
      await this.rearm();
      return;
    }
    const due = this.nextDue();
    const current = await this.storage.getAlarm();
    if (version !== this.alarmVersion) {
      await this.rearm();
      return;
    }
    if (due === undefined) {
      if (current !== null) await this.storage.deleteAlarm();
    } else {
      const desired = Math.max(Date.now() + 250, due);
      if (current !== desired) await this.storage.setAlarm(desired);
    }
  }
}
