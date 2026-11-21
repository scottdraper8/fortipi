import type * as D from "../boundary/dto.js";
import type { StorageSampleInput, StorageSampleReceipt } from "../boundary/infrastructure.js";
import { ControlError, check, json, type Store } from "./store.js";

type Kind = "control" | "agent" | "workspace";
interface Allocation {
  kind: Kind;
  objectId: string;
  estimate: number;
  pending: number;
  measured: number;
  observedAt: number;
  sequence: number;
  census: number;
}
export const storageSampleAgeMs = 30000;
const allocationKind = "storage_allocation";
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const natural = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
function closed(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

/** Private metadata only. Validate before accepting any caller-owned property. */
export function storageSampleInput(value: unknown): StorageSampleInput {
  check(
    record(value) &&
      closed(value, [
        "sampleId",
        "policyVersion",
        "sampleSeq",
        "observedAt",
        "coverage",
        "coveredReservationIds",
      ]),
    "invalid_request",
    "Closed storage sample required",
  );
  const { sampleId, policyVersion, sampleSeq, observedAt, coverage, coveredReservationIds } = value;
  check(
    identifier(sampleId) &&
      natural(policyVersion) &&
      natural(sampleSeq) &&
      sampleSeq > 0 &&
      natural(observedAt),
    "invalid_request",
    "Invalid sample identity or clock",
  );
  check(
    record(coverage) && natural(coverage.bytes),
    "invalid_request",
    "Invalid storage observation",
  );
  check(
    Array.isArray(coveredReservationIds) &&
      coveredReservationIds.length <= 100 &&
      coveredReservationIds.every(identifier) &&
      new Set(coveredReservationIds).size === coveredReservationIds.length,
    "invalid_request",
    "Unique bounded growth claims required",
  );
  if (coverage.kind === "agent") {
    check(closed(coverage, ["kind", "bytes"]), "invalid_request", "Closed Agent coverage required");
    return {
      sampleId,
      policyVersion,
      sampleSeq,
      observedAt,
      coverage: { kind: "agent", bytes: coverage.bytes },
      coveredReservationIds,
    };
  }
  check(
    coverage.kind === "workspace" &&
      natural(coverage.censusVersion) &&
      coverage.censusVersion > 0 &&
      closed(coverage, ["kind", "bytes", "censusVersion"]),
    "invalid_request",
    "Closed Workspace census required",
  );
  return {
    sampleId,
    policyVersion,
    sampleSeq,
    observedAt,
    coverage: { kind: "workspace", bytes: coverage.bytes, censusVersion: coverage.censusVersion },
    coveredReservationIds,
  };
}

export async function readStorageSample(
  request: Request,
  deadline: number,
): Promise<StorageSampleInput> {
  check(
    request.method === "POST" && new URL(request.url).search === "",
    "invalid_request",
    "Storage sampling requires query-free POST",
  );
  const length = request.headers.get("Content-Length");
  check(
    length === null || (/^\d+$/.test(length) && Number(length) <= 65536),
    "payload_too_large",
    "Storage sample exceeds 64KiB",
  );
  check(request.body, "invalid_request", "Storage sample body required");
  check(Date.now() < deadline, "unauthenticated", "Storage sample authority expired");
  const reader = request.body.getReader();
  const boundary = new AbortController();
  const abort = () =>
    boundary.abort(new ControlError("interrupted", "Storage sample body cancelled"));
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) abort();
  const timer = setTimeout(
    () => boundary.abort(new ControlError("unauthenticated", "Storage sample authority expired")),
    deadline - Date.now(),
  );
  const read = () =>
    new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
      const stopped = () => {
        boundary.signal.removeEventListener("abort", stopped);
        reject(boundary.signal.reason);
      };
      boundary.signal.addEventListener("abort", stopped, { once: true });
      if (boundary.signal.aborted) {
        stopped();
        return;
      }
      reader.read().then(
        (value) => {
          boundary.signal.removeEventListener("abort", stopped);
          resolve(value);
        },
        (error) => {
          boundary.signal.removeEventListener("abort", stopped);
          reject(error);
        },
      );
    });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await read();
      check(!request.signal.aborted, "interrupted", "Storage sample body cancelled");
      check(Date.now() < deadline, "unauthenticated", "Storage sample authority expired");
      if (chunk.done) break;
      check(chunk.value.byteLength > 0, "invalid_request", "Storage sample body made no progress");
      size += chunk.value.byteLength;
      check(size <= 65536, "payload_too_large", "Storage sample exceeds 64KiB");
      chunks.push(chunk.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    check(false, "invalid_request", "Malformed storage sample JSON");
  }
  return storageSampleInput(value);
}

