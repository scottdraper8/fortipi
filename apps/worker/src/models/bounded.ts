import type { Api, AssistantMessage, AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
import type { MutableModels, Provider } from "@earendil-works/pi-ai/models";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { wireLimits } from "fortipi-contract";
import { check } from "../api/common.js";

/** Per-stream infrastructure envelopes; no provider-usage policy or turn limit. */
export const modelStorageLimits = Object.freeze({
  messageBytes: 262144,
  toolArgumentsBytes: wireLimits.inlineTailBytes,
  events: 16384,
  durationMs: 60000,
  queuedBytes: 262144,
  encodedWorkBytes: 32 * 1024 * 1024,
} as const);
export type ModelStorageSettings = { [K in keyof typeof modelStorageLimits]: number };
type DeltaEvent = Extract<
  AssistantMessageEvent,
  { type: "text_delta" | "thinking_delta" | "toolcall_delta" }
>;
const progressBytes = 4096;
const progressMs = 100;

/** Fail before building an arbitrarily large serialized response; return an isolated JSON snapshot. */
export function boundedJsonCopy<T>(value: T, limit: number): T {
  const utf8 = new TextEncoder();
  let primitives = 0,
    nodes = 0;
  const encoded = JSON.stringify(value, (key: string, item: unknown) => {
    check(++nodes <= 16384, "quota_paused", "Encoded model data has too many members");
    check(key.length <= limit, "quota_paused", "Encoded model data exceeds its byte bound");
    primitives += utf8.encode(JSON.stringify(key)).byteLength;
    if (typeof item === "string") {
      check(item.length <= limit, "quota_paused", "Encoded model data exceeds its byte bound");
      primitives += utf8.encode(JSON.stringify(item)).byteLength;
    } else if (typeof item === "number" || typeof item === "boolean" || item === null)
      primitives += utf8.encode(JSON.stringify(item)).byteLength;
    check(primitives <= limit, "quota_paused", "Encoded model data exceeds its byte bound");
    return item;
  });
  check(
    encoded !== undefined && utf8.encode(encoded).byteLength <= limit,
    "quota_paused",
    "Encoded model data exceeds its byte bound",
  );
  return JSON.parse(encoded) as T;
}

function failed(model: Model<Api>, aborted: boolean): AssistantMessage {
  return {
    role: "assistant",
    api: model.api.slice(0, 128),
    provider: model.provider.slice(0, 128),
    model: model.id.slice(0, 128),
    content: [],
    stopReason: aborted ? "aborted" : "error",
    errorMessage: aborted
      ? "Model request cancelled"
      : "Model response exceeded a bounded service limit or its stream failed",
    timestamp: Date.now(),
    durationMs: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

/** Own bounded FIFO; uses public end(result) for the SDK result promise. */
class StorageEventStream extends AssistantMessageEventStream {
  readonly #model: Model<Api>;
  readonly #limits: ModelStorageSettings;
  readonly #cancel: () => void;
  readonly #knownEvents: WeakMap<AssistantMessageEvent, number>;
  readonly #reuseSnapshots: boolean;
  readonly #queued = new Map<number, { event: AssistantMessageEvent; bytes: number }>();
  readonly #waiters = new Set<() => void>();
  readonly #startedAt = Date.now();
  readonly #started = performance.now();
  #read = 0;
  #write = 0;
  #bytes = 0;
  #work = 0;
  #closed = false;
  constructor(
    model: Model<Api>,
    limits: ModelStorageSettings,
    cancel: () => void,
    knownEvents: WeakMap<AssistantMessageEvent, number>,
    reuseSnapshots: boolean,
  ) {
    super();
    this.#model = model;
    this.#limits = limits;
    this.#cancel = cancel;
    this.#knownEvents = knownEvents;
    this.#reuseSnapshots = reuseSnapshots;
  }
  #wake(): void {
    for (const ready of this.#waiters) ready();
    this.#waiters.clear();
  }
  charge(bytes: number): void {
    check(
      this.#work + bytes <= this.#limits.encodedWorkBytes,
      "quota_paused",
      "Encoded model progress work limit reached",
    );
    this.#work += bytes;
  }
  accept(event: AssistantMessageEvent): boolean {
    if (this.#closed) return false;
    try {
      // Preserve the public stream's timing semantics on an isolated message.
      if (event.type === "done" || event.type === "error") {
        const message = event.type === "done" ? event.message : event.error;
        if (message.durationMs === undefined && message.timestamp >= this.#startedAt) {
          const timed = {
            ...message,
            durationMs: Math.max(0, Math.round(performance.now() - this.#started)),
          };
          event = event.type === "done" ? { ...event, message: timed } : { ...event, error: timed };
        }
      }
      const remaining = Math.min(
        this.#limits.messageBytes,
        this.#limits.encodedWorkBytes - this.#work,
      );
      check(remaining > 0, "quota_paused", "Encoded model progress work limit reached");
      // Only progress on this private Models handoff is reusable. SDK push
      // can add terminal timing, so terminal messages are revalidated.
      const known =
        this.#reuseSnapshots && event.type !== "done" && event.type !== "error"
          ? this.#knownEvents.get(event)
          : undefined;
      const copied = known === undefined ? boundedJsonCopy(event, remaining) : event;
      const bytes = known ?? new TextEncoder().encode(JSON.stringify(copied)).byteLength;
      check(bytes <= remaining, "quota_paused", "Encoded model progress work limit reached");
      if (this.#reuseSnapshots) this.#knownEvents.delete(event);
      else this.#knownEvents.set(copied, bytes);
      this.#work += bytes;
      check(
        this.#bytes + bytes <= this.#limits.queuedBytes,
        "quota_paused",
        "Model progress queue is full",
      );
      this.#queued.set(this.#write++, { event: copied, bytes });
      this.#bytes += bytes;
      if (copied.type === "done" || copied.type === "error") {
        this.#closed = true;
        super.end(copied.type === "done" ? copied.message : copied.error);
      }
      this.#wake();
      return true;
    } catch {
      this.reject(false);
      return false;
    }
  }
  reject(aborted: boolean): void {
    if (this.#closed) return;
    this.#cancel();
    // Undelivered snapshots need not survive a pressure failure. Already
    // delivered values are independent copies and cannot be mutated here.
    this.#queued.clear();
    this.#read = this.#write;
    this.#bytes = 0;
    this.#closed = true;
    const error = failed(this.#model, aborted);
    const event: AssistantMessageEvent = {
      type: "error",
      reason: aborted ? "aborted" : "error",
      error,
    };
    const bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
    this.#queued.set(this.#write++, { event, bytes });
    this.#bytes = bytes;
    super.end(error);
    this.#wake();
  }
  override push(event: AssistantMessageEvent): void {
    this.accept(event);
  }
  override end(result?: AssistantMessage): void {
    if (!result || result.stopReason === "pending") {
      this.reject(false);
      return;
    }
    if (result.stopReason === "error" || result.stopReason === "aborted")
      this.push({ type: "error", reason: result.stopReason, error: result });
    else this.push({ type: "done", reason: result.stopReason, message: result });
  }
  override async *[Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent, void> {
    try {
      while (true) {
        const queued = this.#queued.get(this.#read);
        if (queued) {
          this.#queued.delete(this.#read++);
          this.#bytes -= queued.bytes;
          yield queued.event;
        } else if (this.#closed) return;
        else await new Promise<void>((ready) => this.#waiters.add(ready));
      }
    } finally {
      if (!this.#closed) this.reject(true);
    }
  }
}

/**
 * Retain ONE controller per actor and install every replacement registry after
 * adding providers. Public Models handoffs are bounded separately from Provider
 * lanes; only Provider lanes count against concurrency. Pressure terminates the
 * caller and aborts upstream, retaining a lane until its public result settles.
 *
 * Copy work is O(accepted encoded work), not O(final text): 32MiB by default,
 * with a real task yield every32 RAW events. Contiguous provider deltas share
 * one snapshot per4KiB/100ms; raw deltas and forwarded snapshots charge work.
 * Provider allocation before this boundary and aggregate Pi/Agent
 * growth remain the owner's responsibility; maxTurns is not enforced here.
 */
export class ModelStorageBounds {
  readonly #wrapped = new WeakSet<Provider>();
  readonly #registries = new WeakSet<MutableModels>();
  readonly #handoffs = new WeakMap<AbortSignal, WeakMap<AssistantMessageEvent, number>>();
  readonly #concurrency: number;
  readonly #limits: ModelStorageSettings;
  #active = 0;
  constructor(concurrency: number, settings: Partial<ModelStorageSettings> = {}) {
    check(
      Number.isSafeInteger(concurrency) && concurrency > 0,
      "invalid_request",
      "Invalid model concurrency",
    );
    this.#concurrency = concurrency;
    this.#limits = { ...modelStorageLimits, ...settings };
    for (const [name, value] of Object.entries(this.#limits))
      check(
        Number.isSafeInteger(value) &&
          value > 0 &&
          value <= modelStorageLimits[name as keyof ModelStorageSettings],
        "invalid_request",
        "Invalid model storage setting",
      );
    check(
      this.#limits.messageBytes >= 4096 && this.#limits.queuedBytes >= 4096,
      "invalid_request",
      "Model storage bounds cannot hold a bounded terminal error",
    );
  }
  install(models: MutableModels): void {
    if (!this.#registries.has(models)) {
      this.#registries.add(models);
      const stream = models.stream.bind(models),
        simple = models.streamSimple.bind(models),
        deferred = models.streamDeferred.bind(models);
      // Models adds its own eager SDK queue around providers. Bound the public
      // final handoff too; validated OWN snapshots are shared, not cloned twice.
      models.stream = (model, context, options) =>
        this.#stream(
          model,
          options?.signal,
          (signal) => stream(model, context, Object.assign({}, options, { signal })),
          false,
        );
      models.streamSimple = (model, context, options) =>
        this.#stream(
          model,
          options?.signal,
          (signal) => simple(model, context, { ...options, signal }),
          false,
        );
      models.streamDeferred = (model, handle, options) =>
        this.#stream(
          model,
          options?.signal,
          (signal) => deferred(model, handle, { ...options, signal }),
          false,
        );
    }
    for (const provider of models.getProviders()) {
      if (this.#wrapped.has(provider)) continue;
      this.#wrapped.add(provider);
      const stream = provider.stream.bind(provider),
        simple = provider.streamSimple.bind(provider),
        deferred = provider.fetchDeferred?.bind(provider);
      provider.stream = (model, context, options) =>
        this.#stream(model, options?.signal, (signal) =>
          stream(model, context, Object.assign({}, options, { signal })),
        );
      provider.streamSimple = (model, context, options) =>
        this.#stream(model, options?.signal, (signal) =>
          simple(model, context, { ...options, signal }),
        );
      if (deferred)
        provider.fetchDeferred = (model, handle, options) =>
          this.#stream(model, options?.signal, (signal) =>
            deferred(model, handle, { ...options, signal }),
          );
    }
  }
  #stream(
    model: Model<Api>,
    caller: AbortSignal | undefined,
    start: (signal: AbortSignal) => AssistantMessageEventStream,
    ownsLane = true,
  ): AssistantMessageEventStream {
    const controller = new AbortController();
    const signal = caller ? AbortSignal.any([caller, controller.signal]) : controller.signal;
    const knownEvents = ownsLane
      ? ((caller ? this.#handoffs.get(caller) : undefined) ??
        new WeakMap<AssistantMessageEvent, number>())
      : new WeakMap<AssistantMessageEvent, number>();
    const output = new StorageEventStream(
      model,
      this.#limits,
      () => controller.abort(),
      knownEvents,
      !ownsLane,
    );
    if (caller?.aborted || (ownsLane && this.#active >= this.#concurrency)) {
      output.reject(!!caller?.aborted);
      return output;
    }
    if (ownsLane) this.#active++;
    else this.#handoffs.set(signal, knownEvents);
    const deadline = Date.now() + this.#limits.durationMs,
      timer = setTimeout(() => controller.abort(), this.#limits.durationMs);
    const drive = async () => {
      let iterator: AsyncIterator<AssistantMessageEvent> | undefined,
        source: AssistantMessageEventStream | undefined,
        onAbort: (() => void) | undefined,
        terminal = false,
        flushTimer: ReturnType<typeof setTimeout> | undefined;
      let batch: { event: DeltaEvent; chunks: string[]; bytes: number } | undefined;
      let flushReady: Promise<"flush"> | undefined;
      const clearBatch = () => {
        clearTimeout(flushTimer);
        flushTimer = undefined;
        flushReady = undefined;
        batch = undefined;
      };
      try {
        signal.throwIfAborted();
        source = start(signal);
        iterator = source[Symbol.asyncIterator]();
        const interrupted = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new Error("Bounded model stream interrupted"));
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        });
        let count = 0;
        const argumentBytes = new Map<number, number>();
        const forward = (event: AssistantMessageEvent) => {
          signal.throwIfAborted();
          const message =
            event.type === "done"
              ? event.message
              : event.type === "error"
                ? event.error
                : event.partial;
          const validated =
            !ownsLane && event.type !== "done" && event.type !== "error" && knownEvents.has(event);
          for (const block of validated ? [] : message.content)
            if (block.type === "toolCall")
              boundedJsonCopy(block.arguments, this.#limits.toolArgumentsBytes);
          if (event.type === "toolcall_end" && !validated)
            boundedJsonCopy(event.toolCall.arguments, this.#limits.toolArgumentsBytes);
          // Only actual SDK partials are copied; no reconstructed response state.
          check(output.accept(event), "quota_paused", "Model progress exceeds its bound");
        };
        const flush = async () => {
          if (!batch) return;
          const event = { ...batch.event, delta: batch.chunks.join("") };
          clearBatch();
          forward(event);
          // A flush and its following authoritative boundary can each approach
          // the queue envelope. Let public consumers drain between them.
          await new Promise<void>((ready) => setTimeout(ready, 0));
        };
        let pendingNext: Promise<IteratorResult<AssistantMessageEvent>> | undefined;
        while (true) {
          signal.throwIfAborted();
          check(Date.now() <= deadline, "quota_paused", "Model stream duration reached");
          pendingNext ??= iterator.next();
          const next = await Promise.race(
            flushReady ? [flushReady, pendingNext, interrupted] : [pendingNext, interrupted],
          );
          if (next === "flush") {
            await flush();
            // Retain this SAME outstanding read until it settles.
            continue;
          }
          pendingNext = undefined;
          if (next.done) break;
          check(++count <= this.#limits.events, "quota_paused", "Model progress limit reached");
          const event = next.value;
          terminal = event.type === "done" || event.type === "error";
          if (event.type === "toolcall_end") argumentBytes.delete(event.contentIndex);
          const delta =
            event.type === "text_delta" ||
            event.type === "thinking_delta" ||
            event.type === "toolcall_delta";
          if (ownsLane && delta) {
            // Bound raw encoded work BEFORE retaining the delta. No growing
            // partial is serialized until its cadence/boundary flush.
            check(
              event.delta.length <= this.#limits.messageBytes,
              "quota_paused",
              "Model delta too large",
            );
            const bytes = new TextEncoder().encode(JSON.stringify(event.delta)).byteLength;
            check(
              bytes <= this.#limits.messageBytes,
              "quota_paused",
              "Encoded model delta exceeds its byte bound",
            );
            output.charge(bytes);
            if (event.type === "toolcall_delta") {
              const total =
                (argumentBytes.get(event.contentIndex) ?? 0) +
                new TextEncoder().encode(event.delta).byteLength;
              check(
                total <= this.#limits.toolArgumentsBytes,
                "quota_paused",
                "Encoded tool arguments exceed their byte bound",
              );
              argumentBytes.set(event.contentIndex, total);
            }
            if (
              batch &&
              (batch.event.type !== event.type ||
                batch.event.contentIndex !== event.contentIndex ||
                batch.bytes + bytes > progressBytes)
            )
              await flush();
            if (bytes > progressBytes) forward(event);
            else {
              if (!batch) {
                batch = { event, chunks: [], bytes: 0 };
                flushReady = new Promise<"flush">((ready) => {
                  flushTimer = setTimeout(() => ready("flush"), progressMs);
                });
              }
              batch.event = event;
              batch.chunks.push(event.delta);
              batch.bytes += bytes;
              if (batch.bytes >= progressBytes) await flush();
            }
          } else {
            await flush();
            forward(event);
          }
          if (terminal) break;
          // Yield to actual cancellation/deadline tasks even during a
          // microtask-only provider flood. This is not a replacement Pi loop.
          if (count % 32 === 0) await new Promise<void>((ready) => setTimeout(ready, 0));
        }
        check(terminal, "interrupted", "Model stream ended without its terminal result");
      } catch {
        output.reject(!!caller?.aborted);
      } finally {
        clearBatch();
        clearTimeout(timer);
        if (onAbort) signal.removeEventListener("abort", onAbort);
        controller.abort();
        if (!ownsLane) this.#handoffs.delete(signal);
        // Provider cancellation uses its supported signal. Its iterator cleanup is
        // observed without letting a broken provider strand the caller's receipt.
        const release = () => {
          if (ownsLane) this.#active--;
        };
        if (terminal || !source) release();
        else {
          // A caller's receipt is bounded, but an uncooperative provider still
          // owns its actor slot until its public terminal result settles.
          try {
            // Returning a consumer iterator does not prove provider closure.
            void source.result().then(release, release);
          } catch {
            /* No cleanup evidence: retain the slot conservatively. */
          }
        }
        try {
          if (iterator?.return) void iterator.return().catch(() => {});
        } catch {
          /* Cleanup failure cannot fabricate public lane closure. */
        }
      }
    };
    void drive();
    return output;
  }
}
