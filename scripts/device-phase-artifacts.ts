import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { repository } from "./build-workspaces.ts";
import {
  type ArtifactReference,
  assertCandidate,
  assertDeployment,
  assertProducer,
  type CandidateManifest,
  canonicalJson,
  type DeploymentIdentity,
  digest,
  type FileRecord,
  freshness,
  type GitHubRequest,
  integer,
  object,
  type Producer,
  privilegedCheckout,
  REPOSITORY,
  REPOSITORY_ID,
  sha256,
  string,
  trustedMain,
} from "./verify-release-gates.ts";

export type DevicePhase = "initial" | "a" | "b" | "cleanup";
export type DeviceJob = DevicePhase | "operate";
export interface LoadedDeviceCandidate {
  candidate: CandidateManifest;
  hash: string;
  directory?: string;
}
/** Nonsecret execution context projected by the trusted caller, never permission. */
export interface CurrentDeviceJobContext {
  job: DeviceJob;
  runId: number;
  runAttempt: number;
  repository: string;
  repositoryId: number;
  sourceCommit: string;
  ref: string;
  event: string;
  workflowRef: string;
  runnerName: string;
  runnerEnvironment: string;
  runnerOs: string;
  operation: "deploy" | "verify";
}
export interface DeviceJobObservation {
  producer: Producer;
  job: {
    id: number;
    name: string;
    runnerId: number;
    runnerName: string;
    labels: readonly string[];
    startedAt: string;
    completedAt: string | null;
  };
  checkedAt: string;
}
/** Loaded candidates may include their harmless local directory. No read context
 * or verified/permission boolean is accepted or returned here. */
export interface DevicePhaseMetadata {
  schemaVersion: 1;
  phase: DevicePhase;
  mode: "perform" | "verify-existing";
  sourceCommit: string;
  candidateSha256: string;
  scope: string;
  producer: Producer;
  jobId: number;
  deployment: DeploymentIdentity;
  checkedAt: string;
  files: FileRecord[];
  initialReference?: ArtifactReference;
  aReference?: ArtifactReference;
  bReference?: ArtifactReference;
  custody?: { reference: ArtifactReference; record: FileRecord };
}
export interface DevicePhaseReadInput {
  loaded: LoadedDeviceCandidate;
  phase: DevicePhase;
  mode: "perform" | "verify-existing";
  reference: ArtifactReference;
  context: { mode: "current"; current: CurrentDeviceJobContext } | { mode: "historical" };
  /** Independently observed original V0 for performed history; never from cipher. */
  deployment: DeploymentIdentity;
  expectedLinks: {
    initial?: ArtifactReference;
    a?: ArtifactReference;
    b?: ArtifactReference;
  };
}
/** Strict transport extension: all regular ZIP names, exact bounded selected
 * members from the digest-verified archive. This stays in trusted setup.
 * The existing byte-only verifyArtifact port cannot prove namespace closure. */
export type DevicePhaseRequest = GitHubRequest & {
  verifyArtifactMembers(
    reference: ArtifactReference,
    bounds: Readonly<Record<string, number>>,
  ): Promise<{ names: readonly string[]; members: Readonly<Record<string, Buffer>> }>;
};
export interface DeviceRecordBytes {
  record: FileRecord;
  /** Immutable exact bytes; consumers may decode a copy, never mutate the cache. */
  base64: string;
  data: unknown;
}
export interface DevicePhaseArtifact {
  reference: ArtifactReference;
  metadata: DevicePhaseMetadata;
  metadataSha256: string;
  metadataBase64: string;
  job: DeviceJobObservation;
  payloads: Readonly<Record<string, DeviceRecordBytes>>;
}
/** Cleanup ownership only; the body is a public allocation/revocation journal,
 * not device evidence, role custody or permission to mint another credential. */
