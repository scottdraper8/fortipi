import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { EntryId, TaskId } from "@earendil-works/pi-durable";
import type { ConversationRow } from "../../src/agent/store.js";
import { boundedJson } from "../../src/api/validation.js";
import type { Env } from "../../src/boundary/env.js";
import worker, { TestAgentSession as ExistingTestAgentSession } from "./fixture-worker.ts";

export {
  ControlPlane,
  LinuxContainerHost,
  StorageGuardProbe,
  WorkspaceObject,
  WorkspaceProxy,
} from "./fixture-worker.ts";

export class TestAgentSession extends ExistingTestAgentSession {
  #gate:
    | {
        piId: number;
        cid: string;
        entered: boolean;
        released: boolean;
        returned: boolean;
        more?: boolean;
        caller?: number;
        release: ReturnType<typeof Promise.withResolvers<void>>;
      }
    | undefined;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Conversations owns a separate host port; the compiler calls that port.
    Object.defineProperties(this.conversations.host, {
      holdQueuedProjection: { value: this.holdQueuedProjection.bind(this) },
      observeQueuedProjectionResult: { value: this.observeQueuedProjectionResult.bind(this) },
    });
  }
  async holdQueuedProjection(piId: number, caller: number) {
    const gate = this.#gate;
    if (!gate || gate.piId !== piId || gate.entered || gate.released) return;
    const inspection = await (await this.pi.pi()).inspect(BACKGROUND_CONTEXT);
    const child = inspection.tasks.find((t) => t.record.id === caller);
    const owner = inspection.tasks.find((t) => t.record.id === child?.record.owner);
    assert.ok(
      child?.record.kind === "fortipi.project" &&
        child.record.conversationId === piId &&
        child.state.kind === "running",
      "Only the real running projection task may acknowledge the gate",
    );
    assert.ok(
      owner?.record.kind === "pi.generation" &&
        owner.record.state.status === "waiting" &&
        owner.record.state.on.includes(caller as TaskId) &&
        (owner.record.state.checkpoint as { phase?: string } | null)?.phase === "drain",
      "The actual generation must already wait for this afterRun child",
    );
    gate.caller = caller;
    gate.entered = true;
    // No application transaction or conversation lane spans this wait.
    await gate.release.promise;
  }
  observeQueuedProjectionResult(piId: number, caller: number, more: boolean) {
    const gate = this.#gate;
    if (!gate || gate.piId !== piId || gate.caller !== caller || !gate.released || gate.returned)
      return;
    assert.equal(typeof more, "boolean");
    gate.returned = true;
    gate.more = more;
  }
  override async onRequest(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/__integration/queued-projection")
      return super.onRequest(request);
    if (
      request.method !== "POST" ||
      request.headers.get("Authorization") !== `Bearer ${this.env.FORTIPI_ADMIN_TOKEN}`
    )
      return new Response(null, { status: 403 });
    const value = await boundedJson(request, 1024);
    if (!value || typeof value !== "object" || Array.isArray(value))
      return new Response(null, { status: 400 });
    const input = value as Record<string, unknown>;
    if (
      input.action === "arm" &&
      typeof input.conversationId === "string" &&
      Object.keys(input).length === 2
    ) {
      assert.ok(!this.#gate, "Gate is armed once");
      const row = await this.store.get<ConversationRow>("conversation", input.conversationId);
      assert.ok(row, "Existing conversation required");
      this.#gate = {
        piId: Number(row.piId),
        cid: input.conversationId,
        entered: false,
        released: false,
        returned: false,
        release: Promise.withResolvers<void>(),
      };
      return Response.json({ armed: true });
    }
    if (Object.keys(input).length !== 1) return new Response(null, { status: 400 });
    if (input.action === "release") {
      if (this.#gate) {
        this.#gate.released = true;
        this.#gate.release.resolve();
      }
      return Response.json({ released: true });
    }
    if (input.action === "state") {
      const gate = this.#gate;
      assert.ok(gate, "Gate must be armed");
      const inspection = await (await this.pi.pi()).inspect(BACKGROUND_CONTEXT);
      const row = await this.store.get<ConversationRow>("conversation", gate.cid);
      assert.ok(row);
      const bookmark = Number(row.bookmark ?? 0);
      const page = await this.pi
        .session(String(gate.piId))
        .entries(
          { order: "ascending", ...(row.bookmark ? { minEntryId: bookmark as EntryId } : {}) },
          100,
          BACKGROUND_CONTEXT,
        );
      const submissions = inspection.submissions.filter((s) => s.conversationId === gate.piId);
      const pending = (await this.store.page("input-pending", 100)).filter((p) =>
        p.id.startsWith(`${gate.cid}:`),
      );
      return Response.json({
        entered: gate.entered,
        released: gate.released,
        returned: gate.returned,
        more: gate.more ?? null,
        pageDrained: !page.next && page.items.every((entry) => entry.id <= bookmark),
        pendingCount: pending.length,
        onlyQueuedPending: pending.every((p) =>
          submissions.some((s) => s.status === "queued" && p.id === `${gate.cid}:${s.requestId}`),
        ),
        caller: gate.caller ?? null,
        tasks: inspection.tasks
          .filter((t) => t.record.conversationId === gate.piId)
          .map((t) => ({
            id: t.record.id,
            kind: t.record.kind,
            owner: t.record.owner ?? null,
            state: {
              kind: t.state.kind,
              ...(t.state.kind === "waiting" ? { on: t.state.on } : {}),
            },
          })),
        submissions: submissions.map((s) => ({
          requestId: s.requestId,
          status: s.status,
          entry: s.entry ?? null,
        })),
      });
    }
    return new Response(null, { status: 400 });
  }
}
export default {
  fetch(request, env) {
    const url = new URL(request.url),
      match = /^\/__integration\/queued-projection\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (!match) return worker.fetch(request, env);
    if (
      request.method !== "POST" ||
      request.headers.get("Authorization") !== `Bearer ${env.FORTIPI_ADMIN_TOKEN}`
    )
      return new Response(null, { status: 403 });
    const agentId = match[1];
    assert.ok(agentId);
    url.pathname = "/__integration/queued-projection";
    return env.AGENT_SESSIONS.getByName(agentId).fetch(new Request(url, request));
  },
} satisfies ExportedHandler<Env>;
