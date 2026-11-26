import type { FortiPiClient } from "../../packages/fortipi-client/dist/browser.js";
import type { ClientEvent, DurableEvent } from "../../packages/fortipi-contract/dist/index.js";
import type { OfflineCompletionDiagnostic } from "./local-evidence-observation.ts";

function requireFact(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function until(read: () => Promise<boolean>, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await read()) return;
    await new Promise<void>((accept) => setTimeout(accept, 25));
  }
  throw new Error("Public committed completion/replay deadline exceeded");
}

function own(value: unknown, key: string): unknown {
  try {
    return value !== null && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, key)?.value
      : undefined;
  } catch {
    return undefined;
  }
}
function rateLimitWait(error: unknown, now: number, allowWire = false): number | undefined {
  const status = own(error, "status");
  if (
    own(error, "code") !== "rate_limited" ||
    (status !== 429 && !(allowWire && status === undefined)) ||
    own(error, "retryable") !== true
  )
    return undefined;
  const details = own(error, "details");
  let wait = 0;
  for (const hint of [own(error, "retryAfterMs"), own(details, "retryAfterMs")]) {
    if (hint === undefined) continue;
    if (typeof hint !== "number" || !Number.isSafeInteger(hint) || hint < 1 || hint > 60000)
      return undefined;
    wait = Math.max(wait, hint);
  }
  if (!wait) return undefined;
  const pressure = own(details, "pressure");
  if (pressure !== undefined) {
    if (own(pressure, "action") !== "retry-later") return undefined;
    const retryAt = own(pressure, "retryAt");
    if (retryAt !== undefined) {
      if (typeof retryAt !== "number" || !Number.isSafeInteger(retryAt) || retryAt < 0)
        return undefined;
      wait = Math.max(wait, retryAt - now);
    }
  }
  return wait <= 60000 ? wait : undefined;
}

/** Fixture wait policy only: server holds do not satisfy committed completion. */
export function createOfflineCompletionWait(started: number) {
  const deadline = started + 240000;
  const seen = new WeakSet<object>();
  const holds: { start: number; end: number }[] = [];
  let refusals = 0;
  let owner: object | undefined;
  let refused: { error: unknown } | undefined;
  const take = (error: object, wait: number, now: number) => {
    if (seen.has(error) || refusals >= 3 || now + wait > deadline) return false;
    seen.add(error);
    refusals++;
    return true;
  };
  const endHolds = (now: number) => {
    for (const hold of holds) hold.end = Math.min(hold.end, now);
  };
  return {
    httpWait(error: unknown): number | undefined {
      const now = Date.now();
      const wait = rateLimitWait(error, now);
      return wait !== undefined && take(error as object, wait, now) ? wait : undefined;
    },
    accept(observer: object) {
      owner ??= observer;
    },
    onStatus(observer: object, status: string, error?: unknown) {
      if (observer !== owner) return;
      const now = Date.now();
      if (status !== "reconnecting" || error == null) {
        endHolds(now);
        return;
      }
      const wait = rateLimitWait(error, now, true);
      if (wait === undefined) {
        endHolds(now);
        return;
      }
      if (seen.has(error as object)) return;
      if (!take(error as object, wait, now)) {
        refused ??= { error };
        return;
      }
      holds.push({ start: now, end: now + wait });
    },
    async wait(read: () => boolean | Promise<boolean>): Promise<void> {
      const began = Date.now();
      while (Date.now() < deadline) {
        if (refused) throw refused.error;
        const now = Date.now();
        let held = 0;
        let through = began;
        for (const hold of holds) {
          const start = Math.max(began, through, hold.start);
          const end = Math.min(now, hold.end);
          if (end > start) {
            held += end - start;
            through = end;
          }
        }
        if (now - began - held >= 20000) break;
        if (await read()) return;
        await new Promise<void>((accept) => setTimeout(accept, 25));
      }
      if (refused) throw refused.error;
      throw new Error("Public committed completion/replay deadline exceeded");
    },
  };
}
/** Shared behavioral oracle, executed by independently installed Node/browser clients.
 * No transport injection, implementation counters or client-side scheduler model.
 */
