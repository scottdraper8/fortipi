import type { Lifecycle, LifecycleJobContext, LifecycleJobOutcome } from "agents/lifecycle";
import { check, Lanes, pressure } from "../api/common.js";
import type * as D from "../boundary/dto.js";
import type { Store } from "./store.js";

interface RepairState {
  generation: number;
  id: string;
  armPending: boolean;
  running: boolean;
  stamp: number;
  predecessor?: string;
}
/** Lifecycle owns timing. This record is only an app intent/CAS barrier, not an alarm or scheduler. */
export class Recovery {
  readonly store: Store;
  readonly lifecycle: Lifecycle;
  readonly drain: (budget: D.DrainBudget) => Promise<D.DrainProgress>;
  private readonly lanes = new Lanes();
  constructor(
    store: Store,
    lifecycle: Lifecycle,
    drain: (budget: D.DrainBudget) => Promise<D.DrainProgress>,
  ) {
    this.store = store;
    this.lifecycle = lifecycle;
    this.drain = drain;
  }
  async arm(): Promise<void> {
    await this.lanes.run("arm", async () => {
      let state = await this.store.get<RepairState>("meta", "repair");
      const present = state ? this.lifecycle.jobs.get(state.id) : undefined;
      // Never reuse an attempted ID. A running generation or a missing acknowledged
      // row gets a persisted distinct successor before the predecessor can retire.
      if (!state || state.running || (!present && !state.armPending)) {
        const generation = ((await this.store.get<number>("meta", "repair-generation")) ?? 0) + 1;
        check(
          Number.isSafeInteger(generation),
          "quota_paused",
          "Recovery generation exhausted",
          pressure("storage", Number.MAX_SAFE_INTEGER, "Recovery generation exhausted"),
        );
        state = {
          generation,
          id: `fortipi-repair-${generation}`,
          armPending: true,
          running: false,
          stamp: (state?.stamp ?? 0) + 1,
          ...(state ? { predecessor: state.id } : {}),
        };
        await this.store.transaction(async (tx) => {
          await this.store.put("meta", "repair-generation", generation, tx);
          await this.store.put("meta", "repair", state, tx);
        });
      }
      const captured = state;
      if (!this.lifecycle.jobs.get(captured.id)) {
        check(captured.armPending, "interrupted", "Recovery arm intent missing");
        await this.lifecycle.jobs.push({
          id: captured.id,
          fn: "fortipi.repair",
          time: Date.now(),
          payload: { generation: captured.generation },
          singleflight: true,
          hungTimeoutSeconds: 15,
          recoveryLoop: true,
          retry: { maxAttempts: 1 },
        });
      } else await this.lifecycle.jobs.rearm();
      if (captured.predecessor) await this.lifecycle.jobs.cancel(captured.predecessor);
      if (captured.armPending)
        await this.store.transaction(async (tx) => {
          const latest = await this.store.get<RepairState>("meta", "repair", tx);
          if (latest?.id === captured.id && latest.armPending) {
            latest.armPending = false;
            delete latest.predecessor;
            await this.store.put("meta", "repair", latest, tx);
          }
        });
    });
  }
  async start(): Promise<void> {
    const state = await this.store.get<RepairState>("meta", "repair");
    const kinds = [
      "admission",
      "creation",
      "export-work",
      "dirty",
      "control",
      "reconciliation",
      "fresh-job",
      "terminal-notification",
      "job-cleanup",
    ];
    let pending = !!state;
    for (const kind of kinds)
      if ((await this.store.page(kind, 1, "", Date.now())).length) pending = true;
    if (pending) await this.arm();
  }
  async job(context: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    if (context.job.fn !== "fortipi.repair") return;
    let state = await this.store.get<RepairState>("meta", "repair");
    if (!state || state.id !== context.job.id) return;
    if (state.running) {
      // Same-generation overlap/hung takeover must first arm a distinct successor.
      await this.arm();
      return;
    }
    const current = this.lifecycle.jobs.get(state.id);
    if (current && current.time > context.job.time && current.time > Date.now())
      return { rescheduleAt: current.time };
    const captured = state.id;
    await this.store.transaction(async (tx) => {
      const latest = await this.store.get<RepairState>("meta", "repair", tx);
      check(latest?.id === captured && !latest.running, "conflict", "Repair ownership transferred");
      latest.running = true;
      await this.store.put("meta", "repair", latest, tx);
    });
    let progress: D.DrainProgress;
    try {
      progress = await this.drain({ maxItems: 16, deadline: Date.now() + 10000 });
    } catch {
      progress = { processed: 0, remaining: true, nextWakeAt: Date.now() + 30000 };
    }
    state = await this.store.get<RepairState>("meta", "repair");
    if (state?.id !== captured) return;
    return this.store.transaction(async (tx) => {
      const latest = await this.store.get<RepairState>("meta", "repair", tx);
      if (latest?.id !== captured) return;
      if (progress.remaining) {
        latest.running = false;
        await this.store.put("meta", "repair", latest, tx);
        return { rescheduleAt: progress.nextWakeAt ?? Date.now() + 5000 };
      }
      await this.store.remove("meta", "repair", tx);
      return;
    });
  }
}
