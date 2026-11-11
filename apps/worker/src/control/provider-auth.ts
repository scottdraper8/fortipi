import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { validateProviderAuthPut } from "fortipi-contract";
import type * as D from "../boundary/dto.js";
import type { Env } from "../boundary/env.js";
import { requireGrant } from "./authorization.js";
import type { Identities } from "./identity.js";
import { EncryptedCredentialStore } from "./provider-auth-store.js";
import { fromWire, supportedProviders, workerOAuth } from "./provider-oauth.js";
import { check, type Store, same } from "./store.js";

export class ProviderAuth {
  readonly credentials: EncryptedCredentialStore;
  readonly models: Models;
  readonly identities: Identities;
  readonly config: () => Env["FORTIPI_CONFIG"];
  readonly keyConfigured: boolean;
  constructor(
    store: Store,
    identities: Identities,
    env: Env,
    config: () => Env["FORTIPI_CONFIG"],
    transport: typeof fetch = fetch,
  ) {
    this.identities = identities;
    this.keyConfigured = !!env.FORTIPI_MODEL_AUTH_KEY;
    this.config = config;
    this.credentials = new EncryptedCredentialStore(
      store,
      identities.deploymentId,
      env.FORTIPI_MODEL_AUTH_KEY,
    );
    const models = createModels({
      credentials: this.credentials,
      authContext: { env: async () => undefined, fileExists: async () => false },
    });
    for (const provider of [openaiProvider(), anthropicProvider(), openaiCodexProvider()]) {
      provider.auth.oauth = workerOAuth(provider.id, transport, () =>
        this.credentials.beginRefresh(provider.id),
      );
      models.setProvider(provider);
    }
    this.models = models;
  }
  provider(ctx: D.AuthContext, provider: string, action: string): void {
    this.identities.current(ctx);
    requireGrant(ctx, action);
    check(
      supportedProviders.some((x) => x === provider),
      "unsupported",
      "Unsupported OAuth provider",
    );
  }
  status(ctx: D.AuthContext, provider: string): D.ProviderAuthStatus {
    this.provider(ctx, provider, "models.auth.status");
    return this.credentials.status(provider);
  }
  async put(
    ctx: D.AuthContext,
    provider: string,
    input: D.ProviderAuthPut,
  ): Promise<D.ProviderAuthReceipt> {
    this.provider(ctx, provider, "models.auth.write");
    validateProviderAuthPut(input);
    return this.credentials.manage(
      ctx.principalId,
      provider,
      input,
      fromWire(provider, input.credential),
      () => this.identities.current(ctx),
    );
  }
  async remove(
    ctx: D.AuthContext,
    provider: string,
    input: D.ProviderAuthDelete,
  ): Promise<D.ProviderAuthReceipt> {
    this.provider(ctx, provider, "models.auth.delete");
    return this.credentials.manage(ctx.principalId, provider, input, undefined, () =>
      this.identities.current(ctx),
    );
  }
  async resolve(
    ctx: D.ModelResolutionContext,
    input: { providerId: string; modelId: string; expectedGeneration?: number; deadline: number },
  ): Promise<D.ResolvedProviderAuth> {
    check(
      ctx.kind === "model-resolution" &&
        ctx.action === "resolve-provider-auth" &&
        ctx.deploymentId === this.identities.deploymentId &&
        ctx.providerId === input.providerId &&
        ctx.modelId === input.modelId &&
        Date.now() < Math.min(input.deadline, ctx.deadline) &&
        input.deadline <= Date.now() + 30000,
      "unauthorized",
      "Invalid model resolution authority",
    );
    const config = this.config();
    check(this.keyConfigured, "unsupported", "Configure the dedicated model authentication key", {
      requiredCapability: "model-auth-key",
      setup:
        "Preserve or provision FORTIPI_MODEL_AUTH_KEY independently from the application bootstrap",
    });
    check(
      "models" in config &&
        config.models.some(
          (m) =>
            m.providerId === input.providerId &&
            m.modelId === input.modelId &&
            "auth" in m &&
            m.auth.kind === "oauth" &&
            m.auth.providerId === input.providerId &&
            m.endpoint === undefined,
        ),
      "unauthorized",
      "OAuth model is not configured",
    );
    const before = this.credentials.status(input.providerId);
    check(
      input.expectedGeneration === undefined || input.expectedGeneration === before.generation,
      "conflict",
      "Model generation changed",
    );
    const resolved = await this.models.getAuth(input.providerId, {
      signal: AbortSignal.timeout(Math.max(1, Math.min(input.deadline, ctx.deadline) - Date.now())),
    });
    const after = this.credentials.status(input.providerId);
    check(
      same(config, this.config()) && Date.now() < Math.min(input.deadline, ctx.deadline),
      "unauthorized",
      "Model configuration or resolution authority changed",
    );
    check(
      resolved && after.version !== null && before.generation === after.generation,
      "unauthenticated",
      "Provider requires sign in",
    );
    return {
      providerId: input.providerId,
      version: after.version,
      generation: after.generation,
      auth: resolved.auth,
      ...(resolved.env ? { env: resolved.env } : {}),
    };
  }
}
