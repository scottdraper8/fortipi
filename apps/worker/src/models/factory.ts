import {
  createModels,
  isModelType,
  type Models,
  type MutableModels,
  type Provider,
} from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { createAI } from "agents/models/pi-ai";
import { check, id, outcome, unwrap } from "../api/common.js";
import type * as D from "../boundary/dto.js";
import type { Env } from "../boundary/env.js";

export const defaultModel: D.ModelConfig = {
  providerId: "cloudflare",
  modelId: "@cf/zai-org/glm-5.3-flash",
};
const endpoints: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  "openai-codex": "https://chatgpt.com/backend-api",
};
const adapters: Record<string, () => Provider> = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
  "openai-codex": openaiCodexProvider,
};
/** Complete read-only store: API-key factories never open ambient files or persist OAuth locally. */
function secretStore(entries: Map<string, string>): D.CredentialStore {
  return {
    read: async (providerId) => {
      const key = entries.get(providerId);
      return key ? { type: "api_key", key } : undefined;
    },
    list: async () =>
      Array.from(entries.keys(), (providerId) => ({ providerId, type: "api_key" as const })),
    modify: async () => {
      throw new Error("Factory credential store is read-only");
    },
    delete: async () => {
      throw new Error("Factory credential store is read-only");
    },
  };
}
export function bootstrapModels(): MutableModels {
  return createModels({
    credentials: secretStore(new Map()),
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
}
export async function createFortiPiModels(
  config: D.ModelConfig[],
  env: Env,
): Promise<D.Outcome<Models>> {
  return buildModels(config, env);
}
export async function buildModels(
  config: D.ModelConfig[],
  env: Env,
  identity?: { agentId: string; deploymentId: string },
): Promise<D.Outcome<MutableModels>> {
  return outcome(id(), () => {
    check(config.length > 0 && config.length <= 32, "invalid_request", "Select a model");
    const keys = new Map<string, string>();
    for (const selection of config) {
      check(selection.modelId.length > 0, "invalid_request", "Select a model");
      if (selection.providerId === "cloudflare") {
        check(env.AI, "unsupported", "Workers AI binding required");
        continue;
      }
      check(
        "auth" in selection && adapters[selection.providerId],
        "unsupported",
        "Provider adapter unavailable",
      );
      check(
        selection.endpoint === undefined || selection.endpoint === endpoints[selection.providerId],
        "invalid_request",
        "Provider endpoint is not allowed",
      );
      if (selection.auth.kind === "secretRef") {
        check(selection.providerId !== "openai-codex", "invalid_request", "Codex requires OAuth");
        const ref = selection.auth.secretRef;
        check(
          ref === "OPENAI_API_KEY" || ref === "ANTHROPIC_API_KEY",
          "invalid_request",
          "Unsupported model secret binding",
        );
        check(
          (selection.providerId === "openai" && ref === "OPENAI_API_KEY") ||
            (selection.providerId === "anthropic" && ref === "ANTHROPIC_API_KEY"),
          "invalid_request",
          "Provider secret binding mismatch",
        );
        const key = env[ref];
        check(key, "unauthenticated", "Selected model secret is missing");
        keys.set(selection.providerId, key);
      } else {
        check(
          selection.auth.providerId === selection.providerId,
          "invalid_request",
          "OAuth provider mismatch",
        );
        check(
          env.FORTIPI_MODEL_AUTH_KEY,
          "unsupported",
          "Dedicated model authentication key required",
          { requiredCapability: "model-auth-key" },
        );
      }
    }
    const models = createModels({
      credentials: secretStore(keys),
      authContext: { env: async () => undefined, fileExists: async () => false },
    });
    const cloud = config.some((selection) => selection.providerId === "cloudflare")
      ? createAI({ binding: env.AI })
      : undefined;
    if (cloud) models.setProvider(cloud.provider);
    const registered = new Set<string>();
    for (const selection of config) {
      if (selection.providerId === "cloudflare") {
        check(cloud, "unsupported", "Workers AI binding required");
        cloud(selection.modelId);
        continue;
      }
      if (registered.has(selection.providerId)) continue;
      registered.add(selection.providerId);
      const create = adapters[selection.providerId];
      check(create && "auth" in selection, "unsupported", "Provider unavailable");
      const provider = create();
      if (selection.auth.kind === "oauth") {
        // CP owns complete OAuth validation, serialization, refresh and persist-before-return.
        // A narrow public Provider auth delegate preserves all returned auth/env fields.
        provider.auth.apiKey = {
          name: "FortiPi OAuth authority",
          check: async () => ({ type: "oauth", source: "OAuth" }),
          resolve: async ({ signal }) => {
            signal.throwIfAborted();
            check(identity, "unauthorized", "Agent model-resolution identity required");
            const cp = env.CONTROL_PLANE.getByName("control");
            const deadline = Date.now() + 30000;
            const ctx: D.ModelResolutionContext = {
              kind: "model-resolution",
              ...identity,
              factoryId: `fortipi-${selection.providerId}`,
              providerId: selection.providerId,
              modelId: selection.modelId,
              action: "resolve-provider-auth",
              deadline,
            };
            const resolved = unwrap(
              await cp.resolveProviderAuth(ctx, {
                providerId: selection.providerId,
                modelId: selection.modelId,
                deadline,
              }),
            );
            signal.throwIfAborted();
            check(
              !resolved.auth.baseUrl || resolved.auth.baseUrl === endpoints[selection.providerId],
              "unauthorized",
              "Provider auth endpoint is not allowed",
            );
            return {
              auth: resolved.auth,
              ...(resolved.env ? { env: resolved.env } : {}),
              source: "OAuth",
            };
          },
        };
        delete provider.auth.oauth;
        // Match the pinned provider's credential-specific model-type policy,
        // without fabricating a complete OAuth credential in this factory.
        if (selection.providerId === "openai") {
          const all = provider.getAllModels?.bind(provider);
          if (all)
            provider.getAllModels = () =>
              all().filter((model) => !isModelType(model, "classifier"));
          provider.filterAllModels = (models) =>
            models.filter((model) => !isModelType(model, "classifier"));
        }
      }
      models.setProvider(provider);
    }
    for (const selected of config)
      check(
        models.getModel(selected.providerId, selected.modelId),
        "invalid_request",
        "Selected model is unavailable",
      );
    return models;
  });
}
