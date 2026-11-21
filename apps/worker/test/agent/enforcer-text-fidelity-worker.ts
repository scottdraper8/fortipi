import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { AgentSession } from "../../src/agent/agent-session.js";
import type { ConversationRow } from "../../src/agent/store.js";
import type { Env } from "../../src/boundary/env.js";
import { defaultModel } from "../../src/models/factory.js";

export {
  ControlPlane,
  default,
  LinuxContainerHost,
  StorageGuardProbe,
  WorkspaceObject,
  WorkspaceProxy,
} from "./runtime-worker.js";

// Only the provider is substituted. PiHarness, Pi, projection, SQLite and HTTP
// use the production composition and supported upstream entry/result reads.
export class TestAgentSession extends AgentSession {
  constructor(ctx: DurableObjectState, env: Env) {
    const faux = fauxProvider({
      provider: "cloudflare",
      models: [{ id: defaultModel.modelId }],
      tokensPerSecond: 100000,
    });
    faux.setResponses([
      fauxAssistantMessage([
        { type: "text", text: "alpha" },
        { type: "text", text: "omega" },
      ]),
    ]);
    super(ctx, env, async () => {
      const models = createModels();
      models.setProvider(faux.provider);
      return { ok: true, value: models };
    });
  }

  async canonicalResult(conversationId: string, operationId: string) {
    const row = await this.store.get<ConversationRow>("conversation", conversationId);
    if (!row) throw new Error("Fixture conversation unavailable");
    return this.pi.session(row.piId).wait(operationId);
  }
}
