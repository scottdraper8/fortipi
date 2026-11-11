import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  defineDoc,
  defineTask,
  Harness,
  type Storage,
} from "@earendil-works/pi-durable";
import { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle, type LifecycleJobContext, type LifecycleJobOutcome } from "agents/lifecycle";

export class RaceProbe extends DurableObject {
  readonly lifecycle = Lifecycle.install(this);
  readonly db = new DurableObjectSqliteDatabase(this.ctx.storage);
  readonly pi = new PiHarness({
    harness: async ({ storage, context, onWake }) => {
      const registry = createRegistry();
      const waitingParent = defineTask<Record<string, never>, { phase: "wait" }, string>({
        name: "fortipi.race.parent",
        version: 1,
        initial: () => ({ phase: "wait" }),
        phases: {
          wait: async (task, runtime, context) => {
            let child: import("@earendil-works/pi-durable").TaskId<string> | undefined;
            await runtime.commit(async (tx) => {
              child = await tx.createTask(
                dormant,
                {},
                { ownership: { kind: "task", taskId: task.id }, abandonOnRestart: false },
              );
            }, context);
            if (child === undefined) throw new Error("Child missing");
            this.taskReady.resolve();
            await this.startWait.promise;
            context.abortSignal?.throwIfAborted();
            const waiting = runtime.waitForTask(child, context).then(
              () => {
                throw new Error("False task-runtime completion");
              },
              (error) => {
                this.taskRejection = error instanceof Error ? error.message : "unknown";
                throw error;
              },
            );
            // The public returned promise also has its handler before cancellation.
            const handled = waiting.catch(() => {});
            this.waitCalled.resolve();
            await handled;
            context.abortSignal?.throwIfAborted();
          },
        },
        abort: async (_task, runtime, context) => {
          await runtime.commit(
            () => ({ status: "terminal", outcome: { status: "aborted" } }),
            context,
          );
        },
      });
      this.parentToken = waitingParent;
      registry.install({ name: "fortipi.race", tasks: [dormant, waitingParent] });
      const instrumented: Storage = new Proxy(storage, {
        get: (target, key, receiver) => {
          if (key === "publishing")
            return (publish: () => void) => {
              if (this.slowPublication) {
                this.delayedPublications++;
                setTimeout(publish, 50);
              } else publish();
            };
          const value: unknown = Reflect.get(target, key, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return Harness.open(
        instrumented,
        {
          models: createModels(),
          registry,
          onWake,
          settings: { afterFailedRun: "keep", progress: { persistWithinMs: 1000 } },
        },
        context,
      );
    },
  });
  private slowPublication = false;
  private delayedPublications = 0;
  private readonly newer = Promise.withResolvers<void>();
  private readonly taskReady = Promise.withResolvers<void>();
  private readonly startWait = Promise.withResolvers<void>();
  private readonly waitCalled = Promise.withResolvers<void>();
  private taskRejection = "";
  private parentToken:
    | ReturnType<typeof defineTask<Record<string, never>, { phase: "wait" }, string>>
    | undefined;
  constructor(ctx: DurableObjectState, env: object) {
    super(ctx, env);
    this.lifecycle.use(this.pi);
  }
  async onStart(): Promise<void> {
    await this.db.exec(
      "CREATE TABLE IF NOT EXISTS fp_race_v1(name TEXT PRIMARY KEY,value INTEGER NOT NULL)",
    );
  }
  async value(name: string): Promise<number> {
    await this.lifecycle.start();
    return (
      (await this.db.get<{ value: number }>("SELECT value FROM fp_race_v1 WHERE name=?", name))
        ?.value ?? 0
    );
  }
  async mark(name: string): Promise<void> {
    await this.db.run(
      "INSERT INTO fp_race_v1 VALUES(?,1) ON CONFLICT(name) DO UPDATE SET value=value+1",
      name,
    );
  }
  async arm(): Promise<void> {
    await this.lifecycle.start();
    await this.db.run(
      "INSERT INTO fp_race_v1 VALUES('generation',1) ON CONFLICT(name) DO UPDATE SET value=1",
    );
    await this.lifecycle.jobs.push({
      id: "race",
      fn: "old",
      time: Date.now() + 60000,
      payload: { intent: 1 },
      retry: { maxAttempts: 2, baseDelayMs: 1000, maxDelayMs: 1000 },
      singleflight: true,
    });
    await this.lifecycle.jobs.reschedule("race", Date.now());
  }
  async drive(): Promise<void> {
    await this.lifecycle.alarm();
  }
  async cancel(): Promise<void> {
    await this.lifecycle.jobs.cancel("race");
  }
  async replace(distinct = false): Promise<void> {
    // Candidate supported integration: the fixed fn is independent of immutable invocation ID.
    await this.db.run("UPDATE fp_race_v1 SET value=2 WHERE name='generation'");
    if (distinct) await this.lifecycle.jobs.cancel("race");
    await this.lifecycle.jobs.push({
      id: distinct ? "race-generation-2" : "race",
      fn: "new",
      time: Date.now(),
      payload: { intent: 2 },
      retry: { maxAttempts: 1 },
      singleflight: true,
    });
  }
  async release(): Promise<void> {
    this.newer.resolve();
  }
  async state(): Promise<{
    exists: boolean;
    fn?: string;
    time?: number;
    oldCalls: number;
    effects: number;
    newCalls: number;
    queued: number;
  }> {
    const job = this.lifecycle.jobs.get("race-generation-2") ?? this.lifecycle.jobs.get("race");
    return {
      exists: !!job,
      ...(job ? { fn: job.fn, time: job.time } : {}),
      oldCalls: await this.value("old-calls"),
      effects: await this.value("effect"),
      newCalls: await this.value("new-calls"),
      queued: this.lifecycle.jobs.list().length,
    };
  }
  async onJob(context: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    if (context.job.fn === "old") {
      await this.mark("old-calls");
      if (context.attempt === 1) throw new Error("synthetic-first-callback-failure");
      // Durable app intent revalidation suppresses stale effects, independently of Lifecycle's row outcome.
      await this.db.transaction(async (tx) => {
        const current = await tx.get<{ value: number }>(
          "SELECT value FROM fp_race_v1 WHERE name='generation'",
        );
        if (current?.value === 1)
          await tx.run(
            "INSERT INTO fp_race_v1 VALUES('effect',1) ON CONFLICT(name) DO UPDATE SET value=value+1",
          );
      });
      return;
    }
    await this.mark("new-calls");
    await this.newer.promise;
    if (context.job.id === "race-generation-2") return { rescheduleAt: Date.now() + 10000 };
    return;
  }
  async close(): Promise<void> {
    await this.lifecycle.dispose();
    await this.db.close();
  }
  unhandledCanary(): void {
    void Promise.reject(new Error("workerd-unhandled-canary"));
  }
  async piWait(
    mode: "aftercall" | "shutdown" | "guarded-shutdown",
  ): Promise<{ rejection: string; delayed: number; guardPassed: boolean }> {
    await this.lifecycle.start();
    const harness = await this.pi.pi();
    const root = await harness.root(BACKGROUND_CONTEXT);
    const taskId = await harness.commit(
      (tx) =>
        tx.createTask(
          dormant,
          {},
          { conversationId: root.id, ownership: { kind: "conversation" } },
        ),
      BACKGROUND_CONTEXT,
    );
    harness.resume();
    for (let i = 0; i < 100; i++) {
      if ((await harness.getTask(taskId, BACKGROUND_CONTEXT))?.state.status === "sleeping") break;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    this.slowPublication = true;
    const write = harness.commit(async (tx) => {
      const doc = await tx.doc(marker);
      doc.value++;
    }, BACKGROUND_CONTEXT);
    const controller = new AbortController();
    const context =
      mode === "shutdown"
        ? BACKGROUND_CONTEXT
        : withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
    context.abortSignal?.throwIfAborted();
    let rejection = "";
    // Install a handler on the public promise immediately; never a global rejection listener.
    const waiting = harness.waitForTask(taskId, context).then(
      () => {
        throw new Error("False completion");
      },
      (error) => {
        rejection = error instanceof Error ? error.message : "unknown";
      },
    );
    let closing: Promise<void> | undefined;
    if (mode === "aftercall") controller.abort(new Error("workerd-aftercall-stop"));
    else {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      if (mode === "guarded-shutdown") controller.abort(new Error("workerd-shutdown-stop"));
      closing = this.pi.dispose();
    }
    await write;
    await waiting;
    await closing;
    this.slowPublication = false;
    return { rejection, delayed: this.delayedPublications, guardPassed: true };
  }
  async piTaskWait(mode: "aftercall" | "shutdown") {
    await this.lifecycle.start();
    const harness = await this.pi.pi();
    const root = await harness.root(BACKGROUND_CONTEXT);
    if (!this.parentToken) throw new Error("Parent missing");
    const parent = this.parentToken;
    const task = await harness.commit(
      (tx) =>
        tx.createTask(parent, {}, { conversationId: root.id, ownership: { kind: "conversation" } }),
      BACKGROUND_CONTEXT,
    );
    harness.resume();
    await this.taskReady.promise;
    this.slowPublication = true;
    const write = harness.commit(async (tx) => {
      const doc = await tx.doc(marker);
      doc.value++;
    }, BACKGROUND_CONTEXT);
    this.startWait.resolve();
    await this.waitCalled.promise;
    const stopping =
      mode === "aftercall" ? harness.abortTask(task, BACKGROUND_CONTEXT) : this.pi.dispose();
    await write;
    await stopping;
    for (let i = 0; i < 100 && !this.taskRejection; i++)
      await new Promise<void>((accept) => setTimeout(accept, 5));
    this.slowPublication = false;
    return { rejection: this.taskRejection, delayed: this.delayedPublications, guardPassed: true };
  }
}
const marker = defineDoc({
  kind: "fortipi.race.marker",
  version: 1,
  scope: "session",
  initial: () => ({ value: 0 }),
  checkpointWhen: () => true,
});
const dormant = defineTask<Record<string, never>, { phase: "sleep" }, string>({
  name: "fortipi.race.sleep",
  version: 1,
  initial: () => ({ phase: "sleep" }),
  phases: {
    sleep: async (_task, runtime, context) => {
      await runtime.sleepUntil(Date.now() + 60000, { phase: "sleep" }, context);
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
  },
});
export default {
  async fetch(
    request: Request,
    env: { PROBE: DurableObjectNamespace<RaceProbe> },
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/canary") {
      await env.PROBE.getByName("canary").unhandledCanary();
      return Response.json({ canary: true });
    }
    if (url.pathname === "/pi") {
      const mode = url.searchParams.get("mode");
      if (mode !== "aftercall" && mode !== "shutdown" && mode !== "guarded-shutdown")
        return new Response(null, { status: 400 });
      return Response.json(await env.PROBE.getByName(mode).piWait(mode));
    }
    if (url.pathname === "/task-pi") {
      const mode = url.searchParams.get("mode");
      if (mode !== "aftercall" && mode !== "shutdown") return new Response(null, { status: 400 });
      return Response.json(await env.PROBE.getByName(`task-${mode}`).piTaskWait(mode));
    }
    return new Response("test-only race fixture");
  },
};
