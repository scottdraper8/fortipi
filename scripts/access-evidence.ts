import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { repository } from "./build-workspaces.ts";
import { checkCloudflareAccess, checkNpmAccess } from "./check-access.ts";
import { loadWorkflowCandidate } from "./prepare-release.ts";
import {
  type ArtifactReference,
  assertAccessResult,
  assertGate,
  type BoundedGitHubRequest,
  type CandidateManifest,
  cliArgs,
  freshness,
  type GateReceipt,
  type GitHubRequest,
  githubRequest,
  integer,
  inventory,
  object,
  type Producer,
  privilegedCheckout,
  REPOSITORY,
  REPOSITORY_ID,
  readAccessGate,
  regularBytes,
  saveJson,
  sha256,
  string,
  trustedMain,
  verifyPayload,
} from "./verify-release-gates.ts";

type Purpose = "deployment" | "publication";
/** Current writer identity; this is never a completed producer assertion. */
export async function accessProducer(
  candidate: CandidateManifest,
  purpose: Purpose,
  request: GitHubRequest,
): Promise<{ producer: Producer; jobs: Record<string, unknown>[] }> {
  assert.ok(purpose === "deployment" || purpose === "publication");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.GITHUB_REPOSITORY, REPOSITORY);
  assert.equal(process.env.GITHUB_REPOSITORY_ID, String(REPOSITORY_ID));
  assert.equal(process.env.GITHUB_SHA, candidate.sourceCommit);
  assert.equal(process.env.GITHUB_REF, "refs/heads/main");
  assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch");
  const workflowPath = ".github/workflows/access-preflight.yml";
  assert.equal(process.env.GITHUB_WORKFLOW_REF, `${REPOSITORY}/${workflowPath}@refs/heads/main`);
  const job = process.env.GITHUB_JOB;
  assert.ok(job === "cloudflare" || (job === "npm" && purpose === "publication"));
  const workflow = object(
    await request(`/repos/${REPOSITORY}/actions/workflows/access-preflight.yml`),
  );
  assert.equal(workflow.path, workflowPath);
  assert.equal(workflow.state, "active");
  const producer: Producer = {
    workflowPath,
    workflowSha256: sha256(await regularBytes(resolve(repository, workflowPath))),
    workflowId: integer(workflow.id),
    runId: integer(Number(process.env.GITHUB_RUN_ID)),
    runAttempt: integer(Number(process.env.GITHUB_RUN_ATTEMPT)),
  };
  const base = `/repos/${REPOSITORY}/actions/runs/${producer.runId}`;
  for (const path of [base, `${base}/attempts/${producer.runAttempt}`]) {
    const run = object(await request(path));
    assert.equal(run.id, producer.runId);
    assert.equal(run.run_attempt, producer.runAttempt);
    assert.equal(run.workflow_id, producer.workflowId);
    assert.equal(run.head_sha, candidate.sourceCommit);
    assert.equal(run.head_branch, "main");
    assert.equal(run.event, "workflow_dispatch");
    assert.equal(string(run.path).split("@")[0], workflowPath);
    assert.equal(object(run.repository).id, REPOSITORY_ID);
    assert.equal(object(run.head_repository).id, REPOSITORY_ID);
    assert.equal(run.status, "in_progress", "Access writer must be the executing attempt");
  }
  const data = object(
    await request(`${base}/attempts/${producer.runAttempt}/jobs?per_page=100&page=1`),
  );
  assert.ok(Array.isArray(data.jobs) && data.jobs.length > 0 && data.jobs.length <= 2);
  assert.equal(data.total_count, data.jobs.length);
  const jobs = data.jobs.map(object);
  const current = jobs.filter((j) => j.name === job);
  assert.equal(current.length, 1);
  assert.equal(current[0]?.status, "in_progress");
  return { producer, jobs };
}

