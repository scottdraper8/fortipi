import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { repository } from "./build-workspaces.ts";
import {
  type ArtifactReference,
  assertCandidate,
  assertProducer,
  type CandidateManifest,
  canonicalJson,
  digest,
  freshness,
  type GitHubRequest,
  git,
  integer,
  object,
  REPOSITORY,
  REPOSITORY_ID,
  sha256,
  string,
} from "./verify-release-gates.ts";

/** Read permission only, never a completed producer, GateReceipt or deployment authority. */
export interface CurrentCandidateReadContext {
  job: "native" | "native-receipt";
}
const workflowPath = ".github/workflows/release.yml";
const base = `/repos/${REPOSITORY}`;
const artifactName = (candidate: CandidateManifest) =>
  `candidate-${candidate.sourceCommit}-${candidate.scope}-${candidate.producer.runId}-${candidate.producer.runAttempt}`;
function time(value: unknown): number {
  const result = Date.parse(string(value));
  assert.ok(Number.isFinite(result), "Invalid current candidate timestamp");
  return result;
}

async function frame(
  candidate: CandidateManifest,
  hash: string,
  context?: CurrentCandidateReadContext,
): Promise<Buffer> {
  assertCandidate(candidate);
  assertProducer(candidate.producer);
  const bytes = Buffer.from(`${canonicalJson(candidate)}\n`);
  assert.ok(bytes.length <= 8_000_000);
  assert.equal(sha256(bytes), digest(hash), "Current candidate metadata hash differs");
  const env = process.env;
  assert.equal(env.GITHUB_ACTIONS, "true");
  assert.equal(env.GITHUB_SERVER_URL, "https://github.com");
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY);
  assert.equal(env.GITHUB_REPOSITORY_ID, String(REPOSITORY_ID));
  assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.equal(env.GITHUB_REF, "refs/heads/main");
  assert.equal(env.GITHUB_WORKFLOW_REF, `${REPOSITORY}/${workflowPath}@refs/heads/main`);
  assert.ok(
    env.GITHUB_JOB === "native" || env.GITHUB_JOB === "native-receipt",
    "Current candidate reader job denied",
  );
  if (context) assert.equal(context.job, env.GITHUB_JOB);
  assert.equal(env.OPERATION, "candidate");
  assert.equal(env.GITHUB_SHA, candidate.sourceCommit);
  assert.equal(env.SOURCE_SHA, candidate.sourceCommit);
  assert.equal(env.RELEASE_VERSION, candidate.version);
  assert.equal(env.RELEASE_SCOPE, candidate.scope);
  assert.equal(env.EXPECTED_TAG, candidate.tag);
  assert.equal(
    env.CONFIRM,
    `candidate v${candidate.version} ${candidate.sourceCommit} ${candidate.scope}`,
  );
  assert.equal(integer(Number(env.GITHUB_RUN_ID)), candidate.producer.runId);
  assert.equal(integer(Number(env.GITHUB_RUN_ATTEMPT)), candidate.producer.runAttempt);
  assert.equal(candidate.producer.workflowPath, workflowPath);
  assert.equal(await git("rev-parse", "HEAD"), candidate.sourceCommit);
  assert.equal(await git("status", "--porcelain"), "", "Current candidate source must be clean");
  // Git object bytes avoid platform checkout CRLF conversion and git()'s trim.
  const workflow = (
    await promisify(execFile)("git", ["show", `${candidate.sourceCommit}:${workflowPath}`], {
      cwd: repository,
      encoding: "buffer",
      timeout: 20_000,
      maxBuffer: 4_000_000,
      env: { PATH: env.PATH, Path: env.Path, SystemRoot: env.SystemRoot, LANG: "C" },
    })
  ).stdout;
  assert.equal(
    sha256(workflow),
    candidate.producer.workflowSha256,
    "Current candidate source workflow differs",
  );
  return bytes;
}

