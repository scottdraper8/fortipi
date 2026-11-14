import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { x as extract } from "tar";
import { canonicalJson } from "../../packages/fortipi-contract/src/canonical-json.ts";
import { checkPins, type SupplyChain } from "../../scripts/check-pins.ts";
import {
  CompatibilityPreparationFailure,
  retainCompatibilityReport,
} from "../../scripts/prepare-release.ts";
import { sources } from "./catalog.ts";
import { controlledCompatibility } from "./fixtures/release.ts";
import {
  assertCompatibilityDetail,
  assessReleaseReport,
  compatibilityDetail,
  immutablePolicyInputs,
  releaseHash,
  validateReleaseReport,
} from "./release.ts";
import { check, exitCode, hash, observer, type Snapshot } from "./watch.ts";

const root = resolve(import.meta.dirname, "../..");

test("real watched Wrangler feature drift remains an alert while installed assessment has separate authority", async () => {
  const { basis, baseline, report } = await controlledCompatibility(root);
  const fixture = JSON.parse(
    await readFile(new URL("fixtures/release-wrangler.json", import.meta.url), "utf8"),
  );
  const wrangler = sources.find((s) => s.id === "wrangler")!;
  const observe = async (commit: string) =>
    observer(async (path) =>
      path.includes("git/ref/heads/")
        ? { object: { type: "commit", sha: commit } }
        : path.includes("package.json?")
          ? fixture.captures[commit].manifest
          : fixture.captures[commit].directory,
    )(wrangler);
  const old = await observe(fixture.old),
    future = await observe(fixture.next);
  assert.equal(old.version, "4.162.0");
  assert.equal(future.version, "4.162.0");
  assert.notEqual(old.paths["packages/wrangler"], future.paths["packages/wrangler"]);
  const b = structuredClone(baseline);
  b.entries.wrangler!.snapshot = old;
  const observations = await check(
    b,
    async (source) => (source.id === "wrangler" ? future : b.entries[source.id]!.snapshot),
    async (source) => basis.pins[source.id]!,
  );
  assert.equal(exitCode(observations), 1);
  assert.equal(observations.find((r) => r.id === "wrangler")!.outcome, "review-required");
  const r = structuredClone(report);
  r.baselineSha256 = releaseHash(b);
  r.lookahead.results = observations;
  r.lookahead.exitCode = 1;
  r.requiredReferences.current = observations.filter(
    (v) => !Object.hasOwn(r.requiredReferences.installed, v.id),
  );
  assessReleaseReport(r, basis, b);
  // Equal bytes cannot override an explicitly unresolved CURRENT impact.
  for (const impact of ["hold", "unknown"]) {
    const bad = structuredClone(b);
    bad.releaseReference.references.wrangler.currentImpact = impact as "hold";
    const changed = structuredClone(r);
    changed.baselineSha256 = releaseHash(bad);
    changed.requiredReferences.installed = bad.releaseReference.references;
    assert.throws(() => assessReleaseReport(changed, basis, bad), /current impact/);
  }
});

test("required current references, source bindings, fresh evidence and detail2 remain fail closed", async () => {
  const { basis, baseline, report } = await controlledCompatibility(root);
  assessReleaseReport(report, basis, baseline);
  assessReleaseReport(JSON.parse(canonicalJson(report)), basis, baseline);
  const changed = structuredClone(report),
    row = changed.lookahead.results.find((r) => r.id === "workers-policy")!;
  row.observed = { ...row.observed!, paths: { ...row.observed!.paths } };
  const first = Object.keys(row.observed.paths)[0]!;
  row.observed.paths[first] = "0".repeat(64);
  row.observed.sha256 = hash(row.observed.paths);
  row.outcome = "review-required";
  row.classification = "unknown";
  changed.lookahead.exitCode = 1;
  changed.requiredReferences.current = changed.lookahead.results.filter(
    (v) => !Object.hasOwn(changed.requiredReferences.installed, v.id),
  );
  assert.throws(() => assessReleaseReport(changed, basis, baseline), /Required current reference/);
  for (const mutate of [
    (r: typeof report) => {
      r.checkedAt = new Date(Date.now() - 25 * 3600000).toISOString();
    },
    (r: typeof report) => {
      r.sourceCommit = "b".repeat(40);
    },
    (r: typeof report) => {
      r.validationInputs.sourcePolicySha256 = "0".repeat(64);
    },
    (r: typeof report) => {
      r.format = 1 as 2;
    },
    (r: typeof report) => {
      r.lookahead.exitCode = 1;
    },
  ]) {
    const bad = structuredClone(report);
    mutate(bad);
    assert.throws(() => assessReleaseReport(bad, basis, baseline));
  }
  for (const key of ["rootLock", "patchReview", "imageInputs", "productTrees"]) {
    const other = structuredClone(basis);
    other.cohort[key] = "0".repeat(64);
    other.cohortSha256 = releaseHash(other.cohort);
    assert.throws(() => assessReleaseReport(report, other, baseline));
  }
  const bytes = Buffer.from(canonicalJson(report) + "\n"),
    candidate = "c".repeat(64),
    detail = compatibilityDetail(report, bytes, candidate);
  assertCompatibilityDetail(detail, report, bytes, candidate);
  for (const bad of [
    { detailSchemaVersion: 1 },
    { ...detail, candidateHash: "d".repeat(64) },
    { ...detail, reportSha256: "0".repeat(64) },
    { ...detail, requiredReferencesSha256: "0".repeat(64) },
    { ...detail, pass: true },
  ])
    assert.throws(() => assertCompatibilityDetail(bad, report, bytes, candidate));
});

