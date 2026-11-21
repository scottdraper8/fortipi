import { DurableObject } from "cloudflare:workers";

/** Synthetic canaries only. These never name or load operator credentials. */
export const canaries = {
  access: "fortipi-model-canary-access",
  refresh: "fortipi-model-canary-refresh",
  fresh: "fortipi-model-canary-refreshed",
  anthropicFresh: "sk-ant-oat01-fortipi-model-canary-refreshed",
  rotated: "fortipi-model-canary-rotated",
  replacement: "fortipi-model-canary-replacement",
  client: "fortipi-model-canary-client",
  openai: "fortipi-model-canary-openai-key",
  anthropic: "fortipi-model-canary-anthropic-key",
};
export function containsCanary(value: unknown): boolean {
  const text = JSON.stringify(value);
  return Object.values(canaries).some((canary) => text.includes(canary));
}
function sse(events: Record<string, unknown>[]) {
  return new Response(
    events
      .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
      .join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
export class ModelProtocolPeer extends DurableObject {
  #gate: Promise<void> | undefined;
  #release: (() => void) | undefined;
  #entered = false;
  #mode: "valid" | "redirect" = "valid";
  #calls = { refresh: 0, openai: 0, anthropic: 0, rejected: 0 };
  async hold(mode: "valid" | "redirect" = "valid") {
    this.#mode = mode;
    this.#entered = false;
    this.#gate = new Promise<void>((resolve) => {
      this.#release = resolve;
    });
  }
  async release() {
    this.#release?.();
    this.#release = undefined;
    this.#gate = undefined;
  }
  async facts() {
    return { ...this.#calls, entered: this.#entered };
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const oauth = url.pathname.includes("oauth/token");
    if (oauth) {
      const openai = url.href === "https://auth.openai.com/api/accounts/oauth/token";
      const anthropic = url.href === "https://platform.claude.com/v1/oauth/token";
      if ((!openai && !anthropic) || request.redirect !== "manual") {
        this.#calls.rejected++;
        return new Response(null, { status: 403 });
      }
      const raw = await request.text();
      const data = openai ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw);
      if (
        data.grant_type !== "refresh_token" ||
        data.refresh_token !== canaries.refresh ||
        (openai &&
          (data.client_id !== canaries.client || data.resource !== "https://api.openai.com/v1"))
      ) {
        this.#calls.rejected++;
        return new Response(null, { status: 400 });
      }
      this.#calls.refresh++;
      this.#entered = true;
      await this.#gate;
      if (this.#mode === "redirect") {
        this.#mode = "valid";
        return new Response(null, {
          status: 302,
          headers: { Location: "https://foreign.invalid/token" },
        });
      }
      return Response.json({
        access_token: openai ? canaries.fresh : canaries.anthropicFresh,
        refresh_token: canaries.rotated,
        expires_in: 7200,
        scope: "openid chatgpt.tokens.use.direct",
      });
    }
    const body = (await request.json()) as { model?: string; input?: unknown; messages?: unknown };
    if (request.method !== "POST" || !JSON.stringify(body).includes("model-security-")) {
      this.#calls.rejected++;
      return new Response(null, { status: 400 });
    }
    if (
      url.href === "https://api.openai.com/v1/responses" &&
      [canaries.openai, canaries.fresh, canaries.replacement].some(
        (key) => request.headers.get("Authorization") === `Bearer ${key}`,
      ) &&
      body.model === "gpt-5.4"
    ) {
      this.#calls.openai++;
      const item = {
        id: "security-message",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "openai-model-security-answer", annotations: [] }],
      };
      return sse([
        { type: "response.created", response: { id: "security-response", model: body.model } },
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
          delta: "openai-model-security-answer",
        },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            id: "security-response",
            model: body.model,
            status: "completed",
            output: [item],
            usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 },
          },
        },
      ]);
    }
    if (
      url.origin === "https://api.anthropic.com" &&
      url.pathname === "/v1/messages" &&
      (request.headers.get("x-api-key") === canaries.anthropic ||
        (request.headers.get("Authorization") === `Bearer ${canaries.anthropicFresh}` &&
          !request.headers.has("x-api-key"))) &&
      body.model === "claude-opus-4-7"
    ) {
      this.#calls.anthropic++;
      return sse([
        {
          type: "message_start",
          message: {
            id: "security-message",
            type: "message",
            role: "assistant",
            model: body.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 4, output_tokens: 0 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "anthropic-model-security-answer" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 3 },
        },
        { type: "message_stop" },
      ]);
    }
    this.#calls.rejected++;
    return new Response(null, { status: 403 });
  }
}