export interface DeviceOwnershipJournal {
  schemaVersion: 1;
  sourceCommit: string;
  candidateSha256: string;
  scope: string;
  producer: Producer;
  jobId: number;
  checkedAt: string;
  body: Record<string, unknown>;
}
export interface DeviceOwnershipArtifact {
  reference: ArtifactReference;
  journal: DeviceOwnershipJournal;
  sha256: string;
  base64: string;
  job: DeviceJobObservation;
  conclusion: "success" | "failure" | "cancelled";
}
const jobs: Readonly<Record<DeviceJob, string>> = Object.freeze({
  initial: "initial-installed-deployment",
  a: "live-device-a",
  b: "live-device-b",
  cleanup: "live-device-cleanup",
  operate: "operate",
});
const base = `/repos/${REPOSITORY}`;
const workflowPath = ".github/workflows/deploy.yml";
const maximum = 1_048_576;
const cipherMaximum = 65_536;
const phaseFiles: Readonly<Record<DevicePhase, readonly string[]>> = {
  initial: ["deployment.json", "deployment.cli.json", "seed.json", "ownership.json"],
  a: ["device-a.json"],
  b: ["device-b.json"],
  cleanup: ["device-cleanup.json"],
};
const metadataFile = (phase: DevicePhase) =>
  phase === "initial" ? "device-initial.json" : "device-phase.json";