/** Coverage lives in the existing CP transaction/store; samples are not settlement receipts. */
export class StorageBudget {
  readonly controlKey: string;
  readonly store: Store;
  readonly policy: () => D.InfrastructurePolicy;
  constructor(store: Store, policy: () => D.InfrastructurePolicy, deploymentId: string) {
    this.store = store;
    this.policy = policy;
    this.controlKey = `control:${deploymentId}`;
    store.tx(() => {
      if (!store.get(allocationKind, this.controlKey)) {
        const legacy = store.get<{ reserved: number; consumed: number }>("capacity", "counters");
        store.put("storage_legacy", "bytes", (legacy?.reserved ?? 0) + (legacy?.consumed ?? 0));
        store.put(allocationKind, this.controlKey, this.initial("control", deploymentId));
      }
    });
  }
  private initial(kind: Kind, objectId: string): Allocation {
    return {
      kind,
      objectId,
      estimate:
        kind === "workspace"
          ? this.policy().bounds.workspaceBytes
          : this.policy().bounds.objectBytes,
      pending: 0,
      measured: 0,
      observedAt: 0,
      sequence: 0,
      census: 0,
    };
  }
  key(kind: Kind, objectId: string): string {
    return `${kind}:${objectId}`;
  }
  retainPolicyFloors(): void {
    const bounds = this.policy().bounds;
    this.store.storage.sql.exec(
      `UPDATE cp_records SET value=json_set(value,'$.estimate',max(json_extract(value,'$.estimate'),CASE WHEN json_extract(value,'$.kind')='workspace' THEN ? ELSE ? END)) WHERE kind=?`,
      bounds.workspaceBytes,
      bounds.objectBytes,
      allocationKind,
    );
  }
  allocation(key: string): Allocation {
    const row = this.store.get<Allocation>(allocationKind, key);
    check(row, "not_found", "Physical allocation is unavailable");
    return row;
  }
  private charge(row: Allocation): number {
    return Math.max(row.estimate, row.measured + row.pending);
  }
  usage(): { reserved: number; consumed: number; total: number } {
    const now = Date.now();
    const foreign = this.store.storage.sql
      .exec<{ total: number; observed: number }>(
        `SELECT coalesce(sum(max(json_extract(value,'$.estimate'),json_extract(value,'$.measured')+json_extract(value,'$.pending'))),0) total,
       coalesce(sum(CASE WHEN json_extract(value,'$.observedAt')>=? THEN json_extract(value,'$.measured') ELSE 0 END),0) observed
       FROM cp_records WHERE kind=? AND key<>?`,
        now - storageSampleAgeMs,
        allocationKind,
        this.controlKey,
      )
      .one();
    const control = this.allocation(this.controlKey);
    const physical = this.store.storage.sql.databaseSize;
    const total =
      foreign.total +
      Math.max(control.estimate, physical + control.pending) +
      (this.store.get<number>("storage_legacy", "bytes") ?? 0);
    const consumed = foreign.observed + physical;
    check(
      Number.isSafeInteger(total) && total >= consumed,
      "quota_exceeded",
      "Storage accounting range exhausted",
    );
    return { reserved: total - consumed, consumed, total };
  }
  pressure(): D.InfrastructurePressure[] {
    const row = this.store.storage.sql
      .exec<{ key: string }>(
        `SELECT key FROM cp_records WHERE kind=? AND key<>? AND
      (json_extract(value,'$.observedAt')<? OR json_extract(value,'$.measured')+json_extract(value,'$.pending')>=json_extract(value,'$.estimate')*?) LIMIT 1`,
        allocationKind,
        this.controlKey,
        Date.now() - storageSampleAgeMs,
        1 - this.policy().bounds.headroomFraction,
      )
      .toArray()[0];
    if (!row) return [];
    const allocation = this.allocation(row.key);
    const stale = Date.now() - allocation.observedAt > storageSampleAgeMs;
    const limit = Math.floor(allocation.estimate * (1 - this.policy().bounds.headroomFraction));
    return [
      {
        resource: "storage",
        scope: { kind: "object", id: allocation.objectId },
        source: "policy",
        measurement: stale ? "unknown" : allocation.pending > 0 ? "estimated" : "observed",
        limit,
        remaining: Math.max(0, limit - allocation.measured - allocation.pending),
        reason: stale
          ? "Recipient observation unavailable or stale; retained coverage is not fresh usage"
          : "Recipient storage reaches admission headroom",
        action: stale ? "retry-later" : "reclaim-storage",
      },
    ];
  }
  allocate(kind: "agent" | "workspace", objectId: string): string {
    const key = this.key(kind, objectId);
    if (this.store.get(allocationKind, key)) return key;
    const row = this.initial(kind, objectId);
    this.admit(undefined, row.estimate);
    this.store.put(allocationKind, key, row, `${kind}:${objectId}`);
    return key;
  }
  admit(key: string | undefined, bytes: number): void {
    const policy = this.policy();
    const usage = this.usage();
    let growth = bytes;
    if (key) {
      const retained = this.allocation(key);
      const row =
        retained.kind === "control"
          ? { ...retained, measured: this.store.storage.sql.databaseSize, observedAt: Date.now() }
          : retained;
      const scope = {
        kind: "object",
        id: row.objectId,
      } satisfies D.InfrastructurePressure["scope"];
      check(
        row.observedAt > 0 && Date.now() - row.observedAt <= storageSampleAgeMs,
        "quota_paused",
        "Fresh recipient storage observation required",
        {
          retryAfterMs: 0,
          pressure: {
            resource: "storage",
            scope,
            source: "policy",
            measurement: "unknown",
            reason:
              "Recipient observation is unavailable or stale; previous charge remains retained",
            action: "retry-later",
          },
        },
      );
      growth = this.charge({ ...row, pending: row.pending + bytes }) - this.charge(row);
      const target =
        row.kind === "workspace" ? policy.bounds.workspaceBytes : policy.bounds.objectBytes;
      check(
        row.measured + row.pending + bytes <= target * (1 - policy.bounds.headroomFraction),
        "quota_paused",
        "Recipient storage admission preserves completion headroom",
        {
          retryAfterMs: 0,
          pressure: {
            resource: "storage",
            scope,
            source: "policy",
            measurement: row.pending > 0 ? "estimated" : "observed",
            limit: Math.floor(target * (1 - policy.bounds.headroomFraction)),
            remaining: Math.max(
              0,
              Math.floor(target * (1 - policy.bounds.headroomFraction)) -
                row.measured -
                row.pending,
            ),
            reason:
              "Recipient physical usage and unspent growth reach operational admission headroom",
            action: "reclaim-storage",
          },
        },
      );
    }
    check(
      usage.total + growth <=
        Math.floor(policy.bounds.installBytes * (1 - policy.bounds.headroomFraction)) &&
        this.store.storage.sql.databaseSize <=
          policy.bounds.objectBytes * (1 - policy.bounds.headroomFraction),
      "quota_exceeded",
      "Installation storage admission exhausted",
      {
        retryAfterMs: 0,
        pressure: {
          resource: "storage",
          scope: { kind: "install" },
          source: "policy",
          measurement: "estimated",
          limit: Math.floor(policy.bounds.installBytes * (1 - policy.bounds.headroomFraction)),
          remaining: Math.max(
            0,
            Math.floor(policy.bounds.installBytes * (1 - policy.bounds.headroomFraction)) -
              usage.total,
          ),
          reason: "Allocation charges or control storage reach operational admission headroom",
          action: "reclaim-storage",
        },
      },
    );
  }
  pending(key: string, delta: number): void {
    const row = this.allocation(key);
    const pending = row.pending + delta;
    check(natural(pending), "conflict", "Invalid pending growth transition");
    this.store.put(allocationKind, key, { ...row, pending });
  }
  legacy(delta: number): void {
    const bytes = (this.store.get<number>("storage_legacy", "bytes") ?? 0) + delta;
    check(natural(bytes), "conflict", "Invalid legacy coverage transition");
    this.store.put("storage_legacy", "bytes", bytes);
  }
  sample(key: string, input: StorageSampleInput, apply: () => void): StorageSampleReceipt {
    const row = this.allocation(key);
    const cacheKey = `${key}:${input.sampleId}`;
    const old = this.store.get<{ body: string; receipt: StorageSampleReceipt }>(
      "storage_sample",
      cacheKey,
    );
    const body = json(input);
    if (old) {
      check(old.body === body, "conflict", "Sample identity changed");
      return old.receipt;
    }
    const now = Date.now();
    check(input.policyVersion === this.policy().version, "conflict", "Storage policy changed");
    check(
      input.observedAt <= now && now - input.observedAt <= storageSampleAgeMs,
      "conflict",
      "Storage sample is stale or future-dated",
    );
    check(
      input.sampleSeq > row.sequence &&
        input.observedAt >= row.observedAt &&
        (input.coverage.kind !== "workspace" || input.coverage.censusVersion > row.census),
      "conflict",
      "Storage sample sequence is stale",
    );
    apply();
    const current = this.allocation(key);
    const updated = {
      ...current,
      measured: input.coverage.bytes,
      observedAt: input.observedAt,
      sequence: input.sampleSeq,
      census: input.coverage.kind === "workspace" ? input.coverage.censusVersion : 0,
    };
    const receipt = { sampleSeq: input.sampleSeq, chargeBytes: this.charge(updated) };
    this.store.put(allocationKind, key, updated);
    this.store.put("storage_sample", cacheKey, { body, receipt });
    return receipt;
  }
}
