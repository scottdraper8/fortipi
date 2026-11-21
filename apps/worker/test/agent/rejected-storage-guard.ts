import type { Storage } from "@earendil-works/pi-durable";
import { check } from "../../src/api/common.js";

/** REJECTED test spike: its outer rollback erases acknowledged competing writes. */
export class PhysicalCeiling {
  readonly storage: DurableObjectStorage;
  readonly limit: number;
  constructor(storage: DurableObjectStorage, limit: number) {
    check(
      Number.isSafeInteger(limit) && limit > 0,
      "invalid_request",
      "Invalid physical storage ceiling",
    );
    this.storage = storage;
    this.limit = limit;
  }
  assert(): void {
    const observed = this.storage.sql.databaseSize;
    check(observed <= this.limit, "quota_paused", "Guarded SQL storage ceiling reached", {
      pressure: {
        resource: "storage",
        scope: { kind: "object" },
        source: "policy",
        measurement: "observed",
        limit: this.limit,
        remaining: Math.max(0, this.limit - observed),
        reason: "Guarded SQL storage ceiling reached",
        action: "reclaim-storage",
      },
    });
  }
}

/** Characterization only. Never import into the production service. */
export function guardPiStorage(original: Storage, ceiling: PhysicalCeiling): Storage {
  const commit: Storage["commit"] = async (batches, receive, context) => {
    const receipts: Parameters<Parameters<Storage["commit"]>[1]>[] = [];
    const result = await ceiling.storage.transaction(async () => {
      const committed = await original.commit(
        batches,
        (index, seq) => {
          receipts.push([index, seq]);
        },
        context,
      );
      ceiling.assert();
      return committed;
    });
    // These are durability receipts. No caller sees them until the outer
    // transaction has committed; Session publication follows its normal API.
    for (const [index, seq] of receipts) receive(index, seq);
    return result;
  };
  return new Proxy(original, {
    get(target, key) {
      if (key === "commit") return commit;
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
