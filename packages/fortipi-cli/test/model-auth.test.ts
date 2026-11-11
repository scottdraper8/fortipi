import assert from "node:assert/strict";
import test from "node:test";
import type { AuthInteraction } from "../dist/model-auth.js";
import { loginAndIngest, memoryStore } from "../dist/model-auth.js";
import { json, server } from "./fixtures.ts";

const device = "12345678-1234-4234-8234-123456789abc";
test("actual public Pi OpenAI login preserves issued clientId/scopes through real localhost write-only ingest", async (t) => {
  let ingested: Record<string, unknown> | undefined;
  let tokenRequests = 0;
  const { api, endpoint } = await server(t, (req, res) => {
    assert.equal(req.headers.authorization, "Bearer synthetic-admin");
    assert.equal(req.url, "/v1/admin/models/openai/auth");
    if (req.method === "GET") {
      json(res, { providerId: "openai", version: null, generation: 0, state: "absent" });
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      ingested = JSON.parse(body) as Record<string, unknown>;
      json(res, { providerId: "openai", version: 1, generation: 1, state: "configured" });
    });
  });
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith(endpoint)) return original(input, init);
    assert.equal(url, "https://auth.openai.com/api/accounts/oauth/token");
    tokenRequests++;
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get("client_id"), "synthetic-issued-client");
    assert.equal(body.get("code"), "synthetic-code");
    assert.equal(body.get("grant_type"), "authorization_code");
    assert.ok(body.get("code_verifier"));
    return Response.json({
      access_token: "synthetic-access",
      refresh_token: "synthetic-refresh",
      id_token: "synthetic-id-token",
      expires_in: 3600,
      scope: "openid chatgpt.tokens.use.direct",
    });
  };
  let authorization: URL | undefined;
  const interaction: AuthInteraction = {
    notify(event) {
      if (event.type === "auth_url") authorization = new URL(event.url);
    },
    async prompt(prompt) {
      assert.equal(prompt.type, "manual_code");
      assert.ok(authorization);
      assert.equal(authorization.searchParams.get("agent_name_hint"), "FortiPi");
      assert.equal(authorization.searchParams.get("ext_agent_host_id"), `urn:uuid:${device}`);
      const callback = new URL("http://127.0.0.1:1455/auth/callback");
      callback.searchParams.set("state", authorization.searchParams.get("state") as string);
      callback.searchParams.set("code", "synthetic-code");
      callback.searchParams.set("client_id", "synthetic-issued-client");
      return callback.href;
    },
  };
  const receipt = await loginAndIngest(api, "openai", interaction, device, "request-A");
  assert.equal(tokenRequests, 1);
  assert.equal(ingested?.requestId, "request-A");
  assert.equal(ingested?.expectedVersion, null);
  const credential = ingested?.credential as {
    access: string;
    refresh: string;
    providerFields: unknown;
  };
  assert.equal(credential.access, "synthetic-access");
  assert.equal(credential.refresh, "synthetic-refresh");
  assert.deepEqual(credential.providerFields, {
    clientId: "synthetic-issued-client",
    scopes: ["openid", "chatgpt.tokens.use.direct"],
  });
  assert.equal(JSON.stringify(receipt).includes("synthetic-"), false);
});

test("actual Pi Anthropic copy-code selection, state rejection and cancellation never fall back to key auth or ingest", async (t) => {
  let ingests = 0;
  let exchanges = 0;
  const { api, endpoint } = await server(t, (req, res) => {
    if (req.method !== "GET") ingests++;
    json(res, { providerId: "anthropic", version: 2, generation: 2, state: "reauth_required" });
  });
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith(endpoint)) return original(input, init);
    exchanges++;
    throw new Error("unexpected upstream synthetic request");
  };
  const interaction: AuthInteraction = {
    notify() {},
    async prompt(prompt) {
      if (prompt.type === "select") {
        assert.ok(prompt.options.some((o) => o.id === "copy_code"));
        assert.ok(prompt.options.some((o) => o.id === "browser"));
        return "copy_code";
      }
      assert.equal(prompt.type, "manual_code");
      return "synthetic-code#wrong-state";
    },
  };
  await assert.rejects(
    loginAndIngest(api, "anthropic", interaction, device, "request-B"),
    /oauth_login_failed_sign_in_again/,
  );
  assert.equal(exchanges, 0);
  assert.equal(ingests, 0);
  const controller = new AbortController();
  const cancelled: AuthInteraction = {
    signal: controller.signal,
    notify() {},
    async prompt(prompt) {
      assert.equal(prompt.type, "select");
      controller.abort();
      throw new Error("synthetic cancellation");
    },
  };
  await assert.rejects(
    loginAndIngest(api, "anthropic", cancelled, device, "request-C"),
    /cancelled/,
  );
  assert.equal(ingests, 0);
});