/** No CF/npm credential is read until the original completed candidate is authenticated. */
async function authenticate(candidatePath: string, purpose: Purpose, request: GitHubRequest) {
  assert.ok(purpose === "deployment" || purpose === "publication");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.ok(process.env.FORTIPI_CANDIDATE_REFERENCE, "Exact candidate ArtifactReference required");
  const loaded = await loadWorkflowCandidate(candidatePath);
  assert.ok(loaded.candidate.publishable);
  await privilegedCheckout(loaded.candidate);
  const current = await accessProducer(loaded.candidate, purpose, request);
  await trustedMain(loaded.candidate, request);
  return { ...loaded, ...current };
}

/** Receipt construction, not producer authorization. Readers require completed/SUCCESS afterward. */
export async function writeAccessGate(
  candidate: CandidateManifest,
  candidateSha256: string,
  producer: Producer,
  directory: string,
  cloudflare: unknown,
  npm?: unknown,
): Promise<GateReceipt> {
  assertAccessResult(cloudflare, "cloudflare", candidate.scope);
  if (npm !== undefined) assertAccessResult(npm, "npm", candidate.scope);
  await mkdir(directory);
  await saveJson(resolve(directory, "cloudflare.json"), cloudflare);
  if (npm !== undefined) await saveJson(resolve(directory, "npm.json"), npm);
  const files = await inventory(directory);
  const gate: GateReceipt = {
    schemaVersion: 1,
    kind: npm === undefined ? "cloudflare-access" : "access",
    candidateSha256,
    sourceCommit: candidate.sourceCommit,
    scope: candidate.scope,
    producer,
    checkedAt: new Date(
      Math.min(
        Date.parse(string(object(cloudflare).checkedAt)),
        ...(npm === undefined ? [] : [Date.parse(string(object(npm).checkedAt))]),
      ),
    ).toISOString(),
    claims: files.map((result) => ({
      id: result.path === "cloudflare.json" ? "cloudflare-read-access" : "npm-read-access",
      outcome: "pass",
      result,
    })),
    platforms: [],
    deployments: [],
    files,
  };
  assertGate(gate);
  await readAccessGate({ receipt: gate, directory }, candidate);
  await saveJson(resolve(directory, "gate.json"), gate);
  return gate;
}

/** Same executing workflow's completed CF job only; never waives whole-run success for consumers. */
export async function currentCloudflareResult(
  candidate: CandidateManifest,
  candidateSha256: string,
  current: Awaited<ReturnType<typeof accessProducer>>,
  directory: string,
  request: BoundedGitHubRequest,
) {
  const cfJob = current.jobs.filter((j) => j.name === "cloudflare");
  assert.equal(cfJob.length, 1);
  assert.equal(cfJob[0]?.status, "completed");
  assert.equal(cfJob[0]?.conclusion, "success");
  // The pinned upload action returns bare hex; the API/ArtifactReference uses sha256:hex.
  const uploadDigest = string(process.env.FORTIPI_CF_ARTIFACT_DIGEST);
  assert.match(uploadDigest, /^[a-f0-9]{64}$/);
  const reference: ArtifactReference = {
    candidateSha256,
    runId: current.producer.runId,
    runAttempt: current.producer.runAttempt,
    artifactId: integer(Number(process.env.FORTIPI_CF_ARTIFACT_ID)),
    artifactDigest: `sha256:${uploadDigest}`,
    artifactName: `cloudflare-access-${candidate.sourceCommit}-${candidate.scope}-${current.producer.runId}-${current.producer.runAttempt}`,
  };
  const saved = object(
    await request(`/repos/${REPOSITORY}/actions/artifacts/${reference.artifactId}`),
  );
  assert.equal(saved.name, reference.artifactName);
  assert.equal(saved.digest, reference.artifactDigest);
  assert.equal(saved.expired, false);
  const lineage = object(saved.workflow_run);
  assert.equal(lineage.id, reference.runId);
  assert.equal(lineage.repository_id, REPOSITORY_ID);
  assert.equal(lineage.head_repository_id, REPOSITORY_ID);
  assert.equal(lineage.head_sha, candidate.sourceCommit);
  assert.equal(lineage.head_branch, "main");
  const created = Date.parse(string(saved.created_at));
  assert.ok(
    created >= Date.parse(string(cfJob[0]?.started_at)) &&
      created <= Date.parse(string(cfJob[0]?.completed_at)),
  );
  assert.ok(Date.parse(string(saved.expires_at)) > Date.now());
  const { members } = await request.verifyArtifactMembers(reference, {
    "gate.json": 8192,
    "cloudflare.json": 8192,
  });
  const bytes = members["gate.json"];
  const verifiedResult = members["cloudflare.json"];
  assert.ok(bytes && verifiedResult);
  assert.equal(sha256(await regularBytes(resolve(directory, "gate.json"))), sha256(bytes));
  const receipt: unknown = JSON.parse(bytes.toString("utf8"));
  assertGate(receipt);
  assert.equal(receipt.kind, "cloudflare-access");
  assert.equal(receipt.candidateSha256, candidateSha256);
  assert.equal(receipt.sourceCommit, candidate.sourceCommit);
  assert.equal(receipt.scope, candidate.scope);
  assert.deepEqual(receipt.producer, current.producer);
  await verifyPayload(directory, receipt.files, ["gate.json"]);
  await readAccessGate({ receipt, directory }, candidate);
  assert.equal(sha256(verifiedResult), receipt.claims[0]?.result.sha256);
  assert.equal(
    sha256(await regularBytes(resolve(directory, "cloudflare.json"), 8192)),
    sha256(verifiedResult),
  );
  return JSON.parse(verifiedResult.toString("utf8")) as unknown;
}

