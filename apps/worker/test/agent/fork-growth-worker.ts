import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type * as D from "../../src/boundary/dto.js";
import type { Env } from "../../src/boundary/env.js";
import base, {
  TestAgentSession as BaseAgent,
  ControlPlane as BaseControlPlane,
} from "./runtime-worker.js";

export {
  LinuxContainerHost,
  StorageGuardProbe,
  WorkspaceObject,
  WorkspaceProxy,
} from "./runtime-worker.js";

export class ControlPlane extends BaseControlPlane {
  override async reserveCapacity(
    auth: D.AuthContext,
    input: {
      operationId: string;
      ownerId: string;
      policyVersion: number;
      bytes: number;
      admissionSlots: number;
    },
  ) {
    const result = await super.reserveCapacity(auth, input);
    if (result.ok && !input.admissionSlots && this.store.get("agent", input.ownerId)) {
      // The Agent still awaits this actual CP response. Inspect only OWN app
      // state; no Pi SQL/private SDK state or fake reservation is substituted.
      const proof = (await (
        await this.env.AGENT_SESSIONS.getByName(input.ownerId).fetch(
          new Request(`https://agent.internal/__fork-growth/proof?operation=${input.operationId}`),
        )
      ).json()) as { hold?: boolean };
      this.store.put("fixture-fork-proof", input.operationId, { input, proof, at: Date.now() });
      if (proof.hold) await new Promise<void>((accept) => setTimeout(accept, 300000));
    }
    return result;
  }
  override async fetch(request: Request) {
    if (new URL(request.url).pathname === "/__fork-growth/proofs")
      return Response.json(this.store.page("fixture-fork-proof", 0, 100).map((row) => row.value));
    return super.fetch(request);
  }
}
export class TestAgentSession extends BaseAgent {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const project = this.conversations.projectEntry.bind(this.conversations);
    this.conversations.projectEntry = async (row, entry) => {
      await project(row, entry);
      if (
        !row.published &&
        entry.kind === "pi.assistant" &&
        (await this.store.get("fixture", "fault")) === "fork-after-prefix-copy"
      ) {
        await this.store.transaction(async (tx) => {
          await this.store.remove("fixture", "fault", tx);
          await this.store.put("fixture", "barrier", "fork-after-prefix-copy", tx);
        });
        await new Promise<void>((accept) => setTimeout(accept, 300000));
      }
    };
    const select = this.conversations.host.selectModel;
    this.conversations.host.selectModel = async (...args) => {
      if (args[1] === "conversations.create" || args[1] === "conversations.fork") {
        if ((await this.store.get("fixture", "fault")) === "creation-before-model") {
          await this.store.transaction(async (tx) => {
            await this.store.remove("fixture", "fault", tx);
            await this.store.put("fixture", "barrier", "creation-before-model", tx);
          });
          await new Promise<void>((accept) => setTimeout(accept, 300000));
        }
      }
      return select(...args);
    };
  }
  override async onRequest(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/__fork-growth/proof") {
      const operationId = url.searchParams.get("operation") ?? "";
      const creations = await this.store.db.all<{ data: string }>(
        "SELECT data FROM fp_records_v1 WHERE kind='creation' AND json_extract(data,'$.operationId')=?",
        operationId,
      );
      const hold = (await this.store.get("fixture", "fault")) === "creation-after-capacity";
      if (hold)
        await this.store.transaction(async (tx) => {
          await this.store.remove("fixture", "fault", tx);
          await this.store.put("fixture", "barrier", "creation-after-capacity", tx);
        });
      return Response.json({
        hold,
        intent: creations.length === 1,
        claim: (await this.store.get("growth-claim", operationId)) ?? null,
        physical: this.store.physicalBytes(),
      });
    }
    if (url.pathname === "/__fork-growth/status") {
      const creations = await this.store.page<
        import("../../src/agent/conversations.js").CreationIntent
      >("creation", 100);
      const harness = await this.pi.pi();
      const sessions = await harness.commit(
        (tx) => tx.scanConversations({ order: "ascending" }, 100),
        BACKGROUND_CONTEXT,
      );
      const projections =
        await this.store.page<import("../../src/agent/store.js").ConversationRow>("conversation");
      const copied = [];
      for (const { value } of projections) {
        const messages = await this.store.db.all<{ id: string; characters: number }>(
          "SELECT id,length(json_extract(data,'$.content')) characters FROM fp_messages_v1 WHERE conversation=? ORDER BY position LIMIT 100",
          value.conversation.conversationId,
        );
        copied.push({
          conversationId: value.conversation.conversationId,
          published: value.published,
          bookmark: value.bookmark ?? null,
          messages,
        });
      }
      return Response.json({
        barrier: (await this.store.get("fixture", "barrier")) ?? null,
        creations: creations.map(({ value }) => ({
          conversationId: value.conversationId,
          operationId: value.operationId,
          growthBytes: value.growthBytes,
          hasModel: !!value.model,
          state: value.state,
        })),
        piIds: sessions.items.filter((row) => !row.owner).map((row) => String(row.id)),
        copied,
        growth: await this.growthReport(),
      });
    }
    if (url.pathname === "/__fork-growth/history") {
      const row = await this.store.get<import("../../src/agent/store.js").ConversationRow>(
        "conversation",
        url.searchParams.get("cid") ?? "",
      );
      if (!row) return new Response(null, { status: 404 });
      const entries = await this.pi
        .session(row.piId)
        .entries({ order: "ascending" }, 100, BACKGROUND_CONTEXT);
      return Response.json({
        bytes: entries.items.reduce(
          (sum, entry) => sum + new TextEncoder().encode(JSON.stringify(entry)).length,
          0,
        ),
        users: entries.items.filter((entry) => entry.kind === "pi.user").length,
        physical: this.store.physicalBytes(),
      });
    }
    return super.onRequest(request);
  }
}
export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/__fork-growth/proofs")
      return env.CONTROL_PLANE.getByName("control").fetch(request);
    if (url.pathname === "/__fork-growth/history" || url.pathname === "/__fork-growth/status")
      return env.AGENT_SESSIONS.getByName(url.searchParams.get("agent") ?? "").fetch(request);
    return base.fetch(request, env);
  },
} satisfies ExportedHandler<Env>;
