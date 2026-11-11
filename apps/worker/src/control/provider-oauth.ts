import type { Provider } from "@earendil-works/pi-ai/models";
import type * as D from "../boundary/dto.js";
import { check } from "./store.js";

type OAuth = NonNullable<Provider["auth"]["oauth"]>;
export type OAuthCredential = Parameters<OAuth["refresh"]>[0];
export const supportedProviders = ["openai", "anthropic", "openai-codex"] as const;
export function validateCredential(provider: string, credential: OAuthCredential): void {
  check(
    supportedProviders.some((x) => x === provider),
    "unsupported",
    "Unsupported OAuth provider",
  );
  check(
    credential.type === "oauth" &&
      Number.isSafeInteger(credential.expires) &&
      credential.expires >= 0,
    "invalid_request",
    "Invalid OAuth credential",
  );
  for (const key of ["access", "refresh"] as const)
    check(
      typeof credential[key] === "string" &&
        credential[key].length > 0 &&
        new TextEncoder().encode(credential[key]).length <= 16384,
      "invalid_request",
      "Invalid OAuth field",
    );
  const allowed =
    provider === "openai"
      ? ["clientId", "scopes"]
      : provider === "openai-codex"
        ? ["accountId"]
        : [];
  check(
    Object.keys(credential).every((k) =>
      ["type", "access", "refresh", "expires", ...allowed].includes(k),
    ),
    "invalid_request",
    "Unknown provider credential field",
  );
  if (provider === "openai") {
    check(
      typeof credential.clientId === "string" &&
        credential.clientId.length > 0 &&
        credential.clientId.length <= 1024,
      "invalid_request",
      "OpenAI requires issued clientId",
    );
    check(
      Array.isArray(credential.scopes) &&
        credential.scopes.length <= 100 &&
        credential.scopes.every((x) => typeof x === "string" && x.length <= 256) &&
        credential.scopes.includes("chatgpt.tokens.use.direct"),
      "invalid_request",
      "OpenAI requires direct-token scope",
    );
  }
  if (provider === "openai-codex")
    check(
      typeof credential.accountId === "string" &&
        credential.accountId.length > 0 &&
        credential.accountId.length <= 256,
      "invalid_request",
      "Codex requires accountId",
    );
}
export function fromWire(provider: string, input: D.OAuthCredential): OAuthCredential {
  check(
    !Object.keys(input.providerFields ?? {}).some((k) =>
      ["type", "access", "refresh", "expires"].includes(k),
    ),
    "invalid_request",
    "Reserved provider field",
  );
  const credential = {
    ...input.providerFields,
    type: input.type,
    access: input.access,
    refresh: input.refresh,
    expires: input.expires,
  };
  validateCredential(provider, credential);
  return credential;
}
/** Protocol adaptation from MIT pi-ai1.5.2 OAuth modules (Mario Zechner). Interactive flows stay in CLI. */
export function workerOAuth(
  provider: string,
  transport: typeof fetch = fetch,
  beginRefresh?: () => void,
): OAuth {
  return {
    name: provider,
    isSubscription: true,
    async login() {
      throw new Error("Interactive login belongs in the CLI");
    },
    async refresh(credential, signal) {
      validateCredential(provider, credential);
      beginRefresh?.();
      const openai = provider === "openai";
      const codex = provider === "openai-codex";
      const endpoint = openai
        ? "https://auth.openai.com/api/accounts/oauth/token"
        : codex
          ? "https://auth.openai.com/oauth/token"
          : "https://platform.claude.com/v1/oauth/token";
      const body = openai
        ? new URLSearchParams({
            grant_type: "refresh_token",
            client_id: String(credential.clientId),
            refresh_token: credential.refresh,
            resource: "https://api.openai.com/v1",
          })
        : codex
          ? new URLSearchParams({
              grant_type: "refresh_token",
              client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
              refresh_token: credential.refresh,
            })
          : JSON.stringify({
              grant_type: "refresh_token",
              client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
              refresh_token: credential.refresh,
            });
      // Construct the real Worker request before the injectable network boundary. Workers
      // supports manual redirects; a 3xx is rejected below without forwarding credentials.
      const request = new Request(endpoint, {
        method: "POST",
        redirect: "manual",
        headers: {
          accept: "application/json",
          "content-type":
            openai || codex ? "application/x-www-form-urlencoded" : "application/json",
        },
        body,
        ...(signal ? { signal } : {}),
      });
      const response = await transport(request);
      check(response.ok, "unauthenticated", "Provider refresh rejected; sign in again");
      const reader = response.body?.getReader();
      check(reader, "unauthenticated", "Invalid provider response");
      const bytes = new Uint8Array(65536);
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          check(
            size + part.value.length <= bytes.length,
            "unauthenticated",
            "Provider response too large",
          );
          bytes.set(part.value, size);
          size += part.value.length;
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      let token: Record<string, unknown>;
      try {
        token = JSON.parse(
          new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
            bytes.subarray(0, size),
          ),
        ) as Record<string, unknown>;
      } catch {
        throw new Error("Invalid provider response");
      }
      check(
        token &&
          typeof token === "object" &&
          typeof token.access_token === "string" &&
          typeof token.refresh_token === "string" &&
          typeof token.expires_in === "number" &&
          token.expires_in > 0 &&
          token.expires_in <= 31536000,
        "unauthenticated",
        "Invalid provider token fields",
      );
      const result: OAuthCredential = {
        ...credential,
        type: "oauth",
        access: token.access_token,
        refresh: token.refresh_token,
        expires: Date.now() + token.expires_in * 1000 - (openai ? 180000 : 300000),
      };
      if (openai) {
        check(typeof token.scope === "string", "unauthenticated", "Missing provider scope");
        result.scopes = token.scope.trim().split(/\s+/);
      }
      if (codex) {
        // Codex is a distinct OAuth-only provider. Account binding comes from the returned access token.
        const part = result.access.split(".")[1];
        check(part, "unauthenticated", "Missing Codex account binding");
        const payload = JSON.parse(atob(part.replaceAll("-", "+").replaceAll("_", "/"))) as Record<
          string,
          unknown
        >;
        const auth = payload["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
        result.accountId = auth?.chatgpt_account_id;
      }
      validateCredential(provider, result);
      return result;
    },
    async toAuth(credential) {
      validateCredential(provider, credential);
      return { apiKey: credential.access };
    },
  };
}
