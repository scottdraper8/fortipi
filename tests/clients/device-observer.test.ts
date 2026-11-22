import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import {
  type AdmissionReceipt,
  type CommitReceipt,
  canonicalJson,
  type DurableEvent,
  type ExecutionIdentity,
  type Job,
  type Manifest,
  type Protocol,
  type TicketReceipt,
} from "../../packages/fortipi-contract/dist/index.js";
import type { DeploymentIdentity } from "../../scripts/verify-release-gates.ts";
import {
  assertDeviceEvidenceData,
  type DeviceEvidenceData,
  observeDeviceContinuation,
} from "./device-observer.ts";
import {
  type DeviceContinuityA,
  type DevicePhaseCompletion,
  type DeviceReadClient,
  deviceSeedBytes,
} from "./live-device.ts";

const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const credential = (credentialId: string) => ({ credentialId, generation: 1, grantVersion: 1 });
function controlledHistory() {
  // Entirely controlled public-data/read-port fixture. It authenticates no
  // artifact/host/provider and never produces a GateReceipt or real deployment.
  const initial: DeploymentIdentity = {
    schemaVersion: 1,
    sourceCommit: "a".repeat(40),
    candidateSha256: hash("candidate"),
    accountBindingSha256: hash("account"),
    origin: "https://example.invalid",
    workerName: "fixture",
    slot: "production",
    workerVersionId: "worker-v0",
    deploymentId: "provider-v0",
    versions: [{ versionId: "worker-v0", percentage: 100 }],
    configSha256: hash("config"),
    runtimeConfigSha256: hash("runtime"),
    assetManifestSha256: hash("assets"),
    publicConfigurationVersion: 1,
    capabilities: { plan: "free", loaders: false, containers: false },
    backend: "free",
    imageDigest: null,
    checkedAt: "2026-11-12T00:00:00.000Z",
  };
  const current = {
    ...initial,
    deploymentId: "provider-v1",
    workerVersionId: "worker-v1",
    versions: [{ versionId: "worker-v1", percentage: 100 }],
  };
  const fresh = credential("new-read-principal"),
    shared = credential("original-client");
  const payloads = ["old-v1", "R1-on-A", "R2-on-B"].map((note) => ({
    ...deviceSeedBytes(),
    "notes.txt": Buffer.from(`${note}\n`),
  }));
  const manifests: Manifest[] = payloads.map((files) => ({
    version: 1,
    entries: Object.entries(files)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, bytes]) => ({
        path,
        size: bytes.length,
        sha256: hash(bytes),
        type: "file",
        mode: 420,
      })),
  }));
  const workspaces = manifests.map((manifest, i) => ({
    binding: {
      workspaceId: "workspace",
      bindingVersion: 1,
      config: { kind: "computer" as const },
      revision: `r${i}`,
      manifestHash: hash(`fortipi:manifest:v1\n${canonicalJson(manifest)}`),
      availability: "available" as const,
    },
    files: manifest.entries.map((entry) => {
      assert.equal(entry.type, "file");
      if (entry.type !== "file") throw Error("file fixture");
      return { path: entry.path, size: entry.size, sha256: entry.sha256 };
    }),
  }));
  const events: DurableEvent[] = [1, 2].map((eventSeq) => ({
    protocolVersion: "1.0",
    schemaVersion: "1.0.0",
    deploymentId: "logical-control",
    conversationId: "conversation",
    eventId: `event-${eventSeq}`,
    timestamp: eventSeq,
    eventSeq,
    durability: "durable",
    type: "fixture.unknown-committed",
    payload: { sequence: eventSeq },
  }));
  const jobs = new Map<string, Job>();
  function phase(name: "a" | "b", index: number): DevicePhaseCompletion {
    const base = workspaces[index]!,
      workspace = workspaces[index + 1]!;
    const lease = {
      ownerKind: "job" as const,
      leaseId: `lease-${name}`,
      operationId: `operation-${name}`,
      credential: credential(`executor-${name}`),
      registrationId: `registration-${name}`,
      leaseVersion: 1,
      workspaceId: "workspace",
      executorId: `executor-${name}`,
      executorGeneration: 1,
      fence: String(index + 2),
      baseRevision: base.binding.revision,
      expiresAt: 2000000000000,
      jobId: `job-${name}`,
    };
    const execution: ExecutionIdentity = {
      jobId: `job-${name}`,
      executionId: `execution-${name}`,
      operationDigest: hash(`operation-${name}`),
      assignmentDigest: hash(`assignment-${name}`),
      baseRevision: base.binding.revision,
      target: { kind: "executor", executorId: `executor-${name}`, generation: 1 },
      deadline: 2000000000000,
      lease,
    };
    const receipt: CommitReceipt = {
      commitId: `commit-${name}`,
      jobId: `job-${name}`,
      operationId: lease.operationId,
      workspaceId: "workspace",
      commitDigest: hash(`commit-${name}`),
      baseRevision: base.binding.revision,
      revision: workspace.binding.revision,
      manifestHash: workspace.binding.manifestHash,
      sourceFactId: `fact-${name}`,
      committedAt: 1,
      providerKind: "computer",
      storeRef: { stageId: `stage-${name}` },
    };
    jobs.set(`job-${name}`, {
      jobId: `job-${name}`,
      agentId: "agent",
      conversationId: "conversation",
      taskId: `task-${name}`,
      operationDigest: execution.operationDigest,
      workspaceId: "workspace",
      baseRevision: base.binding.revision,
      state: "completed",
      version: 1,
      execution,
      preparedResult: {
        identity: execution,
        sequence: 1,
        state: "succeeded",
        commitId: receipt.commitId,
        manifestHash: receipt.manifestHash,
        output: { tail: "", artifacts: [], truncated: false },
        possibleExternalEffects: true,
      },
      evidence: { kind: "committed", receipt },
    });
    const admission: AdmissionReceipt = {
      operationId: `admission-${name}`,
      messageId: `message-${name}`,
      taskId: `task-${name}`,
      revision: `conversation-${name}`,
      eventSeq: index + 1,
    };
    return {
      workspace,
      admission,
      requestId:
        name === "a"
          ? "00000000-0000-4000-8000-000000000001"
          : "00000000-0000-4000-8000-000000000002",
      promptSha256: hash(`prompt-${name}`),
      jobId: `job-${name}`,
      executionId: `execution-${name}`,
      receiptSha256: hash(canonicalJson(receipt)),
      oldLease: lease,
      eventThrough: index + 1,
      eventPrefixSha256: hash(canonicalJson(events.slice(0, index + 1))),
    };
  }
  const a: DeviceContinuityA = {
    schemaVersion: 1,
    phase: "a",
    sourceCommit: initial.sourceCommit,
    candidateSha256: initial.candidateSha256,
    deploymentId: initial.deploymentId,
    workerVersionId: initial.workerVersionId,
    logicalApplicationId: "logical-control",
    host: { runId: 10, runAttempt: 1, jobId: 11, runnerId: 111, bootSha256: hash("boot-a") },
    agentId: "agent",
    conversationId: "conversation",
    executor: { executorId: "executor-a", generation: 1 },
    clientCredential: shared,
    initialWorkspace: workspaces[0]!,
    ...phase("a", 0),
    localRootSha256: hash("root-a"),
    retirementId: "retire-a",
    revocationId: "revoke-a",
  };
  const replacement = phase("b", 1);
  const ref = (artifactId: number) => ({
    runId: 10,
    runAttempt: 1,
    artifactId,
    artifactName: `device-${artifactId}`,
    artifactDigest: `sha256:${hash(String(artifactId))}`,
    candidateSha256: initial.candidateSha256,
  });
  const data: DeviceEvidenceData = {
    schemaVersion: 1,
    initial: {
      deployment: initial,
      seed: {
        agentId: "agent",
        conversationId: "conversation",
        workspace: workspaces[0]!,
        a: a.executor,
        b: { executorId: "executor-b", generation: 1 },
      },
    },
    a,
    b: {
      phase: "b",
      sourceCommit: a.sourceCommit,
      candidateSha256: a.candidateSha256,
      deploymentId: a.deploymentId,
      workerVersionId: a.workerVersionId,
      hosts: [a.host, { ...a.host, jobId: 12, runnerId: 112, bootSha256: hash("boot-b") }],
      originalAdmission: a.admission,
      originalJobId: a.jobId,
      originalExecutionId: a.executionId,
      originalReceiptSha256: a.receiptSha256,
      originalEventPrefixSha256: a.eventPrefixSha256,
      originalWorkspace: a.workspace,
      replacement,
      staleLease: {
        status: 409,
        code: "workspace.conflict",
        leaseId: a.oldLease.leaseId,
        operationId: a.oldLease.operationId,
        jobId: a.jobId,
        fence: a.oldLease.fence,
        expiresAt: a.oldLease.expiresAt,
        originalBaseRevision: a.oldLease.baseRevision,
        currentRevision: replacement.workspace.binding.revision,
        positiveControl: {
          leaseId: "positive-lease",
          uploadId: "positive-upload",
          aborted: true,
          released: true,
          abortConfirmation: "acknowledged",
        },
        limitation: "composite",
      },
      retirementId: "retire-b",
      revocationId: "revoke-b",
      originalStarts: 1,
      replacementStarts: 1,
      aRootAbsentBeforeB: true,
      bMaterializedOriginalHashes: true,
      physicalHostLoss: "not-observed",
    },
    cleanup: [shared, a.oldLease.credential, replacement.oldLease.credential].map((ref) => ({
      credential: ref,
      requestId: `revoke-${ref.credentialId}`,
      receipt: {
        operationId: `operation-${ref.credentialId}`,
        revocationId: `revocation-${ref.credentialId}`,
        state: "complete",
        pendingRecipients: [],
      },
    })),
    references: { initial: ref(1), a: ref(2), b: ref(3), cleanup: ref(4) },
  };
  const calls: string[] = [];
  let foreignReceipt = false,
    corruptBytes = false,
    corruptPrefix = false,
    wrongLogical = false;
  const client: DeviceReadClient = {
    // Only these read/ticket methods exist; no admission/executor/upload port.
    negotiate: async () => {
      calls.push("negotiate");
      return { deploymentId: wrongLogical ? "wrong-logical" : "logical-control" } as Protocol;
    },
    tickets: {
      mint: async () => {
        calls.push("read-ticket");
        return {
          ticket: "synthetic-unused-read-ticket",
          audience: "client-stream",
          expiresAt: 2000000000000,
          identity: {
            role: "client",
            principalId: "new-read-principal",
            credential: fresh,
            deploymentId: "logical-control",
            credentialExpiresAt: 2000000000000,
          },
        } satisfies TicketReceipt;
      },
    },
    conversations: {
      get: async () => {
        calls.push("conversation-read");
        return {
          conversation: {
            conversationId: "conversation",
            agentId: "agent",
            title: "fixture",
            revision: "conversation-b",
            createdAt: 1,
            taskState: { state: "completed" },
          },
          messages: [],
          projectionRevision: "projection",
          lastEventSeq: 2,
          retainedFloor: 1,
        };
      },
      events: async (_id, query) => {
        calls.push("event-read");
        const copy = structuredClone(events);
        if (corruptPrefix) copy[0]!.eventId = "changed";
        return {
          after: query.after ?? 0,
          nextAfter: 2,
          through: 2,
          lastEventSeq: 2,
          retainedFloor: 1,
          hasMore: false,
          events: copy.filter((event) => event.eventSeq > (query.after ?? 0)),
        };
      },
    },
    tasks: {
      get: async (taskId) => {
        calls.push("task-read");
        return {
          taskId,
          conversationId: "conversation",
          version: 1,
          status: { state: "completed" },
        };
      },
    },
    jobs: {
      get: async (jobId) => {
        calls.push("job-read");
        const job = structuredClone(jobs.get(jobId)!);
        if (foreignReceipt && job.state === "completed" && job.evidence.kind === "committed")
          job.evidence.receipt.workspaceId = "foreign-workspace";
        return job;
      },
    },
    workspaces: {
      get: async () => {
        calls.push("binding-read");
        return workspaces[2]!.binding;
      },
      manifest: async (_id, query) => {
        calls.push("manifest-read");
        const i = Number(query.revision.slice(1));
        return { ...workspaces[i]!.binding, manifest: manifests[i]! };
      },
      read: async (_id, query) => {
        calls.push("byte-read");
        const i = Number(query.revision.slice(1)),
          bytes = Buffer.from(payloads[i]![query.path as keyof ReturnType<typeof deviceSeedBytes>]);
        if (corruptBytes) bytes[0] = (bytes[0] ?? 0) ^ 1;
        return bytes;
      },
    },
  };
  return {
    data,
    current,
    fresh,
    client,
    calls,
    setFault(value: string) {
      foreignReceipt = value === "receipt";
      corruptBytes = value === "bytes";
      corruptPrefix = value === "prefix";
      wrongLogical = value === "logical";
    },
  };
}

