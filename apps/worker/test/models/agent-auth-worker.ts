import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentSession } from "../../src/agent/agent-session.js";
import type { Admission } from "../../src/agent/conversations.js";
import type { ConversationRow } from "../../src/agent/store.js";
import { routeRequest } from "../../src/api/router.js";
import type * as D from "../../src/boundary/dto.js";
import type { Env } from "../../src/boundary/env.js";
import { ControlPlane as RealControlPlane } from "../../src/control/control-plane.js";
import { retainedModelConfigurations } from "../../src/models/retained.js";

export { WorkspaceProxy } from "@cloudflare/computer";
export { WorkspaceObject } from "../../src/workspace/workspace-object.js";

const fixtureKeys = {
  openai: "synthetic-first-admission-openai",
  anthropic: "synthetic-first-admission-anthropic",
};
const facts = {
  openai: { calls: 0, authorized: false, apiKeyCalls: 0, oauthCalls: 0 },
  anthropic: { calls: 0, authorized: false },
};
const modelAuthKey = btoa("m".repeat(32));
let omitOpenai = false;
/** Used only by a generated fixture entry after a real process restart. */
export function omitOpenaiBinding() {
  omitOpenai = true;
}
export class ControlPlane extends RealControlPlane {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, {
      ...env,
      FORTIPI_MODEL_AUTH_KEY: modelAuthKey,
      FORTIPI_CONFIG: {
        ...env.FORTIPI_CONFIG,
        workspace: { kind: "local", executorId: "executor", rootBindingId: "root" },
        execution: { kind: "native", executorId: "executor", trust: "host" },
        routing: { kind: "explicit", targetIds: ["executor"] },
        models: [
          {
            providerId: "openai",
            modelId: "gpt-5.4",
            auth: { kind: "oauth", providerId: "openai" },
          },
        ],
      },
    });
  }
}
let held = false;
let release = Promise.withResolvers<void>();
function sse(events: Record<string, unknown>[]) {
  return new Response(
    events.map((data) => `event: ${String(data.type)}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
    {
      headers: { "Content-Type": "text/event-stream" },
    },
  );
}

// Only provider HTTP is substituted. The real AgentSession, Models, credential
// resolution, pinned provider adapter and Pi generation all execute unchanged.
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init),
    url = new URL(request.url),
    body = (await request.json()) as { model: string };
  if (url.hostname === "api.openai.com" && url.pathname === "/v1/responses") {
    facts.openai.calls++;
    const apiKey = request.headers.get("Authorization") === `Bearer ${fixtureKeys.openai}`,
      oauth = request.headers.get("Authorization") === "Bearer synthetic-registry-oauth-access";
    facts.openai.authorized = apiKey || oauth;
    facts.openai.apiKeyCalls += Number(apiKey);
    facts.openai.oauthCalls += Number(oauth);
    if (held) {
      const aborted = Promise.withResolvers<void>();
      const onAbort = () => aborted.reject(new Error("Synthetic model request aborted"));
      request.signal.addEventListener("abort", onAbort, { once: true });
      try {
        request.signal.throwIfAborted();
        await Promise.race([release.promise, aborted.promise]);
      } finally {
        request.signal.removeEventListener("abort", onAbort);
      }
    }
    const item = {
      id: "message",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "openai-answer", annotations: [] }],
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
        delta: "openai-answer",
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
    facts.anthropic.calls++;
    facts.anthropic.authorized = request.headers.get("x-api-key") === fixtureKeys.anthropic;
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
        delta: { type: "text_delta", text: "anthropic-answer" },
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
  throw new Error("Unexpected model fixture network destination");
};

/** No alternate model builder; credentials go through the real service factory. */
export class TestAgentSession extends AgentSession {
  #expireFinalSelection = false;
  #expiredAfterCommit = false;
  constructor(ctx: DurableObjectState, env: Env) {
    const modelEnv: Env = {
      ...env,
      OPENAI_API_KEY: fixtureKeys.openai,
      ANTHROPIC_API_KEY: fixtureKeys.anthropic,
      FORTIPI_MODEL_AUTH_KEY: modelAuthKey,
    };
    if (omitOpenai) delete modelEnv.OPENAI_API_KEY;
    super(ctx, modelEnv);
    const current = this.authority.current.bind(this.authority);
    this.authority.current = async (auth, resources, tx) => {
      // The production selection really commits. Expire exactly its later
      // request check through the real Authority, never replace the factory.
      if (this.#expireFinalSelection && !tx) {
        const selected = await this.store.get<D.ModelConfig>("meta", "selected-model");
        if (selected && "auth" in selected && selected.auth.kind === "oauth") {
          this.#expireFinalSelection = false;
          this.#expiredAfterCommit = true;
          return current({ ...auth, deadline: 0 }, resources);
        }
      }
      return current(auth, resources, tx);
    };
  }
  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/__models/")) return super.onRequest(request);
    if (request.headers.get("Authorization") !== `Bearer ${this.env.FORTIPI_ADMIN_TOKEN}`)
      return new Response(null, { status: 403 });
    const action = url.pathname.split("/").at(-1);
    if (action === "facts") return Response.json(facts);
    if (action === "hold") {
      held = true;
      release = Promise.withResolvers<void>();
      return Response.json({ held });
    }
    if (action === "release") {
      held = false;
      release.resolve();
      return Response.json({ held });
    }
    await this.lifecycle.start();
    if (action === "pending-model-intents") {
      await this.store.put("admission-intent", "fixture-selected", {
        state: "pending",
        model: {
          providerId: "openai",
          modelId: "gpt-5.4",
          auth: { kind: "secretRef", secretRef: "OPENAI_API_KEY" },
        },
      });
      await this.store.put("admission-intent", "fixture-unselected", { state: "pending" });
      await this.store.put("admission-intent", "fixture-null", { state: "pending", model: null });
      return Response.json({ saved: true });
    }
    if (action === "retained-models") {
      const retained = await retainedModelConfigurations(this.store);
      return Response.json({
        providers: retained.configurations.map((model) => model.providerId).sort(),
      });
    }
    if (action === "expire-final-selection") {
      this.#expireFinalSelection = true;
      return Response.json({ armed: true });
    }
    if (action === "state") {
      const admissions = await this.store.page<Admission>("admission"),
        selected = await this.store.get<D.ModelConfig>("meta", "selected-model");
      return Response.json({
        settled: admissions.every((row) => row.value.state === "settled"),
        selectedAuth: selected && "auth" in selected ? selected.auth.kind : null,
        selectedProvider: selected?.providerId ?? null,
        expiredAfterCommit: this.#expiredAfterCommit,
        openaiBindingPresent: !!this.env.OPENAI_API_KEY,
        ready: this.lifecycle.isStarted(),
      });
    }
    if (action === "canary") {
      if (request.method === "PUT")
        await this.store.put("auth-fixture", "canary", { committed: true });
      return Response.json({ committed: !!(await this.store.get("auth-fixture", "canary")) });
    }
    if (action === "entries") {
      const row = await this.store.get<ConversationRow>(
        "conversation",
        url.searchParams.get("cid") ?? "",
      );
      if (!row) return new Response(null, { status: 404 });
      const entries = await this.pi
        .session(row.piId)
        .entries({ order: "ascending" }, 100, BACKGROUND_CONTEXT);
      return Response.json(
        entries.items.filter((entry) => entry.kind === "pi.assistant").map((entry) => entry.data),
      );
    }
    return new Response(null, { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: Env) {
    if (new URL(request.url).pathname === "/__test/ping") return new Response("ready");
    const match = /^\/__models\/([A-Za-z0-9_-]+)\//.exec(new URL(request.url).pathname);
    if (match?.[1]) {
      const response = await env.AGENT_SESSIONS.getByName(match[1]).fetch(request);
      if (!response.ok && !response.headers.get("Content-Type")?.includes("application/json")) {
        const failure = await response.text();
        return Response.json(
          {
            ready: false,
            missingBoundCredential: failure.includes("Selected model secret is missing"),
          },
          { status: response.status },
        );
      }
      return response;
    }
    return routeRequest(request, env);
  },
};
