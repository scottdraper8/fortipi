// Check deployment capabilities without exposing credentials or response bodies.
export {};

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
): Promise<Record<string, unknown>> {
  try {
    const response = await fetch(new URL(path, origin), {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new AccessError(`HTTP ${response.status}`);
    const value: unknown = await response.json();
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new AccessError("Invalid API response");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AccessError) throw error;
    throw new AccessError("Network failure or invalid response");
  }
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