const artifactPrefix: Readonly<Record<DevicePhase, string>> = {
  initial: "deployment-initial",
  a: "device-a",
  b: "device-b",
  cleanup: "device-cleanup",
};
const reason = "Device phase evidence unavailable or inconsistent";
function closed(value: object, keys: readonly string[]) {
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
}
function immutable<T>(value: T): T {
  const copy: T = JSON.parse(canonicalJson(value));
  const freeze = (item: unknown): void => {
    if (item && typeof item === "object" && !Object.isFrozen(item)) {
      Object.values(item).forEach(freeze);
      Object.freeze(item);
    }
  };
  freeze(copy);
  return copy;
}
function time(value: unknown) {
  const text = string(value);
  assert.match(text, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/);
  assert.equal(
    new Date(text).toISOString(),
    text.includes(".") ? text : text.replace(/Z$/, ".000Z"),
  );
  return Date.parse(text);
}
function loadedCandidate(value: LoadedDeviceCandidate) {
  const bound = immutable(value);
  closed(bound, ["candidate", "hash", ...(bound.directory === undefined ? [] : ["directory"])]);
  if (bound.directory !== undefined) string(bound.directory, 4096);
  assertCandidate(bound.candidate);
  const bytes = Buffer.from(`${canonicalJson(bound.candidate)}\n`);
  assert.ok(bytes.length <= 8_000_000);
  assert.equal(sha256(bytes), digest(bound.hash));
  return bound;
}
function reference(value: ArtifactReference, hash: string) {
  closed(value, [
    "runId",
    "runAttempt",
    "artifactId",
    "artifactName",
    "artifactDigest",
    "candidateSha256",
  ]);
  for (const field of [value.runId, value.runAttempt, value.artifactId]) integer(field);
  string(value.artifactName);
  assert.match(value.artifactDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(value.candidateSha256, digest(hash), "Artifact candidate binding differs");
}
export function deviceTargetIdentitySha256(value: DeploymentIdentity): string {
  const bound = immutable(value);
  assertDeployment(bound);
  const { checkedAt: _time, ...identity } = bound;
  return sha256(canonicalJson(identity));
}

/** Only nonsecret Actions/runner fields are read. Credential/key environments
 * are deliberately absent; the caller constructs the actual GH read port. */
export function currentDeviceJobContext(): CurrentDeviceJobContext {
  try {
    assert.equal(process.platform, "linux");
    assert.equal(process.env.GITHUB_ACTIONS, "true");
    assert.equal(process.env.GITHUB_SERVER_URL, "https://github.com");
    const selected = Object.entries(jobs).filter(([, name]) => name === process.env.GITHUB_JOB);
    assert.equal(selected.length, 1);
    const entry = selected[0];
    assert.ok(entry);
    const context: CurrentDeviceJobContext = {
      job: entry[0] as DeviceJob,
      runId: integer(Number(process.env.GITHUB_RUN_ID)),
      runAttempt: integer(Number(process.env.GITHUB_RUN_ATTEMPT)),
      repository: string(process.env.GITHUB_REPOSITORY),
      repositoryId: integer(Number(process.env.GITHUB_REPOSITORY_ID)),
      sourceCommit: string(process.env.GITHUB_SHA),
      ref: string(process.env.GITHUB_REF),
      event: string(process.env.GITHUB_EVENT_NAME),
      workflowRef: string(process.env.GITHUB_WORKFLOW_REF),
      runnerName: string(process.env.RUNNER_NAME),
      runnerEnvironment: string(process.env.RUNNER_ENVIRONMENT),
      runnerOs: string(process.env.RUNNER_OS),
      operation: string(process.env.OPERATION) as CurrentDeviceJobContext["operation"],
    };
    return immutable(context);
  } catch {
    throw new Error(reason);
  }
}
async function source(loaded: LoadedDeviceCandidate, request: GitHubRequest) {
  await privilegedCheckout(loaded.candidate);
  await trustedMain(loaded.candidate, request);
  const workflow = (
    await promisify(execFile)("git", ["show", `${loaded.candidate.sourceCommit}:${workflowPath}`], {
      cwd: repository,
      encoding: "buffer",
      timeout: 20000,
      maxBuffer: 4_000_000,
      env: { PATH: process.env.PATH, LANG: "C" },
    })
  ).stdout;
  const registered = object(await request(`${base}/actions/workflows/deploy.yml`));
  const workflowId = integer(registered.id);
  assert.equal(registered.path, workflowPath);
  assert.equal(registered.state, "active");
  const content = object(
    await request(`${base}/contents/${workflowPath}?ref=${loaded.candidate.sourceCommit}`),
  );
  assert.equal(content.encoding, "base64");
  assert.ok(typeof content.content === "string" && content.content.length <= 4_000_000);
  assert.equal(
    sha256(Buffer.from(content.content.replaceAll("\n", ""), "base64")),
    sha256(workflow),
  );
  return { workflowId, workflowSha256: sha256(workflow) };
}
async function run(
  loaded: LoadedDeviceCandidate,
  request: GitHubRequest,
  producer: Producer,
  state: "in_progress" | "completed",
) {
  for (const suffix of ["", `/attempts/${producer.runAttempt}`]) {
    const value = object(await request(`${base}/actions/runs/${producer.runId}${suffix}`));
    assert.equal(value.id, producer.runId);
    assert.equal(value.run_attempt, producer.runAttempt, "Superseded device attempt");
    assert.equal(value.workflow_id, producer.workflowId);
    assert.equal(value.head_sha, loaded.candidate.sourceCommit);
    assert.equal(value.head_branch, "main");
    assert.equal(value.event, "workflow_dispatch");
    assert.equal(string(value.path).split("@")[0], workflowPath);
    assert.equal(object(value.repository).id, REPOSITORY_ID);
    assert.equal(object(value.head_repository).id, REPOSITORY_ID);
    assert.equal(value.status, state);
    assert.equal(value.conclusion, state === "completed" ? "success" : null);
    freshness(string(value.updated_at), 6);
  }
}
async function selectedJob(request: GitHubRequest, producer: Producer, name: string) {
  const result: Record<string, unknown>[] = [];
  const ids = new Set<number>();
  for (let page = 1; page <= 20; page++) {
    const data = object(
      await request(
        `${base}/actions/runs/${producer.runId}/attempts/${producer.runAttempt}/jobs?per_page=100&page=${page}`,
      ),
    );
    const total = Number(data.total_count);
    assert.ok(Number.isSafeInteger(total) && total > 0 && total <= 2000);
    assert.ok(Array.isArray(data.jobs) && data.jobs.length <= 100);
    for (const raw of data.jobs) {
      const entry = object(raw);
      const id = integer(entry.id);
      assert.ok(!ids.has(id));
      ids.add(id);
      result.push(entry);
    }
    assert.ok(result.length <= total);
    if (result.length === total) break;
    assert.ok(data.jobs.length > 0 && page < 20);
  }
  const matching = result.filter((row) => row.name === name);
  assert.equal(matching.length, 1, "Missing/duplicate device job");
  const value = matching[0];
  assert.ok(value);
  return value;
}
function jobDetails(
  value: Record<string, unknown>,
  producer: Producer,
  name: string,
  state: "in_progress" | "completed",
) {
  assert.equal(value.run_id, producer.runId);
  assert.ok(Array.isArray(value.labels) && value.labels.length <= 20);
  const labels = value.labels.map((label) => string(label));
  assert.ok(labels.includes("ubuntu-24.04") && !labels.includes("self-hosted"));
  const startedAt = string(value.started_at);
  time(startedAt);
  const completedAt = state === "completed" ? string(value.completed_at) : null;
  if (completedAt) {
    assert.ok(time(completedAt) >= time(startedAt));
    freshness(completedAt, 6);
  } else freshness(startedAt, 6);
  return {
    id: integer(value.id),
    name,
    runnerId: integer(value.runner_id),
    runnerName: string(value.runner_name),
    labels,
    startedAt,
    completedAt,
    sourceCommit: string(value.head_sha),
  };
}
async function job(
  request: GitHubRequest,
  producer: Producer,
  name: string,
  state: "in_progress" | "completed",
) {
  const value = await selectedJob(request, producer, name);
  assert.equal(value.status, state);
  assert.equal(value.conclusion, state === "completed" ? "success" : null);
  return jobDetails(value, producer, name, state);
}

async function ownershipJob(
  request: GitHubRequest,
  producer: Producer,
): Promise<ReturnType<typeof jobDetails> & { conclusion: DeviceOwnershipArtifact["conclusion"] }> {
  const value = await selectedJob(request, producer, jobs.initial);
  assert.equal(value.status, "completed");
  assert.ok(
    value.conclusion === "success" ||
      value.conclusion === "failure" ||
      value.conclusion === "cancelled",
  );
  return {
    ...jobDetails(value, producer, jobs.initial, "completed"),
    conclusion: value.conclusion,
  };
}

/** Caller must still authenticate prior artifacts before reading keys. The
 * return is immutable API metadata, never a reusable permission/verified flag. */
export async function authorizeCurrentDeviceJob(
  input: { loaded: LoadedDeviceCandidate; context: CurrentDeviceJobContext },
  request: GitHubRequest,
): Promise<DeviceJobObservation> {
  try {
    const loaded = loadedCandidate(input.loaded);
    const context = immutable(input.context);
    closed(context, [
      "job",
      "runId",
      "runAttempt",
      "repository",
      "repositoryId",
      "sourceCommit",
      "ref",
      "event",
      "workflowRef",
      "runnerName",
      "runnerEnvironment",
      "runnerOs",
      "operation",
    ]);
    assert.ok(Object.hasOwn(jobs, context.job));
    integer(context.runId);
    integer(context.runAttempt);
    assert.equal(context.repository, REPOSITORY);
    assert.equal(context.repositoryId, REPOSITORY_ID);
    assert.equal(context.sourceCommit, loaded.candidate.sourceCommit);
    assert.equal(context.ref, "refs/heads/main");
    assert.equal(context.event, "workflow_dispatch");
    assert.equal(context.workflowRef, `${REPOSITORY}/${workflowPath}@refs/heads/main`);
    assert.equal(context.runnerEnvironment, "github-hosted");
    assert.equal(context.runnerOs, "Linux");
    assert.ok(context.operation === "deploy" || context.operation === "verify");
    string(context.runnerName);
    const workflow = await source(loaded, request);
    const producer: Producer = {
      ...workflow,
      workflowPath,
      runId: context.runId,
      runAttempt: context.runAttempt,
    };
    await run(loaded, request, producer, "in_progress");
    const observed = await job(request, producer, jobs[context.job], "in_progress");
    assert.equal(observed.sourceCommit, loaded.candidate.sourceCommit);
    assert.equal(observed.runnerName, context.runnerName);
    const { sourceCommit: _source, ...publicJob } = observed;
    // Refresh source/attempt after all metadata awaits before returning.
    await privilegedCheckout(loaded.candidate);
    await run(loaded, request, producer, "in_progress");
    await trustedMain(loaded.candidate, request);
    return immutable({ producer, job: publicJob, checkedAt: new Date().toISOString() });
  } catch {
    throw new Error(reason);
  }
}

function canonical(bytes: Buffer, limit: number) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= limit);
  const value = object(JSON.parse(bytes.toString("utf8")));
  assert.ok(bytes.equals(Buffer.from(`${canonicalJson(value)}\n`)), "Noncanonical phase record");
  return value;
}
function record(value: FileRecord, path: string, limit: number) {
  closed(value, ["path", "mode", "size", "sha256"]);
  assert.equal(value.path, path);
  assert.equal(value.mode, 0o600);
  assert.ok(Number.isSafeInteger(value.size) && value.size > 0 && value.size <= limit);
  digest(value.sha256);
}
function artifactName(prefix: string, loaded: LoadedDeviceCandidate, ref: ArtifactReference) {
  return `${prefix}-${loaded.candidate.sourceCommit}-${loaded.candidate.scope}-${ref.runId}-${ref.runAttempt}`;
}
async function savedArtifact(
  loaded: LoadedDeviceCandidate,
  ref: ArtifactReference,
  request: GitHubRequest,
  observed: DeviceJobObservation,
  prefix: string,
  maximumArchiveBytes: number,
) {
  reference(ref, loaded.hash);
  assert.equal(ref.artifactName, artifactName(prefix, loaded, ref));
  assert.equal(ref.runId, observed.producer.runId);
  assert.equal(ref.runAttempt, observed.producer.runAttempt);
  const saved = object(await request(`${base}/actions/artifacts/${ref.artifactId}`));
  assert.equal(saved.id, ref.artifactId);
  assert.equal(saved.name, ref.artifactName);
  assert.equal(saved.digest, ref.artifactDigest);
  assert.equal(saved.expired, false);
  assert.ok(
    Number.isSafeInteger(saved.size_in_bytes) &&
      Number(saved.size_in_bytes) > 0 &&
      Number(saved.size_in_bytes) <= maximumArchiveBytes,
  );
  const lineage = object(saved.workflow_run);
  assert.equal(lineage.id, ref.runId);
  assert.equal(lineage.repository_id, REPOSITORY_ID);
  assert.equal(lineage.head_repository_id, REPOSITORY_ID);
  assert.equal(lineage.head_sha, loaded.candidate.sourceCommit);
  assert.equal(lineage.head_branch, "main");
  assert.ok(observed.job.completedAt);
  const created = time(saved.created_at);
  assert.ok(
    created >= time(observed.job.startedAt) && created <= time(observed.job.completedAt),
    "Artifact outside exact device job window",
  );
  const expires = time(saved.expires_at);
  assert.ok(expires > Date.now(), "Device artifact expired");
  return { created, expires };
}
async function completed(
  bound: DevicePhaseReadInput,
  request: GitHubRequest,
): Promise<DeviceJobObservation> {
  let producer: Producer;
  if (bound.context.mode === "current") {
    closed(bound.context, ["mode", "current"]);
    assert.equal(bound.reference.runId, bound.context.current.runId);
    assert.equal(bound.reference.runAttempt, bound.context.current.runAttempt);
    producer = (
      await authorizeCurrentDeviceJob(
        { loaded: bound.loaded, context: bound.context.current },
        request,
      )
    ).producer;
  } else {
    closed(bound.context, ["mode"]);
    assert.equal(bound.context.mode, "historical");
    const workflow = await source(bound.loaded, request);
    producer = {
      ...workflow,
      workflowPath,
      runId: bound.reference.runId,
      runAttempt: bound.reference.runAttempt,
    };
  }
  await run(
    bound.loaded,
    request,
    producer,
    bound.context.mode === "current" ? "in_progress" : "completed",
  );
  const observed = await job(request, producer, jobs[bound.phase], "completed");
  assert.equal(observed.sourceCommit, bound.loaded.candidate.sourceCommit);
  let previousEnd = 0;
  for (const phase of priorPhases(bound)) {
    const ref = bound.expectedLinks[phase];
    assert.ok(ref);
    const prior = await job(request, producer, jobs[phase], "completed");
    assert.equal(prior.sourceCommit, bound.loaded.candidate.sourceCommit);
    assert.ok(prior.completedAt);
    assert.ok(time(prior.startedAt) >= previousEnd);
    previousEnd = time(prior.completedAt);
    assert.ok(previousEnd <= time(observed.startedAt), "Device phases out of order");
    const { sourceCommit: _priorSource, ...priorJob } = prior;
    // This authenticates the link's producer/order, not its payload. Callers
    // still read each required prior phase before consuming its public data.
    await savedArtifact(
      bound.loaded,
      ref,
      request,
      { producer, job: priorJob, checkedAt: new Date().toISOString() },
      artifactPrefix[phase],
      (phaseFiles[phase].length + 1) * maximum + 65_536,
    );
  }
  const { sourceCommit: _source, ...publicJob } = observed;
  return immutable({ producer, job: publicJob, checkedAt: new Date().toISOString() });
}
function priorPhases(bound: DevicePhaseReadInput): ("initial" | "a" | "b")[] {
  const links = bound.expectedLinks;
  assert.ok(!links.b || links.a, "B requires the A reference");
  const phases: ("initial" | "a" | "b")[] =
    bound.phase === "initial"
      ? []
      : bound.phase === "a"
        ? ["initial"]
        : bound.phase === "b"
          ? ["initial", "a"]
          : ["initial", ...(links.a ? (["a"] as const) : []), ...(links.b ? (["b"] as const) : [])];
  closed(links, phases);
  return phases;
}
async function recheck(
  bound: DevicePhaseReadInput,
  observed: DeviceJobObservation,
  request: GitHubRequest,
) {
  await privilegedCheckout(bound.loaded.candidate);
  await run(
    bound.loaded,
    request,
    observed.producer,
    bound.context.mode === "current" ? "in_progress" : "completed",
  );
  await trustedMain(bound.loaded.candidate, request);
  assert.ok(observed.job.completedAt);
  freshness(observed.job.completedAt, 6);
}
async function memberSet(
  ref: ArtifactReference,
  bounds: Readonly<Record<string, number>>,
  metadata: string,
  request: DevicePhaseRequest,
) {
  assert.equal(
    typeof request.verifyArtifactMembers,
    "function",
    "Strict phase ZIP namespace port required",
  );
  const contents = await request.verifyArtifactMembers(ref, Object.freeze({ ...bounds }));
  assert.deepEqual(
    [...contents.names].sort(),
    Object.keys(bounds).sort(),
    "Unexpected device ZIP member",
  );
  assert.deepEqual(Object.keys(contents.members).sort(), Object.keys(bounds).sort());
  for (const [name, limit] of Object.entries(bounds)) {
    const bytes = contents.members[name];
    assert.ok(bytes);
    assert.ok(
      Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= limit,
      "Device member byte bound",
    );
  }
  // Preserve the existing actual API ZIP-digest/selected-member authentication.
  const actual = await request.verifyArtifact(ref, metadata);
  const limit = bounds[metadata];
  const selected = contents.members[metadata];
  assert.ok(limit !== undefined && selected);
  assert.ok(actual && actual.length <= limit && actual.equals(selected));
  return Object.fromEntries(
    Object.entries(contents.members).map(([name, bytes]) => [name, Buffer.from(bytes)]),
  );
}
function metadata(
  value: Record<string, unknown>,
  bound: DevicePhaseReadInput,
  observed: DeviceJobObservation,
) {
  const common = [
    "schemaVersion",
    "phase",
    "mode",
    "sourceCommit",
    "candidateSha256",
    "scope",
    "producer",
    "jobId",
    "deployment",
    "checkedAt",
    "files",
  ];
  const links = bound.expectedLinks;
  const allowedLinks = priorPhases(bound);
  const custody = bound.phase === "initial" && value.custody !== undefined;
  closed(value, [
    ...common,
    ...allowedLinks.map((name) => `${name}Reference`),
    ...(custody ? ["custody"] : []),
  ]);
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.phase, bound.phase);
  assert.ok(value.mode === "perform" || value.mode === "verify-existing");
  assert.equal(value.mode, bound.mode);
  assert.equal(value.sourceCommit, bound.loaded.candidate.sourceCommit);
  assert.equal(value.candidateSha256, bound.loaded.hash);
  assert.equal(value.scope, bound.loaded.candidate.scope);
  assertProducer(value.producer);
  assert.deepEqual(value.producer, observed.producer);
  assert.equal(value.jobId, observed.job.id);
  assertDeployment(value.deployment);
  assert.equal(
    deviceTargetIdentitySha256(value.deployment),
    deviceTargetIdentitySha256(bound.deployment),
  );
  assert.ok(observed.job.completedAt);
  for (const at of [value.checkedAt, value.deployment.checkedAt])
    assert.ok(
      time(at) >= time(observed.job.startedAt) && time(at) <= time(observed.job.completedAt),
    );
  freshness(string(value.checkedAt), 6);
  for (const name of allowedLinks) {
    const expected = links[name as keyof typeof links];
    assert.ok(expected);
    reference(expected, bound.loaded.hash);
    const actual = value[`${name}Reference`] as ArtifactReference;
    reference(actual, bound.loaded.hash);
    assert.deepEqual(actual, expected);
  }
  if (bound.phase === "initial" && value.mode === "perform")
    assert.ok(custody, "Initial role custody reference required");
  if (custody) {
    const selected = object(value.custody);
    closed(selected, ["reference", "record"]);
    reference(selected.reference as ArtifactReference, bound.loaded.hash);
    record(selected.record as FileRecord, "custody.json", cipherMaximum);
  }
  assert.ok(Array.isArray(value.files));
  assert.equal(value.files.length, phaseFiles[bound.phase].length);
  for (const name of phaseFiles[bound.phase]) {
    const selected: unknown[] = value.files.filter((file) => object(file).path === name);
    assert.equal(selected.length, 1);
    record(selected[0] as FileRecord, name, maximum);
  }
  return value as unknown as DevicePhaseMetadata;
}

