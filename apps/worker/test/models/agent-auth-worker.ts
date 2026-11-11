import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentSession } from "../../src/agent/agent-session.js";
import type { ConversationRow } from "../../src/agent/store.js";
import { routeRequest } from "../../src/api/router.js";
import type { Env } from "../../src/boundary/env.js";

export { WorkspaceProxy } from "@cloudflare/computer";
export { ControlPlane } from "../../src/control/control-plane.js";
export { WorkspaceObject } from "../../src/workspace/workspace-object.js";

const fixtureKeys = {
  openai: "synthetic-first-admission-openai",
  anthropic: "synthetic-first-admission-anthropic",
};
const facts = {
  openai: { calls: 0, authorized: false },
  anthropic: { calls: 0, authorized: false },
};
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
    facts.openai.authorized =
      request.headers.get("Authorization") === `Bearer ${fixtureKeys.openai}`;
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
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, {
      ...env,
      OPENAI_API_KEY: fixtureKeys.openai,
      ANTHROPIC_API_KEY: fixtureKeys.anthropic,
    });
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
  fetch(request: Request, env: Env) {
    if (new URL(request.url).pathname === "/__test/ping") return new Response("ready");
    const match = /^\/__models\/([A-Za-z0-9_-]+)\//.exec(new URL(request.url).pathname);
    if (match) return env.AGENT_SESSIONS.getByName(match[1]!).fetch(request);
    return routeRequest(request, env);
  },
};