async function source(candidate: CandidateManifest, request: GitHubRequest): Promise<void> {
  // Same repository/main/tag constraints as trustedMain, without its privilege
  // requirement: a consistently nonpublishable source bootstrap may read bytes.
  const repo = object(await request(base));
  assert.equal(repo.id, REPOSITORY_ID);
  assert.equal(repo.full_name, REPOSITORY);
  assert.equal(
    object(object(await request(`${base}/git/ref/heads/main`)).object).sha,
    candidate.sourceCommit,
    "Main advanced beyond candidate",
  );
  const refs = await request(`${base}/git/matching-refs/tags/${candidate.tag}`);
  assert.ok(Array.isArray(refs));
  for (const row of refs.map(object).filter((row) => row.ref === `refs/tags/${candidate.tag}`)) {
    let target = object(row.object);
    if (target.type === "tag")
      target = object(object(await request(`${base}/git/tags/${string(target.sha)}`)).object);
    assert.equal(target.type, "commit");
    assert.equal(target.sha, candidate.sourceCommit, "Existing tag conflicts");
  }
}
async function run(candidate: CandidateManifest, request: GitHubRequest): Promise<void> {
  const producer = candidate.producer;
  for (const suffix of ["", `/attempts/${producer.runAttempt}`]) {
    const value = object(await request(`${base}/actions/runs/${producer.runId}${suffix}`));
    assert.equal(value.id, producer.runId);
    assert.equal(value.run_attempt, producer.runAttempt, "Superseded current candidate attempt");
    assert.equal(value.workflow_id, producer.workflowId);
    assert.equal(value.head_sha, candidate.sourceCommit);
    assert.equal(value.head_branch, "main");
    assert.equal(value.event, "workflow_dispatch");
    assert.equal(string(value.path).split("@")[0], workflowPath);
    assert.equal(object(value.repository).id, REPOSITORY_ID);
    assert.equal(object(value.head_repository).id, REPOSITORY_ID);
    assert.ok(
      value.status === "in_progress" || value.status === "completed",
      "Current candidate run unavailable",
    );
    assert.equal(value.conclusion, value.status === "completed" ? "success" : null);
  }
}
async function pages(
  request: GitHubRequest,
  path: string,
  field: "jobs" | "artifacts",
): Promise<Record<string, unknown>[]> {
  const result: Record<string, unknown>[] = [];
  const ids = new Set<number>();
  for (let page = 1; page <= 20; page++) {
    const value = object(await request(`${path}?per_page=100&page=${page}`));
    const total = Number(value.total_count);
    assert.ok(
      Number.isSafeInteger(total) && total >= 0 && total <= 2000,
      "Current candidate API count bound",
    );
    const rows = value[field];
    assert.ok(Array.isArray(rows) && rows.length <= 100);
    for (const raw of rows) {
      const row = object(raw);
      const id = integer(row.id);
      assert.ok(!ids.has(id), "Duplicate current candidate API record");
      ids.add(id);
      result.push(row);
    }
    assert.ok(result.length <= total);
    if (result.length === total) return result;
    assert.ok(rows.length > 0, "Incomplete current candidate pagination");
  }
  throw new Error("Current candidate API pagination bound");
}

/** Resolve data only. The returned reference still requires verifyCurrentCandidateRead. */
export async function resolveCurrentCandidateReference(
  candidate: CandidateManifest,
  hash: string,
  request: GitHubRequest,
  context?: CurrentCandidateReadContext,
): Promise<ArtifactReference> {
  await frame(candidate, hash, context);
  const rows = await pages(
    request,
    `${base}/actions/runs/${candidate.producer.runId}/artifacts`,
    "artifacts",
  );
  const matching = rows.filter((row) => row.name === artifactName(candidate));
  assert.equal(matching.length, 1, "Missing/duplicate current candidate artifact");
  const saved = matching[0];
  assert.ok(saved);
  return {
    runId: candidate.producer.runId,
    runAttempt: candidate.producer.runAttempt,
    artifactId: integer(saved.id),
    artifactName: artifactName(candidate),
    artifactDigest: string(saved.digest),
    candidateSha256: digest(hash),
  };
}

