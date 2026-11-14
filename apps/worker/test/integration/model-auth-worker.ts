import type { MutableModels } from "@earendil-works/pi-ai/models";
import { AgentSession } from "../../src/agent/agent-session.js";
import { errorResponse, unwrap as value } from "../../src/api/common.js";
import { routeRequest } from "../../src/api/router.js";
import type * as D from "../../src/boundary/dto.js";
import type { Env } from "../../src/boundary/env.js";
import { EncryptedCredentialStore } from "../../src/control/provider-auth-store.js";
import { id, outcome } from "../../src/control/store.js";
import { bootstrapModels, buildModels } from "../../src/models/factory.js";
import { TestControlPlane as BaseControl } from "../control/fixtures/worker.js";
import { canaries, containsCanary, ModelProtocolPeer } from "./model-protocol-peer.js";

export { WorkspaceObject } from "../../src/workspace/workspace-object.js";
export { TestRecipient } from "../control/fixtures/recipients.js";
export { ModelProtocolPeer };

interface SecurityEnv extends Env {
  MODEL_PEER: DurableObjectNamespace<ModelProtocolPeer>;
}
const models = { openai: "gpt-5.4", anthropic: "claude-opus-4-7" };
type Provider = keyof typeof models;
const uuid = () => crypto.randomUUID();
function request<K extends D.OperationId>(
  operationId: K,
  body: D.OperationRequest<K>["body"],
  path: D.OperationRequest<K>["path"],
): D.OperationRequest<K> {
  return { operationId, path, body, query: {} } as D.OperationRequest<K>;
}
function credential(provider: Provider, replacement = false): D.OAuthCredential {
  return {
    type: "oauth",
    access: replacement ? canaries.replacement : canaries.access,
    refresh: canaries.refresh,
    expires: replacement ? Date.now() + 7_200_000 : 0,
    ...(provider === "openai"
      ? {
          providerFields: {
            clientId: canaries.client,
            scopes: ["openid", "chatgpt.tokens.use.direct"],
          },
        }
      : {}),
  };
}
const transport =
  (env: SecurityEnv): typeof fetch =>
  (input, init) =>
    env.MODEL_PEER.getByName("protocol").fetch(new Request(input, init));