/** Completed individual phase only. Current-run admission is limited to the
 * same source/attempt and successful completed job; this creates no Gate. */
export async function readDevicePhaseArtifact(
  input: DevicePhaseReadInput,
  request: DevicePhaseRequest,
): Promise<DevicePhaseArtifact> {
  try {
    const bound = immutable(input);
    closed(bound, [
      "loaded",
      "phase",
      "mode",
      "reference",
      "context",
      "deployment",
      "expectedLinks",
    ]);
    loadedCandidate(bound.loaded);
    assert.ok(Object.hasOwn(phaseFiles, bound.phase));
    assert.ok(bound.mode === "perform" || bound.mode === "verify-existing");
    reference(bound.reference, bound.loaded.hash); // Before any artifact payload access.
    priorPhases(bound);
    for (const linked of Object.values(bound.expectedLinks)) {
      reference(linked, bound.loaded.hash);
      assert.equal(linked.runId, bound.reference.runId);
      assert.equal(linked.runAttempt, bound.reference.runAttempt);
      assert.notEqual(linked.artifactId, bound.reference.artifactId);
    }
    if (bound.context.mode === "current")
      assert.equal(
        bound.mode,
        bound.context.current.operation === "deploy" ? "perform" : "verify-existing",
      );
    assertDeployment(bound.deployment);
    assert.equal(bound.deployment.sourceCommit, bound.loaded.candidate.sourceCommit);
    assert.equal(bound.deployment.candidateSha256, bound.loaded.hash);
    const observed = await completed(bound, request);
    const name = metadataFile(bound.phase);
    const bounds = Object.fromEntries(
      [name, ...phaseFiles[bound.phase]].map((path) => [path, maximum]),
    );
    const wire = await savedArtifact(
      bound.loaded,
      bound.reference,
      request,
      observed,
      artifactPrefix[bound.phase],
      Object.keys(bounds).length * maximum + 65_536,
    );
    const members = await memberSet(bound.reference, bounds, name, request);
    // Authority is refreshed after all ZIP awaits BEFORE any phase JSON parsing.
    await recheck(bound, observed, request);
    await savedArtifact(
      bound.loaded,
      bound.reference,
      request,
      observed,
      artifactPrefix[bound.phase],
      Object.keys(bounds).length * maximum + 65_536,
    );
    assert.ok(wire.expires > Date.now());
    freshness(string(observed.job.completedAt), 6);
    const metaBytes = members[name];
    assert.ok(metaBytes);
    const parsed = metadata(canonical(metaBytes, maximum), bound, observed);
    const payloads: Record<string, DeviceRecordBytes> = {};
    for (const file of parsed.files) {
      const bytes = members[file.path];
      assert.ok(bytes);
      assert.equal(bytes.length, file.size);
      assert.equal(sha256(bytes), file.sha256);
      payloads[file.path] = {
        record: file,
        base64: bytes.toString("base64"),
        data: canonical(bytes, maximum),
      };
    }
    return immutable({
      reference: bound.reference,
      metadata: parsed,
      metadataSha256: sha256(metaBytes),
      metadataBase64: metaBytes.toString("base64"),
      job: observed,
      payloads,
    });
  } catch {
    throw new Error(reason);
  }
}