export async function runAccessEvidence(
  operation: "authenticate" | "cloudflare" | "publication",
  candidatePath: string,
  purpose: Purpose,
  out?: string,
  cloudflareDirectory?: string,
): Promise<void> {
  const request = githubRequest(process.env.GITHUB_TOKEN);
  const loaded = await authenticate(candidatePath, purpose, request);
  if (operation === "authenticate") return;
  assert.ok(out);
  let cf: unknown, npm: unknown;
  if (operation === "cloudflare") {
    assert.equal(process.env.GITHUB_JOB, "cloudflare");
    cf = await checkCloudflareAccess();
  } else {
    assert.equal(operation, "publication");
    assert.equal(purpose, "publication");
    assert.equal(process.env.GITHUB_JOB, "npm");
    assert.ok(cloudflareDirectory);
    cf = await currentCloudflareResult(
      loaded.candidate,
      loaded.hash,
      loaded,
      cloudflareDirectory,
      request,
    );
    assert.equal(process.env.NPM_SCOPE?.trim().replace(/^@/, ""), loaded.candidate.scope);
    npm = await checkNpmAccess();
  }
  await trustedMain(loaded.candidate, request);
  const gate = await writeAccessGate(loaded.candidate, loaded.hash, loaded.producer, out, cf, npm);
  freshness(gate.checkedAt, 24);
  await writeFile(
    string(process.env.GITHUB_OUTPUT),
    `artifact=${gate.kind}-${gate.sourceCommit}-${gate.scope}-${gate.producer.runId}-${gate.producer.runAttempt}\n`,
    { flag: "a" },
  );
}

if (import.meta.main) {
  try {
    const args = cliArgs();
    const operation = process.argv[2];
    assert.ok(
      operation === "authenticate" || operation === "cloudflare" || operation === "publication",
    );
    const purpose = args.purpose;
    assert.ok(purpose === "deployment" || purpose === "publication");
    await runAccessEvidence(
      operation,
      resolve(string(args.candidate)),
      purpose,
      args.out && resolve(args.out),
      args.cloudflare && resolve(args.cloudflare),
    );
  } catch {
    console.error("Candidate-bound access proof unavailable; no access qualification granted.");
    process.exitCode = 1;
  }
}
