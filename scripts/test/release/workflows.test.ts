import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { repository } from "../../build-workspaces.ts";
import { assertRunnerHardeningPolicy } from "../../runner-hardening-policy.ts";
import { object } from "../../verify-release-gates.ts";

test("native hardening keeps all platform oracles and final read-only health under the supported mode", async () => {
  for (const [file, name, required] of [
    [
      "ci",
      "native-executor",
      [
        "pnpm run test:executor",
        "node --test scripts/test/release/artifact-payload-portability.test.ts",
      ],
    ],
    [
      "release",
      "native",
      ["node scripts/install-dependencies.ts", "node scripts/build-workspaces.ts build:evidence"],
    ],
  ] as const) {
    const workflow = object(
      parse(await readFile(resolve(repository, `.github/workflows/${file}.yml`), "utf8")),
    );
    for (const [jobName, job] of Object.entries(object(workflow.jobs)))
      assertRunnerHardeningPolicy(
        `.github/workflows/${file}.yml`,
        workflow.permissions,
        workflow.env,
        jobName,
        job,
      );
    const job = object(object(workflow.jobs)[name]);
    assert.ok(Array.isArray(job.steps));
    const steps = job.steps.map(object);
    for (const command of required) {
      const matching = steps.filter((step) => step.run === command);
      assert.equal(matching.length, 1);
      assert.equal(matching[0]?.if, undefined);
    }
    if (file === "release") {
      const evidence = steps.filter((step) =>
        String(step.run).startsWith("node scripts/prepare-release.ts evidence --mode native "),
      );
      assert.equal(evidence.length, 1);
      assert.equal(evidence[0]?.if, undefined);
    }
  }
});

test("compatibility workflows keep PR scope explicit and installed release gates strict", async () => {
  const [watch, ci, release] = await Promise.all(
    ["compatibility-watch", "ci", "release"].map(async (name) =>
      object(parse(await readFile(resolve(repository, `.github/workflows/${name}.yml`), "utf8"))),
    ),
  );
  assert.ok(watch && ci && release);
  const events = object(watch.on);
  for (const event of ["pull_request", "schedule", "workflow_dispatch"])
    assert.ok(Object.hasOwn(events, event));
  assert.deepEqual(watch.permissions, { contents: "read" });
  const command = "node tools/compatibility-watch/watch.ts";
  const steps = (job: Record<string, unknown>) => {
    assert.equal(job["continue-on-error"] ?? false, false);
    assert.ok(Array.isArray(job.steps));
    return job.steps.map(object);
  };
  const observations = (values: Record<string, unknown>[]) =>
    values.filter((step) => String(step.run ?? "").includes("tools/compatibility-watch/watch.ts"));
  const review = object(object(watch.jobs).review);
  assert.equal(review.if, undefined);
  const reviewSteps = steps(review);
  for (const step of reviewSteps) assert.equal(step["continue-on-error"] ?? false, false);
  const watchSteps = observations(reviewSteps);
  assert.deepEqual(
    watchSteps.map((step) => ({ run: step.run, if: step.if })),
    [
      { run: `${command} --required-current`, if: "github.event_name == 'pull_request'" },
      { run: command, if: "github.event_name != 'pull_request'" },
    ],
  );
  for (const step of watchSteps)
    assert.deepEqual(step.env, { GITHUB_TOKEN: "$" + "{{ github.token }}" });
  for (const [workflow, name, condition] of [
    [ci, "policy-and-integration", "github.event_name != 'workflow_dispatch'"],
    [release, "candidate", undefined],
  ] as const) {
    const gates = observations(steps(object(object(workflow.jobs)[name])));
    assert.equal(gates.length, 1);
    const gate = gates[0];
    assert.ok(gate);
    assert.equal(gate.run, `${command} --release`);
    assert.equal(gate.if, condition);
    assert.equal(gate["continue-on-error"] ?? false, false);
  }
});

