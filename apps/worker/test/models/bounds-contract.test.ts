import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { createAI } from "agents/models/pi-ai";
import { ModelStorageBounds, modelStorageLimits } from "../../src/models/bounded.ts";

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function registry(
  bounds: ModelStorageBounds,
  start: (signal: AbortSignal | undefined) => AssistantMessageEventStream,
) {
  const faux = fauxProvider({ models: [{ id: "bounded-contract" }] }),
    models = createModels();
  faux.provider.stream = (_model, _context, options) => start(options?.signal);
  faux.provider.streamSimple = (_model, _context, options) => start(options?.signal);
  models.setProvider(faux.provider);
  bounds.install(models);
  return { models, model: faux.getModel(), provider: faux.provider };
}
function completed() {
  const stream = new AssistantMessageEventStream(),
    message = fauxAssistantMessage("finished");
  stream.push({ type: "start", partial: message });
  stream.push({ type: "done", reason: "stop", message });
  return stream;
}

test("queued encoded progress stays bounded when the public stream consumer stalls", async () => {
  const bounded = registry(new ModelStorageBounds(1), () => {
    const stream = new AssistantMessageEventStream(),
      partial = fauxAssistantMessage("x".repeat(102400));
    stream.push({ type: "start", partial });
    for (let i = 0; i < 10; i++)
      stream.push({ type: "text_delta", contentIndex: 0, delta: "", partial });
    stream.push({ type: "done", reason: "stop", message: partial });
    return stream;
  });
  const output = bounded.models.streamSimple(bounded.model, { messages: [] });
  const result = await output.result();
  let queuedBytes = 0;
  for await (const event of output)
    queuedBytes += new TextEncoder().encode(JSON.stringify(event)).byteLength;
  console.log(JSON.stringify({ queuedBytes, backlogRejected: result.stopReason === "error" }));
  assert.equal(
    result.stopReason,
    "error",
    "A bounded queue must reject stalled-consumer progress pressure",
  );
  assert.ok(queuedBytes <= modelStorageLimits.messageBytes);
});

test("cancelled provider cleanup retains the actor slot across a replacement Models registry", async () => {
  const bounds = new ModelStorageBounds(1),
    upstream = new AssistantMessageEventStream(),
    caller = new AbortController();
  let began = false,
    observedAbort = false,
    replacementStarts = 0;
  const first = registry(bounds, (signal) => {
    began = true;
    signal?.addEventListener(
      "abort",
      () => {
        observedAbort = true;
      },
      { once: true },
    );
    return upstream;
  });
  const output = first.models.streamSimple(
    first.model,
    { messages: [] },
    { signal: caller.signal },
  );
  for (let i = 0; i < 50 && !began; i++) await pause();
  assert.equal(began, true);
  caller.abort();
  assert.equal((await output.result()).stopReason, "aborted");
  assert.equal(observedAbort, true);
  await pause();
  const second = registry(bounds, () => {
    replacementStarts++;
    return completed();
  });
  const result = await second.models.completeSimple(second.model, { messages: [] });
  console.log(JSON.stringify({ replacementStarts, slotRetained: result.stopReason === "error" }));
  // Resolve the deliberately uncooperative provider through its public API.
  upstream.push({
    type: "error",
    reason: "aborted",
    error: fauxAssistantMessage("", { stopReason: "aborted" }),
  });
  await pause();
  assert.equal(replacementStarts, 0, "Cancellation alone cannot certify provider cleanup");
  assert.equal(result.stopReason, "error");
  assert.equal(
    (await second.models.completeSimple(second.model, { messages: [] })).stopReason,
    "stop",
  );
});