/** Authenticate metadata BEFORE a caller opens candidate payloads; no source fallback here. */
export async function verifyCurrentCandidateRead(
  candidate: CandidateManifest,
  hash: string,
  reference: ArtifactReference,
  request: GitHubRequest,
  context?: CurrentCandidateReadContext,
): Promise<void> {
  const bytes = await frame(candidate, hash, context);
  const ref = Object.freeze({ ...reference });
  const producer = { ...candidate.producer };
  assert.equal(ref.runId, producer.runId);
  assert.equal(ref.runAttempt, producer.runAttempt);
  integer(ref.artifactId);
  assert.equal(ref.candidateSha256, hash);
  assert.equal(ref.artifactName, artifactName(candidate));
  assert.match(ref.artifactDigest, /^sha256:[a-f0-9]{64}$/);
  await source(candidate, request);
  await run(candidate, request);
  const workflow = object(await request(`${base}/actions/workflows/${producer.workflowId}`));
  assert.equal(workflow.id, producer.workflowId);
  assert.equal(workflow.path, workflowPath);
  assert.equal(workflow.state, "active");
  const content = object(
    await request(`${base}/contents/${workflowPath}?ref=${candidate.sourceCommit}`),
  );
  assert.equal(content.encoding, "base64");
  assert.ok(typeof content.content === "string" && content.content.length <= 4_000_000);
  assert.equal(
    sha256(Buffer.from(content.content.replaceAll("\n", ""), "base64")),
    producer.workflowSha256,
    "Current candidate API workflow differs",
  );
  const jobs = await pages(
    request,
    `${base}/actions/runs/${producer.runId}/attempts/${producer.runAttempt}/jobs`,
    "jobs",
  );
  const matching = jobs.filter((job) => job.name === "candidate");
  assert.equal(matching.length, 1, "Missing/duplicate completed candidate job");
  const job = matching[0];
  assert.ok(job);
  assert.equal(job.run_id, producer.runId);
  assert.equal(job.head_sha, candidate.sourceCommit);
  assert.equal(job.status, "completed");
  assert.equal(job.conclusion, "success");
  const start = time(job.started_at);
  const end = time(job.completed_at);
  assert.ok(start <= end);
  freshness(string(job.completed_at), 24);
  const saved = object(await request(`${base}/actions/artifacts/${ref.artifactId}`));
  assert.equal(saved.id, ref.artifactId);
  assert.equal(saved.name, ref.artifactName);
  assert.equal(saved.expired, false);
  assert.equal(saved.digest, ref.artifactDigest);
  const lineage = object(saved.workflow_run);
  assert.equal(lineage.id, producer.runId);
  assert.equal(lineage.repository_id, REPOSITORY_ID);
  assert.equal(lineage.head_repository_id, REPOSITORY_ID);
  assert.equal(lineage.head_sha, candidate.sourceCommit);
  assert.equal(lineage.head_branch, "main");
  const created = time(saved.created_at);
  assert.ok(created >= start && created <= end, "Candidate artifact outside candidate job window");
  const expires = time(saved.expires_at);
  assert.ok(expires > Date.now(), "Expired current candidate artifact");
  const actual = await request.verifyArtifact(ref, "candidate.json");
  assert.ok(
    actual && actual.equals(bytes),
    "Current candidate bytes differ from actual producer archive",
  );
  // A slow ZIP read must not confer authority to a superseded run or changed source.
  await frame(candidate, hash, context);
  await run(candidate, request);
  await source(candidate, request);
  assert.ok(expires > Date.now(), "Current candidate artifact expired during verification");
  freshness(string(job.completed_at), 24);
}