test("access dispatch preserves informational bootstrap and authenticates recorded candidates before scoped keys", async () => {
  const access = object(
    parse(await readFile(resolve(repository, ".github/workflows/access-preflight.yml"), "utf8")),
  );
  const inputs = object(object(object(access.on).workflow_dispatch).inputs);
  assert.deepEqual(object(inputs.purpose).options, ["informational", "deployment", "publication"]);
  assert.equal(object(inputs.purpose).default, "informational");
  assert.equal(object(inputs.candidate).default, "{}");
  const jobs = object(access.jobs);
  assert.equal(object(jobs.npm).needs, "cloudflare");
  assert.match(String(object(jobs.npm).if), /inputs\.purpose == 'informational'/);
  assert.match(
    String(object(jobs.npm).if),
    /inputs\.purpose == 'publication' && needs\.cloudflare\.result == 'success'/,
  );
  const validate = (value: Record<string, unknown>) => {
    for (const [name, raw] of Object.entries(object(value.jobs))) {
      const job = object(raw);
      assert.equal(job.environment, name === "cloudflare" ? "production" : "npm-release");
      assert.ok(Array.isArray(job.steps));
      const steps = job.steps.map(object);
      assert.match(String(steps[0]?.uses), /^step-security\/harden-runner@[a-f0-9]{40}$/);
      assert.equal(object(steps[0]?.with)["egress-policy"], "block");
      const condition =
        name === "cloudflare"
          ? "inputs.purpose != 'informational'"
          : "inputs.purpose == 'publication'";
      const authenticated = steps.findIndex((s) =>
        String(s.run).includes("access-evidence.ts authenticate"),
      );
      const recorded = steps.findIndex((s) =>
        String(s.run).includes(
          `access-evidence.ts ${name === "cloudflare" ? "cloudflare" : "publication"} `,
        ),
      );
      assert.ok(authenticated >= 0 && recorded > authenticated);
      assert.equal(steps[authenticated]?.if, condition);
      for (const key of ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "NPM_TOKEN"])
        assert.equal(object(steps[authenticated]?.env)[key], undefined);
      assert.equal(steps[recorded]?.if, condition);
      assert.equal(object(steps[recorded]?.env).GITHUB_TOKEN, "$" + "{{ github.token }}");
      const probe = steps.find((s) => String(s.run) === `node scripts/check-access.ts ${name}`);
      assert.ok(probe);
      assert.equal(probe.if, "inputs.purpose == 'informational'");
      const uploads = steps.filter((s) => String(s.uses).startsWith("actions/upload-artifact@"));
      assert.equal(uploads.length, 1);
      assert.equal(uploads[0]?.if, condition);
      assert.equal(object(uploads[0]?.with)["if-no-files-found"], "error");
      assert.equal(object(uploads[0]?.with)["retention-days"], 30);
      const checkout = steps.find((s) => String(s.uses).startsWith("actions/checkout@"));
      assert.equal(object(checkout?.with)["persist-credentials"], false);
    }
  };
  validate(access);
  const bad = structuredClone(access);
  const steps = object(object(bad.jobs).cloudflare).steps;
  assert.ok(Array.isArray(steps));
  const auth = steps
    .map(object)
    .find((s) => String(s.run).includes("access-evidence.ts authenticate"));
  assert.ok(auth);
  object(auth.env).CLOUDFLARE_API_TOKEN = "synthetic-only";
  assert.throws(() => validate(bad));
  const deploySource = await readFile(resolve(repository, "scripts/deploy-smoke.ts"), "utf8");
  const operation = deploySource.slice(
    deploySource.indexOf("export async function operateDeployment("),
  );
  assert.ok(
    operation.indexOf("assertTarget(target)") < operation.indexOf("const gate = await execute("),
  );
  assert.match(operation, /"--account-binding-sha256",\s+target\.accountBindingSha256/);
});

