import { randomUUID } from "node:crypto";
import type { Provider } from "@earendil-works/pi-ai/models";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { OAuthCredential, ProviderAuthPut, ProviderAuthReceipt } from "fortipi-contract";
import { validateProviderAuthPut } from "fortipi-contract";
import type { AdminClient } from "./admin.js";
import { CliError, check } from "./errors.js";
import { readProtected, writeProtected } from "./profiles.js";
import { validate } from "./validation.js";

export type AuthInteraction = Parameters<ReturnType<typeof createModels>["login"]>[2];
type Credential = Awaited<ReturnType<ReturnType<typeof createModels>["login"]>>;
type Store = NonNullable<NonNullable<Parameters<typeof createModels>[0]>["credentials"]>;
export const supportedOAuth = ["openai", "anthropic", "openai-codex"] as const;
export function providerFactory(id: string): Provider {
  switch (id) {
    case "openai":
      return openaiProvider();
    case "anthropic":
      return anthropicProvider();
    case "openai-codex":
      return openaiCodexProvider();
    default:
      throw new CliError("unsupported_oauth_provider", 3);
  }
}
/** Full public store contract, deliberately ephemeral and without ambient auth fallback. */
export function memoryStore(): Store & { clear(): void } {
  const entries = new Map<string, Credential>();
  let tail = Promise.resolve();
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = tail.then(fn);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  return {
    async read(id, options) {
      options?.signal?.throwIfAborted();
      await tail;
      return entries.get(id);
    },
    async list(options) {
      options?.signal?.throwIfAborted();
      await tail;
      return [...entries].map(([providerId, c]) => ({ providerId, type: c.type }));
    },
    modify(id, fn, options) {
      return serial(async () => {
        options?.signal?.throwIfAborted();
        const value = await fn(entries.get(id));
        options?.signal?.throwIfAborted();
        if (value !== undefined) entries.set(id, value);
        return entries.get(id);
      });
    },
    delete(id, options) {
      return serial(async () => {
        options?.signal?.throwIfAborted();
        entries.delete(id);
      });
    },
    clear() {
      entries.clear();
    },
  };
}
export function toWire(providerId: string, credential: Credential): OAuthCredential {
  check(credential.type === "oauth", "oauth_credential_required", 3);
  const { type, refresh, access, expires, ...fields } = credential;
  const allowed =
    providerId === "openai"
      ? ["clientId", "scopes"]
      : providerId === "openai-codex"
        ? ["accountId"]
        : [];
  check(
    Object.keys(fields).every((k) => allowed.includes(k)),
    "unsupported_oauth_field",
    3,
  );
  if (providerId === "openai")
    check(
      typeof fields.clientId === "string" &&
        fields.clientId.length > 0 &&
        Array.isArray(fields.scopes) &&
        fields.scopes.includes("chatgpt.tokens.use.direct"),
      "openai_extensions_required",
      3,
    );
  if (providerId === "openai-codex")
    check(
      typeof fields.accountId === "string" && fields.accountId.length > 0,
      "codex_account_required",
      3,
    );
  const wire = {
    type,
    refresh,
    access,
    expires,
    ...(Object.keys(fields).length ? { providerFields: fields } : {}),
  };
  validate("OAuthCredential", wire);
  return wire as OAuthCredential;
}
export async function installationId(path: string): Promise<string> {
  let value: unknown;
  try {
    value = await readProtected(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    value = { version: 1, deviceId: randomUUID() };
    await writeProtected(path, value);
  }
  const id = (value as { deviceId?: unknown }).deviceId;
  check(typeof id === "string" && /^[a-f0-9-]{36}$/.test(id), "invalid_installation_id", 3);
  return id;
}
export async function loginAndIngest(
  client: AdminClient,
  providerId: string,
  interaction: AuthInteraction,
  deviceId: string,
  requestId: string,
): Promise<ProviderAuthReceipt> {
  // This one nonsecret upstream override bypasses AuthContext; reject it before lazy flow loading.
  check(
    !process.env.PI_OAUTH_CALLBACK_HOST || process.env.PI_OAUTH_CALLBACK_HOST === "127.0.0.1",
    "oauth_callback_must_be_loopback",
    3,
  );
  const provider = providerFactory(providerId);
  const status = await client.call("getProviderAuthStatus", {
    path: { providerId },
    query: {},
    body: undefined,
  });
  const store = memoryStore();
  const models = createModels({
    credentials: store,
    authContext: {
      async env() {
        return undefined;
      },
      async fileExists() {
        return false;
      },
    },
  });
  models.setProvider(provider);
  let credential: Credential | undefined;
  let body: ProviderAuthPut | undefined;
  try {
    credential = await models.login(providerId, "oauth", interaction, {
      getDeviceId: () => deviceId,
      agentName: "FortiPi",
    });
    interaction.signal?.throwIfAborted();
    body = {
      requestId,
      expectedVersion: status.version,
      credential: toWire(providerId, credential),
    };
    validateProviderAuthPut(body);
    return await client.call("putProviderAuth", { path: { providerId }, query: {}, body });
  } catch (e) {
    if (interaction.signal?.aborted) throw new CliError("cancelled", 130);
    if (e instanceof CliError) throw e;
    // Upstream errors can contain token-response bodies. Never surface them.
    throw new CliError("oauth_login_failed_sign_in_again", 3);
  } finally {
    body = undefined;
    credential = undefined;
    store.clear();
    models.clearProviders();
  }
}
