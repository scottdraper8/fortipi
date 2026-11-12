import type { FortiPiClient } from "../../packages/fortipi-client/dist/browser.js";
import type { ClientEvent, DurableEvent } from "../../packages/fortipi-contract/dist/index.js";

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
/** Shared behavioral oracle, executed by independently installed Node/browser clients.
 * No transport injection, implementation counters or client-side scheduler model.
 */
export async function publicFlow(
  client: FortiPiClient,
  second: FortiPiClient,
  input: { agentId: string; conversationId: string; seed: 1010; observe?: (phase: string) => void },
) {
  const { agentId, conversationId } = input;
  const observe = (phase: string) => input.observe?.(phase);
  const started = Date.now();
  const backoffs: number[] = [];
  async function request<T>(operation: () => Promise<T>): Promise<T> {
    for (;;) {
      try {
        return await operation();
      } catch (error) {
        const pressure = error as {
          code?: string;
          status?: number;
          retryable?: boolean;
          retryAfterMs?: number;
          details?: { retryAfterMs?: number };
        };
        const wait = pressure.retryAfterMs ?? pressure.details?.retryAfterMs;
        // Only an explicit public refusal authorizes this bounded retry. Each
        // mutating closure below retains its original intent/request ID. A
        // transport/uncertain failure is never replayed by this observer.
        if (
          pressure.code !== "rate_limited" ||
          pressure.status !== 429 ||
          pressure.retryable !== true ||
          !Number.isSafeInteger(wait) ||
          !wait ||
          wait < 1 ||
          wait > 60000 ||
          backoffs.length >= 3 ||
          Date.now() + wait > started + 240000
        )
          throw error;
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
    observe("second-client-subscribe");
    offlineObserver = await connect(() =>
      second.conversations.subscribe(conversationId, {
        agentId,
        onSnapshot() {},
        onEvent(event) {
          if (event.durability === "durable" && event.type === "task.completed" && event.taskId)
            offlineCompletions.add(event.taskId);
        },
      }),
    );
    await offlineObserver.ready;
    observe("offline-send");
    const offlineInput = {
      clientRequestId: crypto.randomUUID(),
      content: "seed1010-public-offline",
      busyBehavior: "followUp" as const,
    };
    const offline = await request(() => second.conversations.send(conversationId, offlineInput));
    await until(async () => offlineCompletions.has(offline.taskId));
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