test("workflow topology keeps target credentials in fixed slots, publication after readiness, and finalization after publication", async () => {
  const release = object(
    parse(await readFile(resolve(repository, ".github/workflows/release.yml"), "utf8")),
  );
  const deploy = object(
    parse(await readFile(resolve(repository, ".github/workflows/deploy.yml"), "utf8")),
  );
  const jobs = object(release.jobs);
  assert.equal(
    object(release.env).FORTIPI_CANDIDATE_REFERENCE,
    "$" + "{{ inputs.operation == 'publish' && inputs.candidate || '' }}",
  );
  assert.equal(object(deploy.env).FORTIPI_CANDIDATE_REFERENCE, "$" + "{{ inputs.candidate }}");
  const finalSteps = object(jobs.finalize).steps;
  assert.ok(Array.isArray(finalSteps));
  assert.ok(
    String(object(object(finalSteps[0]).with)["allowed-endpoints"])
      .split(/\s+/)
      .includes("uploads.github.com:443"),
  );
  assert.deepEqual(object(jobs.publish).needs, ["proofs", "readiness"]);
  assert.deepEqual(object(jobs["final-readiness"]).needs, ["proofs", "publish"]);
  assert.deepEqual(object(jobs.finalize).needs, ["proofs", "publish", "final-readiness"]);
  assert.deepEqual(object(jobs["native-receipt"]).needs, ["candidate", "native"]);
  const assertJobs = (workflow: Record<string, unknown>, workflowPath: string) => {
    for (const [name, raw] of Object.entries(object(workflow.jobs))) {
      const job = object(raw);
      assert.ok(Array.isArray(job.steps));
      const steps = job.steps.map(object);
      assertRunnerHardeningPolicy(workflowPath, workflow.permissions, workflow.env, name, job);
      const permissions = object(job.permissions ?? {});
      if (permissions["id-token"] === "write") assert.equal(name, "publish");
      if (permissions.contents === "write") assert.equal(name, "finalize");
      for (const step of steps) {
        if (step.uses) assert.match(String(step.uses), /@[a-f0-9]{40}$/);
        if (String(step.uses).startsWith("actions/checkout"))
          assert.equal(object(step.with)["persist-credentials"], false);
        if (String(step.uses).startsWith("actions/upload-artifact"))
          assert.ok(Number(object(step.with)["retention-days"]) >= 30);
        const env = object(step.env ?? {});
        if (env.NPM_TOKEN) {
          assert.equal(name, "publish");
          assert.equal(job.environment, "npm-release");
        }
        if (env.CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_ACCOUNT_ID) {
          assert.ok(
            [
              "readiness",
              "final-readiness",
              "initial-installed-deployment",
              "live-device-a",
              "live-device-b",
              "operate",
            ].includes(name),
          );
          assert.match(
            String(job.environment),
            /== 'paid-validation' && 'paid-validation' \|\| 'production'/,
          );
        }
        if (env.FORTIPI_ADMIN_TOKEN) {
          assert.ok(
            [
              "readiness",
              "final-readiness",
              "initial-installed-deployment",
              "live-device-a",
              "live-device-b",
              "live-device-cleanup",
              "operate",
            ].includes(name),
          );
          assert.match(
            String(job.environment),
            /== 'paid-validation' && 'paid-validation' \|\| 'production'/,
          );
        }
      }
      if (
        [
          "initial-installed-deployment",
          "live-device-a",
          "live-device-b",
          "live-device-cleanup",
          "operate",
        ].includes(name)
      ) {
        const installed = steps.findIndex((step) =>
          String(step.run).includes("live-device-evidence.ts install "),
        );
        const exposed = steps.findIndex((step) => {
          const env = object(step.env ?? {});
          return Boolean(
            env.FORTIPI_ADMIN_TOKEN || env.CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_ACCOUNT_ID,
          );
        });
        assert.ok(
          installed >= 0 && exposed > installed,
          "Own credential-free install must precede every protected device call",
        );
      }
      if (name === "readiness" || name === "final-readiness") {
        assert.ok(object(object(job.strategy).matrix).target);
        const install = steps.findIndex((s) => String(s.run).includes("prepare-readiness"));
        const protectedCall = steps.findIndex((s) => object(s.env ?? {}).CLOUDFLARE_API_TOKEN);
        assert.ok(
          install >= 0 && protectedCall > install,
          "Retained distribution must install before credentials are exposed",
        );
        assert.equal(object(steps[install]?.env).GITHUB_TOKEN, "$" + "{{ github.token }}");
        const upload = steps.find((s) => String(s.uses).startsWith("actions/upload-artifact"));
        assert.ok(upload);
        assert.match(String(object(upload.with).name), /matrix.target.target.backend/);
      }
    }
  };
  assertJobs(release, ".github/workflows/release.yml");
  assertJobs(deploy, ".github/workflows/deploy.yml");
  const assertDeviceDag = (workflow: Record<string, unknown>) => {
    const jobs = object(workflow.jobs);
    assert.equal(object(jobs["initial-installed-deployment"]).needs, "proofs");
    assert.equal(object(jobs["live-device-a"]).needs, "initial-installed-deployment");
    assert.equal(object(jobs["live-device-b"]).needs, "live-device-a");
    assert.deepEqual(object(jobs["live-device-cleanup"]).needs, [
      "initial-installed-deployment",
      "live-device-a",
      "live-device-b",
    ]);
    assert.match(String(object(jobs["live-device-cleanup"]).if), /always\(\)/);
    assert.deepEqual(object(jobs.operate).needs, [
      "proofs",
      "initial-installed-deployment",
      "live-device-a",
      "live-device-b",
      "live-device-cleanup",
    ]);
    for (const phase of [
      "proofs",
      "initial-installed-deployment",
      "live-device-a",
      "live-device-b",
      "live-device-cleanup",
    ])
      assert.ok(String(object(jobs.operate).if).includes(`needs.${phase}.result == 'success'`));
  };
  assertDeviceDag(deploy);
  const premature = structuredClone(deploy);
  const deviceJob = object(object(premature.jobs)["live-device-a"]);
  assert.ok(Array.isArray(deviceJob.steps));
  object(deviceJob.steps[0]).env = { FORTIPI_ADMIN_TOKEN: "synthetic-test-value" };
  assert.throws(
    () => assertJobs(premature, ".github/workflows/deploy.yml"),
    /credential-free install/,
  );
  const missingCleanup = structuredClone(deploy);
  object(object(missingCleanup.jobs).operate).needs = [
    "proofs",
    "initial-installed-deployment",
    "live-device-a",
    "live-device-b",
  ];
  assert.throws(() => assertDeviceDag(missingCleanup));
  const fault = structuredClone(release);
  object(object(fault.jobs).readiness).environment = "$" + "{{ matrix.target.target.slot }}";
  assert.throws(() => assertJobs(fault, ".github/workflows/release.yml"), /paid-validation/);
});

