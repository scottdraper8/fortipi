import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { freeInfrastructurePolicy } from "fortipi-contract";
import { argv, commands } from "../dist/argv.js";
import { exactOrigin, operatorConfig } from "../dist/config.js";
import { config, example } from "./fixtures.ts";

test("emitted Configuration schema validates independent workspace/model/execution choices and canonical Free bounds", async () => {
  const c = await config();
  assert.deepEqual(c.runtime.infrastructure, freeInfrastructurePolicy);
  c.runtime.workspace = { kind: "local", executorId: "device-B", rootBindingId: "root-B" };
  c.runtime.models = [
    { providerId: "openai", modelId: "gpt-5", auth: { kind: "oauth", providerId: "openai" } },
  ];
  assert.equal(operatorConfig(c).runtime.execution.kind, "native");
  c.runtime.execution = {
    kind: "cloud-js",
    backendId: "js",
    modules: [],
    egress: [],
    onInterrupt: "fail",
  };
  assert.throws(() => operatorConfig(c), /paid_capability_required/);
  c.runtime.infrastructure.profile = "verified";
  c.runtime.infrastructure.accountPlan = "paid";
  c.runtime.infrastructure.capabilities = [
    {
      capability: "loader",
      state: "available",
      accountPlan: "paid",
      deploymentId: c.deployment.name,
      observedAt: 1,
    },
  ];
  assert.equal(operatorConfig(c).runtime.workspace.kind, "local");
  c.runtime.execution = {
    kind: "linux",
    backendId: "linux",
    host: "container",
    imageDigest: `sha256:${"a".repeat(64)}`,
    runtime: { cpuMs: 1, memoryBytes: 1, timeoutMs: 1 },
  };
  assert.throws(() => operatorConfig(c), /paid_capability_required/);
  c.runtime.infrastructure.capabilities.push({
    capability: "containers",
    state: "available",
    accountPlan: "paid",
    deploymentId: c.deployment.name,
    observedAt: 1,
  });
  assert.equal(operatorConfig(c).runtime.execution.kind, "linux");
});

test("unknown secrets/budgets, schema overflow, reserved bindings and mismatched OAuth identity fail closed", async () => {
  const original = JSON.parse(await readFile(example, "utf8")) as Record<string, unknown>;
  assert.throws(
    () => operatorConfig({ ...original, token: "synthetic-canary" }),
    /invalid_operator_config/,
  );
  const c = await config();
  c.runtime.infrastructure.bounds.objectBytes++;
  assert.throws(() => operatorConfig(c), /free_policy_exceeds_canonical_bounds/);
  c.runtime.infrastructure.bounds.objectBytes--;
  c.runtime.models = [
    {
      providerId: "openai",
      modelId: "gpt-5",
      auth: { kind: "secretRef", secretRef: "FORTIPI_ADMIN_TOKEN" },
    },
  ];
  assert.throws(() => operatorConfig(c), /reserved_secret_reference/);
  c.runtime.models = [
    { providerId: "openai", modelId: "gpt-5", auth: { kind: "oauth", providerId: "anthropic" } },
  ];
  assert.throws(() => operatorConfig(c), /oauth_provider_mismatch/);
  assert.throws(
    () =>
      operatorConfig({ ...original, runtime: { ...(original.runtime as object), modelBudget: 1 } }),
    /invalid_contract_input/,
  );
});

test("operator browser origins are opt-in exact HTTPS authorities with a closed bounded allowlist", async () => {
  const original = await config();
  assert.equal(operatorConfig(original).deployment.allowedOrigins, undefined);
  const withOrigins = (allowedOrigins: unknown) => ({
    ...original,
    deployment: { ...original.deployment, allowedOrigins },
  });
  const allowed = ["https://127.0.0.1:10110", "https://app.example"];
  assert.deepEqual(operatorConfig(withOrigins(allowed)).deployment.allowedOrigins, allowed);
  assert.deepEqual(operatorConfig(withOrigins([])).deployment.allowedOrigins, []);
  const maximum = Array.from({ length: 16 }, (_, index) => `https://app-${index}.example`);
  assert.deepEqual(operatorConfig(withOrigins(maximum)).deployment.allowedOrigins, maximum);
  for (const invalid of [
    null,
    allowed[0],
    [1],
    ["http://127.0.0.1:10110"],
    ["https://*.example"],
    ["https://user:password@app.example"],
    ["https://app.example/"],
    ["https://app.example/path"],
    ["https://app.example?query=1"],
    ["https://app.example#fragment"],
    ["https://APP.example"],
    [allowed[0], allowed[0]],
    [...maximum, "https://overflow.example"],
  ])
    assert.throws(() => operatorConfig(withOrigins(invalid)), /invalid_allowed_origins/);
  assert.throws(
    () => operatorConfig({ ...original, deployment: { ...original.deployment, vars: {} } }),
    /invalid_deployment/,
  );
});

test("argv accepts only documented options, preserves TUI argv, and every command has help", () => {
  for (const command of Object.keys(commands))
    assert.equal(argv([...command.split(" "), "--help"]).command, command);
  for (const input of [
    [],
    ["deploy", "--token", "synthetic-canary"],
    ["status", "--profile", "a", "--profile", "b"],
    ["status", "--profile=a"],
    ["status", "unwanted"],
    ["status", "--", "unwanted"],
  ])
    assert.throws(() => argv(input));
  assert.deepEqual(argv(["tui", "--", "--conversation", "$(echo no)"]).passthrough, [
    "--conversation",
    "$(echo no)",
  ]);
  assert.throws(() => exactOrigin("https://example.com/path"), /invalid_origin/);
  assert.throws(() => exactOrigin("http://127.0.0.1:9"), /invalid_origin/);
  assert.equal(exactOrigin("http://127.0.0.1:9", true), "http://127.0.0.1:9");
});
