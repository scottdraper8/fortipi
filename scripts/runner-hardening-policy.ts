import assert from "node:assert/strict";

const nativeMode = "$" + "{{ runner.os == 'Linux' && 'block' || 'audit' }}";
const readToken = "$" + "{{ github.token }}";
const healthCommand = "node scripts/verify-foundation.ts --egress";
const evidenceCommand =
  'node scripts/prepare-release.ts evidence --mode native --candidate "$RUNNER_TEMP/candidate/candidate.json" --fixture "$FORTIPI_EVIDENCE_FIXTURE" --out dist/evidence/native';
const credentialName =
  /TOKEN|SECRET|PASSWORD|CREDENTIAL|(?:API|PRIVATE|ACCESS)[_-]?KEY|AUTHORIZATION|^CLOUDFLARE_/i;

function record(value: unknown): Record<string, unknown> {
  assert.ok(
    value && typeof value === "object" && !Array.isArray(value),
    "Invalid hardening policy object",
  );
  return value as Record<string, unknown>;
}
function publicValues(value: unknown): void {
  if (typeof value === "string")
    assert.ok(
      !/\bsecrets\b|\bgithub\s*(?:\.|\[)\s*['"]?token\b|\btoJSON\s*\(\s*github\b|CLOUDFLARE_(?:API_TOKEN|ACCOUNT_ID)|NPM_TOKEN|FORTIPI_ADMIN_TOKEN/i.test(
        value,
      ),
      "Native audit job cannot inherit credentials or unscoped tokens",
    );
  else if (Array.isArray(value)) value.forEach(publicValues);
  else if (value && typeof value === "object") Object.values(value).forEach(publicValues);
}
function publicInputs(value: unknown, tokenAllowed = false): Record<string, unknown> {
  const inputs = record(value ?? {}),
    publicInputs: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(inputs)) {
    if (key === "GITHUB_TOKEN" && tokenAllowed) {
      assert.equal(item, readToken, "Native read token must be the built-in job token");
      continue;
    }
    if (key === "persist-credentials") assert.equal(item, false);
    else assert.ok(!credentialName.test(key), "Native audit job cannot carry credential inputs");
    publicInputs[key] = item;
  }
  publicValues(publicInputs);
  return publicInputs;
}

/** Source policy only: audit does not attest installation, health or event delivery. */
export function assertRunnerHardeningPolicy(
  workflowPath: string,
  workflowPermissions: unknown,
  workflowEnv: unknown,
  jobName: string,
  jobValue: unknown,
): void {
  const job = record(jobValue);
  assert.ok(Array.isArray(job.steps), "Missing hardened job steps");
  const steps = job.steps.map(record),
    hardening = steps[0],
    health = steps[1];
  assert.ok(
    hardening && /^step-security\/harden-runner@[a-f0-9]{40}$/.test(String(hardening.uses)),
    "harden-runner must be first",
  );
  assert.equal(hardening.if, undefined, "Hardener must run unconditionally");
  assert.equal(hardening["continue-on-error"] ?? false, false);
  const inputs = record(hardening.with);
  const path = workflowPath.replaceAll("\\", "/"),
    native =
      (path === ".github/workflows/ci.yml" && jobName === "native-executor") ||
      (path === ".github/workflows/release.yml" && jobName === "native");
  assert.equal(
    inputs["egress-policy"],
    native ? nativeMode : "block",
    "Unreviewed runner egress policy",
  );
  assert.ok(
    health?.run === "/usr/bin/systemctl is-active --quiet agent.service" &&
      health.if === "runner.os == 'Linux'" &&
      health.shell === "bash" &&
      health["timeout-minutes"] === 1,
    "Linux hardener health gate must precede checkout and network steps",
  );
  assert.equal(health["continue-on-error"] ?? false, false);
  const endpoints = inputs["allowed-endpoints"];
  assert.ok(
    typeof endpoints === "string" && endpoints.trim(),
    "Explicit hardener endpoints are required",
  );
  assert.ok(
    !/[\r\n]/.test(endpoints.trim()),
    "harden-runner allowed-endpoints contains an internal newline; use a folded YAML scalar",
  );
  if (!native) return;

  assert.deepEqual(job.permissions, { contents: "read", actions: "read", checks: "read" });
  const inherited = record(workflowPermissions);
  assert.equal(inherited.contents, "read");
  assert.ok(
    Object.entries(inherited).every(
      ([key, value]) => ["contents", "actions", "checks"].includes(key) && value === "read",
    ),
    "Native audit workflow permissions must be read-only",
  );
  assert.equal(job["runs-on"], "$" + "{{ matrix.os }}");
  assert.deepEqual(job.strategy, {
    "fail-fast": false,
    matrix: { os: ["ubuntu-24.04", "macos-15", "windows-2025"] },
  });
  for (const key of ["environment", "secrets", "uses", "container", "services"])
    assert.ok(
      !Object.hasOwn(job, key),
      "Native audit is limited to hosted, unprivileged step jobs",
    );
  assert.equal(job["continue-on-error"] ?? false, false);
  assert.deepEqual(Object.keys(inputs).sort(), ["allowed-endpoints", "egress-policy"]);
  publicInputs(workflowEnv);
  publicInputs(job.env);
  const { steps: _steps, ...options } = job;
  publicValues(options);

  const final = steps.at(-1);
  assert.ok(final);
  assert.equal(final.name, "Require runner hardener health");
  assert.equal(final.run, healthCommand);
  assert.equal(final.if, "always()");
  assert.deepEqual(final.env, {
    GITHUB_TOKEN: readToken,
    FORTIPI_RUNNER_HARDENING_MODE: nativeMode,
  });
  assert.equal(steps.filter((step) => step.run === healthCommand).length, 1);
  for (const step of steps) {
    assert.equal(step["continue-on-error"] ?? false, false);
    const tokenAllowed =
      step === final || (path === ".github/workflows/release.yml" && step.run === evidenceCommand);
    const env = publicInputs(step.env, tokenAllowed);
    publicInputs(step.with);
    publicValues({ ...step, env });
    if (tokenAllowed) assert.equal(record(step.env).GITHUB_TOKEN, readToken);
  }
}
