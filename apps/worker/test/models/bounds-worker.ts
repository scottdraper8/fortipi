import { DurableObject } from "cloudflare:workers";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { ModelStorageBounds } from "../../src/models/bounded.js";

/** Helper qualification: real PiHarness/Lifecycle/SQLite, synthetic provider only. */
export class BoundsProbe extends DurableObject {
  readonly lifecycle = Lifecycle.install(this);
  readonly bounds = new ModelStorageBounds(1);
  readonly faux = fauxProvider({
    models: [{ id: "bounded" }],
    tokensPerSecond: 1000000,
    tokenSize: { min: 1024, max: 1024 },
  });
  #progress = false;
  #signal: AbortSignal | undefined;
  #chunkBytes = 1024;
  #responseProvider: ReturnType<typeof fauxProvider> | undefined;
  readonly pi = new PiHarness({
    defaults: { model: this.faux.getModel(), maxTurns: 4 },
    harness: async ({ storage, context, onWake }) => {
      const models = createModels();
      const provider = fauxProvider({
        models: [{ id: "bounded" }],
        tokensPerSecond: 1000000,
        // The pinned faux provider emits four ASCII characters per faux token.
        tokenSize: { min: this.#chunkBytes / 4, max: this.#chunkBytes / 4 },
      });
      this.#responseProvider = provider;
      const original = provider.provider.streamSimple.bind(provider.provider);
      provider.provider.streamSimple = (model, messages, options) => {
        this.#signal = options?.signal;
        if (!this.#progress) return original(model, messages, options);
        const stream = new AssistantMessageEventStream(),
          partial = fauxAssistantMessage("bounded progress");
        stream.push({ type: "start", partial });
        for (let i = 0; i < 16400; i++)
          stream.push({ type: "text_delta", contentIndex: 0, delta: "", partial });
        stream.push({ type: "done", reason: "stop", message: partial });
        stream.end();
        return stream;
      };
      models.setProvider(provider.provider);
      this.bounds.install(models);
      return Harness.open(
        storage,
        {
          models,
          registry: createRegistry(),
          onWake,
          settings: {
            retry: { enabled: false, maxRetries: 0 },
            afterFailedRun: "keep",
            progress: { persistWithinMs: 1000 },
          },
        },
        context,
      );
    },
  });
  constructor(ctx: DurableObjectState, env: object) {
    super(ctx, env);
    this.lifecycle.use(this.pi);
  }
  async run(
    kind:
      | "text"
      | "unicode"
      | "thinking"
      | "thinking-unicode"
      | "tool"
      | "tool-unicode"
      | "error"
      | "progress"
      | "chunked"
      | "high-churn",
    size: number,
  ) {
    this.#progress = kind === "progress";
    if (kind === "chunked" || kind === "high-churn") {
      this.#chunkBytes = kind === "chunked" ? 256 : 32;
    }
    await this.lifecycle.start();
    let message = fauxAssistantMessage("x".repeat(size));
    if (kind === "unicode") message = fauxAssistantMessage("🧪".repeat(size));
    if (kind === "thinking") message.content = [{ type: "thinking", thinking: "x".repeat(size) }];
    if (kind === "thinking-unicode")
      message.content = [{ type: "thinking", thinking: "🧪".repeat(size) }];
    if (kind === "tool")
      message = fauxAssistantMessage(fauxToolCall("unknown-tool", { command: "x".repeat(size) }), {
        stopReason: "toolUse",
      });
    if (kind === "tool-unicode")
      message = fauxAssistantMessage(fauxToolCall("unknown-tool", { command: "🧪".repeat(size) }), {
        stopReason: "toolUse",
      });
    if (kind === "error")
      message = {
        ...fauxAssistantMessage(""),
        stopReason: "error",
        errorMessage: "x".repeat(size),
      };
    if (!this.#responseProvider) throw new Error("Actual provider was not initialized");
    this.#responseProvider.setResponses([message]);
    const session = await this.pi.sessions.create(),
      before = this.ctx.storage.sql.databaseSize,
      result = await this.pi.session(session.id).prompt("bounded infrastructure fixture");
    const encoded = result.messages.flatMap((entry) =>
      (entry.model ?? [])
        .filter((value) => value.role === "assistant")
        .map((value) => JSON.stringify(value)),
    );
    const response = {
      status: result.status,
      textBytes: new TextEncoder().encode(result.text ?? "").byteLength,
      maxAssistantBytes: Math.max(
        0,
        ...encoded.map((value) => new TextEncoder().encode(value).byteLength),
      ),
      containsLargeData: encoded.some((value) => value.includes("x".repeat(65537))),
      providerCancelled: this.#signal?.aborted === true,
      physicalBefore: before,
      physicalAfter: this.ctx.storage.sql.databaseSize,
    };
    await this.pi.dispose();
    const reopened = await this.pi.session(session.id).entries({ order: "ascending" }, 100);
    const retainedBytes = reopened.items
      .flatMap((entry) => entry.model ?? [])
      .filter((entry) => entry.role === "assistant")
      .reduce(
        (total, entry) => total + new TextEncoder().encode(JSON.stringify(entry)).byteLength,
        0,
      );
    await this.pi.dispose();
    return { ...response, retainedBytes, chunkBytes: this.#chunkBytes };
  }
}
export default { fetch: () => new Response("test-only model bounds") };