test("outer queue pressure aborts the original Models signal before a cooperative producer keeps growing", async () => {
  let cancelled = false,
    produced = 0;
  const bounds = new ModelStorageBounds(1, { durationMs: 1000 });
  const bounded = registry(bounds, (signal) => {
    const source = new AssistantMessageEventStream(),
      partial = fauxAssistantMessage("x".repeat(102400));
    signal?.addEventListener(
      "abort",
      () => {
        cancelled = true;
        source.push({
          type: "error",
          reason: "aborted",
          error: fauxAssistantMessage("", { stopReason: "aborted" }),
        });
      },
      { once: true },
    );
    source.push({ type: "start", partial });
    void (async () => {
      while (!cancelled && produced < 10) {
        await pause();
        if (cancelled) return;
        produced++;
        source.push({ type: "text_delta", contentIndex: 0, delta: "", partial });
      }
    })();
    return source;
  });
  const output = bounded.models.streamSimple(bounded.model, { messages: [] });
  assert.equal((await output.result()).stopReason, "error");
  assert.equal(cancelled, true);
  assert.ok(
    produced >= 2 && produced < 10,
    "The final queue bound must cancel upstream before the later duration limit",
  );
  await pause();
  const replacement = registry(bounds, completed);
  assert.equal(
    (await replacement.models.completeSimple(replacement.model, { messages: [] })).stopReason,
    "stop",
  );
});

test("toolcall_end arguments are bounded independently of its shared partial", async () => {
  const bounded = registry(new ModelStorageBounds(1), () => {
    const stream = new AssistantMessageEventStream(),
      partial = fauxAssistantMessage("");
    stream.push({ type: "start", partial });
    stream.push({
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: fauxToolCall("tool", { text: "x".repeat(70000) }),
      partial,
    });
    stream.push({ type: "done", reason: "stop", message: partial });
    return stream;
  });
  const output = bounded.models.streamSimple(bounded.model, { messages: [] });
  const events: AssistantMessageEvent[] = [];
  for await (const event of output) events.push(event);
  assert.equal(
    events.some((event) => event.type === "toolcall_end"),
    false,
    "No oversized authoritative arguments may cross into Pi",
  );
  assert.equal((await output.result()).stopReason, "error");
});

test("forwarded progress is isolated from subsequent provider mutation and unsafe public replay", async () => {
  const upstream = new AssistantMessageEventStream(),
    raw = fauxAssistantMessage("accepted"),
    bounds = new ModelStorageBounds(1);
  const bounded = registry(bounds, () => upstream);
  const output = bounded.models.streamSimple(bounded.model, { messages: [] });
  const iterator = output[Symbol.asyncIterator]();
  upstream.push({ type: "start", partial: raw });
  const accepted = await iterator.next();
  assert.equal(accepted.done, false);
  const retained = accepted.value;
  raw.content = [{ type: "text", text: "x".repeat(524288) }];
  upstream.push({ type: "done", reason: "stop", message: raw });
  assert.equal((await output.result()).stopReason, "error");
  assert.ok(retained && "partial" in retained);
  assert.equal(
    JSON.stringify(retained.partial).includes("x".repeat(65537)),
    false,
    "Provider mutation cannot change an accepted snapshot",
  );
  await iterator.return?.();

  // An arbitrary provider may replay an object that a previous public caller
  // mutated. It must never gain the private handoff's validated status.
  const directSource = new AssistantMessageEventStream();
  const direct = registry(bounds, () => directSource);
  const directStream = direct.provider.streamSimple(
    direct.model,
    normalizeContext({ messages: [] }),
  );
  directSource.push({ type: "start", partial: fauxAssistantMessage("public") });
  const directIterator = directStream[Symbol.asyncIterator]();
  const exposed = await directIterator.next();
  directSource.push({ type: "done", reason: "stop", message: fauxAssistantMessage("public") });
  await directStream.result();
  await directIterator.return?.();
  assert.ok(exposed.value && "partial" in exposed.value);
  exposed.value.partial.content = [{ type: "text", text: "x".repeat(524288) }];
  const replayed = exposed.value;
  const replay = registry(bounds, () => {
    const source = new AssistantMessageEventStream();
    source.push(replayed);
    source.push({ type: "done", reason: "stop", message: fauxAssistantMessage("end") });
    return source;
  });
  assert.equal(
    (await replay.models.completeSimple(replay.model, { messages: [] })).stopReason,
    "error",
  );
});

