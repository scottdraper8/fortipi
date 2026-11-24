import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineTask, Harness, type TaskId } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle, type LifecycleJobContext } from "agents/lifecycle";

const sleeper = defineTask<{ until: number }, { phase: "sleep" | "done" }, string>({
  name: "fortipi.fixed-wake.sleep",
  version: 1,
  initial: () => ({ phase: "sleep" }),
  phases: {
    sleep: async (task, runtime, context) => {
      await runtime.sleepUntil(task.input.until, { phase: "done" }, context);
    },
    done: async (_task, runtime, context) => {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "completed", result: "awake" } }),
        context,
      );
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
  },
});
/** Declared public callback/protected capability services only; no private fields or SQL. */
class HeldPiHarness extends PiHarness {
  holdNextIdle = false;
  entered = false;
  readonly release = Promise.withResolvers<void>();
  override async onJob(context: LifecycleJobContext) {
    const result = await super.onJob(context);
    if (this.holdNextIdle && context.job.id === "pi-wake" && result === undefined) {
      this.holdNextIdle = false;
      this.entered = true;
      await this.release.promise;
    }
    return result;
  }
  row() {
    const row = this.lifecycle.jobs.get("pi-wake");
    return row ? { id: row.id, fn: row.fn, time: row.time } : null;
  }
  async dueNow() {
    if (this.row()) await this.lifecycle.jobs.reschedule("pi-wake", Date.now());
  }
}
/** Observe public alarm promises, including alarms installed on the host. */
class ObservedLifecycle extends Lifecycle {
  readonly alarmRuns = new Set<Promise<void>>();
  entered = 0;
  settled = 0;
  override alarm(): Promise<void> {
    this.entered = Math.min(1000, this.entered + 1);
    const run = super.alarm().finally(() => {
      this.alarmRuns.delete(run);
      this.settled = Math.min(1000, this.settled + 1);
    });
    this.alarmRuns.add(run);
    return run;
  }
}
export class FixedWakeProbe extends DurableObject {
  readonly lifecycle = new ObservedLifecycle(this);
  readonly pi = new HeldPiHarness({
    harness: async ({ storage, context, onWake }) => {
      const registry = createRegistry();
      registry.install({ name: "fortipi.fixed-wake", tasks: [sleeper] });
      return Harness.open(storage, { models: createModels(), registry, onWake }, context);
    },
  });
  #task: TaskId<string> | undefined;
  constructor(ctx: DurableObjectState, env: object) {
    super(ctx, env);
    this.lifecycle.installHandlers();
    this.lifecycle.use(this.pi);
  }
  async begin() {
    await this.lifecycle.start();
    const receipt = await this.pi
      .session()
      .continue({ operationId: "fixed-wake-empty-continuation" });
    await this.pi.session().wait(receipt.operationId);
    this.pi.holdNextIdle = true;
    if (!this.pi.row())
      await this.pi.session().continue({ operationId: "fixed-wake-second-continuation" });
    await this.pi.dueNow();
  }
  async drive() {
    await this.lifecycle.alarm();
  }
  async prepareDrive() {
    await this.pi.dueNow();
  }
  async sleepingSuccessor() {
    const harness = await this.pi.pi(),
      root = await harness.root(BACKGROUND_CONTEXT);
    const until = Date.now() + 60000;
    this.#task = await harness.commit(
      (tx) =>
        tx.createTask(
          sleeper,
          { until },
          { conversationId: root.id, ownership: { kind: "conversation" }, abandonOnRestart: false },
        ),
      BACKGROUND_CONTEXT,
    );
    harness.resume();
    return until;
  }
  async releaseAndJoin() {
    const runs = [...this.lifecycle.alarmRuns];
    if (runs.length === 0) throw new Error("Held wake must have an observed alarm invocation");
    this.release();
    await Promise.all(runs);
    return runs.length;
  }
  release() {
    this.pi.release.resolve();
  }
  async state() {
    const harness = await this.pi.pi(),
      task = this.#task ? await harness.getTask(this.#task, BACKGROUND_CONTEXT) : undefined;
    return {
      held: this.pi.entered,
      wake: harness.wake(),
      taskStatus: task?.state.status,
      row: this.pi.row(),
      alarm: await this.ctx.storage.getAlarm(),
      alarms: {
        entered: this.lifecycle.entered,
        settled: this.lifecycle.settled,
        inFlight: Math.min(1000, this.lifecycle.alarmRuns.size),
      },
    };
  }
  async close() {
    this.release();
    await this.lifecycle.dispose();
  }
}
export default { fetch: () => new Response("Test-only Pi fixed-wake probe") };
