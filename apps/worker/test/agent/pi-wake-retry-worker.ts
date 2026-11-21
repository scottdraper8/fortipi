import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineTask, Harness, type TaskId } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle, type LifecycleJobContext } from "agents/lifecycle";

const sleep = defineTask<{ until: number }, { phase: "sleep" | "done" }, number>({
  name: "fortipi.wake-retry.sleep",
  version: 1,
  initial: () => ({ phase: "sleep" }),
  phases: {
    sleep: async (task, runtime, context) => {
      await runtime.sleepUntil(task.input.until, { phase: "done" }, context);
    },
    done: async (_task, runtime, context) => {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "completed", result: Date.now() } }),
        context,
      );
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
  },
});

class ObservedPiHarness extends PiHarness {
  readonly calls: {
    attempt: number;
    capturedTime: number;
    calledAt: number;
    finishedAt: number | null;
  }[] = [];
  failed = false;
  failedCapturedTime: number | undefined;
  readonly release = Promise.withResolvers<void>();
  override async onJob(context: LifecycleJobContext) {
    const call: (typeof this.calls)[number] = {
      attempt: context.attempt,
      capturedTime: context.job.time,
      calledAt: Date.now(),
      finishedAt: null,
    };
    this.calls.push(call);
    try {
      return await super.onJob(context);
    } catch (error) {
      if (!this.failed) {
        this.failed = true;
        this.failedCapturedTime = context.job.time;
        // Preserve the real failed-open rejection, held outside every queue.
        await this.release.promise;
      }
      throw error;
    } finally {
      call.finishedAt = Date.now();
    }
  }
  row() {
    return this.lifecycle.jobs.get("pi-wake") ?? null;
  }
  async dueNow() {
    return this.lifecycle.jobs.reschedule("pi-wake", Date.now());
  }
}

export class WakeRetryProbe extends DurableObject {
  readonly lifecycle = Lifecycle.install(this);
  #failOpen = false;
  #opens = 0;
  #until = 0;
  #task: TaskId<number> | undefined;
  readonly pi = new ObservedPiHarness({
    harness: async ({ storage, context, onWake }) => {
      this.#opens++;
      if (this.#failOpen) {
        this.#failOpen = false;
        throw new Error("synthetic-factory-reopen-failure");
      }
      const registry = createRegistry();
      registry.install({ name: "fortipi.wake-retry", tasks: [sleep] });
      return Harness.open(storage, { models: createModels(), registry, onWake }, context);
    },
  });
  constructor(ctx: DurableObjectState, env: object) {
    super(ctx, env);
    this.lifecycle.use(this.pi);
  }
  async prepare() {
    await this.lifecycle.start();
    const harness = await this.pi.pi();
    const root = await harness.root(BACKGROUND_CONTEXT);
    this.#until = Date.now() + 4000;
    this.#task = await harness.commit(
      (tx) =>
        tx.createTask(
          sleep,
          { until: this.#until },
          {
            conversationId: root.id,
            ownership: { kind: "conversation" },
            abandonOnRestart: false,
          },
        ),
      BACKGROUND_CONTEXT,
    );
    harness.resume();
    for (let i = 0; i < 100; i++) {
      if ((await harness.getTask(this.#task, BACKGROUND_CONTEXT))?.state.status === "sleeping")
        break;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    await this.pi.dispose();
    this.#failOpen = true;
    if (!(await this.pi.dueNow())) throw new Error("Real Pi wake missing before fault");
    return { until: this.#until, taskId: this.#task };
  }
  drive() {
    return this.lifecycle.alarm();
  }
  stateJson() {
    // Do not reopen Pi as an observer: recovery is an explicit foreground step.
    return JSON.stringify({
      failed: this.pi.failed,
      failedCapturedTime: this.pi.failedCapturedTime,
      calls: this.pi.calls,
      row: this.pi.row(),
      opens: this.#opens,
    });
  }
  async recover() {
    await this.pi.pi();
  }
  releaseFailure() {
    this.pi.release.resolve();
  }
  async taskJson() {
    if (!this.#task) throw new Error("Task was not created");
    return JSON.stringify(
      (await (await this.pi.pi()).getTask(this.#task, BACKGROUND_CONTEXT))?.state ?? null,
    );
  }
  alarmTime() {
    return this.ctx.storage.getAlarm();
  }
  async close() {
    this.releaseFailure();
    await this.lifecycle.dispose();
  }
}
export default { fetch: () => new Response("Test-only Pi wake retry probe") };