test("normal stream, simple and actual deferred public APIs preserve terminal and cancellation contracts", async () => {
  const bounds = new ModelStorageBounds(1),
    faux = fauxProvider({ deferred: { pendingFetches: 0 }, tokensPerSecond: 1000000 }),
    models = createModels();
  models.setProvider(faux.provider);
  const auth = faux.provider.auth;
  bounds.install(models);
  bounds.install(models);
  assert.equal(faux.provider.auth, auth);
  for (const mode of ["stream", "streamSimple"] as const) {
    faux.setResponses([fauxAssistantMessage("normal")]);
    const output = models[mode](faux.getModel(), { messages: [] });
    assert.ok(output instanceof AssistantMessageEventStream);
    const events: AssistantMessageEvent[] = [];
    for await (const event of output) events.push(event);
    assert.equal(events[0]?.type, "start");
    assert.equal(events.at(-1)?.type, "done");
    assert.equal((await output.result()).stopReason, "stop");
  }
  faux.setResponses([fauxAssistantMessage("deferred result")]);
  const pending = await models.completeSimple(
    faux.getModel(),
    { messages: [] },
    { deferred: true },
  );
  assert.equal(pending.stopReason, "deferred");
  assert.ok(pending.deferred);
  const output = models.streamDeferred(faux.getModel(), pending.deferred);
  for await (const _event of output) {
    /* consume progress */
  }
  assert.equal((await output.result()).stopReason, "stop");
  await models.cancelDeferred(faux.getModel(), pending.deferred);
  assert.equal(faux.state.cancelledDeferred.length, 1);
});

test("preaborted, active caller cancellation, deadlines and early iterator return produce bounded terminals", async () => {
  const bounds = new ModelStorageBounds(1, { durationMs: 30 });
  let starts = 0,
    cancelled = false;
  const bounded = registry(bounds, (signal) => {
    starts++;
    const stream = new AssistantMessageEventStream();
    stream.push({ type: "start", partial: fauxAssistantMessage("started") });
    signal?.addEventListener(
      "abort",
      () => {
        cancelled = true;
        stream.push({
          type: "error",
          reason: "aborted",
          error: fauxAssistantMessage("", { stopReason: "aborted" }),
        });
      },
      { once: true },
    );
    return stream;
  });
  const cancelledBefore = AbortSignal.abort();
  assert.equal(
    (
      await bounded.models.completeSimple(
        bounded.model,
        { messages: [] },
        { signal: cancelledBefore },
      )
    ).stopReason,
    "aborted",
  );
  assert.equal(starts, 0);
  const caller = new AbortController(),
    output = bounded.models.streamSimple(
      bounded.model,
      { messages: [] },
      { signal: caller.signal },
    );
  const iterator = output[Symbol.asyncIterator]();
  await iterator.next();
  caller.abort();
  assert.equal((await output.result()).stopReason, "aborted");
  await iterator.return?.();
  assert.equal(cancelled, true);
  await pause();
  cancelled = false;
  const deadline = bounded.models.streamSimple(bounded.model, { messages: [] });
  assert.equal((await deadline.result()).stopReason, "error");
  assert.equal(cancelled, true);
  await pause();
  const early = bounded.models.streamSimple(bounded.model, { messages: [] }),
    consumer = early[Symbol.asyncIterator]();
  await consumer.next();
  await consumer.return?.();
  assert.equal((await early.result()).stopReason, "aborted");
});

test("finite encoded work and real task yields stop high churn before unbounded CPU work", async () => {
  const bounds = new ModelStorageBounds(1, { encodedWorkBytes: 65536 });
  let aborted = false;
  const bounded = registry(bounds, (signal) => {
    signal?.addEventListener(
      "abort",
      () => {
        aborted = true;
      },
      { once: true },
    );
    const stream = new AssistantMessageEventStream(),
      partial = fauxAssistantMessage("x".repeat(4096));
    stream.push({ type: "start", partial });
    for (let i = 0; i < 200; i++)
      stream.push({ type: "text_delta", delta: "", contentIndex: 0, partial });
    stream.push({ type: "done", reason: "stop", message: partial });
    return stream;
  });
  const output = bounded.models.streamSimple(bounded.model, { messages: [] });
  for await (const _event of output) {
    /* keep the consumer fast: exercise work, not queue pressure */
  }
  const limited = await output.result();
  console.log(
    JSON.stringify({ workLimited: limited.stopReason === "error", providerCancelled: aborted }),
  );
  assert.equal(limited.stopReason, "error");
  assert.equal(aborted, true);

  const caller = new AbortController();
  let began = false;
  const flood = registry(new ModelStorageBounds(1), () => {
    began = true;
    setTimeout(() => caller.abort(), 0);
    const stream = new AssistantMessageEventStream(),
      partial = fauxAssistantMessage("small");
    stream.push({ type: "start", partial });
    for (let i = 0; i < 4000; i++)
      stream.push({ type: "text_delta", delta: "", contentIndex: 0, partial });
    stream.push({ type: "done", reason: "stop", message: partial });
    return stream;
  });
  const flooded = flood.models.streamSimple(
    flood.model,
    { messages: [] },
    { signal: caller.signal },
  );
  for await (const _event of flooded) {
    /* drain */
  }
  assert.equal(began, true);
  assert.equal(
    (await flooded.result()).stopReason,
    "aborted",
    "A real timer must interrupt a microtask-only provider flood",
  );
});