/** Reauthenticates the initial artifact rather than accepting a serialized
 * "verified" object. Returns ciphertext only; no key lookup or decryption. */
export async function readDeviceCustodyArtifact(
  input: DevicePhaseReadInput,
  request: DevicePhaseRequest,
) {
  try {
    assert.equal(input.phase, "initial");
    assert.equal(input.context.mode, "current");
    const bound = immutable(input);
    const initial = await readDevicePhaseArtifact(bound, request);
    assert.equal(initial.metadata.mode, bound.mode);
    const custody = initial.metadata.custody;
    assert.ok(custody);
    reference(custody.reference, bound.loaded.hash);
    const observed = await completed(bound, request);
    const initialSaved = await savedArtifact(
      bound.loaded,
      bound.reference,
      request,
      observed,
      artifactPrefix.initial,
      5 * maximum + 65_536,
    );
    const saved = await savedArtifact(
      bound.loaded,
      custody.reference,
      request,
      observed,
      "device-custody",
      cipherMaximum + 65_536,
    );
    assert.notEqual(custody.reference.artifactId, bound.reference.artifactId);
    assert.ok(
      saved.created <= initialSaved.created,
      "Custody must precede initial metadata upload",
    );
    const members = await memberSet(
      custody.reference,
      { "custody.json": cipherMaximum },
      "custody.json",
      request,
    );
    await recheck(bound, observed, request);
    await savedArtifact(
      bound.loaded,
      custody.reference,
      request,
      observed,
      "device-custody",
      cipherMaximum + 65_536,
    );
    assert.ok(saved.expires > Date.now());
    const bytes = members["custody.json"];
    assert.ok(bytes);
    assert.equal(bytes.length, custody.record.size);
    assert.equal(sha256(bytes), custody.record.sha256);
    canonical(bytes, cipherMaximum);
    return immutable({
      reference: custody.reference,
      record: custody.record,
      base64: bytes.toString("base64"),
    });
  } catch {
    throw new Error(reason);
  }
}