test("original device continuation uses a new read principal and rejects changed historical facts without repeating effects", async () => {
  const fixture = controlledHistory(),
    before = canonicalJson(fixture.data);
  const invoke = () =>
    observeDeviceContinuation({
      client: fixture.client,
      devices: fixture.data,
      deployment: fixture.current,
      credential: fixture.fresh,
    });
  const result = await invoke();
  assert.equal(canonicalJson(fixture.data), before);
  assert.equal(result.observation.historicalProviderDeploymentId, "provider-v0");
  assert.equal(result.observation.currentProviderDeploymentId, "provider-v1");
  assert.equal(result.observation.freshReplacement, false);
  assert.equal(result.observation.freshInterruption, false);
  assert.equal(result.observation.physicalHostLoss, "not-observed");
  assert.ok(
    !("send" in fixture.client.conversations) &&
      !("uploads" in fixture.client) &&
      !("executors" in fixture.client),
  );
  for (const fault of ["receipt", "bytes", "prefix", "logical"]) {
    fixture.setFault(fault);
    await assert.rejects(invoke);
  }
  fixture.setFault("");
  const beforeOldPrincipal = fixture.calls.length;
  await assert.rejects(() =>
    observeDeviceContinuation({
      client: fixture.client,
      devices: fixture.data,
      deployment: fixture.current,
      credential: fixture.data.a.clientCredential,
    }),
  );
  assert.equal(
    fixture.calls.length,
    beforeOldPrincipal,
    "Revoked historical credentials cannot be reused for current reads",
  );
  for (const fault of ["candidate", "source", "pending", "unknown"]) {
    const data = structuredClone(fixture.data);
    if (fault === "candidate") data.references.a.candidateSha256 = hash("foreign-candidate");
    if (fault === "source") data.a.sourceCommit = "b".repeat(40);
    if (fault === "pending")
      data.cleanup[0]!.receipt = {
        operationId: "pending",
        revocationId: "pending",
        state: "pending",
        pendingRecipients: [{ kind: "workspace", id: "workspace" }],
      };
    if (fault === "unknown") data.cleanup[0]!.receipt = null as never;
    const count = fixture.calls.length;
    await assert.rejects(() =>
      observeDeviceContinuation({
        client: fixture.client,
        devices: data,
        deployment: fixture.current,
        credential: fixture.fresh,
      }),
    );
    assert.equal(fixture.calls.length, count, "Invalid history/cleanup must block before reads");
  }
  assertDeviceEvidenceData(fixture.data, fixture.current);
});