test("lawful maturity and review metadata preserve byte identity, never raw enforcement bindings", async () => {
  const git = promisify(execFile),
    read = async (ref: string, path: string) =>
      (await git("git", ["show", `${ref}:${path}`], { cwd: root, maxBuffer: 8_000_000 })).stdout;
  const beforeWorkspace = await read("82fd187", "pnpm-workspace.yaml"),
    beforePolicy = await read("82fd187", "tools/unstale/supply-chain.json"),
    workspace = await readFile(resolve(root, "pnpm-workspace.yaml")),
    policy = await readFile(resolve(root, "tools/unstale/supply-chain.json"));
  assert.notEqual(beforeWorkspace, workspace.toString());
  assert.notEqual(beforePolicy, policy.toString());
  const normalized = immutablePolicyInputs(workspace, policy);
  assert.deepEqual(
    immutablePolicyInputs(Buffer.from(beforeWorkspace), Buffer.from(beforePolicy)),
    normalized,
  );
  const refresh = JSON.parse(policy.toString());
  refresh.advisory.checkedAt = new Date().toISOString();
  for (const record of Object.values(refresh.packages) as { reviewedAt: string }[])
    record.reviewedAt = new Date().toISOString();
  assert.deepEqual(
    immutablePolicyInputs(workspace, Buffer.from(JSON.stringify(refresh))),
    normalized,
  );
  const id = Object.keys(refresh.packages)[0]!;
  refresh.packages[id].archiveSha256 = "0".repeat(64);
  assert.notEqual(
    immutablePolicyInputs(workspace, Buffer.from(JSON.stringify(refresh))).sourcePolicyInputs,
    normalized.sourcePolicyInputs,
  );
});