/** Failed/cancelled initial jobs can convey cleanup ownership only. A missing,
 * skipped or unfinished initial job remains unavailable. No historical mode. */
export async function readDeviceOwnershipArtifact(
  input: {
    loaded: LoadedDeviceCandidate;
    reference: ArtifactReference;
    context: CurrentDeviceJobContext;
  },
  request: DevicePhaseRequest,
): Promise<DeviceOwnershipArtifact> {
  try {
    const bound = immutable(input);
    closed(bound, ["loaded", "reference", "context"]);
    loadedCandidate(bound.loaded);
    reference(bound.reference, bound.loaded.hash);
    assert.equal(bound.context.job, "cleanup");
    assert.equal(bound.reference.runId, bound.context.runId);
    assert.equal(bound.reference.runAttempt, bound.context.runAttempt);
    const current = await authorizeCurrentDeviceJob(bound, request);
    const original = await ownershipJob(request, current.producer);
    assert.equal(original.sourceCommit, bound.loaded.candidate.sourceCommit);
    assert.ok(original.completedAt);
    assert.ok(time(original.completedAt) <= time(current.job.startedAt));
    const { sourceCommit: _source, conclusion, ...job } = original;
    const observed = { producer: current.producer, job, checkedAt: new Date().toISOString() };
    const saved = await savedArtifact(
      bound.loaded,
      bound.reference,
      request,
      observed,
      "device-ownership",
      maximum + 65_536,
    );
    const members = await memberSet(
      bound.reference,
      { "ownership.json": maximum },
      "ownership.json",
      request,
    );
    // Keep the normal phase reader's completed-success policy untouched.
    await privilegedCheckout(bound.loaded.candidate);
    await run(bound.loaded, request, current.producer, "in_progress");
    await trustedMain(bound.loaded.candidate, request);
    freshness(original.completedAt, 6);
    await savedArtifact(
      bound.loaded,
      bound.reference,
      request,
      observed,
      "device-ownership",
      maximum + 65_536,
    );
    assert.ok(saved.expires > Date.now());
    const bytes = members["ownership.json"];
    assert.ok(bytes);
    const value = canonical(bytes, maximum);
    closed(value, [
      "schemaVersion",
      "sourceCommit",
      "candidateSha256",
      "scope",
      "producer",
      "jobId",
      "checkedAt",
      "body",
    ]);
    assert.equal(value.schemaVersion, 1);
    assert.equal(value.sourceCommit, bound.loaded.candidate.sourceCommit);
    assert.equal(value.candidateSha256, bound.loaded.hash);
    assert.equal(value.scope, bound.loaded.candidate.scope);
    assertProducer(value.producer);
    assert.deepEqual(value.producer, observed.producer);
    assert.equal(value.jobId, original.id);
    assert.ok(
      time(value.checkedAt) >= time(original.startedAt) &&
        time(value.checkedAt) <= time(original.completedAt),
    );
    freshness(string(value.checkedAt), 6);
    object(value.body);
    return immutable({
      reference: bound.reference,
      journal: value as unknown as DeviceOwnershipJournal,
      sha256: sha256(bytes),
      base64: bytes.toString("base64"),
      job: observed,
      conclusion,
    });
  } catch {
    throw new Error(reason);
  }
}
