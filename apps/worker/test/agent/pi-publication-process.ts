import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  defineDoc,
  defineTask,
  Harness,
  type Storage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

// An independent process runs with Node's fatal unhandled-rejection policy. No rejection listener.
const directory = process.argv[3] ?? (await mkdtemp(join(tmpdir(), "fortipi-pi-publication-")));
const raw = await openNodeSqliteStorage(join(directory, "actual.sqlite"));
let slow = false;
let publications = 0;
const mode = process.argv[2] ?? "preaborted";
const storage: Storage = new Proxy(raw, {
  get(target, key, receiver) {
    if (key === "publishing")
      return (publish: () => void) => {
        if (slow) {
          publications++;
          setTimeout(publish, 50);
        } else publish();
      };
    if (key === "task" && mode === "cancel-before-read")
      return async (...args: Parameters<Storage["task"]>) => {
        const value = await target.task(...args);
        if (slow) await new Promise<void>((resolve) => setTimeout(resolve, 25));
        return value;
      };
    if (key === "submission" && mode === "submission-cancel")
      return async (...args: Parameters<Storage["submission"]>) => {
        const value = await target.submission(...args);
        if (slow) await new Promise<void>((resolve) => setTimeout(resolve, 25));
        return value;
      };
    const value: unknown = Reflect.get(target, key, receiver);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const dormant = defineTask<{ name: string }, { phase: "sleep" }, string>({
  name: "fortipi.race.dormant",
  version: 1,
  initial: () => ({ phase: "sleep" }),
  phases: {
    sleep: async (_task, runtime, context) => {
      await runtime.sleepUntil(Date.now() + 60000, { phase: "sleep" }, context);
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(
      () => ({ status: "terminal", outcome: { status: "aborted", reason: "cancelled" } }),
      context,
    );
  },
});
const registry = createRegistry();
registry.install({ name: "fortipi.race", tasks: [dormant] });
const harness = await Harness.open(
  storage,
  { models: createModels(), registry, onWake: () => {} },
  BACKGROUND_CONTEXT,
);
const doc = defineDoc({
  kind: "fortipi.race.marker",
  version: 1,
  scope: "session",
  initial: () => ({ value: 0 }),
  checkpointWhen: () => true,
});
try {
  const root = await harness.root(BACKGROUND_CONTEXT);
  const taskId = await harness.commit(
    (tx) =>
      tx.createTask(
        dormant,
        { name: "waiting" },
        { conversationId: root.id, ownership: { kind: "conversation" } },
      ),
    BACKGROUND_CONTEXT,
  );
  harness.resume();
  for (let i = 0; i < 100; i++) {
    const current = await harness.getTask(taskId, BACKGROUND_CONTEXT);
    if (current?.state.status === "sleeping") break;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  const submissionId = await harness.commit(
    (tx) =>
      tx.createSubmission({
        type: "input",
        status: "queued",
        conversationId: root.id,
        requestId: "synthetic-pending",
      }),
    BACKGROUND_CONTEXT,
  );
  const submission = await harness.submission(submissionId.id, BACKGROUND_CONTEXT);
  assert.ok(submission);
  slow = true;
  const write = harness.commit(async (tx) => {
    const marker = await tx.doc(doc);
    marker.value++;
  }, BACKGROUND_CONTEXT);
  const controller = new AbortController();
  if (mode === "preaborted") controller.abort(new Error("pin-race-stop"));
  const context =
    mode === "shutdown"
      ? BACKGROUND_CONTEXT
      : withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
  // The supported caller-side guard passes in aftercall mode.
  if (mode === "aftercall") context.abortSignal?.throwIfAborted();
  const waiting =
    mode === "submission-cancel" ? submission.wait(context) : harness.waitForTask(taskId, context);
  const checked = assert.rejects(
    waiting,
    mode === "shutdown" ? /Harness is closed|Session is closed|session closed/ : /pin-race-stop/,
  );
  if (mode === "aftercall") controller.abort(new Error("pin-race-stop"));
  if (mode === "cancel" || mode === "cancel-before-read" || mode === "submission-cancel")
    setTimeout(() => controller.abort(new Error("pin-race-stop")), 5);
  if (mode === "shutdown")
    setTimeout(() => {
      void harness.close(BACKGROUND_CONTEXT).catch(() => {});
    }, 5);
  await write;
  await checked;
  slow = false;
  assert.ok(publications > 0, "Publication delay must actually execute");
  if (mode !== "shutdown")
    assert.notEqual(
      (await harness.getTask(taskId, BACKGROUND_CONTEXT))?.state.status,
      "terminal",
      "Cancelled waiter must not complete the durable task",
    );
  console.log(
    JSON.stringify({ mode, publications, callerRejection: true, falseCompletion: false }),
  );
} finally {
  slow = false;
  await harness.close(BACKGROUND_CONTEXT);
  await rm(directory, { recursive: true, force: true });
}