test("device jobs projection permits only bound metadata pages and rejects archive capability or another attempt", async () => {
  const source = await readFile(new URL("./live-device.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function host("),
    end = source.indexOf("\nasync function prefix(", start);
  assert.ok(start >= 0 && end > start);
  const invoke = new Function(
    "assert",
    "process",
    "readFile",
    "hash",
    "input",
    `${stripTypeScriptTypes(source.slice(start, end))}\nreturn host(input,'a');`,
  );
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "scottdraper8/fortipi",
    GITHUB_REPOSITORY_ID: "1453249080",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_JOB: "live-device-a",
    RUNNER_ENVIRONMENT: "github-hosted",
    RUNNER_OS: "Linux",
    RUNNER_NAME: "runner",
    GITHUB_RUN_ID: "10",
    GITHUB_RUN_ATTEMPT: "1",
  };
  const pages: number[] = [];
  const context = {
    candidateSha256: hash("candidate"),
    runId: 10,
    runAttempt: 1,
    readJobs: async (page: number) => {
      pages.push(page);
      return {
        total_count: 1,
        jobs: [
          {
            id: 11,
            name: "live-device-a",
            run_id: 10,
            head_sha: env.GITHUB_SHA,
            status: "in_progress",
            conclusion: null,
            runner_name: "runner",
            runner_id: 111,
            labels: ["ubuntu-24.04"],
          },
        ],
      };
    },
  };
  const input = {
    context,
    installed: { hash: context.candidateSha256, candidate: { sourceCommit: env.GITHUB_SHA } },
  };
  // Simulated eligibility/boot metadata proves this source port only, never a
  // Linux/GHA host. Actual OS is neither changed nor granted fixture permission.
  await invoke(
    assert,
    { platform: "linux", env },
    async () => "00000000-0000-4000-8000-000000000001",
    hash,
    input,
  );
  assert.deepEqual(pages, [1]);
  const count = pages.length;
  await assert.rejects(() =>
    invoke(assert, { platform: "linux", env }, async () => "unused", hash, {
      ...input,
      context: {
        ...context,
        request: () => {
          throw Error("archive callback must not be used");
        },
      },
    }),
  );
  await assert.rejects(() =>
    invoke(assert, { platform: "linux", env }, async () => "unused", hash, {
      ...input,
      context: { ...context, runAttempt: 2 },
    }),
  );
  assert.equal(pages.length, count);
});
