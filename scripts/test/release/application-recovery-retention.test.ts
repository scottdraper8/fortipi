import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import type {
  ApplicationRecoveryAfter,
  ApplicationRecoveryBefore,
} from "../../../tests/clients/platform-recovery.ts";
import type { ApplicationRecoveryProviderResult } from "../../application-recovery-checkpoints.ts";
import { validateRecoveryRetention } from "../../application-recovery-retention.ts";
import { repository } from "../../build-workspaces.ts";
import {
  type ArtifactReference,
  canonicalJson,
  type DeploymentIdentity,
  type FileRecord,
  type GateReceipt,
  githubRequest,
  inventory,
  object,
  REPOSITORY_ID,
  readJson,
  regularBytes,
  saveJson,
  sha256,
} from "../../verify-release-gates.ts";
import { candidate, deviceProducerJobs, directoryArchive, httpFixture } from "./fixtures.ts";

// Synthetic IDs/provider result test local binding only; no actual recovery claim.
const candidateSha256 = sha256("checkpoint candidate");
const sourceCommit = "a".repeat(40);
const capturedAt = new Date().toISOString();
function deployment(n: number): DeploymentIdentity {
  const version = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  return {
    schemaVersion: 1,
    candidateSha256,
    sourceCommit,
    accountBindingSha256: sha256("account"),
    slot: "production",
    workerName: "recovery-test",
    origin: "https://recovery-test.example.com",
    workerVersionId: version,
    deploymentId: `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    versions: [{ versionId: version, percentage: 100 }],
    configSha256: sha256("config"),
    runtimeConfigSha256: sha256("runtime"),
    assetManifestSha256: sha256("assets"),
    publicConfigurationVersion: 1,
    capabilities: { plan: "free", loaders: false, containers: false },
    backend: "free",
    imageDigest: null,
    checkedAt: capturedAt,
  };
}

// Checkpoint DTO setup above is adapted from frozen93ff; no actual public or CF
// operation is represented. Below exercises real files, HTTP, ZIP and validators.
async function fixture(t: TestContext, mode: "perform" | "verify-existing") {
  const root = await fs.mkdtemp(resolve(await fs.realpath(tmpdir()), "fortipi-retention-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = resolve(root, "child");
  const points = await checkpoints(resolve(directory, "application-recovery"));
  const provider = points.input.provider;
  const journal = resolve(directory, "provider-recovery");
  await fs.mkdir(journal, { mode: 0o700 });
  const intent = await write(resolve(journal, "intent.json"), {
    schemaVersion: 1,
    operationId: provider.transition.operationId,
    candidateSha256,
    sourceCommit,
    before: provider.transition.before,
    beforeCheckpointSha256: points.input.before.sha256,
    requestedStrategy: "immediate",
    strategyReadBack: false,
  });
  provider.transition.intentSha256 = intent.sha256;
  const transition = await write(resolve(journal, "transition.json"), provider.transition);
  provider.transitionSha256 = transition.sha256;
  const relativeRecord = (file: FileRecord) => ({
    ...file,
    path: `application-recovery/${basename(file.path)}`,
  });
  const proof = {
    schemaVersion: 1,
    sourceCommit,
    candidateSha256,
    operationId: provider.transition.operationId,
    transitionSha256: transition.sha256,
    before: relativeRecord(points.input.before),
    after: relativeRecord(points.input.after),
  };
  const proofFile = await write(resolve(journal, "application-recovery.json"), proof);
  const original = deployment(1);
  const current = deployment(2);
  const cli = {
    workerName: original.workerName,
    origin: original.origin,
    targets: [original.origin],
    workerVersionId: original.workerVersionId,
    sourceCommit,
    packageVersion: "0.1.0",
    assetManifestSha256: original.assetManifestSha256,
    configSha256: original.configSha256,
  };
  const originalPath = resolve(root, "original-deployment.json");
  const originalCliPath = resolve(root, "original-deployment.cli.json");
  const currentReceiptPath = resolve(root, "original-deployment.cli.provider-version.json");
  const originalFile = await write(originalPath, original);
  const cliFile = await write(originalCliPath, cli);
  const receiptFile = await write(currentReceiptPath, {
    ...cli,
    workerVersionId: current.workerVersionId,
  });
  await fs.copyFile(originalPath, resolve(journal, "original-deployment.json"));
  await fs.copyFile(originalCliPath, resolve(journal, "original-deployment.cli.json"));
  const c = candidate();
  const childStartupObservation = mode === "perform" ? original : current;
  const operation = {
    status: "operation-confirmed",
    before: provider.transition.before,
    after: provider.transition.after,
    operationEvidenceSha256: transition.sha256,
    requestedStrategy: "immediate",
    strategyReadBack: false,
    reset: "inferred-from-provider-contract",
    incarnation: "not-observed",
    eviction: "not-observed",
    physicalHostLoss: "not-observed",
  };
  const rowPath = resolve(directory, "platform-recovery.json");
  const row = await write(rowPath, {
    id: "platform-recovery",
    outcome: "pass",
    identity: { deployments: [childStartupObservation] },
    observation: { mode, operation },
  });
  const workflow = await regularBytes(resolve(repository, ".github/workflows/deploy.yml"));
  const producer = {
    workflowPath: ".github/workflows/deploy.yml",
    workflowSha256: sha256(workflow),
    workflowId: 71,
    runId: 81,
    runAttempt: 1,
  };
  const child: GateReceipt = {
    schemaVersion: 1,
    kind: "live",
    candidateSha256,
    sourceCommit,
    scope: c.scope,
    producer,
    checkedAt: new Date().toISOString(),
    platforms: [],
    deployments: [childStartupObservation],
    claims: [
      {
        id: "platform-recovery",
        outcome: "pass",
        result: { ...row, path: "platform-recovery.json" },
      },
    ],
    files: await inventory(directory),
  };
  const childGate = await write(resolve(directory, "gate.json"), child);
  const facts = {
    schemaVersion: 1,
    sourceCommit,
    candidateSha256,
    original,
    childStartupObservation,
    current,
    childGateSha256: childGate.sha256,
    originalDeploymentSha256: originalFile.sha256,
    originalCliSha256: cliFile.sha256,
    currentReceiptSha256: receiptFile.sha256,
    receiptProvenance: "provider-confirmed-version; not a second CLI invocation",
    mode,
    operationId: proof.operationId,
    transitionSha256: proof.transitionSha256,
    proofSha256: proofFile.sha256,
    before: proof.before,
    after: proof.after,
    transitionBefore: provider.transition.before,
    transitionAfter: provider.transition.after,
  };
  const factsPath = resolve(root, "recovery-facts.json");
  const proofsPath = resolve(root, "proofs.json");
  let failedProducer = false;
  let downloads = 0;
  let originalDirectory: string | undefined;
  if (mode === "verify-existing") {
    originalDirectory = resolve(root, "proofs", "original-live");
    await fs.mkdir(originalDirectory, { recursive: true, mode: 0o700 });
    await fs.cp(directory, resolve(originalDirectory, "claims"), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    const originalFiles = await inventory(originalDirectory);
    const originalRow = originalFiles.find((file) => file.path === "claims/platform-recovery.json");
    assert.ok(originalRow);
    const gate: GateReceipt = {
      ...child,
      deployments: [current],
      claims: [{ id: "platform-recovery", outcome: "pass", result: originalRow }],
      files: originalFiles,
    };
    await write(resolve(originalDirectory, "gate.json"), gate);
    for (const file of [...originalFiles, { path: "gate.json" }])
      await fs.chmod(resolve(originalDirectory, file.path), 0o644);
    const archive = await directoryArchive(originalDirectory);
    t.after(archive.close);
    const reference: ArtifactReference = {
      runId: 81,
      runAttempt: 1,
      artifactId: 83,
      artifactName: `live-${sourceCommit}-${c.scope}-81-1`,
      artifactDigest: `sha256:${sha256(archive.bytes)}`,
      candidateSha256,
    };
    await saveJson(proofsPath, {
      schemaVersion: 1,
      candidateArtifact: reference,
      proofs: [{ artifact: reference, directory: originalDirectory }],
    });
    const now = Date.now();
    const server = await httpFixture((request, response) => {
      assert.equal(request.method, "GET");
      assert.equal(request.headers.authorization, undefined);
      const url = request.url ?? "";
      if (url.endsWith("/zip")) {
        response.writeHead(302, { location: "https://fixture.blob.core.windows.net/original.zip" });
        response.end();
        return;
      }
      if (url === "/original.zip") {
        downloads++;
        response.end(archive.bytes);
        return;
      }
      const run = {
        id: 81,
        run_attempt: 1,
        workflow_id: 71,
        head_sha: sourceCommit,
        head_branch: "main",
        event: "workflow_dispatch",
        path: ".github/workflows/deploy.yml",
        repository: { id: REPOSITORY_ID },
        head_repository: { id: REPOSITORY_ID },
        status: "completed",
        conclusion: failedProducer ? "failure" : "success",
        run_started_at: new Date(now - 10000).toISOString(),
        updated_at: new Date(now - 1000).toISOString(),
      };
      let value: unknown;
      if (url.endsWith("/actions/workflows/71"))
        value = { id: 71, path: producer.workflowPath, state: "active" };
      else if (url.includes("/contents/"))
        value = { encoding: "base64", content: workflow.toString("base64") };
      else if (url.includes("/jobs?"))
        value = {
          total_count: deviceProducerJobs.length,
          jobs: deviceProducerJobs.map((name, index) => ({
            id: 91 + index,
            name,
            status: "completed",
            conclusion: "success",
            started_at: new Date(now - 5000).toISOString(),
            completed_at: run.updated_at,
          })),
        };
      else if (url.endsWith("/actions/artifacts/83"))
        value = {
          id: 83,
          name: reference.artifactName,
          digest: reference.artifactDigest,
          expired: false,
          created_at: new Date(now - 2000).toISOString(),
          expires_at: new Date(now + 60000).toISOString(),
          workflow_run: {
            id: 81,
            repository_id: REPOSITORY_ID,
            head_repository_id: REPOSITORY_ID,
            head_sha: sourceCommit,
            head_branch: "main",
          },
        };
      else if (url.includes("/actions/runs/81")) value = run;
      else {
        response.statusCode = 404;
        response.end();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(value));
    });
    t.after(server.close);
    const linked = { ...facts, evidence: reference };
    await write(factsPath, linked);
    return {
      input: {
        candidate: c,
        candidateSha256,
        kind: "independent" as const,
        child,
        claimsDirectory: directory,
        deployment: current,
        originalCliPath,
        currentReceiptPath,
        factsPath,
        proofsPath,
        request: githubRequest(undefined, server.transport),
      },
      facts: linked,
      points,
      root,
      originalDirectory,
      downloads: () => downloads,
      failProducer: () => {
        failedProducer = true;
      },
    };
  }
  await write(factsPath, facts);
  return {
    input: {
      candidate: c,
      candidateSha256,
      kind: "live" as const,
      child,
      claimsDirectory: directory,
      deployment: current,
      originalCliPath,
      currentReceiptPath,
      factsPath,
      proofsPath,
      request: githubRequest(undefined, async () => {
        throw Error("Perform retention must not contact original producer");
      }),
    },
    facts,
    points,
    root,
    originalDirectory,
    downloads: () => downloads,
    failProducer: () => {
      failedProducer = true;
    },
  };
}

test("perform retention links child V0 to provider V1 without rewriting original CLI or checkpoints", async (t) => {
  const f = await fixture(t, "perform");
  const before = await inventory(f.root);
  const originalCli = await regularBytes(f.input.originalCliPath);
  await validateRecoveryRetention(f.input);
  await assert.rejects(validateRecoveryRetention({ ...f.input, kind: "independent" }));
  assert.deepEqual(f.input.child.deployments, [deployment(1)]);
  assert.equal(f.input.deployment.workerVersionId, deployment(2).workerVersionId);
  assert.equal(
    object(await readJson(f.input.originalCliPath)).workerVersionId,
    deployment(1).workerVersionId,
  );
  assert.equal(
    object(await readJson(f.input.currentReceiptPath)).workerVersionId,
    deployment(2).workerVersionId,
  );
  assert.deepEqual(await regularBytes(f.input.originalCliPath), originalCli);
  assert.deepEqual(
    await inventory(f.root),
    before,
    "Retention validation must not mutate evidence",
  );
});

test("verify-existing authenticates original live ZIP644 while validating child600 copies and leaves both unchanged", async (t) => {
  const f = await fixture(t, "verify-existing");
  assert.ok(f.originalDirectory);
  const original = await inventory(f.originalDirectory);
  const all = await inventory(f.root);
  assert.ok(original.every((file) => file.mode === 0o644));
  for (const record of [f.points.input.before, f.points.input.after]) {
    assert.equal((await fs.stat(record.path)).mode & 0o777, 0o600);
    const retainedPath = resolve(
      f.originalDirectory,
      "claims/application-recovery",
      basename(record.path),
    );
    assert.deepEqual(await regularBytes(retainedPath), await regularBytes(record.path));
  }
  await validateRecoveryRetention(f.input);
  await assert.rejects(validateRecoveryRetention({ ...f.input, kind: "live" }));
  assert.equal(f.downloads(), 1, "Must authenticate actual ZIP, not serialized evidence alone");
  assert.deepEqual(f.input.child.deployments, [deployment(2)]);
  assert.deepEqual(await inventory(f.originalDirectory), original);
  assert.deepEqual(await inventory(f.root), all);
  assert.equal(
    object(await readJson(f.input.originalCliPath)).workerVersionId,
    deployment(1).workerVersionId,
  );
});

test("unlinked V1, changed proof digest and checkpoint drift cannot qualify either retention mode", async (t) => {
  for (const mode of ["perform", "verify-existing"] as const) {
    const f = await fixture(t, mode);
    const originalFacts = structuredClone(f.facts);
    const originalReceipt = await regularBytes(f.input.currentReceiptPath);
    f.input.deployment = deployment(3);
    f.facts.current = deployment(3);
    const unlinkedReceipt = await write(f.input.currentReceiptPath, {
      ...object(await readJson(f.input.originalCliPath)),
      workerVersionId: deployment(3).workerVersionId,
    });
    f.facts.currentReceiptSha256 = unlinkedReceipt.sha256;
    await write(f.input.factsPath, f.facts);
    await assert.rejects(validateRecoveryRetention(f.input));
    f.input.deployment = deployment(2);
    Object.assign(f.facts, originalFacts);
    await fs.writeFile(f.input.currentReceiptPath, originalReceipt);
    f.facts.proofSha256 = sha256("substituted combined proof");
    await write(f.input.factsPath, f.facts);
    await assert.rejects(validateRecoveryRetention(f.input));
    await write(f.input.factsPath, originalFacts);
    await write(f.points.input.after.path, { ...f.points.after, originalJobId: "substituted-job" });
    await assert.rejects(validateRecoveryRetention(f.input));
  }
});

test("forged original producer fails before reading original recovery payload or checkpoint copies", async (t) => {
  const f = await fixture(t, "verify-existing");
  assert.ok(f.originalDirectory);
  const before = await inventory(f.root);
  f.failProducer();
  const open = fs.open;
  const selected: string[] = [];
  const hook = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const path = String(args[0]);
    if (
      path.startsWith(resolve(f.originalDirectory ?? "", "claims")) ||
      path.startsWith(f.points.input.checkpointDirectory)
    )
      selected.push(path);
    return open(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      validateRecoveryRetention(f.input),
      (error: unknown) =>
        error instanceof assert.AssertionError &&
        error.actual === "failure" &&
        error.expected === "success",
    );
    assert.equal(f.downloads(), 0);
    assert.deepEqual(
      selected,
      [],
      "Producer failure must precede recovery payload reads/copy validation",
    );
  } finally {
    hook.mock.restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual(await inventory(f.root), before);
});

test("original artifact reference candidate digest must match the retained candidate before payload access", async (t) => {
  const f = await fixture(t, "verify-existing");
  const bundle = object(await readJson(f.input.proofsPath));
  assert.ok(Array.isArray(bundle.proofs));
  const artifact = object(object(bundle.proofs[0]).artifact);
  artifact.candidateSha256 = sha256("unrelated candidate reference");
  const facts = object(await readJson(f.input.factsPath));
  facts.evidence = artifact;
  await fs.writeFile(f.input.proofsPath, `${canonicalJson(bundle)}\n`);
  await write(f.input.factsPath, facts);
  await assert.rejects(
    validateRecoveryRetention(f.input).then(() => {
      t.diagnostic(
        JSON.stringify({
          accepted: true,
          downloads: f.downloads(),
          referenceCandidateSha256: artifact.candidateSha256,
          candidateSha256,
        }),
      );
    }),
    "Matching serialized references must not replace the authenticated candidate binding",
  );
  assert.equal(f.downloads(), 0);
});
async function write(path: string, value: unknown): Promise<FileRecord> {
  const bytes = Buffer.from(`${canonicalJson(value)}\n`);
  await fs.writeFile(path, bytes, { mode: 0o600 });
  return { path, size: bytes.length, mode: 0o600, sha256: sha256(bytes) };
}
async function checkpoints(directory: string) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const target = { kind: "executor" as const, executorId: "offline-executor", generation: 1 };
  const before: ApplicationRecoveryBefore = {
    schemaVersion: 1,
    candidateSha256,
    sourceCommit,
    deploymentId: deployment(1).deploymentId,
    workerVersionId: deployment(1).workerVersionId,
    capturedAt,
    agentId: "original-agent",
    conversationId: "original-conversation",
    requestId: "original-request",
    jobId: "original-job",
    admission: {
      operationId: "send-operation",
      taskId: "original-task",
      messageId: "original-message",
      revision: "r1",
      eventSeq: 1,
    },
    approval: {
      approvalId: "original-approval",
      jobId: "original-job",
      agentId: "original-agent",
      conversationId: "original-conversation",
      requestingPrincipalId: "original-principal",
      version: 1,
      state: "pending",
      operation: {
        operationId: "dispatch-operation",
        operationDigest: sha256("dispatch"),
        tool: "shell",
        arguments: { command: "echo seed1010-recovery-no-start" },
        workspaceId: "original-workspace",
        baseRevision: "r1",
        target,
        trust: "host",
        capabilities: ["shell"],
        policyVersion: 1,
        grantVersion: 1,
        expiresAt: 2000000000000,
      },
    },
    target,
    eventThrough: 3,
    eventPrefixSha256: sha256("original prefix"),
    snapshotSha256: sha256("snapshot"),
    workspace: {
      binding: {
        workspaceId: "original-workspace",
        bindingVersion: 1,
        config: { kind: "computer" },
        revision: "r1",
        manifestHash: sha256("manifest"),
        availability: "available",
      },
      files: [{ path: "canary.txt", size: 5, sha256: sha256("bytes") }],
    },
  };
  const beforeFile = await write(resolve(directory, "application-before.json"), before);
  const after: ApplicationRecoveryAfter = {
    schemaVersion: 1,
    candidateSha256,
    sourceCommit,
    beforeCheckpointSha256: beforeFile.sha256,
    workerVersionId: deployment(2).workerVersionId,
    originalTaskId: before.admission.taskId,
    originalJobId: before.jobId,
    originalReceiptRetained: true,
    originalEventPrefixSha256: before.eventPrefixSha256,
    actualWorkspaceHashes: structuredClone(before.workspace.files),
    continuation: "public-approval-rejection",
    taskState: "completed",
    executionIdentityAbsentBeforeAndAfter: true,
    checkedAt: capturedAt,
  };
  const provider: ApplicationRecoveryProviderResult = {
    transition: {
      schemaVersion: 1,
      phase: "provider-confirmed",
      operationId: "b".repeat(32),
      intentSha256: sha256("intent"),
      candidateSha256,
      beforeCheckpointSha256: beforeFile.sha256,
      before: deployment(1),
      after: deployment(2),
      requestedStrategy: "immediate",
      strategyReadBack: false,
      reset: "inferred-from-provider-contract",
      incarnation: "not-observed",
      eviction: "not-observed",
      physicalHostLoss: "not-observed",
      requiresApplicationVerification: true,
    },
    transitionSha256: "",
    current: deployment(2),
  };
  provider.transitionSha256 = sha256(`${canonicalJson(provider.transition)}\n`);
  const input = {
    checkpointDirectory: directory,
    candidateSha256,
    sourceCommit,
    before: beforeFile,
    after: await write(resolve(directory, "application-after.json"), after),
    provider,
  };
  return {
    input,
    before,
    after,
    async saveAfter() {
      input.after = await write(input.after.path, after);
    },
  };
}
