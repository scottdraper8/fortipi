import { check, id, Lanes, ServiceError } from "../api/common.js";
import { boundedJson, validate } from "../api/validation.js";
import type * as D from "../boundary/dto.js";
import type { StorageSampleInput, StorageSampleReceipt } from "../boundary/infrastructure.js";
import type { Authority } from "./authority.js";
import type { Sql, Store } from "./store.js";

interface Report {
  input: StorageSampleInput;
  receipt?: StorageSampleReceipt;
}

/** Public SQLite observations, independent of per-operation settlement estimates. */
export class PhysicalStorage {
  readonly #lanes = new Lanes();
  readonly store: Store;
  readonly authority: Pick<Authority, "current">;
  readonly control: { fetch(request: Request): Promise<Response> };
  constructor(
    store: Store,
    authority: Pick<Authority, "current">,
    control: { fetch(request: Request): Promise<Response> },
  ) {
    this.store = store;
    this.authority = authority;
    this.control = control;
  }

  /** Call only AFTER the matching consumed settlement has been acknowledged by CP. */
  async completed(reservationId: string, tx?: Sql): Promise<void> {
    await this.store.put("storage-completed", reservationId, { reservationId }, tx);
  }

  async beforeGrowth(auth: D.AuthContext, resources: D.ResourceScope): Promise<void> {
    await this.#lanes.run("sample", async () => {
      await this.authority.current(auth, resources);
      const report = await this.store.transaction(async (tx) => {
        await this.authority.current(auth, resources, tx);
        const pending = await this.store.get<Report>("meta", "storage-report", tx);
        // A lost response retries the identical observation, not a newer timestamp.
        // An older unacknowledged observation is superseded by a NEW sequence;
        // its uncertain CP outcome never becomes a local coverage acknowledgement.
        if (pending && !pending.receipt && Date.now() - pending.input.observedAt < 10000)
          return pending;
        const completed = await tx.all<{ id: string }>(
          "SELECT id FROM fp_records_v1 WHERE kind='storage-completed' ORDER BY id LIMIT 100",
        );
        const sequence = (await this.store.get<number>("meta", "storage-sequence", tx)) ?? 0;
        check(sequence < Number.MAX_SAFE_INTEGER, "interrupted", "Storage sequence exhausted");
        const input: StorageSampleInput = {
          sampleId: id(),
          policyVersion: this.store.policy.version,
          sampleSeq: sequence + 1,
          observedAt: Date.now(),
          coverage: { kind: "agent", bytes: this.store.physicalBytes() },
          coveredReservationIds: completed.map((row) => row.id),
        };
        const next: Report = { input };
        await this.store.put("meta", "storage-sequence", input.sampleSeq, tx);
        await this.store.put("meta", "storage-report", next, tx);
        await this.authority.current(auth, resources, tx);
        return next;
      });
      await this.authority.current(auth, resources);
      const signal = AbortSignal.timeout(Math.max(1, Math.min(10000, auth.deadline - Date.now())));
      // This is an ordinary physical CP admission. A rate limit holds NEW growth;
      // it neither consumes repair headroom nor erases existing receipts/claims.
      const response = await this.control.fetch(
        new Request("https://control.internal/internal/storage-sample", {
          method: "POST",
          headers: { "X-Fortipi-Context": JSON.stringify(auth) },
          body: JSON.stringify(report.input),
          signal,
        }),
      );
      const body: unknown = await boundedJson(
        { body: response.body, signal },
        65536,
        auth.deadline,
      );
      await this.authority.current(auth, resources);
      check(body && typeof body === "object", "unavailable", "Storage sample unavailable");
      if ("error" in body) {
        const error: unknown = body.error;
        validate<D.ProtocolError>("ProtocolError", error);
        throw new ServiceError(error.code, error.message, error.details, error.retryable);
      }
      check(response.ok && "ok" in body, "unavailable", "Storage sample unavailable");
      if (body.ok === false) {
        const { ok: _ok, ...error } = body;
        validate<D.ProtocolError>("ProtocolError", error);
        throw new ServiceError(error.code, error.message, error.details, error.retryable);
      }
      check(body.ok === true && "value" in body, "unavailable", "Storage sample unavailable");
      const value = body.value;
      check(
        value &&
          typeof value === "object" &&
          Object.keys(value).sort().join(",") === "chargeBytes,sampleSeq" &&
          "sampleSeq" in value &&
          value.sampleSeq === report.input.sampleSeq &&
          "chargeBytes" in value &&
          typeof value.chargeBytes === "number" &&
          Number.isSafeInteger(value.chargeBytes) &&
          value.chargeBytes >= 0,
        "unavailable",
        "Storage sample receipt mismatch",
      );
      const receipt: StorageSampleReceipt = {
        sampleSeq: value.sampleSeq,
        chargeBytes: value.chargeBytes,
      };
      await this.store.transaction(async (tx) => {
        await this.authority.current(auth, resources, tx);
        const current = await this.store.get<Report>("meta", "storage-report", tx);
        check(
          current?.input.sampleId === report.input.sampleId,
          "conflict",
          "Storage sample superseded",
        );
        await this.store.put("meta", "storage-report", { input: report.input, receipt }, tx);
        for (const reservationId of report.input.coveredReservationIds)
          await this.store.remove("storage-completed", reservationId, tx);
        await this.authority.current(auth, resources, tx);
      });
      await this.authority.current(auth, resources);
    });
  }
}