test("fresh deployment operate provisions pinned Chromium before credentials with reviewed egress", async () => {
  const deploy = object(
    parse(await readFile(resolve(repository, ".github/workflows/deploy.yml"), "utf8")),
  );
  const release = object(
    parse(await readFile(resolve(repository, ".github/workflows/release.yml"), "utf8")),
  );
  const command = "pnpm exec playwright install --with-deps chromium";
  const requiredEndpoints = [
    "cdn.playwright.dev:443",
    "playwright.download.prss.microsoft.com:443",
    "archive.ubuntu.com:80",
    "security.ubuntu.com:80",
    "azure.archive.ubuntu.com:80",
    "*.ec2.archive.ubuntu.com:80",
    "packages.microsoft.com:443",
  ];
  const assertEndpoints = (workflow: Record<string, unknown>, jobName: string) => {
    const steps = object(object(workflow.jobs)[jobName]).steps;
    assert.ok(Array.isArray(steps));
    const endpoints = String(object(object(steps[0]).with)["allowed-endpoints"]).split(/\s+/);
    assert.deepEqual(
      endpoints.filter((endpoint) => /playwright|microsoft|ubuntu/.test(endpoint)).sort(),
      [...requiredEndpoints].sort(),
      "Use only reviewed provisioning endpoints",
    );
  };
  const assertPrerequisite = (workflow: Record<string, unknown>) => {
    const job = object(object(workflow.jobs).operate);
    assert.ok(Array.isArray(job.steps));
    const steps = job.steps.map(object);
    const frozen = steps.findIndex((step) => step.run === "node scripts/install-dependencies.ts");
    const browser = steps.findIndex((step) => step.run === command);
    assert.ok(frozen >= 0 && browser > frozen, "Pinned Chromium must follow frozen dependencies");
    assert.equal(steps.filter((step) => step.run === command).length, 1);
    assert.equal(steps[browser]?.if, undefined, "Required browser provisioning cannot be skipped");
    assert.deepEqual(steps[browser]?.env ?? {}, {});
    const credentials = steps.findIndex((step) => {
      const env = object(step.env ?? {});
      return Boolean(
        env.CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_ACCOUNT_ID || env.FORTIPI_ADMIN_TOKEN,
      );
    });
    assert.ok(credentials > browser, "Chromium must be provisioned before credentials");
    assert.match(String(steps[0]?.uses), /^step-security\/harden-runner@[a-f0-9]{40}$/);
    const hardener = object(steps[0]?.with);
    assert.equal(hardener["egress-policy"], "block");
    assertEndpoints(workflow, "operate");
  };
  const candidate = object(object(release.jobs).candidate);
  assert.ok(Array.isArray(candidate.steps));
  assert.ok(candidate.steps.some((step) => object(step).run === command));
  assertEndpoints(release, "candidate");
  const ci = object(parse(await readFile(resolve(repository, ".github/workflows/ci.yml"), "utf8")));
  assertEndpoints(ci, "policy-and-integration");
  assertPrerequisite(deploy);
  const missing = structuredClone(deploy);
  const missingSteps = object(object(missing.jobs).operate).steps;
  assert.ok(Array.isArray(missingSteps));
  missingSteps.splice(
    missingSteps.findIndex((step) => object(step).run === command),
    1,
  );
  assert.throws(() => assertPrerequisite(missing), /Pinned Chromium/);
  const exposed = structuredClone(deploy);
  const exposedSteps = object(object(exposed.jobs).operate).steps;
  assert.ok(Array.isArray(exposedSteps));
  object(exposedSteps[0]).env = { CLOUDFLARE_API_TOKEN: "synthetic-test-value" };
  assert.throws(() => assertPrerequisite(exposed), /before credentials/);
  for (const endpoint of ["*.playwright.dev:443", "*.ubuntu.com:80", "*.microsoft.com:443"]) {
    for (const [workflow, job] of [
      [deploy, "operate"],
      [release, "candidate"],
      [ci, "policy-and-integration"],
    ] as const) {
      const broad = structuredClone(workflow);
      const broadSteps = object(object(broad.jobs)[job]).steps;
      assert.ok(Array.isArray(broadSteps));
      object(object(broadSteps[0]).with)["allowed-endpoints"] += ` ${endpoint}`;
      assert.throws(() => assertEndpoints(broad, job), /reviewed provisioning endpoints/);
    }
  }
});

