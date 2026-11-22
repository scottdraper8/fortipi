import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineDoc, Harness, type Storage } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { freeInfrastructurePolicy } from "fortipi-contract";
import { piStorageWatermark } from "../../src/agent/pi-storage.js";
import { Store } from "../../src/agent/store.js";

export { ControlPlane, TestAgentSession, WorkspaceObject } from "./runtime-worker.js";

const doc = defineDoc({
  kind: "fortipi.preentry-watermark",
  version: 1,
  scope: "session",
  initial: () => ({ text: "" }),
  checkpointWhen: () => true,
});

/** Lower isolated watermark; no production allocation/global hard-cap claim. */
export class StorageGuardProbe extends DurableObject {
  readonly lifecycle = Lifecycle.install(this);
  readonly store = new Store(this.ctx.storage, {
    ...freeInfrastructurePolicy,
    bounds: { ...freeInfrastructurePolicy.bounds, objectBytes: 524288 },
  });
  #delegates = 0;
  #receipts = 0;
  #publications = 0;
  #barrier:
    | {
        entered: ReturnType<typeof Promise.withResolvers<void>>;
        release: ReturnType<typeof Promise.withResolvers<void>>;
      }
    | undefined;
  readonly pi = new PiHarness({
    harness: async ({ storage, context, onWake }) => {
      await this.store.open();
      const watched = new Proxy(storage, {
        get: (target, key) => {
          if (key === "commit")
            return async (...[batches, receive, current]: Parameters<Storage["commit"]>) => {
              this.#delegates++;
              const barrier = this.#barrier;
              if (barrier) {
                this.#barrier = undefined;
                barrier.entered.resolve();
                await barrier.release.promise;
                throw new Error("Synthetic original storage adapter failure");
              }
              return target.commit(
                batches,
                (index, seq) => {
                  this.#receipts++;
                  receive(index, seq);
                },
                current,
              );
            };
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const harness = await Harness.open(
        piStorageWatermark(watched, this.store),
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
  async characterize(mode: "entry" | "adapter-failure") {
    await this.lifecycle.start();
    const harness = await this.pi.pi();
    await harness.commit(async (tx) => {
      (await tx.doc(doc)).text = "retained-canary";
    }, BACKGROUND_CONTEXT);
    const before = {
      delegates: this.#delegates,
      receipts: this.#receipts,
      publications: this.#publications,
    };
    const writeAcknowledgments = async () => {
      await this.store.put("watermark", "acknowledged-app", { nonce: "must-survive" });
      await this.lifecycle.jobs.push({
        id: "acknowledged-wake",
        fn: "watermark.probe",
        time: Date.now() + 60000,
        payload: { nonce: "must-survive" },
        retry: { maxAttempts: 1 },
      });
    };
    const commit = () =>
      harness
        .commit(async (tx) => {
          (await tx.doc(doc)).text = "must-not-publish";
        }, BACKGROUND_CONTEXT)
        .then(
          () => "unexpected-success",
          (error) => (error instanceof Error ? error.message : "rejected"),
        );
    let failure: string;
    if (mode === "entry") {
      await writeAcknowledgments();
      // One acknowledged write crosses the watermark; the next commit must
      // refuse at entry. This is expressly not a post-write SQLite hard cap.
      await this.store.put("watermark", "physical-pressure", "x".repeat(524288));
      failure = await commit();
    } else {
      const barrier = {
        entered: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
      };
      this.#barrier = barrier;
      const pending = commit();
      await barrier.entered.promise;
      await writeAcknowledgments();
      barrier.release.resolve();
      failure = await pending;
    }
    const rejectedCounts = {
      delegates: this.#delegates - before.delegates,
      receipts: this.#receipts - before.receipts,
      publications: this.#publications - before.publications,
    };
    const markerRefused = await this.store.put("watermark", "hold-marker", { held: true }).then(
      () => false,
      () => true,
    );
    await this.pi.dispose();
    const reopened = await this.pi.pi();
    const result = {
      mode,
      failure,
      ...rejectedCounts,
      markerRefused,
      bytes: this.store.physicalBytes(),
      retainedDoc: await reopened.snapshot(doc, BACKGROUND_CONTEXT),
      appRetained: !!(await this.store.get("watermark", "acknowledged-app")),
      wakeRetained: !!this.lifecycle.jobs.get("acknowledged-wake"),
    };
    await this.lifecycle.jobs.cancel("acknowledged-wake");
    await this.pi.dispose();
    return result;
  }
}
export default { fetch: () => new Response(null, { status: 404 }) };
