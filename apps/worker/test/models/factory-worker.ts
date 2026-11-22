import type * as D from "../../src/boundary/dto.js";
import { buildModels } from "../../src/models/factory.js";
import { TestControlPlane as BaseControlPlane } from "../control/fixtures/worker.js";

export { default, TestRecipient } from "../control/fixtures/worker.js";

export class TestControlPlane extends BaseControlPlane {
  #resolutions = 0;
  override resolveProviderAuth(
    ctx: D.ModelResolutionContext,
    input: Parameters<BaseControlPlane["resolveProviderAuth"]>[1],
  ) {
    this.#resolutions++;
    return super.resolveProviderAuth(ctx, input);
  }
  async workersAiProbe() {
    const calls: { model: string; raw: boolean; user: boolean }[] = [];
    const binding = {
      run: async (model: string, input: unknown, options: unknown) => {
        calls.push({
          model,
          raw:
            !!options &&
            typeof options === "object" &&
            "returnRawResponse" in options &&
            options.returnRawResponse === true,
          user: JSON.stringify(input).includes("selected Workers AI input"),
        });
        return Response.json({
          id: "synthetic-ai-answer",
          object: "chat.completion",
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "selected Workers AI output" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 },
        });
      },
    } as unknown as Ai;
    const result = await buildModels(
      [{ providerId: "cloudflare", modelId: "@cf/zai-org/glm-5.3-flash" }],
      { ...this.env, AI: binding },
      { agentId: "agent", deploymentId: this.ctx.id.toString() },
    );
    if (!result.ok) return JSON.stringify(result);
    const model = result.value.getModel("cloudflare", "@cf/zai-org/glm-5.3-flash");
    if (!model) throw new Error("Selected Workers AI model absent");
    const answer = await result.value.completeSimple(model, {
      messages: [{ role: "user", content: "selected Workers AI input", timestamp: Date.now() }],
    });
    return JSON.stringify({
      calls,
      provider: model.provider,
      modelId: model.id,
      text: answer.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(""),
      stopReason: answer.stopReason,
      resolutions: this.#resolutions,
    });
  }
  async factoryAuthProbe(providerId: string, modelId: string, mode: "oauth" | "secret") {
    const before = this.#resolutions;
    const selection: D.ModelConfig =
      mode === "oauth"
        ? { providerId, modelId, auth: { kind: "oauth", providerId } }
        : {
            providerId,
            modelId,
            auth: {
              kind: "secretRef",
              secretRef: providerId === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY",
            },
          };
    const result = await buildModels(
      [selection],
      {
        ...this.env,
        OPENAI_API_KEY: "synthetic-factory-api-key",
        ANTHROPIC_API_KEY: "synthetic-factory-anthropic-key",
      },
      { agentId: "agent", deploymentId: this.ctx.id.toString() },
    );
    if (!result.ok)
      return JSON.stringify({ ok: false, providerId, code: result.code, message: result.message });
    const startupCalls = this.#resolutions - before;
    const values = await Promise.all([
      result.value.getAuth(providerId),
      result.value.getAuth(providerId),
      result.value.getAuth(providerId),
    ]);
    const controller = new AbortController();
    controller.abort();
    let aborted = false;
    try {
      await result.value.getAuth(providerId, { signal: controller.signal });
    } catch {
      aborted = true;
    }
    const model = result.value.getModel(providerId, modelId),
      auth = values[0];
    const complete = values.every(
      (value) =>
        value !== undefined &&
        (mode === "secret"
          ? value.auth.apiKey ===
            (providerId === "openai"
              ? "synthetic-factory-api-key"
              : "synthetic-factory-anthropic-key")
          : providerId === "openai-codex"
            ? value.auth.apiKey?.endsWith(".signature")
            : value.auth.apiKey === "synthetic-refreshed-access"),
    );
    const credential =
      mode === "oauth" ? await this.providerAuth.credentials.read(providerId) : undefined;
    const accountBinding =
      credential?.type === "oauth" && credential.accountId === "synthetic-account";
    const openaiFields =
      providerId !== "openai" ||
      mode !== "oauth" ||
      (credential?.type === "oauth" &&
        credential.clientId === "synthetic-client" &&
        Array.isArray(credential.scopes) &&
        credential.scopes.includes("chatgpt.tokens.use.direct"));
    return JSON.stringify({
      ok: true,
      startupCalls,
      resolutions: this.#resolutions - before,
      modelSelected: model?.id === modelId,
      providerCount: result.value.getProviders().filter((provider) => provider.id === providerId)
        .length,
      source: auth?.source,
      complete,
      accountBinding: providerId === "openai-codex" ? accountBinding : undefined,
      openaiFields,
      aborted,
      credentialStatus:
        mode === "oauth" ? this.providerAuth.credentials.status(providerId) : undefined,
    });
  }
}
