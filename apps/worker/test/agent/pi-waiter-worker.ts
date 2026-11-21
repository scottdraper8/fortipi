import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT as BG, withAbortSignal } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineDoc, defineTask, Harness } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const events: string[] = [];
addEventListener("unhandledrejection", (event) => events.push(String(event.reason)));
const started = Promise.withResolvers<void>();
const Hold = defineTask<null, { phase: "hold" }, null>({
  name: "qualification.hold",
  version: 1,
  initial: () => ({ phase: "hold" }),
  phases: {
    hold: async (_task, api) => {
      started.resolve();
      await new Promise<void>((resolve) => {
        if (api.signal.aborted) resolve();
        else api.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  },
  abort: async (_task, api, context) =>
    api.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});
const Doc = defineDoc({
  kind: "qualification.unrelated",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ n: 0 }),
  checkpointWhen: () => true,
});
interface Env {
  PROBES: DurableObjectNamespace<PiWaiterProbe>;
}
export class PiWaiterProbe extends DurableObject<Env> {
  readonly lifecycle: Lifecycle<Env>;
  readonly pi: PiHarness;
  #gate: PromiseWithResolvers<void> | undefined;
  #entered: PromiseWithResolvers<void> | undefined;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.lifecycle = Lifecycle.install(this);
    this.pi = new PiHarness({
      harness: async ({ storage, context, onWake }) => {
        const original = storage.commit.bind(storage);
        storage.commit = async (...args) => {
          const gate = this.#gate;
          if (gate) {
            this.#gate = undefined;
            this.#entered?.resolve();
            // Controlled latency before the actual storage operation. The real
            // batches, receipts, queued SQLite, and publication remain untouched.
            await gate.promise;
          }
          return original(...args);
        };
        const registry = createRegistry();
        registry.install({ name: "qualification", tasks: [Hold] });
        return Harness.open(storage, { registry, models: () => createModels(), onWake }, context);
      },
    });
    this.lifecycle.use(this.pi);
  }
  async qualify() {
    // The observation must detect a known unhandled rejection before absence
    // can be meaningful. This listener does not suppress the runtime event.
    const positive = Promise.reject(new Error("qualification-unhandled-positive-control"));
    await pause(40);
    positive.catch(() => {});
    await pause(1);
    await this.lifecycle.start();
    const harness = await this.pi.pi();
    const root = await harness.root(BG);
    const id = await root.commit(
      (tx) => tx.createTask(Hold, null, { ownership: { kind: "conversation" } }),
      BG,
    );
    harness.resume();
    await started.promise;
    const gate = Promise.withResolvers<void>();
    this.#gate = gate;
    this.#entered = Promise.withResolvers<void>();
    const committing = root.commit(async (tx) => {
      const doc = await tx.doc(Doc, root.id);
      doc.n++;
    }, BG);
    committing.catch(() => {});
    await this.#entered.promise;
    const line = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const queued = harness.commit(async () => {
      entered.resolve();
      await line.promise;
    }, BG);
    queued.catch(() => {});
    await entered.promise;
    const controller = new AbortController();
    const reason = new Error("qualification-already-cancelled-wait");
    const waiting = harness.waitForTask(id, withAbortSignal(controller.signal, BG)).then(
      () => ({ cancelled: false, message: "resolved" }),
      (error) => ({ cancelled: error === reason, message: String(error) }),
    );
    controller.abort(reason);
    line.resolve();
    await pause(80);
    gate.resolve();
    await queued;
    await committing;
    const wait = await waiting;
    await harness.abortTask(id, BG);
    return { committed: true, wait, events };
  }
}
export default {
  async fetch(_request: Request, env: Env) {
    return Response.json(await env.PROBES.getByName("waiter").qualify());
  },
};
