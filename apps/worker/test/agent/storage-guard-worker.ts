import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineDoc, Harness, type Storage } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { freeInfrastructurePolicy } from "fortipi-contract";
import { Store } from "../../src/agent/store.js";
import { guardPiStorage, PhysicalCeiling } from "./rejected-storage-guard.js";

const doc = defineDoc({
  kind: "fortipi.storage-guard-probe",
  version: 1,
  scope: "session",
  initial: () => ({ value: "" }),
  checkpointWhen: () => true,
});
/** Test-only runtime. No production caller or residual/init bound claim. */
export class StorageGuardProbe extends DurableObject {
  readonly lifecycle = Lifecycle.install(this);
  readonly ceiling = new PhysicalCeiling(this.ctx.storage, 524288);
  readonly store = new Store(this.ctx.storage, freeInfrastructurePolicy);
  #barrier:
    | {
        entered: ReturnType<typeof Promise.withResolvers<void>>;
        release: ReturnType<typeof Promise.withResolvers<void>>;
      }
    | undefined;
  #publications = 0;
  readonly pi = new PiHarness({
    harness: async ({ storage, context, onWake }) => {
      await this.store.open();
      const mediated: Storage = new Proxy(storage, {
        get: (target, key) => {
          if (key === "commit")
            return async (...args: Parameters<Storage["commit"]>) => {
              const barrier = this.#barrier;
              if (barrier) {
                this.#barrier = undefined;
                barrier.entered.resolve();
                await barrier.release.promise;
              }
              return target.commit(...args);
            };
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const harness = await Harness.open(
        guardPiStorage(mediated, this.ceiling),
        { models: createModels(), registry: createRegistry(), onWake },
        context,
      );
      harness.observeCommits({
        advance: () => {
          this.#publications++;
        },
        end: () => {},
      });
      return harness;
    },
  });
  constructor(ctx: DurableObjectState, env: object) {
    super(ctx, env);
    this.lifecycle.use(this.pi);
  }
  async characterize(mode: "solo" | "app" | "lifecycle") {
    await this.lifecycle.start();
    const harness = await this.pi.pi();
    await harness.commit(async (tx) => {
      const state = await tx.doc(doc);
      state.value = "retained-canary";
    }, BACKGROUND_CONTEXT);
    const baselineBytes = this.ctx.storage.sql.databaseSize,
      before = this.#publications;
    const barrier = {
      entered: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
    };
    this.#barrier = barrier;
    const rejected = harness
      .commit(async (tx) => {
        const state = await tx.doc(doc);
        state.value = "x".repeat(1048576);
      }, BACKGROUND_CONTEXT)
      .then(
        () => "unexpected-success",
        (error) => (error instanceof Error ? error.message : "rejected"),
      );
    await barrier.entered.promise;
    let competing = "none";
    if (mode === "app")
      competing = await this.store
        .put("guard-probe", "independent-app", { canary: "must-survive-ack" })
        .then(
          () => "acknowledged",
          () => "rejected",
        );
    if (mode === "lifecycle")
      competing = await this.lifecycle.jobs
        .push({
          id: "independent-wake",
          fn: "guard.probe",
          time: Date.now() + 60000,
          payload: { canary: "must-survive-ack" },
          retry: { maxAttempts: 1 },
        })
        .then(
          () => "acknowledged",
          () => "rejected",
        );
    barrier.release.resolve();
    const failure = await rejected,
      publications = this.#publications - before;
    await this.pi.dispose();
    const reopened = await this.pi.pi();
    const retained = await reopened.commit(
      async (tx) => (await tx.doc(doc)).value,
      BACKGROUND_CONTEXT,
    );
    const result = {
      mode,
      failure,
      competing,
      publications,
      baselineBytes,
      afterBytes: this.ctx.storage.sql.databaseSize,
      retainedCanary: retained === "retained-canary",
      appRetained: !!(await this.store.get("guard-probe", "independent-app")),
      wakeRetained: !!this.lifecycle.jobs.get("independent-wake"),
    };
    await this.lifecycle.jobs.cancel("independent-wake");
    await this.pi.dispose();
    return JSON.stringify(result);
  }
}
