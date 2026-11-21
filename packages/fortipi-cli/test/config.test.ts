import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { freeInfrastructurePolicy } from "fortipi-contract";
import { argv, commands } from "../dist/argv.js";
import { exactOrigin, operatorConfig } from "../dist/config.js";
import { runCommand } from "../dist/index.js";
import { initialize } from "../dist/initialization.js";
import { localModels } from "../dist/models.js";
import { config, example, temp } from "./fixtures.ts";

test("API-key onboarding accepts only executable provider/binding pairs before secret upload", async (t) => {
  const root = await temp(t);
  const path = join(root, "operator.json");
  let uploads = 0;
  for (const [providerId, canonical, other] of [
    ["openai", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
    ["anthropic", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
  ] as const) {
    const c = await config();
    for (const secretRef of [
      canonical,
      other,
      "MY_PROVIDER_KEY",
      "FORTIPI_ADMIN_TOKEN",
      "FORTIPI_MODEL_AUTH_KEY",
    ]) {
      c.runtime.models = [
        { providerId, modelId: "selected-model", auth: { kind: "secretRef", secretRef } },
      ];
      if (secretRef === canonical) {
        assert.deepEqual(operatorConfig(c).runtime.models, c.runtime.models);
        continue;
      }
      const error = secretRef.startsWith("FORTIPI_")
        ? /reserved_secret_reference/
        : /unsupported_model_secret_binding/;
      assert.throws(() => operatorConfig(c), error);
      await writeFile(path, JSON.stringify(c));
      await assert.rejects(
        runCommand(
          [
            "models",
            "configure",
            "--config",
            path,
            "--provider",
            providerId,
            "--auth",
            "binding",
            "--secret-ref",
            secretRef,
            "--directory",
            join(root, "not-prepared"),
            "--secret-stdin",
          ],
          {
            signal: new AbortController().signal,
            profileDirectory: root,
            wrangler: {
              async run() {
                uploads++;
                assert.fail("invalid binding reached Wrangler");
              },
            },
            transport: async () => {
              assert.fail("invalid binding reached the account");
            },
          },
        ),
        error,
      );
    }
    c.runtime.models = [
      { providerId, modelId: "selected-model", auth: { kind: "oauth", providerId } },
    ];
    assert.deepEqual(operatorConfig(c).runtime.models, c.runtime.models);
  }
  const c = await config();
  c.runtime.models = [
    {
      providerId: "openai-codex",
      modelId: "selected-model",
      auth: { kind: "oauth", providerId: "openai-codex" },
    },
  ];
  assert.deepEqual(operatorConfig(c).runtime.models, c.runtime.models);
  for (const secretRef of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "MY_PROVIDER_KEY"]) {
    c.runtime.models = [
      {
        providerId: "openai-codex",
        modelId: "selected-model",
        auth: { kind: "secretRef", secretRef },
      },
    ];
    assert.throws(() => operatorConfig(c), /codex_requires_oauth/);
  }
  assert.equal(uploads, 0);
});

test("initialization offers the actual canonical API-key name and rejects other choices before writing", async (t) => {
  const root = await temp(t);
  for (const [providerId, canonical, other] of [
    ["openai", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
    ["anthropic", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
  ] as const) {
    const modelId = localModels(providerId)[0]!.modelId;
    for (const selected of [canonical, other, "MY_PROVIDER_KEY"]) {
      const path = join(root, `${providerId}-${selected}.json`);
      const answers = [
        "binding-test",
        "https://binding-test.example",
        "",
        providerId,
        modelId,
        "binding",
        selected,
        "computer",
        "native",
        "device-A",
        "host",
        "explicit",
        "",
        "yes",
      ];
      let offered = false;
      const result = initialize(path, {
        interaction: () => ({
          async prompt(prompt) {
            if (prompt.type === "select" && prompt.message.startsWith("Provider API-key binding")) {
              offered = true;
              assert.deepEqual(prompt.options, [{ id: canonical, label: canonical }]);
            }
            const answer = answers.shift();
            assert.notEqual(answer, undefined, "unexpected initialization question");
            return answer!;
          },
          notify() {},
        }),
      });
      if (selected === canonical) {
        await result;
        assert.equal(answers.length, 0);
        const written = operatorConfig(JSON.parse(await readFile(path, "utf8")));
        assert.deepEqual(written.runtime.models, [
          { providerId, modelId, auth: { kind: "secretRef", secretRef: canonical } },
        ]);
      } else {
        await assert.rejects(result, /invalid_setup_choice/);
        await assert.rejects(readFile(path), { code: "ENOENT" });
        assert.equal(answers.length, 7, "bad binding must fail before remaining setup choices");
      }
      assert.equal(offered, true);
    }
  }
});

test("emitted Configuration schema validates independent workspace/model/execution choices and canonical Free bounds", async () => {
  const c = await config();
  assert.deepEqual(c.runtime.models, [
    { providerId: "cloudflare", modelId: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
  ]);
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
  assert.throws(
    () => operatorConfig(c),
    /paid_deployment_id_required_bootstrap_native_then_reprepare/,
  );
  c.deployment.deploymentId = "a".repeat(64);
  c.runtime.infrastructure.profile = "verified";
  c.runtime.infrastructure.accountPlan = "paid";
  c.runtime.infrastructure.capabilities = [
    {
      capability: "loader",
      state: "available",
      accountPlan: "paid",
      deploymentId: c.deployment.deploymentId,
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
    deploymentId: c.deployment.deploymentId,
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

test("Paid identity is the public DO ID; historical name evidence requires explicit reprepare", async () => {
  const c = await config();
  assert.equal(operatorConfig(c).deployment.deploymentId, undefined, "Free/native needs no ID");
  c.runtime.execution = {
    kind: "cloud-js",
    backendId: "js",
    modules: [],
    egress: [],
    onInterrupt: "fail",
  };
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
  const historical = JSON.stringify(c);
  assert.throws(() => operatorConfig(c), /paid_deployment_id_required.*reprepare/);
  assert.equal(JSON.stringify(c), historical, "Historical evidence is never rewritten");
  c.deployment.deploymentId = "a".repeat(64);
  const declared = JSON.stringify(c);
  assert.throws(() => operatorConfig(c), /paid_capability_required.*reprepare/);
  assert.equal(JSON.stringify(c), declared, "Adding identity cannot rebind evidence");
  for (const invalid of ["", c.deployment.name, "rollout-id", "a".repeat(63), 42, null]) {
    assert.throws(
      () =>
        operatorConfig({
          ...c,
          deployment: { ...c.deployment, deploymentId: invalid },
        }),
      /invalid_canonical_deployment_id/,
    );
  }
  c.runtime.infrastructure.capabilities[0]!.deploymentId = c.deployment.deploymentId;
  assert.equal(operatorConfig(c), c);
  for (const fault of ["foreign", "free-policy", "free-record", "unavailable"] as const) {
    const bad = structuredClone(c);
    if (fault === "foreign")
      bad.runtime.infrastructure.capabilities[0]!.deploymentId = "b".repeat(64);
    if (fault === "free-policy") bad.runtime.infrastructure.accountPlan = "free";
    if (fault === "free-record") bad.runtime.infrastructure.capabilities[0]!.accountPlan = "free";
    if (fault === "unavailable") bad.runtime.infrastructure.capabilities = [];
    assert.throws(() => operatorConfig(bad), /paid_capability_required/);
  }
});

test("Paid init imports the existing public ID separately from unchanged capability evidence", async (t) => {
  const root = await temp(t);
  const policy = structuredClone(freeInfrastructurePolicy);
  policy.profile = "verified";
  policy.accountPlan = "paid";
  const deploymentId = "a".repeat(64);
  policy.capabilities = [
    {
      capability: "loader",
      state: "available",
      accountPlan: "paid",
      deploymentId,
      observedAt: 1,
    },
  ];
  const policyPath = join(root, "policy.json"),
    backendPath = join(root, "backend.json");
  await writeFile(policyPath, JSON.stringify(policy));
  await writeFile(
    backendPath,
    JSON.stringify({
      kind: "cloud-js",
      backendId: "js",
      modules: [],
      egress: [],
      onInterrupt: "fail",
    }),
  );
  for (const selectedId of [deploymentId, "b".repeat(64)]) {
    const path = join(root, `${selectedId}.json`);
    const answers = [
      "existing-worker",
      "https://existing-worker.example",
      "",
      "cloudflare",
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      "computer",
      "cloud-js",
      selectedId,
      policyPath,
      backendPath,
      "cloud",
      "js",
      "yes",
    ];
    let bootstrapNotice = false;
    const result = initialize(path, {
      interaction: () => ({
        async prompt() {
          const answer = answers.shift();
          assert.notEqual(answer, undefined);
          return answer!;
        },
        notify(event) {
          if (event.type === "info" && event.message.includes("first deploy Free/native")) {
            bootstrapNotice = true;
            assert.match(event.message, /does not prove Paid entitlement/);
          }
        },
      }),
    });
    if (selectedId === deploymentId) {
      await result;
      const written = operatorConfig(JSON.parse(await readFile(path, "utf8")));
      assert.equal(written.deployment.deploymentId, deploymentId);
      assert.deepEqual(written.runtime.infrastructure, policy);
      assert.equal(answers.length, 0);
    } else {
      await assert.rejects(result, /paid_capability_required.*reprepare/);
      await assert.rejects(readFile(path), { code: "ENOENT" });
    }
    assert.equal(bootstrapNotice, true);
    assert.deepEqual(JSON.parse(await readFile(policyPath, "utf8")), policy);
  }
});
