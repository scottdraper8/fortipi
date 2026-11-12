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
  observe("negotiate");
  const protocol = await client.negotiate();
  requireFact(protocol.protocolVersion === "1.0", "Actual discovery negotiation required");
  observe("original-snapshot");
  const original = await client.conversations.get(conversationId);
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
  let subscription = client.conversations.subscribe(conversationId, {
    agentId,
    maxReconnects: 0,
    onSnapshot(snapshot) {
      appliedSequence = snapshot.lastEventSeq;
    },
    onEvent: accept,
  });
  let offlineObserver: ReturnType<typeof second.conversations.subscribe> | undefined;
  try {
    await subscription.ready;
    const intent = client.messageIntent(conversationId, "seed1010-public-first", "followUp");
    observe("first-send");
    const first = await intent.send();
    await until(async () =>
      seen.some((e) => e.type === "task.completed" && "taskId" in e && e.taskId === first.taskId),
    );
    observe("first-task-observe");
    requireFact(
      (await client.tasks.get(first.taskId)).status.state === "completed",
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
      JSON.stringify(await intent.send()) === JSON.stringify(first),
      "Explicit idempotent send must retain actual receipt",
    );
    const saved = subscription.cursor,
      scope = subscription.scope;
    requireFact(scope, "Applied cursor must retain its ticket identity scope");
    subscription.close();
    await subscription.done;
    const offlineCompletions = new Set<string>();
    observe("second-client-subscribe");
    offlineObserver = second.conversations.subscribe(conversationId, {
      agentId,
      maxReconnects: 0,
      onSnapshot() {},
      onEvent(event) {
        if (event.durability === "durable" && event.type === "task.completed" && event.taskId)
          offlineCompletions.add(event.taskId);
      },
    });
    await offlineObserver.ready;
    observe("offline-send");
    const offline = await second.conversations.send(conversationId, {
      clientRequestId: crypto.randomUUID(),
      content: "seed1010-public-offline",
      busyBehavior: "followUp",
    });
    await until(async () => offlineCompletions.has(offline.taskId));
    observe("offline-task-observe");
    requireFact(
      (await second.tasks.get(offline.taskId)).status.state === "completed",
      "The second client's actual committed completion must agree with public task state",
    );
    offlineObserver.close();
    await offlineObserver.done;
    offlineObserver = undefined;
    requireFact(subscription.cursor === saved, "Disconnected projection cursor cannot advance");
    observe("offline-stored-replay");
    const page = await second.conversations.events(conversationId, { after: saved });
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
    subscription = client.conversations.subscribe(conversationId, {
      agentId,
      after: saved,
      scope,
      maxReconnects: 0,
      onSnapshot() {
        throw new Error("Retained cursor unexpectedly replaced by a snapshot");
      },
      onEvent: accept,
    });
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
    const projection = await client.conversations.get(conversationId);
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
    };
  } finally {
    offlineObserver?.close();
    await offlineObserver?.done.catch(() => {});
    subscription.close();
    await subscription.done.catch(() => {});
  }
}