test("pinned OpenAI, Anthropic and Cloudflare adapters retain their actual Models auth and terminal protocols", async () => {
  const originalFetch = globalThis.fetch;
  const authorized: boolean[] = [];
  const sse = (events: Record<string, unknown>[]) =>
    new Response(
      events
        .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
        .join(""),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init),
      url = new URL(request.url),
      body = (await request.json()) as { model: string };
    if (url.hostname === "api.openai.com" && url.pathname === "/v1/responses") {
      authorized.push(request.headers.get("Authorization") === "Bearer synthetic-openai-bound-key");
      const item = {
        id: "message",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "adapter-output", annotations: [] }],
      };
      return sse([
        { type: "response.created", response: { id: "response", model: body.model } },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...item, status: "in_progress", content: [] },
        },
        {
          type: "response.content_part.added",
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        },
        {
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          delta: "adapter-output",
        },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            id: "response",
            status: "completed",
            model: body.model,
            output: [item],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ]);
    }
    if (url.hostname === "api.anthropic.com" && url.pathname === "/v1/messages") {
      authorized.push(request.headers.get("x-api-key") === "synthetic-anthropic-bound-key");
      return sse([
        {
          type: "message_start",
          message: {
            id: "message",
            model: body.model,
            type: "message",
            role: "assistant",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "adapter-output" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        },
        { type: "message_stop" },
      ]);
    }
    if (url.hostname === "api.cloudflare.com" && url.pathname.includes("/ai/run/@cf/")) {
      authorized.push(
        request.headers.get("Authorization") === "Bearer synthetic-cloudflare-bound-key",
      );
      return Response.json({
        id: "fixture",
        object: "chat.completion",
        model: "@cf/zai-org/glm-5.3-flash",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "adapter-output" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }
    throw new Error("Unexpected bounded adapter fixture destination");
  };
  try {
    const keys = new Map([
      ["openai", "synthetic-openai-bound-key"],
      ["anthropic", "synthetic-anthropic-bound-key"],
    ]);
    const models = createModels({
      credentials: {
        read: async (id) => {
          const key = keys.get(id);
          return key ? { type: "api_key", key } : undefined;
        },
        list: async () =>
          [...keys.keys()].map((providerId) => ({ providerId, type: "api_key" as const })),
        modify: async () => {
          throw new Error("Read-only test credentials");
        },
        delete: async () => {
          throw new Error("Read-only test credentials");
        },
      },
      authContext: { env: async () => undefined, fileExists: async () => false },
    });
    const cloud = createAI({
      accountId: "synthetic-account",
      apiToken: "synthetic-cloudflare-bound-key",
    });
    for (const provider of [openaiProvider(), anthropicProvider(), cloud.provider])
      models.setProvider(provider);
    const bounds = new ModelStorageBounds(1);
    bounds.install(models);
    for (const [providerId, modelId] of [
      ["openai", "gpt-5.4"],
      ["anthropic", "claude-opus-4-7"],
      ["cloudflare", "@cf/zai-org/glm-5.3-flash"],
    ] as const) {
      const model = models.getModel(providerId, modelId);
      assert.ok(model);
      const output = models.streamSimple(model, {
        messages: [{ role: "user", content: "bounded adapter", timestamp: Date.now() }],
      });
      for await (const _event of output) {
        /* actual provider event protocol */
      }
      const result = await output.result();
      assert.equal(result.stopReason, "stop", providerId);
      assert.equal(
        result.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(""),
        "adapter-output",
      );
    }
    assert.deepEqual(authorized, [true, true, true]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