test("actual Pi Anthropic copy-code completion delivers canonical full OAuth shape and preserves version CAS", async (t) => {
  let credential: unknown;
  const { api, endpoint } = await server(t, (req, res) => {
    if (req.method === "GET") {
      json(res, { providerId: "anthropic", version: 9, generation: 3, state: "configured" });
      return;
    }
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString();
    });
    req.on("end", () => {
      const value = JSON.parse(body) as { credential: unknown; expectedVersion: number };
      assert.equal(value.expectedVersion, 9);
      credential = value.credential;
      json(res, { providerId: "anthropic", version: 10, generation: 4, state: "configured" });
    });
  });
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith(endpoint)) return original(input, init);
    assert.equal(String(input), "https://platform.claude.com/v1/oauth/token");
    const value = JSON.parse(String(init?.body)) as { redirect_uri: string };
    assert.equal(value.redirect_uri, "https://platform.claude.com/oauth/code/callback");
    return Response.json({
      access_token: "synthetic-anthropic-access",
      refresh_token: "synthetic-anthropic-refresh",
      expires_in: 3600,
    });
  };
  let state = "";
  const interaction: AuthInteraction = {
    notify(event) {
      if (event.type === "auth_url") state = new URL(event.url).searchParams.get("state") as string;
    },
    async prompt(prompt) {
      return prompt.type === "select" ? "copy_code" : `synthetic-code#${state}`;
    },
  };
  await loginAndIngest(api, "anthropic", interaction, device, "request-D");
  const c = credential as { type: string; access: string; refresh: string; expires: number };
  assert.deepEqual(Object.keys(c).sort(), ["access", "expires", "refresh", "type"]);
  assert.equal(c.type, "oauth");
  assert.equal(c.access, "synthetic-anthropic-access");
  assert.ok(Number.isSafeInteger(c.expires));
});

test("in-memory complete CredentialStore serializes modify/delete without ambient persistence", async () => {
  const store = memoryStore();
  await store.modify("openai", async () => ({
    type: "oauth",
    access: "synthetic",
    refresh: "synthetic",
    expires: 1,
    clientId: "synthetic",
  }));
  let release: () => void = () => {};
  const pending = store.modify("openai", async (current) => {
    await new Promise<void>((r) => {
      release = r;
    });
    return current;
  });
  await Promise.resolve();
  const deletion = store.delete("openai");
  release();
  await Promise.all([pending, deletion]);
  assert.deepEqual(await store.list(), []);
  assert.equal(await store.read("openai"), undefined);
  store.clear();
});

test("actual public Pi Codex device-code flow remains distinct and retains account binding at ingest", async (t) => {
  let wire: { providerFields?: unknown } | undefined;
  const { api, endpoint } = await server(t, (req, res) => {
    assert.equal(req.url, "/v1/admin/models/openai-codex/auth");
    if (req.method === "GET") {
      json(res, { providerId: "openai-codex", version: null, generation: 0, state: "absent" });
      return;
    }
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString();
    });
    req.on("end", () => {
      wire = (JSON.parse(body) as { credential: typeof wire }).credential;
      json(res, { providerId: "openai-codex", version: 1, generation: 1, state: "configured" });
    });
  });
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const endpoints: string[] = [];
  const access = `synthetic.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64")}.signature`;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith(endpoint)) return original(input, init);
    endpoints.push(url);
    switch (url) {
      case "https://auth.openai.com/api/accounts/deviceauth/usercode":
        return Response.json({
          device_auth_id: "synthetic-device",
          user_code: "SYNTHETIC",
          interval: 0,
        });
      case "https://auth.openai.com/api/accounts/deviceauth/token":
        return Response.json({
          authorization_code: "synthetic-code",
          code_verifier: "synthetic-verifier",
        });
      case "https://auth.openai.com/oauth/token": {
        const body = new URLSearchParams(String(init?.body));
        assert.equal(body.get("redirect_uri"), "https://auth.openai.com/deviceauth/callback");
        assert.equal(body.get("code_verifier"), "synthetic-verifier");
        return Response.json({
          access_token: access,
          refresh_token: "synthetic-codex-refresh",
          expires_in: 3600,
        });
      }
      default:
        throw new Error("unexpected synthetic endpoint");
    }
  };
  let deviceEvent = false;
  const interaction: AuthInteraction = {
    notify(event) {
      if (event.type === "device_code") {
        deviceEvent = true;
        assert.equal(event.verificationUri, "https://auth.openai.com/codex/device");
      }
    },
    async prompt(prompt) {
      assert.equal(prompt.type, "select");
      if (prompt.type === "select")
        assert.ok(prompt.options.some((option) => option.id === "device_code"));
      return "device_code";
    },
  };
  await loginAndIngest(api, "openai-codex", interaction, device, "request-E");
  assert.equal(deviceEvent, true);
  assert.equal(endpoints.length, 3);
  assert.deepEqual(wire?.providerFields, { accountId: "synthetic-account" });
});