function withPeer(registry: MutableModels, env: SecurityEnv) {
  for (const provider of registry.getProviders()) {
    const simple = provider.streamSimple.bind(provider);
    provider.streamSimple = (model, context, options) =>
      simple(model, context, { ...options, fetch: transport(env) });
  }
}
/** Real Pi/Agent implementation; only its supported provider HTTP option is supplied. */
export class ModelAgent extends AgentSession {
  constructor(ctx: DurableObjectState, env: SecurityEnv) {
    super(ctx, env, async (config, bindings, identity) => {
      const built = config.length
        ? await buildModels(config, bindings, identity)
        : await outcome(id(), async () => bootstrapModels());
      if (built.ok) withPeer(built.value, env);
      return built;
    });
  }
}
export class TestControlPlane extends BaseControl {
  #env: SecurityEnv;
  #resolutions = 0;
  constructor(ctx: DurableObjectState, env: SecurityEnv) {
    super(ctx, env, () => transport(env));
    this.#env = env;
  }
  override resolveProviderAuth(
    ctx: D.ModelResolutionContext,
    input: Parameters<BaseControl["resolveProviderAuth"]>[1],
  ) {
    this.#resolutions++;
    return super.resolveProviderAuth(ctx, input);
  }
  async #auth(): Promise<D.AuthContext> {
    return value(
      await this.authenticate({
        bearer: this.env.FORTIPI_ADMIN_TOKEN,
        deploymentId: this.identities.deploymentId,
        requestId: uuid(),
        deadline: Date.now() + 30000,
      }),
    );
  }
  async #put(
    provider: Provider,
    ctx: D.AuthContext,
    expectedVersion: number | null,
    replacement = false,
  ) {
    return this.putProviderAuth(
      ctx,
      request(
        "putProviderAuth",
        { requestId: uuid(), expectedVersion, credential: credential(provider, replacement) },
        { providerId: provider },
      ),
    );
  }
  #resolution(provider: Provider) {
    const deadline = Date.now() + 30000;
    return {
      kind: "model-resolution" as const,
      action: "resolve-provider-auth" as const,
      deploymentId: this.identities.deploymentId,
      agentId: "model-security-agent",
      factoryId: "model-security",
      providerId: provider,
      modelId: models[provider],
      deadline,
    };
  }
  async #factory(provider: Provider, mode: "oauth" | "secret") {
    const resolutionsBefore = this.#resolutions;
    let foreignReads = 0;
    const bindings = { ...this.#env };
    if (mode === "secret")
      Object.defineProperty(
        bindings,
        provider === "openai" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY",
        {
          get() {
            foreignReads++;
            throw new Error("Unselected secret binding read");
          },
        },
      );
    const selection: D.ModelConfig = {
      providerId: provider,
      modelId: models[provider],
      auth:
        mode === "oauth"
          ? { kind: "oauth", providerId: provider }
          : {
              kind: "secretRef",
              secretRef: provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY",
            },
    };
    const built = value(
      await buildModels([selection], bindings, {
        agentId: "model-security-agent",
        deploymentId: this.identities.deploymentId,
      }),
    );
    const startupCalls = this.#resolutions - resolutionsBefore;
    const selected = built.getModel(provider, models[provider]);
    if (!selected) throw new Error("Selected model absent");
    const answers = await Promise.all(
      [0, 1].map(() =>
        built.completeSimple(
          selected,
          {
            messages: [{ role: "user", content: "model-security-input", timestamp: Date.now() }],
          },
          { fetch: transport(this.#env), maxRetries: 0, signal: AbortSignal.timeout(10000) },
        ),
      ),
    );
    const text = answers.map((answer) =>
      answer.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(""),
    );
    const saved = await this.providerAuth.credentials.read(provider);
    return {
      text,
      startupCalls,
      resolutions: this.#resolutions - resolutionsBefore,
      stopped: answers.every((answer) => answer.stopReason === "stop"),
      failures: answers
        .filter((answer) => answer.stopReason === "error")
        .map((answer) => {
          let message = answer.errorMessage ?? "Provider failed without diagnostic";
          for (const canary of Object.values(canaries))
            message = message.replaceAll(canary, "<synthetic>");
          return message.slice(0, 512);
        }),
      foreignReads,
      providerCount: built.getProviders().length,
      completeFields:
        mode === "secret" ||
        (saved?.type === "oauth" &&
          saved.access === (provider === "anthropic" ? canaries.anthropicFresh : canaries.fresh) &&
          saved.refresh === canaries.rotated &&
          (provider !== "openai" ||
            (saved.clientId === canaries.client &&
              Array.isArray(saved.scopes) &&
              saved.scopes.includes("chatgpt.tokens.use.direct")))),
      status: this.providerAuth.credentials.status(provider),
    };
  }
  async #audit() {
    const rows = await this.encryptedRows();
    const records = JSON.stringify(this.ctx.storage.sql.exec("SELECT * FROM cp_records").toArray());
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rows));
    return {
      cipherHash: Array.from(new Uint8Array(hash), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
      ciphertextPresent: rows.includes('"ciphertext":"') && rows.includes('"nonce":"'),
      noPlaintext: !containsCanary(rows) && !containsCanary(records),
    };
  }
  async #race(provider: Provider, action: "replace" | "logout" | "stale-login") {
    const ctx = await this.#auth(),
      store = this.providerAuth.credentials;
    value(await this.#put(provider, ctx, store.status(provider).version));
    const before = store.status(provider),
      peer = this.#env.MODEL_PEER.getByName("protocol");
    await peer.hold();
    const resolution = this.#resolution(provider);
    const active = this.resolveProviderAuth(resolution, resolution);
    try {
      for (let n = 0; n < 200 && !(await peer.facts()).entered; n++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      if (!(await peer.facts()).entered) throw new Error("Refresh peer not entered");
      let finished = false;
      const expectedVersion = (before.version ?? 0) + (action === "stale-login" ? 0 : 1);
      const management = (
        action === "logout"
          ? this.deleteProviderAuth(
              ctx,
              request(
                "deleteProviderAuth",
                { requestId: uuid(), expectedVersion },
                { providerId: provider },
              ),
            )
          : this.#put(provider, ctx, expectedVersion, true)
      ).then((result) => {
        finished = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const blocked = !finished;
      await peer.release();
      const [resolved, managed] = await Promise.all([active, management]);
      const after = store.status(provider),
        saved = await store.read(provider);
      const oldGeneration = await this.resolveProviderAuth(resolution, {
        ...resolution,
        expectedGeneration: before.generation,
      });
      return {
        blocked,
        managementOk: managed.ok,
        managementCode: managed.ok ? null : managed.code,
        generationAdvanced:
          after.generation === before.generation + (action === "stale-login" ? 0 : 1),
        versionAdvanced:
          after.version === (before.version ?? 0) + (action === "stale-login" ? 1 : 2),
        staleGenerationDenied: action === "stale-login" || !oldGeneration.ok,
        retained:
          action === "logout"
            ? saved === undefined && after.state === "absent"
            : saved?.type === "oauth" &&
              saved.access === (action === "replace" ? canaries.replacement : canaries.fresh),
        noLeak: !containsCanary(managed),
        resolverReturned: resolved.ok,
        audit: await this.#audit(),
      };
    } finally {
      await peer.release();
      await active;
    }
  }
  async #negatives() {
    const before = await this.#audit(),
      ctx = await this.#auth();
    const denied: boolean[] = [];
    for (const key of [undefined, "b2".repeat(32), "invalid-short-key"]) {
      try {
        await new EncryptedCredentialStore(this.store, this.identities.deploymentId, key).read(
          "openai",
        );
        denied.push(false);
      } catch (error) {
        if (containsCanary(String(error))) throw new Error("Credential leaked");
        denied.push(true);
      }
    }
    const invalid = await this.putProviderAuth(
      ctx,
      request(
        "putProviderAuth",
        {
          requestId: uuid(),
          expectedVersion: this.providerAuth.credentials.status("openai").version,
          credential: { ...credential("openai"), access: "" },
        },
        { providerId: "openai" },
      ),
    );
    const unsupported = await this.putProviderAuth(
      ctx,
      request(
        "putProviderAuth",
        { requestId: uuid(), expectedVersion: null, credential: credential("openai") },
        { providerId: "unsupported-provider" },
      ),
    );
    const badSelections: D.ModelConfig[] = [
      {
        providerId: "openai",
        modelId: models.openai,
        endpoint: "https://foreign.invalid/v1",
        auth: { kind: "secretRef", secretRef: "OPENAI_API_KEY" },
      },
      {
        providerId: "openai",
        modelId: models.openai,
        auth: { kind: "secretRef", secretRef: "ANTHROPIC_API_KEY" },
      },
    ];
    const selectionDenied: boolean[] = [];
    for (const selection of badSelections)
      selectionDenied.push(!(await buildModels([selection], this.#env)).ok);
    const missingBindings = { ...this.#env };
    delete missingBindings.OPENAI_API_KEY;
    const missingSecret = await buildModels(
      [
        {
          providerId: "openai",
          modelId: models.openai,
          auth: { kind: "secretRef", secretRef: "OPENAI_API_KEY" },
        },
      ],
      missingBindings,
    );
    return {
      keyDenied: denied,
      invalidDenied: !invalid.ok,
      unsupportedDenied: !unsupported.ok,
      selectionDenied,
      missingSecretDenied: !missingSecret.ok,
      noLeak: !containsCanary([invalid, unsupported, missingSecret]),
      ciphertextPreserved: before.cipherHash === (await this.#audit()).cipherHash,
      crypto: await this.cryptoProbe(),
    };
  }
  async securityProbe(action: string, provider: Provider = "openai"): Promise<unknown> {
    if (action === "seed") {
      const ctx = await this.#auth();
      return value(
        await this.#put(provider, ctx, this.providerAuth.credentials.status(provider).version),
      ).body;
    }
    if (action === "factory-oauth") return this.#factory(provider, "oauth");
    if (action === "factory-secret") return this.#factory(provider, "secret");
    if (action === "audit") return this.#audit();
    if (action === "negatives") return this.#negatives();
    if (action === "resolve-check") {
      const context = this.#resolution(provider),
        result = await this.resolveProviderAuth(context, context);
      return {
        ok: result.ok,
        code: result.ok ? null : result.code,
        noLeak: result.ok || !containsCanary(result),
      };
    }
    if (action === "replace" || action === "logout" || action === "stale-login")
      return this.#race(provider, action);
    if (action === "redirect") {
      const ctx = await this.#auth(),
        peer = this.#env.MODEL_PEER.getByName("protocol");
      value(await this.#put(provider, ctx, this.providerAuth.credentials.status(provider).version));
      await peer.hold("redirect");
      await peer.release();
      const resolution = this.#resolution(provider);
      const result = await this.resolveProviderAuth(resolution, resolution),
        count = (await peer.facts()).refresh;
      const retry = await this.resolveProviderAuth(resolution, resolution);
      return {
        rejected: !result.ok,
        noLeak: !containsCanary([result, retry]),
        state: this.providerAuth.credentials.status(provider).state,
        noBlindRetry: (await peer.facts()).refresh === count,
      };
    }
    throw new Error("Unknown synthetic scenario");
  }
}
export default {
  async fetch(request: Request, env: SecurityEnv): Promise<Response> {
    const url = new URL(request.url),
      cp = env.CONTROL_PLANE.getByName("control") as unknown as Pick<
        TestControlPlane,
        "canary" | "securityProbe"
      >;
    if (url.pathname === "/__models/ping") return Response.json({ ready: true });
    if (url.pathname === "/__models/peer")
      return Response.json(await env.MODEL_PEER.getByName("protocol").facts());
    if (url.pathname === "/__models/canary")
      return Response.json(await cp.canary(url.searchParams.get("write") ?? undefined));
    if (url.pathname === "/__models/probe") {
      const provider = url.searchParams.get("provider") === "anthropic" ? "anthropic" : "openai";
      try {
        return Response.json(
          await cp.securityProbe(url.searchParams.get("action") ?? "audit", provider),
        );
      } catch (error) {
        return errorResponse(error, uuid());
      }
    }
    return routeRequest(
      new Request(`https://fixture.invalid${url.pathname}${url.search}`, request),
      env,
    );
  },
} satisfies ExportedHandler<SecurityEnv>;
