import assert from "node:assert/strict";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { ModelStorageBounds } from "../../src/models/bounded.ts";

test("public Models complete methods use the bounded final handoff while the provider result is stalled", async () => {
  for (const method of ["complete", "completeSimple"] as const) {
    const controller = new ModelStorageBounds(1, { queuedBytes: 4096 });
    const provider = fauxProvider(),
      source = new AssistantMessageEventStream(),
      partial = fauxAssistantMessage("x".repeat(128));
    let starts = 0,
      aborted = false;
    provider.provider.stream = (_model, _context, options) => {
      starts++;
      options?.signal?.addEventListener(
        "abort",
        () => {
          aborted = true;
        },
        { once: true },
      );
      // Public result deliberately remains unsettled despite the abort signal.
      // Start/end boundaries must pass through batching. Empty contiguous deltas
      // legitimately coalesce and no longer create a stalled final queue.
      for (let i = 0; i < 40; i++) {
        source.push({ type: "text_start", contentIndex: 0, partial });
        source.push({ type: "text_end", contentIndex: 0, content: "x".repeat(128), partial });
      }
      return source;
    };
    provider.provider.streamSimple = provider.provider.stream;
    const models = createModels();
    models.setProvider(provider.provider);
    controller.install(models);
    const pending = models[method](provider.getModel(), { messages: [] });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(aborted, true, `${method} must abort a stalled final-handoff backlog`);
      const result = await pending;
      assert.equal(result.stopReason, "error");
      assert.deepEqual(result.content, []);
      assert.ok(JSON.stringify(result).length < 4096);
      const replacement = createModels();
      replacement.setProvider(provider.provider);
      controller.install(replacement);
      assert.equal(
        (await replacement[method](provider.getModel(), { messages: [] })).stopReason,
        "error",
      );
      assert.equal(starts, 1, "Abort cannot free the unclosed provider's actor lane");
    } finally {
      source.end(fauxAssistantMessage("actual public provider closure"));
      await pending;
    }
  }
});