test("normal current-policy checks and closed spawn/parse/write/assessment failures preserve private input", async () => {
  const { report } = await controlledCompatibility(root);
  await validateReleaseReport(root, report, report.sourceCommit);
  // Exercise the actual producer's stdout boundary, not a hand-constructed JSON response.
  const script =
    'import{controlledCompatibility}from"./tools/compatibility-watch/fixtures/release.ts";import{createReleaseReport}from"./tools/compatibility-watch/release.ts";const{report}=await controlledCompatibility(process.cwd());console.log(JSON.stringify(await createReleaseReport(process.cwd(),report.lookahead.results,report.checkedAt)));';
  const produced = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "-e", script],
    { cwd: root, timeout: 15000, maxBuffer: 1_000_000 },
  );
  const actual = JSON.parse(produced.stdout);
  assert.equal(actual.format, 2);
  assert.equal(actual.sourceCommit, report.sourceCommit);

  const directory = await mkdtemp(resolve(tmpdir(), "fortipi-compatibility-control-")),
    path = resolve(directory, "report.json"),
    canary = "synthetic-private-input-NOT-OUTPUT";
  const refusal = (kind: string) => (e: unknown) => {
    assert.ok(e instanceof CompatibilityPreparationFailure);
    assert.equal(e.failureClass, kind);
    assert.ok(!String(e).includes(canary));
    return true;
  };
  try {
    await assert.rejects(
      retainCompatibilityReport(root, path, async () => {
        throw Error(canary);
      }),
      refusal("spawn"),
    );
    await assert.rejects(
      retainCompatibilityReport(root, path, async () => ({
        stdout: canary,
        code: 0,
        timedOut: false,
      })),
      refusal("report-parse"),
    );
    await assert.rejects(
      retainCompatibilityReport(root, path, async () => ({
        stdout: JSON.stringify(report),
        code: 2,
        timedOut: false,
      })),
      refusal("required-assessment"),
    );
    const run = async () => ({ stdout: JSON.stringify(report), code: 0, timedOut: false });
    await retainCompatibilityReport(root, path, run);
    const original = await readFile(path);
    await assert.rejects(retainCompatibilityReport(root, path, run), refusal("report-write"));
    assert.deepEqual(await readFile(path), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// This is a disposable validation fixture, never a candidate or an installed runtime.
test("expired source observation and absent ignored inputs require bound fresh retained security data", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "fortipi-retained-policy-"));
  try {
    const archive = await promisify(execFile)("git", ["archive", "--format=tar", "HEAD"], {
      cwd: root,
      encoding: "buffer",
      maxBuffer: 32_000_000,
    });
    const path = resolve(directory, "source.tar");
    await writeFile(path, archive.stdout);
    await extract({ file: path, cwd: directory });
    await rm(path);
    // ONLY reviewed patch members are copied as validator input facts; no package is executed.
    const patches = JSON.parse(await readFile(resolve(root, "patches/review.json"), "utf8"));
    for (const [id, patch] of Object.entries(patches) as [
      string,
      { files: Record<string, unknown> },
    ][]) {
      const name = id.slice(0, id.lastIndexOf("@"));
      for (const member of Object.keys(patch.files)) {
        const relative = `apps/worker/node_modules/${name}/${member}`,
          target = resolve(directory, relative);
        await mkdir(resolve(target, ".."), { recursive: true });
        await copyFile(resolve(root, relative), target);
      }
    }
    const policyPath = resolve(directory, "tools/unstale/supply-chain.json");
    const policy = JSON.parse(await readFile(policyPath, "utf8")) as SupplyChain;
    policy.advisory.checkedAt = new Date(Date.now() - 25 * 3600000).toISOString();
    const policyBytes = Buffer.from(JSON.stringify(policy));
    await writeFile(policyPath, policyBytes);
    // Intentionally no dist/image or ignored receipt. Original source-side observation is expired.
    await assert.rejects(checkPins(directory), /Advisory graph review/);
    const receipt = JSON.parse(
      await readFile(resolve(root, "dist/supply-chain/advisory-review.json"), "utf8"),
    );
    const { createHash } = await import("node:crypto");
    receipt.reviewSha256 = createHash("sha256").update(policyBytes).digest("hex");
    await checkPins(directory, receipt);
    // Invalid supplied data must not fall back even when the real default path is fresh.
    await checkPins(root);
    for (const invalid of [null, false, {}, []]) await assert.rejects(checkPins(root, invalid));
    for (const mutate of [
      (r: typeof receipt) => {
        r.reviewSha256 = "0".repeat(64);
      },
      (r: typeof receipt) => {
        r.locks["pnpm-lock.yaml"] = "0".repeat(64);
      },
      (r: typeof receipt) => {
        r.locks["tools/unstale/pnpm-lock.yaml"] = "0".repeat(64);
      },
      (r: typeof receipt) => {
        r.advisory.identities++;
      },
      (r: typeof receipt) => {
        r.advisory.findings = ["synthetic-actionable-advisory"];
      },
      (r: typeof receipt) => {
        r.advisory.checkedAt = new Date(Date.now() - 25 * 3600000).toISOString();
      },
      (r: typeof receipt) => {
        r.advisory.checkedAt = new Date(Date.now() + 120000).toISOString();
      },
    ]) {
      const bad = structuredClone(receipt);
      mutate(bad);
      await assert.rejects(checkPins(directory, bad));
    }
    for (const invalid of [null, false, {}, []])
      await assert.rejects(checkPins(directory, invalid));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("completion-time freshness refuses an observation expiring during validation and preserves explicit clocks", async () => {
  const { report } = await controlledCompatibility(root),
    clock = Date.now,
    start = clock();
  report.checkedAt = new Date(start - 86_400_000 + 250).toISOString();
  report.lookahead.checkedAt = report.checkedAt;
  try {
    Date.now = () => start;
    await validateReleaseReport(root, report, report.sourceCommit);
    let advanced = false;
    Date.now = () => (advanced ? start + 1000 : start);
    const crossing = validateReleaseReport(root, report, report.sourceCommit);
    setImmediate(() => {
      advanced = true;
    });
    await assert.rejects(crossing, /Stale\/future compatibility evidence/);
    assert.equal(advanced, true);
    await validateReleaseReport(root, report, report.sourceCommit, start);
    await assert.rejects(
      validateReleaseReport(root, report, report.sourceCommit, start + 1000),
      /Stale\/future compatibility evidence/,
    );
  } finally {
    Date.now = clock;
  }
});
