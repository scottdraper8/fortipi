import assert from "node:assert/strict";
import test from "node:test";
import { assertRunnerHardeningPolicy } from "../../runner-hardening-policy.ts";

const mode = "$" + "{{ runner.os == 'Linux' && 'block' || 'audit' }}";
const token = "$" + "{{ github.token }}";
interface PolicyCase {
  path: string;
  name: string;
  permissions: unknown;
  env: Record<string, unknown>;
  job: Record<string, unknown>;
}
function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function steps(c: PolicyCase): Record<string, unknown>[] {
  assert.ok(Array.isArray(c.job.steps));
  return c.job.steps.map(record);
}
function step(c: PolicyCase, index: number): Record<string, unknown> {
  const value = steps(c).at(index);
  assert.ok(value);
  return value;
}
function fixture(release = false): PolicyCase {
  return {
    path: `.github/workflows/${release ? "release" : "ci"}.yml`,
    name: release ? "native" : "native-executor",
    permissions: { contents: "read" },
    env: { CI: "true" },
    job: {
      permissions: { contents: "read", actions: "read", checks: "read" },
      strategy: {
        "fail-fast": false,
        matrix: { os: ["ubuntu-24.04", "macos-15", "windows-2025"] },
      },
      "runs-on": "$" + "{{ matrix.os }}",
      steps: [
        {
          uses: `step-security/harden-runner@${"a".repeat(40)}`,
          with: { "egress-policy": mode, "allowed-endpoints": "github.com:443" },
        },
        {
          name: "Require Linux hardener service active",
          if: "runner.os == 'Linux'",
          shell: "bash",
          "timeout-minutes": 1,
          run: "/usr/bin/systemctl is-active --quiet agent.service",
        },
        { uses: `actions/checkout@${"b".repeat(40)}`, with: { "persist-credentials": false } },
        {
          name: "Require runner hardener health",
          if: "always()",
          run: "node scripts/verify-foundation.ts --egress",
          env: { GITHUB_TOKEN: token, FORTIPI_RUNNER_HARDENING_MODE: mode },
        },
      ],
    },
  };
}
function validate(c: PolicyCase): void {
  assertRunnerHardeningPolicy(c.path, c.permissions, c.env, c.name, c.job);
}

test("native audit policy accepts only the two fixed hosted matrices and scoped read tokens", () => {
  validate(fixture());
  const folded = fixture();
  record(step(folded, 0).with)["allowed-endpoints"] = "github.com:443 api.github.com:443\n";
  validate(folded);
  const release = fixture(true);
  const values = steps(release);
  values.splice(3, 0, {
    run: 'node scripts/prepare-release.ts evidence --mode native --candidate "$RUNNER_TEMP/candidate/candidate.json" --fixture "$FORTIPI_EVIDENCE_FIXTURE" --out dist/evidence/native',
    env: { GITHUB_TOKEN: token },
  });
  release.job.steps = values;
  validate(release);
});

test("native audit policy refuses inherited secrets, protected environments and permission escalation", () => {
  const faults: ((c: PolicyCase) => void)[] = [
    (c) => {
      c.env.SAFE = "$" + "{{ secrets['PRODUCTION'] }}";
    },
    (c) => {
      c.env.SAFE = "$" + "{{ toJSON(secrets) }}";
    },
    (c) => {
      c.env.NPM_TOKEN = "synthetic-private";
    },
    (c) => {
      c.env.GITHUB_TOKEN = token;
    },
    (c) => {
      c.job.env = { CLOUDFLARE_ACCOUNT_ID: "synthetic-account" };
    },
    (c) => {
      c.job.environment = "production";
    },
    (c) => {
      c.job.secrets = "inherit";
    },
    (c) => {
      c.permissions = "write-all";
    },
    (c) => {
      c.permissions = { contents: "write" };
    },
    (c) => {
      record(c.job.permissions)["id-token"] = "write";
    },
    (c) => {
      record(c.job.permissions).contents = "write";
    },
    (c) => {
      record(c.job.permissions).checks = "write";
    },
    (c) => {
      delete record(c.job.permissions).checks;
    },
    (c) => {
      step(c, 2).env = { GITHUB_TOKEN: token };
    },
    (c) => {
      step(c, 2).with = { "api-key": "synthetic-key" };
    },
    (c) => {
      step(c, -1).env = {
        GITHUB_TOKEN: "$" + "{{ secrets.READ_TOKEN }}",
        FORTIPI_RUNNER_HARDENING_MODE: mode,
      };
    },
  ];
  for (const fault of faults) {
    const c = fixture();
    fault(c);
    assert.throws(() => validate(c));
  }
});

test("native audit policy rejects matrix substitutions, changed mode expressions and suppressed health", () => {
  const faults: ((c: PolicyCase) => void)[] = [
    (c) => {
      c.path = ".github/workflows/deploy.yml";
    },
    (c) => {
      c.name = "native-other";
    },
    (c) => {
      c.job["runs-on"] = "self-hosted";
    },
    (c) => {
      record(step(c, 0).with)["allowed-endpoints"] = "github.com:443\napi.github.com:443";
    },
    (c) => {
      record(record(c.job.strategy).matrix).os = ["ubuntu-24.04", "macos-15"];
    },
    (c) => {
      record(record(c.job.strategy).matrix).include = [{ os: "self-hosted" }];
    },
    (c) => {
      record(c.job.strategy)["fail-fast"] = true;
    },
    (c) => {
      record(step(c, 0).with)["egress-policy"] = "audit";
    },
    (c) => {
      record(step(c, 0).with)["egress-policy"] = "block";
    },
    (c) => {
      record(step(c, 0).with)["egress-policy"] = mode.replace("'Linux'", "'Windows'");
    },
    (c) => {
      step(c, 0).if = "false";
    },
    (c) => {
      step(c, 1).if = "false";
    },
    (c) => {
      step(c, -1)["continue-on-error"] = true;
    },
    (c) => {
      step(c, -1).if = "success()";
    },
    (c) => {
      record(step(c, -1).env).FORTIPI_RUNNER_HARDENING_MODE = "audit";
    },
  ];
  for (const fault of faults) {
    const c = fixture();
    fault(c);
    assert.throws(() => validate(c));
  }
});

test("credentialed publication jobs keep literal block and cannot borrow the native exception", () => {
  const c = fixture(true);
  c.name = "publish";
  c.job.environment = "npm-release";
  c.job.permissions = { contents: "write", "id-token": "write" };
  record(step(c, 0).with)["egress-policy"] = "block";
  validate(c);
  for (const value of ["audit", mode]) {
    record(step(c, 0).with)["egress-policy"] = value;
    assert.throws(() => validate(c));
  }
  for (const [path, name] of [
    [".github/workflows/compatibility-watch.yml", "review"],
    [".github/workflows/image-proof.yml", "image"],
    [".github/workflows/deploy.yml", "operate"],
  ]) {
    assert.ok(path && name);
    c.path = path;
    c.name = name;
    record(step(c, 0).with)["egress-policy"] = "block";
    validate(c);
    for (const value of ["audit", mode]) {
      record(step(c, 0).with)["egress-policy"] = value;
      assert.throws(() => validate(c));
    }
  }
});
