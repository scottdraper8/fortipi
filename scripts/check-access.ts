// Check deployment capabilities without exposing credentials or response bodies.
import { createHash } from "node:crypto";

class AccessError extends Error {}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new AccessError(`Missing ${name}`);
  return value;
}

async function request(
  origin: string,
  path: string,
  token: string,
  bounded = false,
): Promise<Record<string, unknown>> {
  try {
    const response = await fetch(new URL(path, origin), {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
      ...(bounded ? { redirect: "error" as const } : {}),
    });
    if (!response.ok) {
      if (bounded) void response.body?.cancel().catch(() => {});
      throw new AccessError(`HTTP ${response.status}`);
    }
    let value: unknown;
    if (bounded) {
      if (!response.body) throw new AccessError("Invalid API response");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > 2_000_000) throw new AccessError("Response exceeds size bound");
          chunks.push(part.value);
        }
      } finally {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      value = JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
    } else value = await response.json();
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new AccessError("Invalid API response");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AccessError) throw error;
    throw new AccessError("Network failure or invalid response");
  }
}

async function analyticsAccess(account: string, token: string): Promise<void> {
  const nodes = [
    "workersInvocationsAdaptive",
    "durableObjectsInvocationsAdaptiveGroups",
    "durableObjectsPeriodicGroups",
  ] as const;
  const query = `query FortiPiInfrastructureAccess($account: string!) {
    viewer { accounts(filter: { accountTag: $account }) { accountTag settings {
      workersInvocationsAdaptive { enabled }
      durableObjectsInvocationsAdaptiveGroups { enabled }
      durableObjectsPeriodicGroups { enabled }
    } } }
  }`;
  function fail(
    kind:
      | "http-denied"
      | "unavailable"
      | "response-invalid"
      | "response-too-large"
      | "graphql-rejected"
      | "field-unavailable"
      | "account-mismatch"
      | "dataset-disabled",
  ): never {
    throw new AccessError(`Infrastructure analytics: ${kind}`);
  }
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  try {
    const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables: { account } }),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => {});
      fail(response.status === 401 || response.status === 403 ? "http-denied" : "unavailable");
    }
    if (!response.body) fail("response-invalid");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > 2_000_000) fail("response-too-large");
        chunks.push(part.value);
      }
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
    } catch {
      fail("response-invalid");
    }
    if (!object(value)) fail("response-invalid");
    if (value.errors !== undefined && value.errors !== null) {
      if (!Array.isArray(value.errors) || value.errors.length > 0) fail("graphql-rejected");
    }
    const data = value.data;
    if (!object(data) || !object(data.viewer)) fail("field-unavailable");
    const accounts = data.viewer.accounts;
    if (!Array.isArray(accounts) || accounts.length !== 1 || !object(accounts[0]))
      fail("account-mismatch");
    const selected = accounts[0];
    if (selected.accountTag !== account) fail("account-mismatch");
    const settings = selected.settings;
    if (!object(settings)) fail("field-unavailable");
    for (const node of nodes) {
      const setting = settings[node];
      if (!object(setting) || typeof setting.enabled !== "boolean") fail("field-unavailable");
      if (!setting.enabled) fail("dataset-disabled");
    }
  } catch (error) {
    if (error instanceof AccessError) throw error;
    fail("unavailable");
  }
  console.log("Infrastructure analytics datasets: enabled");
}

async function cloudflare(): Promise<void> {
  const account = required("CLOUDFLARE_ACCOUNT_ID");
  if (!/^[a-fA-F0-9]{32}$/.test(account)) {
    throw new AccessError("CLOUDFLARE_ACCOUNT_ID must be a 32-character account ID");
  }
  const token = required("CLOUDFLARE_API_TOKEN");
  const base = `/client/v4/accounts/${account}`;
  const checks = [
    ["Account access", base],
    ["Workers API", `${base}/workers/scripts`],
    ["Workers AI model catalog", `${base}/ai/models/search?per_page=1`],
  ] as const;
  for (const [label, path] of checks) {
    try {
      const result = await request("https://api.cloudflare.com", path, token);
      if (result.success !== true) throw new AccessError("API rejected access");
    } catch (error) {
      const detail = error instanceof AccessError ? error.message : "Request failed";
      throw new AccessError(`${label}: ${detail}`);
    }
    console.log(`${label}: verified`);
  }
  await analyticsAccess(account, token);
  let subdomain: unknown;
  try {
    const response = await request(
      "https://api.cloudflare.com",
      `${base}/workers/subdomain`,
      token,
      true,
    );
    const result = response.result;
    if (
      response.success !== true ||
      result === null ||
      typeof result !== "object" ||
      Array.isArray(result)
    )
      throw new AccessError("Unavailable subdomain");
    subdomain = (result as Record<string, unknown>).subdomain;
    if (
      typeof subdomain !== "string" ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain) ||
      subdomain.includes(account.toLowerCase()) ||
      subdomain.includes(token.toLowerCase())
    )
      throw new AccessError("Unavailable subdomain");
  } catch {
    throw new AccessError("Workers.dev target: unavailable");
  }
  console.log(`Account binding SHA-256: ${createHash("sha256").update(account).digest("hex")}`);
  console.log(`Workers.dev base: https://${subdomain}.workers.dev`);
  console.log("Write/deploy permissions will be verified by the actual deployment.");
}

async function npm(): Promise<void> {
  const token = required("NPM_TOKEN");
  const scope = required("NPM_SCOPE").replace(/^@/, "");
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(scope)) {
    throw new AccessError("NPM_SCOPE must be an npm username or organization name");
  }
  const result = await request("https://registry.npmjs.org", "/-/whoami", token);
  if (typeof result.username !== "string" || !result.username) {
    throw new AccessError("npm did not authenticate the token");
  }
  // A publishing token does not need organization-management permission.
  console.log("npm authentication: verified; publication scope configured");
  console.log("Publication rights and new-package creation remain unverified until publish.");
}

try {
  const target = process.argv[2];
  if (target === "cloudflare") await cloudflare();
  else if (target === "npm") await npm();
  else throw new AccessError("Expected target: cloudflare or npm");
} catch (error) {
  const detail = error instanceof AccessError ? error.message : "Unexpected failure";
  console.error(`Access preflight failed: ${detail}`);
  process.exitCode = 1;
}
