import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { repository } from "../../build-workspaces.ts";
import { object } from "../../verify-release-gates.ts";

test("workflow topology keeps target credentials in fixed slots, publication after readiness, and finalization after publication", async () => {
  const release = object(
    parse(await readFile(resolve(repository, ".github/workflows/release.yml"), "utf8")),
  );
  const deploy = object(
    parse(await readFile(resolve(repository, ".github/workflows/deploy.yml"), "utf8")),
  );
  const jobs = object(release.jobs);
  assert.deepEqual(object(jobs.publish).needs, ["proofs", "readiness"]);
  assert.deepEqual(object(jobs["final-readiness"]).needs, ["proofs", "publish"]);
  assert.deepEqual(object(jobs.finalize).needs, ["proofs", "publish", "final-readiness"]);
  assert.deepEqual(object(jobs["native-receipt"]).needs, ["candidate", "native"]);
  const assertJobs = (workflow: Record<string, unknown>) => {
    for (const [name, raw] of Object.entries(object(workflow.jobs))) {
      const job = object(raw);
      assert.ok(Array.isArray(job.steps));
      const steps = job.steps.map(object);
      assert.match(String(steps[0]?.uses), /^step-security\/harden-runner@[a-f0-9]{40}$/);
      assert.equal(object(steps[0]?.with)["egress-policy"], "block");
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
          assert.ok(["readiness", "final-readiness", "operate"].includes(name));
          assert.match(
            String(job.environment),
            /== 'paid-validation' && 'paid-validation' \|\| 'production'/,
          );
        }
      }
      if (name === "readiness" || name === "final-readiness") {
        assert.ok(object(object(job.strategy).matrix).target);
        const install = steps.findIndex((s) => String(s.run).includes("prepare-readiness"));
        const protectedCall = steps.findIndex((s) => object(s.env ?? {}).CLOUDFLARE_API_TOKEN);
        assert.ok(
          install >= 0 && protectedCall > install,
          "Retained distribution must install before credentials are exposed",
        );
        const upload = steps.find((s) => String(s.uses).startsWith("actions/upload-artifact"));
        assert.ok(upload);
        assert.match(String(object(upload.with).name), /matrix.target.target.backend/);
      }
    }
  };
  assertJobs(release);
  assertJobs(deploy);
  const fault = structuredClone(release);
  object(object(fault.jobs).readiness).environment = "$" + "{{ matrix.target.target.slot }}";
  assert.throws(() => assertJobs(fault), /paid-validation/);
});