export async function publicFlow(
  client: FortiPiClient,
  second: FortiPiClient,
  input: {
    agentId: string;
    conversationId: string;
    seed: 1010;
    observe?: (phase: string) => void;
    observeOfflineCompletion?: (diagnostic: OfflineCompletionDiagnostic) => void;
  },
) {
  const { agentId, conversationId } = input;
  const observe = (phase: string) => input.observe?.(phase);
  const started = Date.now();
  const backoffs: number[] = [];
  const completion = createOfflineCompletionWait(started);
  async function request<T>(operation: () => Promise<T>): Promise<T> {
    for (;;) {
      try {
        return await operation();
      } catch (error) {
        const wait = completion.httpWait(error);
        // Only an explicit public refusal authorizes this bounded retry. Each
        // mutating closure below retains its original intent/request ID. A
        // transport/uncertain failure is never replayed by this observer.
        if (wait === undefined) throw error;
        backoffs.push(wait);
        await new Promise<void>((accept) => setTimeout(accept, wait));
      }
    }
  }
  async function connect(open: () => ReturnType<typeof client.conversations.subscribe>) {
    return request(async () => {
      const candidate = open();
      try {
        await candidate.ready;
        return candidate;
      } catch (error) {
        candidate.close();
        await candidate.done.catch(() => {});
        throw error;
      }
    });
  }
  observe("negotiate");
  const protocol = await request(() => client.negotiate());
  requireFact(protocol.protocolVersion === "1.0", "Actual discovery negotiation required");
  observe("original-snapshot");
  const original = await request(() => client.conversations.get(conversationId));
  const seen: DurableEvent[] = [];
  let appliedSequence = original.lastEventSeq;
  let volatile = 0;
  const accept = (event: ClientEvent) => {
    if (event.durability === "volatile") {
      volatile++;
      return;
    }
    requireFact(
      event.eventSeq === appliedSequence + 1,
      "Applied durable sequence must be contiguous",
    );
    appliedSequence = event.eventSeq;
    seen.push(structuredClone(event));
  };
  observe("first-subscribe");
  let subscription = await connect(() =>
    client.conversations.subscribe(conversationId, {
      agentId,
      maxReconnects: 0,
      onSnapshot(snapshot) {
        appliedSequence = snapshot.lastEventSeq;
      },
      onEvent: accept,
    }),
  );
  let offlineObserver: ReturnType<typeof second.conversations.subscribe> | undefined;
  try {
    await subscription.ready;
    const intent = client.messageIntent(conversationId, "seed1010-public-first", "followUp");
    observe("first-send");
    const first = await request(() => intent.send());
    await until(async () =>
      seen.some((e) => e.type === "task.completed" && "taskId" in e && e.taskId === first.taskId),
    );
    observe("first-task-observe");
    requireFact(
      (await request(() => client.tasks.get(first.taskId))).status.state === "completed",
      "Real terminal task required",
    );
    requireFact(
      seen.some(
        (e) => e.type === "message.completed" && "taskId" in e && e.taskId === first.taskId,
      ),
      `Committed assistant message must correlate to the actual admitted task; metadata=${JSON.stringify(
        seen
          .filter((e) => e.type === "message.completed" || e.type === "task.completed")
          .map((e) => ({
            type: e.type,
            taskId: e.taskId ?? null,
            admittedTask: e.taskId === first.taskId,
          })),
      )}`,
    );
    observe("first-receipt-retry");
    requireFact(
      JSON.stringify(await request(() => intent.send())) === JSON.stringify(first),
      "Explicit idempotent send must retain actual receipt",
    );
    const saved = subscription.cursor,
      scope = subscription.scope;
    requireFact(scope, "Applied cursor must retain its ticket identity scope");
    subscription.close();
    await subscription.done;
    const offlineCompletions = new Set<string>();
    let offlineObservation: Pick<
      OfflineCompletionDiagnostic,
      "status" | "settlement" | "statusError" | "snapshots" | "lastErrorCode" | "lastErrorStatus"
    > = {
      status: null,
      settlement: "pending",
      statusError: false,
      snapshots: 0,
      lastErrorCode: null,
      lastErrorStatus: null,
    };
    observe("second-client-subscribe");
    offlineObserver = await connect(() => {
      const observation: typeof offlineObservation = {
        status: null,
        settlement: "pending",
        statusError: false,
        snapshots: 0,
        lastErrorCode: null,
        lastErrorStatus: null,
      };
      offlineObservation = observation;
      const noteError = (error: unknown) => {
        observation.lastErrorCode = null;
        observation.lastErrorStatus = null;
        try {
          if (error !== null && typeof error === "object") {
            const code = Object.getOwnPropertyDescriptor(error, "code")?.value;
            const status = Object.getOwnPropertyDescriptor(error, "status")?.value;
            // Only scalars stay in-page; both output projections clip the code
            // to browserDiagnosticCodes, as for the original top-level error.
            observation.lastErrorCode = typeof code === "string" && code.length <= 64 ? code : null;
            observation.lastErrorStatus =
              typeof status === "number" &&
              Number.isInteger(status) &&
              status >= 100 &&
              status <= 599
                ? status
                : null;
          }
        } catch {}
      };
      const candidate = second.conversations.subscribe(conversationId, {
        agentId,
        onSnapshot() {
          try {
            observation.snapshots = Math.min(1000, (observation.snapshots ?? 0) + 1);
          } catch {}
        },
        onStatus(status, error) {
          try {
            observation.status = status;
            observation.statusError ||= error != null;
            if (error != null) noteError(error);
          } catch {}
          // The validated subscribe ack signals online immediately before ready.
          // An old setup attempt cannot select itself or end this observer's hold.
          if (status === "online" && offlineObservation === observation)
            completion.accept(observation);
          completion.onStatus(observation, status, error);
        },
        onEvent(event) {
          if (event.durability === "durable" && event.type === "task.completed" && event.taskId)
            offlineCompletions.add(event.taskId);
        },
      });
      void candidate.done
        .then(
          () => {
            observation.settlement = "fulfilled";
          },
          (error) => {
            observation.settlement = "rejected";
            noteError(error);
          },
        )
        .catch(() => {});
      return candidate;
    });
    await offlineObserver.ready;
    completion.accept(offlineObservation);
    observe("offline-send");
    const offlineInput = {
      clientRequestId: crypto.randomUUID(),
      content: "seed1010-public-offline",
      busyBehavior: "followUp" as const,
    };
    const offline = await request(() => second.conversations.send(conversationId, offlineInput));
    observe("offline-completion");
    try {
      await completion.wait(async () => offlineCompletions.has(offline.taskId));
    } catch (error) {
      try {
        if (
          input.observeOfflineCompletion &&
          error instanceof Error &&
          error.message === "Public committed completion/replay deadline exceeded"
        ) {
          // Freeze passive facts before any later read or subscription cleanup.
          const diagnostic: OfflineCompletionDiagnostic = {
            ...offlineObservation,
            matched: offlineCompletions.has(offline.taskId),
            taskRead: false,
            taskState: null,
            eventsRead: false,
            canonicalMatch: null,
            hasMore: null,
            complete: null,
            elapsedMs: 0,
          };
          const samplingStarted = Date.now();
          try {
            const signal = AbortSignal.timeout(2000);
            // One SDK call each; its existing one-time 401 refresh is unchanged.
            // No flow retry wrapper, pagination or writes are used here.
            const [task, events] = await Promise.allSettled([
              Promise.resolve().then(() => second.tasks.get(offline.taskId, { signal })),
              Promise.resolve().then(() =>
                second.conversations.events(conversationId, { after: saved }, { signal }),
              ),
            ]);
            if (task.status === "fulfilled") {
              diagnostic.taskRead = true;
              diagnostic.taskState = task.value.status.state;
            }
            if (events.status === "fulfilled") {
              diagnostic.eventsRead = true;
              diagnostic.canonicalMatch = events.value.events.some(
                (event) => event.type === "task.completed" && event.taskId === offline.taskId,
              );
              diagnostic.hasMore = events.value.hasMore;
              // Completeness is only through this page's fixed bound; these
              // reads are later and non-atomic, and never satisfy the oracle.
              diagnostic.complete =
                !events.value.hasMore && events.value.nextAfter === events.value.through;
            }
          } catch {}
          diagnostic.elapsedMs = Math.min(60000, Math.max(0, Date.now() - samplingStarted));
          input.observeOfflineCompletion(diagnostic);
        }
      } catch {}
      throw error;
    }
    // This socket only acknowledges the second client's terminal fact. Close
    // it before a rate-guided HTTP wait can outlive an otherwise idle stream.
    observe("offline-observer-close");
    offlineObserver.close();
    try {
      await offlineObserver.done;
    } catch (error) {
      requireFact(
        (error as { code?: string })?.code === "aborted",
        "Unexpected failure while closing the acknowledged second-client observer",
      );
    }
    offlineObserver = undefined;
    observe("offline-task-observe");
    requireFact(
      (await request(() => second.tasks.get(offline.taskId))).status.state === "completed",
      "The second client's actual committed completion must agree with public task state",
    );
    requireFact(subscription.cursor === saved, "Disconnected projection cursor cannot advance");
    observe("offline-stored-replay");
    const page = await request(() => second.conversations.events(conversationId, { after: saved }));
    requireFact(
      page.events.length > 0 &&
        page.events.some(
          (e) => e.type === "task.completed" && "taskId" in e && e.taskId === offline.taskId,
        ),
      "Offline completion must exist in canonical durable replay",
    );
    const stored = page.events.map((e) => JSON.stringify(e));
    const start = seen.length;
    observe("original-client-resume");
    subscription = await connect(() =>
      client.conversations.subscribe(conversationId, {
        agentId,
        after: saved,
        scope,
        maxReconnects: 0,
        onSnapshot() {
          throw new Error("Retained cursor unexpectedly replaced by a snapshot");
        },
        onEvent: accept,
      }),
    );
    await subscription.ready;
    await until(async () =>
      seen.some((e) => e.type === "task.completed" && "taskId" in e && e.taskId === offline.taskId),
    );
    const resumed = seen.slice(start).map((e) => JSON.stringify(e));
    requireFact(
      stored.every((e, i) => resumed[i] === e),
      "Stored original event envelopes must equal applied offline replay",
    );
    observe("final-snapshot");
    const projection = await request(() => client.conversations.get(conversationId));
    requireFact(
      projection.lastEventSeq >= subscription.cursor &&
        projection.lastEventSeq > original.lastEventSeq,
      "Snapshot and applied durable cursor must agree",
    );
    requireFact(
      new Set(seen.map((e) => e.eventId)).size === seen.length,
      "No duplicate durable rendering/application",
    );
    return {
      protocol: "1.0",
      actualTaskIds: [first.taskId, offline.taskId],
      correlatedCommittedMessages: true,
      explicitRetrySameReceipt: true,
      offlineEvents: stored.length,
      exactOriginalReplay: true,
      appliedEvents: seen.length,
      cursor: subscription.cursor,
      volatileEventsObserved: volatile,
      publicRateLimitBackoffsMs: backoffs,
    };
  } finally {
    offlineObserver?.close();
    await offlineObserver?.done.catch(() => {});
    subscription.close();
    await subscription.done.catch(() => {});
  }
}