test("CI authenticates a retained candidate without repacking and source CI requires the qualified image port", async () => {
  const ci = object(parse(await readFile(resolve(repository, ".github/workflows/ci.yml"), "utf8")));
  const release = object(
    parse(await readFile(resolve(repository, ".github/workflows/release.yml"), "utf8")),
  );
  assert.ok(object(object(ci.on).workflow_dispatch).inputs);
  const job = object(object(ci.jobs)["policy-and-integration"]);
  assert.match(String(job.if), /refs\/heads\/main/);
  assert.deepEqual(job.permissions, { contents: "read", actions: "read" });
  assert.ok(Array.isArray(job.steps));
  const steps = job.steps.map(object);
  const run = (s: Record<string, unknown>) => String(s.run ?? "");
  const dispatch = steps.filter((s) => s.if === "github.event_name == 'workflow_dispatch'");
  assert.ok(dispatch.some((s) => run(s).includes("build:evidence")));
  assert.ok(dispatch.some((s) => run(s).includes("retained-evidence")));
  assert.equal(
    dispatch.some((s) => /candidate:local|--scope|pnpm run build\b/.test(run(s))),
    false,
  );
  const verify = steps.findIndex((s) => run(s).includes("retained-evidence"));
  const prove = steps.findIndex((s) => run(s).includes("evidence --mode local"));
  const upload = steps.findIndex((s) => String(s.uses).startsWith("actions/upload-artifact"));
  assert.ok(verify > 0 && prove > verify && upload > prove);
  assert.equal(object(steps[upload]?.with)["if-no-files-found"], "error");
  assert.equal(object(steps[upload]?.with)["retention-days"], 30);
  assert.equal(object(steps[upload]?.with).name, "$" + "{{ steps.retained.outputs.artifact }}");
  assert.ok(
    steps.some(
      (s) => object(s.env ?? {}).IMAGE_REFERENCE === "$" + "{{ vars.FORTIPI_IMAGE_REFERENCE }}",
    ),
  );
  assert.ok(steps.some((s) => run(s).includes("prepare-release.ts image")));
  assert.equal(
    object(object(ci.jobs)["native-executor"]).if,
    "github.event_name != 'workflow_dispatch'",
  );
  const candidateSteps = object(object(release.jobs).candidate).steps;
  assert.ok(Array.isArray(candidateSteps));
  assert.equal(
    candidateSteps.map(object).some((s) => run(s).includes("evidence --mode local")),
    false,
  );
  const aliases = await readFile(resolve(repository, "scripts/build-workspaces.ts"), "utf8");
  assert.ok(
    aliases.includes('["scripts/prepare-release.ts", "evidence", "--mode", "local", ...extra]'),
  );
  assert.equal(aliases.includes('["tests/clients/run-evidence.ts", "local", ...extra]'), false);
});
