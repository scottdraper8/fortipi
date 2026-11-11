import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { Configuration } from "fortipi-contract";
import { effectiveLimits, freeInfrastructurePolicy, requireCapability } from "fortipi-contract";
import { CliError, check } from "./errors.js";
import { validate } from "./validation.js";

export interface OperatorConfig {
  schemaVersion: 1;
  deployment: { name: string; origin: string; accountId?: string };
  runtime: Configuration;
}
export function exactOrigin(value: string, allowLoopback = false): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError("invalid_origin", 2);
  }
  check(
    url.origin === value &&
      !url.username &&
      !url.password &&
      (url.protocol === "https:" ||
        (allowLoopback &&
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))),
    "invalid_origin",
  );
  return value;
}
export function operatorConfig(value: unknown): OperatorConfig {
  check(value && typeof value === "object" && !Array.isArray(value), "invalid_operator_config");
  const c = value as OperatorConfig;
  check(
    Object.keys(c).sort().join() === "deployment,runtime,schemaVersion" && c.schemaVersion === 1,
    "invalid_operator_config",
  );
  check(
    c.deployment &&
      typeof c.deployment === "object" &&
      Object.keys(c.deployment).every((k) => ["name", "origin", "accountId"].includes(k)) &&
      typeof c.deployment.name === "string" &&
      /^[a-z][a-z0-9-]{0,62}$/.test(c.deployment.name) &&
      typeof c.deployment.origin === "string" &&
      (c.deployment.accountId === undefined || /^[a-f0-9]{32}$/.test(c.deployment.accountId)),
    "invalid_deployment",
  );
  exactOrigin(c.deployment.origin);
  validate("Configuration", c.runtime);
  const policy = c.runtime.infrastructure;
  if (policy.accountPlan !== "paid" || policy.profile === "free") {
    for (const [name, maximum] of Object.entries(freeInfrastructurePolicy.bounds)) {
      const actual = policy.bounds[name as keyof typeof policy.bounds];
      check(
        name === "headroomFraction" ? actual >= maximum : actual <= maximum,
        "free_policy_exceeds_canonical_bounds",
      );
    }
  }
  if (c.runtime.execution.kind !== "native") {
    const capability = c.runtime.execution.kind === "linux" ? "containers" : "loader";
    check(
      policy.profile === "verified" && requireCapability(policy, capability, c.deployment.name),
      "paid_capability_required",
      3,
    );
    // Contract evidence carries deployment identity; it has no account identity or expiry.
    // Never invent account verification from this local declaration.
  }
  const limits = effectiveLimits(policy);
  check(
    limits.fileBytes <= limits.snapshotBytes &&
      policy.bounds.workspaceBytes <= policy.bounds.objectBytes &&
      policy.bounds.objectBytes <= policy.bounds.installBytes,
    "inconsistent_capacity_bounds",
  );
  for (const m of c.runtime.models) {
    check(
      ["cloudflare", "openai", "anthropic", "openai-codex"].includes(m.providerId),
      "unsupported_model_provider",
      3,
    );
    if ("auth" in m) {
      check(
        m.auth.kind !== "oauth" || m.auth.providerId === m.providerId,
        "oauth_provider_mismatch",
      );
      check(m.providerId !== "openai-codex" || m.auth.kind === "oauth", "codex_requires_oauth");
      check(!m.endpoint, "custom_provider_endpoint_requires_review", 3);
      if (m.auth.kind === "secretRef")
        check(
          !["FORTIPI_ADMIN_TOKEN", "FORTIPI_MODEL_AUTH_KEY"].includes(m.auth.secretRef),
          "reserved_secret_reference",
        );
    }
  }
  return c;
}
export async function readJson(path: string, maximum = 1048576): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    check(stat.isFile() && stat.size <= maximum, "invalid_input_file");
    const buffer = Buffer.alloc(maximum + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    check(bytesRead <= maximum, "input_too_large");
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead)),
      );
    } catch {
      throw new CliError("invalid_json", 2);
    }
  } finally {
    await file.close();
  }
}
export async function readConfig(path: string): Promise<OperatorConfig> {
  return operatorConfig(await readJson(path));
}
export async function writeConfig(path: string, config: OperatorConfig): Promise<void> {
  operatorConfig(config);
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(config, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
}
