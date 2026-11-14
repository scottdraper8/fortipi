import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { readArtifactZip } from "../../artifact-zip.ts";
import { repository } from "../../build-workspaces.ts";
import {
  authorizeCurrentDeviceJob,
  type CurrentDeviceJobContext,
  type DeviceOwnershipJournal,
  type DevicePhase,
  type DevicePhaseMetadata,
  type DevicePhaseReadInput,
  type DevicePhaseRequest,
  deviceTargetIdentitySha256,
  readDeviceCustodyArtifact,
  readDeviceOwnershipArtifact,
  readDevicePhaseArtifact,
} from "../../device-phase-artifacts.ts";
import {
  type ArtifactReference,
  canonicalJson,
  type DeploymentIdentity,
  type FileRecord,
  git,
  githubRequest,
  REPOSITORY,
  REPOSITORY_ID,
  remoteHash,
  sha256,
  verifyProducer,
} from "../../verify-release-gates.ts";
import { candidate, directoryArchive, httpFixture, temporary } from "./fixtures.ts";

// Real HTTP, ZIP and Git-source guards; all Actions/provider identities and
// public records are synthetic. This is not actual GHA/device/provider proof.
const jobNames = {
  initial: "initial-installed-deployment",
  a: "live-device-a",
  b: "live-device-b",
  cleanup: "live-device-cleanup",
} as const;
const names = {
  initial: ["deployment.json", "deployment.cli.json", "seed.json", "ownership.json"],
  a: ["device-a.json"],
  b: ["device-b.json"],
  cleanup: ["device-cleanup.json"],
} as const;
async function fixture(t: TestContext, phase: DevicePhase = "a", ownershipOnly = false) {
  const root = await temporary("fortipi-device-artifacts-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const c = candidate();
  c.sourceCommit = await git("rev-parse", "HEAD");
  const hash = sha256(`${canonicalJson(c)}\n`);
  const workflow = await readFile(resolve(repository, ".github/workflows/deploy.yml"));
  const now = Date.now();
  // Actual GitHub API examples/records use whole UTC seconds, independently
  // of the repository-generated records' millisecond precision.
  const wireTime = (at: number) => new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");
  const producer = {
    workflowPath: ".github/workflows/deploy.yml",
    workflowSha256: sha256(workflow),
    workflowId: 71,
    runId: 81,
    runAttempt: 1,
  };
  const deployment: DeploymentIdentity = {
    schemaVersion: 1,
    candidateSha256: hash,
    sourceCommit: c.sourceCommit,
    accountBindingSha256: sha256("synthetic-account"),
    slot: "production",
    workerName: "device-test",
    origin: "https://device-test.example.workers.dev",
    workerVersionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    deploymentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    versions: [{ versionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", percentage: 100 }],
    configSha256: sha256("config"),
    runtimeConfigSha256: sha256("runtime"),
    assetManifestSha256: c.assetManifestSha256,
    publicConfigurationVersion: 1,
    capabilities: { plan: "free", loaders: false, containers: false },
    backend: "free",
    imageDigest: null,
    checkedAt: new Date(now - 3500).toISOString(),
  };
  const ref = (id: number, prefix: string): ArtifactReference => ({
    runId: 81,
    runAttempt: 1,
    artifactId: id,
    artifactName: `${prefix}-${c.sourceCommit}-${c.scope}-81-1`,
    artifactDigest: `sha256:${"f".repeat(64)}`,
    candidateSha256: hash,
  });
  const initialReference = ref(40, "deployment-initial"),
    aReference = ref(41, "device-a"),
    bReference = ref(42, "device-b");
  const primary = ownershipOnly
    ? ref(44, "device-ownership")
    : phase === "initial"
      ? initialReference
      : phase === "a"
        ? aReference
        : phase === "b"
          ? bReference
          : ref(43, "device-cleanup");
  const custodyRef = ref(39, "device-custody");
  const directory = resolve(root, "phase");
  await mkdir(directory);
  const cipherDirectory = resolve(root, "cipher");
  await mkdir(cipherDirectory);
  const wireRecord = (path: string, bytes: Buffer): FileRecord => ({
    path,
    size: bytes.length,
    mode: 0o600,
    sha256: sha256(bytes),
  });
  const cipherBytes = Buffer.from(
    `${canonicalJson({ schemaVersion: 1, nonce: "synthetic-encrypted-envelope", ciphertext: "opaque-authenticated-ciphertext" })}\n`,
  );
  await writeFile(resolve(cipherDirectory, "custody.json"), cipherBytes);
  const cipherZip = await directoryArchive(cipherDirectory);
  t.after(cipherZip.close);
  custodyRef.artifactDigest = `sha256:${sha256(cipherZip.bytes)}`;
  const files: FileRecord[] = [];
  const expectedPayloads: Record<string, Buffer> = {};
  for (const path of ownershipOnly ? [] : names[phase]) {
    const bytes = Buffer.from(`${canonicalJson({ publicRecord: path, seed: 1010 })}\n`);
    await writeFile(resolve(directory, path), bytes);
    files.push(wireRecord(path, bytes));
    expectedPayloads[path] = bytes;
  }
  const expectedLinks: DevicePhaseReadInput["expectedLinks"] = {};
  if (phase !== "initial") expectedLinks.initial = initialReference;
  if (phase === "b" || phase === "cleanup") expectedLinks.a = aReference;
  if (phase === "cleanup") expectedLinks.b = bReference;
  const metadata: DevicePhaseMetadata = {
    schemaVersion: 1,
    phase,
    mode: "perform",
    sourceCommit: c.sourceCommit,
    candidateSha256: hash,
    scope: c.scope,
    producer,
    jobId: 91,
    deployment,
    checkedAt: new Date(now - 2500).toISOString(),
    files,
    ...(expectedLinks.initial ? { initialReference } : {}),
    ...(expectedLinks.a ? { aReference } : {}),
    ...(expectedLinks.b ? { bReference } : {}),
    ...(phase === "initial"
      ? { custody: { reference: custodyRef, record: wireRecord("custody.json", cipherBytes) } }
      : {}),
  };
  const ownershipJournal: DeviceOwnershipJournal = {
    schemaVersion: 1,
    sourceCommit: c.sourceCommit,
    candidateSha256: hash,
    scope: c.scope,
    producer,
    jobId: 91,
    checkedAt: new Date(now - 2500).toISOString(),
    body: {
      allocations: [{ requestId: "fixed-allocation-request", disposition: "unknown" }],
      cleanup: "pending",
    },
  };
  const metaName = ownershipOnly
    ? "ownership.json"
    : phase === "initial"
      ? "device-initial.json"
      : "device-phase.json";
  await writeFile(
    resolve(directory, metaName),
    `${canonicalJson(ownershipOnly ? ownershipJournal : metadata)}\n`,
  );
  let archive = await directoryArchive(directory);
  t.after(() => archive.close());
  primary.artifactDigest = `sha256:${sha256(archive.bytes)}`;
  let fault = "",
    reads = 0,
    selected = 0,
    apiCalls = 0,
    artifactLookups = 0;
  let historical = false;
  let activeJob = ownershipOnly ? "live-device-cleanup" : "operate";
  const context: CurrentDeviceJobContext = {
    job: ownershipOnly ? "cleanup" : "operate",
    runId: 81,
    runAttempt: 1,
    repository: REPOSITORY,
    repositoryId: REPOSITORY_ID,
    sourceCommit: c.sourceCommit,
    ref: "refs/heads/main",
    event: "workflow_dispatch",
    workflowRef: `${REPOSITORY}/.github/workflows/deploy.yml@refs/heads/main`,
    runnerName: "GitHub-hosted-current",
    runnerEnvironment: "github-hosted",
    runnerOs: "Linux",
    operation: "deploy",
  };
  const phases = ["initial", "a", "b", "cleanup"] as const;
  const prior = phases.slice(0, phases.indexOf(phase));
  const priorJobs = () =>
    prior.map((name, index) => ({
      id: 80 + index,
      name: jobNames[name],
      run_id: 81,
      head_sha: c.sourceCommit,
      status: "completed",
      conclusion: "success",
      started_at: wireTime(now - (prior.length - index) * 10000 - 10000),
      completed_at: wireTime(
        now - (fault === "wrong-order" ? 4000 : (prior.length - index) * 10000 + 2000),
      ),
      runner_id: 180 + index,
      runner_name: `GitHub-hosted-prior-${name}`,
      labels: ["ubuntu-24.04"],
    }));
  const server = await httpFixture((req, res) => {
    assert.equal(req.method, "GET");
    assert.equal(req.headers.authorization, undefined);
    apiCalls++;
    const path = req.url ?? "";
    const send = (value: unknown) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(value));
    };
    if (path.endsWith("/zip")) {
      const cipher = path.includes("/39/");
      res.writeHead(302, {
        location: `https://fixture.blob.core.windows.net/${cipher ? "cipher" : "phase"}.zip`,
      });
      res.end();
      return;
    }
    if (path === "/phase.zip" || path === "/cipher.zip") {
      reads++;
      res.end(path === "/cipher.zip" ? cipherZip.bytes : archive.bytes);
      return;
    }
    const base = `/repos/${REPOSITORY}`;
    if (path === base) return send({ id: REPOSITORY_ID, full_name: REPOSITORY });
    if (path.endsWith("/git/ref/heads/main"))
      return send({
        object: {
          sha:
            fault === "main" || (fault === "main-after-zip" && reads > 0)
              ? "c".repeat(40)
              : c.sourceCommit,
        },
      });
    if (path.includes("/git/matching-refs/")) return send([]);
    if (path.includes("/contents/"))
      return send({
        encoding: "base64",
        content: (fault === "workflow-bytes" ? Buffer.from("wrong source\n") : workflow).toString(
          "base64",
        ),
      });
    if (path.includes("/actions/workflows/"))
      return send({ id: 71, path: producer.workflowPath, state: "active" });
    if (path.includes("/jobs?"))
      return send({
        total_count: 2 + prior.length,
        jobs: [
          ...priorJobs(),
          {
            id: 91,
            name: fault === "job-name" ? "foreign-job" : jobNames[phase],
            run_id: 81,
            head_sha: c.sourceCommit,
            status: fault === "unfinished" ? "in_progress" : "completed",
            conclusion:
              fault === "unfinished"
                ? null
                : fault === "failed-job"
                  ? "failure"
                  : fault === "cancelled-job"
                    ? "cancelled"
                    : fault === "skipped-job"
                      ? "skipped"
                      : "success",
            started_at: wireTime(now - 5000),
            completed_at: wireTime(now - 1000),
            runner_id: 191,
            runner_name: "GitHub-hosted-phase",
            labels: fault === "self-hosted" ? ["ubuntu-24.04", "self-hosted"] : ["ubuntu-24.04"],
          },
          {
            id: 99,
            name: activeJob,
            run_id: 81,
            head_sha: c.sourceCommit,
            status: "in_progress",
            conclusion: null,
            started_at: wireTime(now - 500),
            completed_at: null,
            runner_id: 199,
            runner_name: "GitHub-hosted-current",
            labels: ["ubuntu-24.04"],
          },
        ],
      });
    if (path.includes("/actions/artifacts/")) {
      artifactLookups++;
      if (fault === "missing-artifact") {
        res.statusCode = 404;
        res.end();
        return;
      }
      const cipher = path.endsWith("/39"),
        selectedId = Number(path.split("/").at(-1)),
        chosen = cipher
          ? custodyRef
          : [initialReference, aReference, bReference, primary].find(
              (ref) => ref.artifactId === selectedId,
            );
      assert.ok(chosen);
      const previousIndex = [40, 41, 42].indexOf(selectedId);
      const previous = !cipher && selectedId !== primary.artifactId;
      return send({
        id: chosen.artifactId,
        name: chosen.artifactName,
        digest: chosen.artifactDigest,
        expired: fault === "expired",
        size_in_bytes: cipher ? cipherZip.bytes.length : previous ? 200 : archive.bytes.length,
        created_at: wireTime(
          now -
            (previous
              ? (prior.length - previousIndex) * 10000 + 3000
              : fault === "wrong-window"
                ? 20000
                : cipher
                  ? fault === "cipher-after-initial"
                    ? 1000
                    : 3500
                  : 2000),
        ),
        expires_at: wireTime(fault === "expires-after-zip" && reads > 0 ? now - 1 : now + 60000),
        workflow_run: {
          id: 81,
          repository_id: REPOSITORY_ID,
          head_repository_id: fault === "foreign-repo" ? 1 : REPOSITORY_ID,
          head_sha: c.sourceCommit,
          head_branch: "main",
        },
      });
    }
    if (path.includes("/actions/runs/81"))
      return send({
        id: 81,
        run_attempt: fault === "attempt" || (fault === "attempt-after-zip" && reads > 0) ? 2 : 1,
        workflow_id: 71,
        head_sha: fault === "source" ? "d".repeat(40) : c.sourceCommit,
        head_branch: "main",
        event: "workflow_dispatch",
        path: producer.workflowPath,
        status: historical ? "completed" : "in_progress",
        conclusion: historical ? "success" : null,
        repository: { id: REPOSITORY_ID },
        head_repository: { id: REPOSITORY_ID },
        updated_at: wireTime(now - 1000),
      });
    res.statusCode = 404;
    res.end();
  });
  t.after(server.close);
  const plain = githubRequest(undefined, server.transport);
  // Test-side strict transport uses the existing real HTTP digest verifier and
  // native ZIP helper. Production requires the corresponding trusted adapter;
  // no mock names, archive-parser implementation or credentials are supplied.
  const request: DevicePhaseRequest = Object.assign(plain, {
    async verifyArtifactMembers(
      reference: ArtifactReference,
      bounds: Readonly<Record<string, number>>,
    ) {
      selected++;
      const path = resolve(root, `download-${selected}.zip`);
      const hash = await remoteHash(
        `https://api.github.com/repos/${REPOSITORY}/actions/artifacts/${reference.artifactId}/zip`,
        {},
        server.transport,
        path,
      );
      assert.equal(`sha256:${hash}`, reference.artifactDigest);
      assert.ok(
        (await stat(path)).size <= Object.values(bounds).reduce((a, b) => a + b, 0) + 65536,
      );
      const members: Record<string, Buffer> = {};
      let listed: string[] = [];
      for (const [name, limit] of Object.entries(bounds)) {
        const read = await readArtifactZip(path, name);
        listed = read.names;
        assert.ok(read.bytes.length <= limit);
        members[name] = read.bytes;
      }
      return { names: listed, members };
    },
  });
  const input: DevicePhaseReadInput = {
    loaded: { candidate: c, hash },
    phase,
    mode: "perform",
    reference: primary,
    context: { mode: "current", current: context },
    deployment,
    expectedLinks,
  };
  return {
    input,
    request,
    context,
    producer,
    metadata,
    ownershipJournal,
    ownershipInput: { loaded: input.loaded, reference: primary, context },
    expectedPayloads,
    cipherBytes,
    counts: () => ({ reads, selected, apiCalls, artifactLookups }),
    fault: (value: string) => {
      fault = value;
    },
    activeJob: (name: string) => {
      activeJob = name;
    },
    historical: () => {
      historical = true;
      input.context = { mode: "historical" };
    },
    async rewrite(change: (metadata: DevicePhaseMetadata) => void, extra = false) {
      change(metadata);
      await writeFile(resolve(directory, metaName), `${canonicalJson(metadata)}\n`);
      if (extra) await writeFile(resolve(directory, "unexpected.json"), "{}\n");
      await archive.close();
      archive = await directoryArchive(directory);
      primary.artifactDigest = `sha256:${sha256(archive.bytes)}`;
    },
    async replacePayload(bytes: Buffer) {
      const file = metadata.files[0];
      assert.ok(file);
      await writeFile(resolve(directory, file.path), bytes);
      Object.assign(file, wireRecord(file.path, bytes));
      expectedPayloads[file.path] = bytes;
      await writeFile(resolve(directory, metaName), `${canonicalJson(metadata)}\n`);
      await archive.close();
      archive = await directoryArchive(directory);
      primary.artifactDigest = `sha256:${sha256(archive.bytes)}`;
    },
  };
}

test("completed initial/A/B/cleanup records authenticate current jobs and immutable exact member bytes; historical run must complete", async (t) => {
  for (const phase of ["initial", "a", "b", "cleanup"] as const) {
    const f = await fixture(t, phase);
    const observation = await authorizeCurrentDeviceJob(
      { loaded: f.input.loaded, context: f.context },
      f.request,
    );
    assert.equal(observation.job.name, "operate");
    assert.ok(Object.isFrozen(observation.job));
    if (phase === "initial") {
      f.context.job = "a";
      f.activeJob("live-device-a");
      assert.equal(
        (await authorizeCurrentDeviceJob({ loaded: f.input.loaded, context: f.context }, f.request))
          .job.name,
        "live-device-a",
      );
      f.context.job = "operate";
      f.activeJob("operate");
    }
    const read = await readDevicePhaseArtifact(f.input, f.request);
    assert.equal(read.metadata.phase, phase);
    assert.ok(Object.isFrozen(read.metadata.files));
    for (const [path, payload] of Object.entries(read.payloads)) {
      assert.deepEqual(Buffer.from(payload.base64, "base64"), f.expectedPayloads[path]);
      assert.equal(
        createHash("sha256").update(Buffer.from(payload.base64, "base64")).digest("hex"),
        payload.record.sha256,
      );
      assert.ok(Object.isFrozen(payload));
    }
    const originalTime = read.metadata.deployment.checkedAt;
    assert.equal(
      deviceTargetIdentitySha256({ ...f.input.deployment, checkedAt: new Date().toISOString() }),
      deviceTargetIdentitySha256(f.input.deployment),
    );
    assert.equal(read.metadata.deployment.checkedAt, originalTime);
    const prior = f.counts().selected;
    f.historical();
    assert.equal((await readDevicePhaseArtifact(f.input, f.request)).metadata.phase, phase);
    assert.equal(f.counts().selected, prior + 1);
  }
});

test("cleanup retains the exact initial provider observation while its own timestamp belongs to the cleanup job", async (t) => {
  const f = await fixture(t, "cleanup");
  const initialTime = new Date(Date.parse(f.input.deployment.checkedAt) - 31000).toISOString();
  f.input.deployment = { ...f.input.deployment, checkedAt: initialTime };
  await f.rewrite((meta) => {
    meta.deployment = { ...meta.deployment, checkedAt: initialTime };
  });
  const original = await readDevicePhaseArtifact(f.input, f.request);
  assert.equal(original.metadata.deployment.checkedAt, initialTime);
  assert.ok(Date.parse(original.metadata.checkedAt) > Date.parse(initialTime));
  await f.rewrite((meta) => {
    meta.deployment.checkedAt = meta.checkedAt;
  });
  await assert.rejects(readDevicePhaseArtifact(f.input, f.request), /unavailable/);
  await f.rewrite((meta) => {
    meta.deployment.checkedAt = initialTime;
    meta.checkedAt = initialTime;
  });
  await assert.rejects(readDevicePhaseArtifact(f.input, f.request), /unavailable/);
  const a = await fixture(t, "a");
  a.input.deployment = { ...a.input.deployment, checkedAt: initialTime };
  await a.rewrite((meta) => {
    meta.deployment = { ...meta.deployment, checkedAt: initialTime };
  });
  await assert.rejects(readDevicePhaseArtifact(a.input, a.request), /unavailable/);
});

test("reference/source/latest attempt/job/runner/window guards reject before artifact payload; generic live producer still requires completed run", async (t) => {
  const f = await fixture(t);
  for (const fault of [
    "main",
    "workflow-bytes",
    "source",
    "attempt",
    "job-name",
    "unfinished",
    "failed-job",
    "self-hosted",
    "foreign-repo",
    "wrong-window",
    "wrong-order",
    "expired",
  ]) {
    f.fault(fault);
    const before = f.counts();
    await assert.rejects(readDevicePhaseArtifact(f.input, f.request), /unavailable/);
    assert.equal(f.counts().selected, before.selected, `${fault} reached payload`);
  }
  f.fault("");
  const originalRunner = f.context.runnerName;
  f.context.runnerName = "foreign-runner";
  await assert.rejects(
    authorizeCurrentDeviceJob({ loaded: f.input.loaded, context: f.context }, f.request),
    /unavailable/,
  );
  f.context.runnerName = originalRunner;
  f.context.job = "a";
  await assert.rejects(
    authorizeCurrentDeviceJob({ loaded: f.input.loaded, context: f.context }, f.request),
    /unavailable/,
  );
  f.context.job = "operate";
  const ref = f.input.reference;
  f.input.reference = { ...ref, candidateSha256: sha256("wrong candidate") };
  await assert.rejects(readDevicePhaseArtifact(f.input, f.request), /unavailable/);
  assert.equal(f.counts().selected, 0);
  f.input.reference = ref;
  await assert.rejects(
    verifyProducer(
      f.input.loaded.candidate,
      "live",
      f.producer,
      {
        ...ref,
        artifactName: `live-${f.input.loaded.candidate.sourceCommit}-${f.input.loaded.candidate.scope}-81-1`,
      },
      f.request,
    ),
    (error: unknown) =>
      error instanceof assert.AssertionError &&
      error.actual === "in_progress" &&
      error.expected === "completed",
  );
  assert.equal((await readDevicePhaseArtifact(f.input, f.request)).metadata.phase, "a");
});

test("actual ZIP digest/namespace/member hashes and post-await main/attempt/expiry refuse inconsistent phase bytes; custody is initial-bound and separate", async (t) => {
  for (const fault of ["main-after-zip", "attempt-after-zip", "expires-after-zip"]) {
    const f = await fixture(t);
    f.fault(fault);
    await assert.rejects(readDevicePhaseArtifact(f.input, f.request), /unavailable/);
    assert.equal(f.counts().selected, 1, `${fault} must occur after actual archive await`);
  }
  // Fresh fixture restores a positive transport and isolates digest/closure failures.
  const g = await fixture(t);
  const digest = g.input.reference.artifactDigest;
  g.input.reference.artifactDigest = `sha256:${sha256("wrong ZIP")}`;
  await assert.rejects(readDevicePhaseArtifact(g.input, g.request), /unavailable/);
  assert.equal(g.counts().selected, 1);
  g.input.reference.artifactDigest = digest;
  await g.rewrite((meta) => {
    const file = meta.files[0];
    assert.ok(file);
    file.sha256 = sha256("changed member");
  });
  await assert.rejects(readDevicePhaseArtifact(g.input, g.request), /unavailable/);
  await g.rewrite((meta) => {
    const file = meta.files[0];
    assert.ok(file);
    const bytes = g.expectedPayloads[file.path];
    assert.ok(bytes);
    file.sha256 = sha256(bytes);
  }, true);
  await assert.rejects(readDevicePhaseArtifact(g.input, g.request), /unavailable/);
  const initial = await fixture(t, "initial");
  const cipher = await readDeviceCustodyArtifact(initial.input, initial.request);
  assert.deepEqual(Buffer.from(cipher.base64, "base64"), initial.cipherBytes);
  assert.ok(Object.isFrozen(cipher.record));
  const lateCipher = await fixture(t, "initial");
  lateCipher.fault("cipher-after-initial");
  await assert.rejects(
    readDeviceCustodyArtifact(lateCipher.input, lateCipher.request),
    /unavailable/,
  );
  assert.equal(lateCipher.counts().selected, 1, "Reject cipher ordering before its payload");
  const verify = await fixture(t, "initial");
  verify.input.mode = "verify-existing";
  verify.context.operation = "verify";
  await verify.rewrite((meta) => {
    meta.mode = "verify-existing";
  });
  assert.deepEqual(
    Buffer.from((await readDeviceCustodyArtifact(verify.input, verify.request)).base64, "base64"),
    verify.cipherBytes,
  );
  const beforeOldCustody = verify.counts().selected;
  await verify.rewrite((meta) => {
    assert.ok(meta.custody);
    meta.custody.reference.runId = 80;
  });
  await assert.rejects(readDeviceCustodyArtifact(verify.input, verify.request), /unavailable/);
  assert.equal(verify.counts().selected, beforeOldCustody + 1, "Prior-run cipher is never read");
  initial.historical();
  await assert.rejects(readDeviceCustodyArtifact(initial.input, initial.request), /unavailable/);
});

test("public record byte boundary and closed metadata reject authenticated oversize/extra authority fields", async (t) => {
  const f = await fixture(t);
  const empty = Buffer.byteLength(`${canonicalJson({ pad: "" })}\n`);
  const bytes = Buffer.from(`${canonicalJson({ pad: "x".repeat(1_048_576 - empty) })}\n`);
  assert.equal(bytes.length, 1_048_576);
  await f.replacePayload(bytes);
  const read = await readDevicePhaseArtifact(f.input, f.request);
  assert.equal(Object.values(read.payloads)[0]?.record.size, 1_048_576);
  await f.replacePayload(Buffer.from(`${canonicalJson({ pad: "x".repeat(1_048_577 - empty) })}\n`));
  await assert.rejects(readDevicePhaseArtifact(f.input, f.request), /unavailable/);
  const g = await fixture(t);
  await g.rewrite((meta) => Object.assign(meta, { verified: true }));
  await assert.rejects(readDevicePhaseArtifact(g.input, g.request), /unavailable/);
  const initial = await fixture(t, "initial");
  await initial.rewrite((meta) => {
    assert.ok(meta.custody);
    meta.custody.record.size = 65_537;
  });
  await assert.rejects(readDeviceCustodyArtifact(initial.input, initial.request), /unavailable/);
});

test("cleanup-only ownership accepts completed failed/cancelled initial jobs without granting phase/custody proof; missing and unfinished ownership remain unavailable", async (t) => {
  for (const [fault, expected] of [
    ["", "success"],
    ["failed-job", "failure"],
    ["cancelled-job", "cancelled"],
  ]) {
    const f = await fixture(t, "initial", true);
    f.fault(fault ?? "");
    const read = await readDeviceOwnershipArtifact(f.ownershipInput, f.request);
    assert.equal(read.conclusion, expected);
    assert.deepEqual(read.journal, f.ownershipJournal);
    assert.equal(
      createHash("sha256").update(Buffer.from(read.base64, "base64")).digest("hex"),
      read.sha256,
    );
    assert.equal(read.journal.body.cleanup, "pending");
    assert.ok(Object.isFrozen(read.journal.body));
    assert.equal(Object.hasOwn(read, "payloads"), false);
    if (fault) {
      const before = f.counts();
      await assert.rejects(readDevicePhaseArtifact(f.input, f.request), /unavailable/);
      await assert.rejects(readDeviceCustodyArtifact(f.input, f.request), /unavailable/);
      assert.equal(f.counts().selected, before.selected);
      assert.equal(f.counts().artifactLookups, before.artifactLookups);
    }
  }
  for (const fault of [
    "unfinished",
    "skipped-job",
    "missing-artifact",
    "attempt",
    "main-after-zip",
  ]) {
    const f = await fixture(t, "initial", true);
    f.fault(fault);
    await assert.rejects(readDeviceOwnershipArtifact(f.ownershipInput, f.request), /unavailable/);
    assert.equal(f.counts().selected, fault === "main-after-zip" ? 1 : 0);
  }
  const f = await fixture(t, "initial", true);
  f.ownershipInput.context.job = "a";
  await assert.rejects(readDeviceOwnershipArtifact(f.ownershipInput, f.request), /unavailable/);
  assert.equal(f.counts().apiCalls, 0);
  f.ownershipInput.context.job = "cleanup";
  f.ownershipInput.reference.candidateSha256 = sha256("wrong candidate");
  await assert.rejects(readDeviceOwnershipArtifact(f.ownershipInput, f.request), /unavailable/);
  assert.equal(f.counts().apiCalls, 0);
});
