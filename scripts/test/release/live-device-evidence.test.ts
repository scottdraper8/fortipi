// Coordinator protocol only: Installed/source/artifact/provider/continuation ports
// are controlled. Real coordinator, allocation, filesystem journals, role routing,
// canonical inventories and AES-GCM custody run. No GHA/CF/installed/native proof.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { mock, test } from "node:test";
import { promisify } from "node:util";
import type {
  CredentialMint,
  CredentialRef,
} from "../../../packages/fortipi-contract/dist/index.js";
import * as observer from "../../../tests/clients/device-observer.ts";
import * as device from "../../../tests/clients/live-device.ts";
import type { IssuedRole, RoleContext } from "../../../tests/clients/roles.ts";
import type { Installed } from "../../../tests/distribution/install.ts";
import type {
  CurrentDeviceJobContext,
  DevicePhase,
  DevicePhaseArtifact,
  DevicePhaseReadInput,
} from "../../device-phase-artifacts.ts";
import type { LiveDeviceOwnership } from "../../live-device-allocation.ts";
import type {
  LiveDeviceCustodyEnvelope,
  LiveDeviceCustodyFrame,
} from "../../live-device-custody.ts";
import { openLiveDeviceRole } from "../../live-device-custody.ts";
import { childEnvironment } from "../../prepare-release.ts";
import * as gates from "../../verify-release-gates.ts";
import { candidate, temporary } from "./fixtures.ts";

const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const copy = <T>(value: T): T => structuredClone(value);
const encoded = (value: unknown) => Buffer.from(`${gates.canonicalJson(value)}\n`);
const bytesRecord = (path: string, bytes: Buffer) => ({
  path,
  mode: 0o600,
  size: bytes.length,
  sha256: hash(bytes),
});
const account = "a".repeat(32);
const admin = "synthetic-device-admin-1010".repeat(3);
const providerToken = "synthetic-provider-only-canary";
const origin = "https://device-coordinator.invalid";
const worker0 = "11111111-1111-4111-8111-111111111111";
const worker1 = "22222222-2222-4222-8222-222222222222";
const deployment0 = "33333333-3333-4333-8333-333333333333";
const deployment1 = "44444444-4444-4444-8444-444444444444";
const jobNames = {
  initial: "initial-installed-deployment",
  a: "live-device-a",
  b: "live-device-b",
  cleanup: "live-device-cleanup",
  operate: "operate",
} as const;

function workspace(note: string, revision: string) {
  const multi = Buffer.alloc(2 * 1024 * 1024);
  for (let i = 0; i < multi.length; i++) multi[i] = (1010 + i * 31) % 256;
  const files = Object.entries({
    "notes.txt": Buffer.from(`${note}\n`),
    "binary.bin": Buffer.from([0, 255, 13, 10, 128, 1]),
    "multi.bin": multi,
  })
    .map(([path, bytes]) => ({ path, size: bytes.length, sha256: hash(bytes) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return {
    binding: {
      workspaceId: "workspace",
      bindingVersion: 1,
      config: { kind: "computer" as const },
      revision,
      manifestHash: hash(
        `fortipi:manifest:v1\n${gates.canonicalJson({ version: 1, entries: files.map((file) => ({ ...file, type: "file", mode: 420 })) })}`,
      ),
      availability: "available" as const,
    },
    files,
  };
}

function observations(
  seed: device.DeviceContinuitySeed,
  deployment: gates.DeploymentIdentity,
  client: CredentialRef,
  aRole: CredentialRef,
  bRole: CredentialRef,
  runId: number,
) {
  const phase = (
    name: "a" | "b",
    ref: CredentialRef,
    baseRevision: string,
    workspaceNote: string,
    revision: string,
  ) => ({
    workspace: workspace(workspaceNote, revision),
    admission: {
      operationId: `admission-${name}`,
      messageId: `message-${name}`,
      taskId: `task-${name}`,
      revision: `conversation-${name}`,
      eventSeq: name === "a" ? 1 : 2,
    },
    requestId:
      name === "a"
        ? ("00000000-0000-4000-8000-000000000001" as const)
        : ("00000000-0000-4000-8000-000000000002" as const),
    promptSha256: hash(`prompt-${name}`),
    jobId: `job-${name}`,
    executionId: `execution-${name}`,
    receiptSha256: hash(`receipt-${name}`),
    eventThrough: name === "a" ? 1 : 2,
    eventPrefixSha256: hash(`prefix-${name}`),
    oldLease: {
      ownerKind: "job" as const,
      leaseId: `lease-${name}`,
      operationId: `operation-${name}`,
      credential: ref,
      registrationId: `registration-${name}`,
      leaseVersion: 1,
      workspaceId: "workspace",
      executorId: seed[name].executorId,
      executorGeneration: 1,
      fence: name === "a" ? "2" : "3",
      baseRevision,
      expiresAt: Date.now() + 3600000,
      jobId: `job-${name}`,
    },
  });
  const a: device.DeviceContinuityA = {
    schemaVersion: 1,
    phase: "a",
    sourceCommit: deployment.sourceCommit,
    candidateSha256: deployment.candidateSha256,
    deploymentId: deployment.deploymentId,
    workerVersionId: deployment.workerVersionId,
    logicalApplicationId: "logical-application",
    host: { runId, runAttempt: 1, jobId: 12, runnerId: 112, bootSha256: hash("boot-a") },
    agentId: seed.agentId,
    conversationId: seed.conversationId,
    executor: seed.a,
    clientCredential: client,
    initialWorkspace: seed.workspace,
    ...phase("a", aRole, "r0", "R1-on-A", "r1"),
    localRootSha256: hash("root-a"),
    retirementId: "retire-a",
    revocationId: "revoke-a",
  };
  const replacement = phase("b", bRole, "r1", "R2-on-B", "r2");
  const b: device.DeviceContinuityBObservation = {
    phase: "b",
    sourceCommit: a.sourceCommit,
    candidateSha256: a.candidateSha256,
    deploymentId: a.deploymentId,
    workerVersionId: a.workerVersionId,
    hosts: [a.host, { ...a.host, jobId: 13, runnerId: 113, bootSha256: hash("boot-b") }],
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
      fence: a.oldLease.fence,
      jobId: a.jobId,
      operationId: a.oldLease.operationId,
      expiresAt: a.oldLease.expiresAt,
      originalBaseRevision: "r0",
      currentRevision: "r2",
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
  };
  return { a, b };
}

async function controlled(which: string) {
  const root = await temporary("fortipi-device-coordinator-");
  const originalEnvironment = process.env;
  const originalFetch = globalThis.fetch;
  const c = candidate(),
    candidateHash = hash(encoded(c));
  const operator = { deployment: { name: "device-test", origin } };
  const target = {
    schemaVersion: 1 as const,
    accountBindingSha256: hash(account),
    backend: "free" as const,
    operator,
  };
  const v0: gates.DeploymentIdentity = {
    schemaVersion: 1,
    sourceCommit: c.sourceCommit,
    candidateSha256: candidateHash,
    accountBindingSha256: hash(account),
    origin,
    workerName: "device-test",
    slot: "production",
    deploymentId: deployment0,
    workerVersionId: worker0,
    versions: [{ versionId: worker0, percentage: 100 }],
    configSha256: hash("config"),
    runtimeConfigSha256: hash("runtime"),
    assetManifestSha256: c.assetManifestSha256,
    publicConfigurationVersion: 1,
    capabilities: { plan: "free", loaders: false, containers: false },
    backend: "free",
    imageDigest: null,
    checkedAt: new Date().toISOString(),
  };
  const v1 = {
    ...v0,
    deploymentId: deployment1,
    workerVersionId: worker1,
    versions: [{ versionId: worker1, percentage: 100 }],
  };
  const cli = {
    workerName: "device-test",
    origin,
    targets: [origin],
    workerVersionId: worker0,
    sourceCommit: c.sourceCommit,
    assetManifestSha256: c.assetManifestSha256,
    backend: "free",
    imageDigest: null,
  };
  const events: string[] = [];
  const artifacts = new Map<number, DevicePhaseArtifact>();
  const references = new Map<string, gates.ArtifactReference>();
  const records = new Map<number, { bytes: Buffer; reference: gates.ArtifactReference }>();
  const issued = new Map<string, IssuedRole>();
  const mintRequests: CredentialMint[] = [];
  const revokeRequests: { requestId: string; credential: CredentialRef }[] = [];
  let runId = 101,
    job: CurrentDeviceJobContext["job"] = "initial",
    operation: "deploy" | "verify" = "deploy",
    current = v0;
  let out = resolve(root, "perform"),
    journalPath = resolve(out, "ownership/ownership.json"),
    protectedReads = 0,
    auth = true,
    artifactAuth = true,
    authSerial = 0,
    keySerial = 0,
    rejectReplacement = false,
    replacementRejected = false;
  let mintFault = "",
    pendingCleanup = false,
    failedB = false,
    initialConclusion = "success",
    cipherSwap = false;
  let seed: device.DeviceContinuitySeed,
    publicObservations: ReturnType<typeof observations>,
    historical: observer.DeviceEvidenceData | undefined;
  let sideEffects = 0,
    readonlyCalls = 0,
    nextArtifact = 1000;
  let originalGate: { bytes: Buffer; reference: gates.ArtifactReference; at: number } | undefined;
  const context = (): CurrentDeviceJobContext => ({
    job,
    operation,
    runId,
    runAttempt: 1,
    repository: gates.REPOSITORY,
    repositoryId: gates.REPOSITORY_ID,
    sourceCommit: c.sourceCommit,
    ref: "refs/heads/main",
    event: "workflow_dispatch",
    workflowRef: `${gates.REPOSITORY}/.github/workflows/deploy.yml@refs/heads/main`,
    runnerName: `runner-${job}`,
    runnerEnvironment: "github-hosted",
    runnerOs: "Linux",
  });
  const producer = () => ({
    workflowPath: ".github/workflows/deploy.yml",
    workflowSha256: hash("controlled workflow"),
    workflowId: 1,
    runId,
    runAttempt: 1,
  });
  const reference = (prefix: string, bytes: Buffer) => ({
    runId,
    runAttempt: 1,
    artifactId: ++nextArtifact,
    artifactName: `${prefix}-${c.sourceCommit}-${c.scope}-${runId}-1`,
    artifactDigest: `sha256:${hash(bytes)}`,
    candidateSha256: candidateHash,
  });
  const protectedKeys = new Set([
    "FORTIPI_ADMIN_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_API_TOKEN",
  ]);
  const syntheticEnvironment = {
    PATH: originalEnvironment.PATH,
    LANG: "C.UTF-8",
    GITHUB_TOKEN: "synthetic-gh-read-only",
    FORTIPI_ADMIN_TOKEN: admin,
    CLOUDFLARE_ACCOUNT_ID: account,
    CLOUDFLARE_API_TOKEN: providerToken,
  };
  process.env = new Proxy(syntheticEnvironment, {
    get(env, key: string) {
      if (protectedKeys.has(key)) {
        protectedReads++;
        assert.ok(authSerial > keySerial, "Source authority must be refreshed before key lookup");
        events.push(`key:${key}`);
      }
      return Reflect.get(env, key);
    },
  });
  const stable = ({ checkedAt: _time, ...value }: gates.DeploymentIdentity) => value;
  const installed = {
    candidate: c,
    hash: candidateHash,
    prepared: resolve(root, "prepared"),
    async verifyUnchanged() {
      events.push("installed-rechecked");
    },
    resolveExport(name: string) {
      assert.equal(name, `@${c.scope}/fortipi-client/node`);
      return resolve(import.meta.dirname, "../../../packages/fortipi-client/dist/node.js");
    },
  } as unknown as Installed;
  const authority = async (input: {
    loaded: { candidate: gates.CandidateManifest; hash: string };
    context: CurrentDeviceJobContext;
  }) => {
    events.push(`authorize:${job}`);
    assert.ok(auth, "Controlled source/attempt refusal");
    assert.equal(input.loaded.hash, candidateHash);
    assert.deepEqual(input.context, context());
    authSerial++;
    return {
      producer: producer(),
      checkedAt: new Date().toISOString(),
      job: {
        id:
          job === "initial"
            ? 11
            : job === "a"
              ? 12
              : job === "b"
                ? 13
                : job === "cleanup"
                  ? 14
                  : 15,
        name: jobNames[job],
        runnerId: 111,
        runnerName: `runner-${job}`,
        labels: ["ubuntu-24.04"],
        startedAt: new Date().toISOString(),
        completedAt: null,
      },
    };
  };
  const find = (ref: gates.ArtifactReference) => {
    const phase = artifacts.get(ref.artifactId);
    assert.ok(phase, "No fixture phase exists");
    assert.deepEqual(ref, phase.reference);
    return phase;
  };
  const readPhase = async (input: DevicePhaseReadInput) => {
    assert.ok(artifactAuth, "Controlled producer/ZIP refusal");
    const phase = find(input.reference);
    assert.equal(input.loaded.hash, candidateHash);
    assert.equal(input.phase, phase.metadata.phase);
    assert.equal(input.mode, phase.metadata.mode);
    assert.deepEqual(stable(input.deployment), stable(phase.metadata.deployment));
    if (input.context.mode === "current") assert.equal(input.reference.runId, runId);
    else assert.equal(input.reference.runId, 101);
    const actualLinks = Object.fromEntries(
      ["initial", "a", "b"]
        .filter((key) => Object.hasOwn(phase.metadata, `${key}Reference`))
        .map((key) => [key, Reflect.get(phase.metadata, `${key}Reference`)]),
    );
    assert.deepEqual(input.expectedLinks, actualLinks);
    events.push(`phase-auth:${input.context.mode}:${input.phase}`);
    return copy(phase);
  };
  const request = Object.assign(
    async (path: string) => {
      const original = originalGate;
      if (original && operation === "verify") {
        const base = `/repos/${gates.REPOSITORY}`;
        if (path === `${base}/actions/workflows/1`)
          return { id: 1, path: ".github/workflows/deploy.yml", state: "active" };
        if (path === `${base}/actions/runs/101` || path === `${base}/actions/runs/101/attempts/1`)
          return {
            id: 101,
            run_attempt: 1,
            workflow_id: 1,
            head_sha: c.sourceCommit,
            head_branch: "main",
            event: "workflow_dispatch",
            path: ".github/workflows/deploy.yml",
            repository: { id: gates.REPOSITORY_ID },
            head_repository: { id: gates.REPOSITORY_ID },
            status: "completed",
            conclusion: "success",
            run_started_at: new Date(original.at - 100000).toISOString(),
            updated_at: new Date(original.at).toISOString(),
          };
        if (path.includes("/contents/.github/workflows/deploy.yml?ref="))
          return {
            encoding: "base64",
            content: Buffer.from("controlled workflow").toString("base64"),
          };
        if (path.includes("/actions/runs/101/attempts/1/jobs?"))
          return {
            total_count: 5,
            jobs: Object.values(jobNames).map((name, i) => ({
              id: i + 1,
              name,
              status: "completed",
              conclusion: "success",
              started_at: new Date(original.at - 100000).toISOString(),
              completed_at: new Date(original.at).toISOString(),
            })),
          };
        if (path === `${base}/actions/artifacts/${original.reference.artifactId}`)
          return {
            name: original.reference.artifactName,
            digest: original.reference.artifactDigest,
            expired: false,
            workflow_run: {
              id: 101,
              repository_id: gates.REPOSITORY_ID,
              head_repository_id: gates.REPOSITORY_ID,
              head_sha: c.sourceCommit,
              head_branch: "main",
            },
            created_at: new Date(original.at - 1000).toISOString(),
            expires_at: new Date(original.at + 3600000).toISOString(),
          };
      }
      assert.ok(path.includes(`/actions/runs/${runId}/`));
      if (path.includes("/artifacts?")) {
        const values = [...references.values()].filter((ref) => ref.runId === runId);
        return {
          total_count: values.length,
          artifacts: values.map((ref) => ({
            id: ref.artifactId,
            name: ref.artifactName,
            digest: ref.artifactDigest,
            expired: false,
          })),
        };
      }
      assert.ok(path.includes("/jobs?"));
      return {
        total_count: 1,
        jobs: [
          {
            id: 12,
            name: jobNames[job],
            run_id: runId,
            head_sha: c.sourceCommit,
            status: "in_progress",
            conclusion: null,
            runner_name: "synthetic-runner",
            runner_id: 12,
            labels: ["ubuntu-24.04"],
          },
        ],
      };
    },
    {
      async verifyArtifact(ref: gates.ArtifactReference, member?: string) {
        if (member === "gate.json") {
          assert.ok(artifactAuth && originalGate);
          assert.deepEqual(ref, originalGate.reference);
          events.push("original-live-producer");
          return Buffer.from(originalGate.bytes);
        }
        assert.equal(member, "deployment.json");
        const phase = find(ref);
        return Buffer.from(phase.payloads["deployment.json"]?.base64 ?? "", "base64");
      },
      async verifyArtifactMembers(
        ref: gates.ArtifactReference,
        bounds: Readonly<Record<string, number>>,
      ) {
        assert.deepEqual(bounds, { "custody.json": 65536 });
        const row = records.get(ref.artifactId);
        assert.ok(row);
        assert.deepEqual(row.reference, ref);
        return { names: ["custody.json"], members: { "custody.json": Buffer.from(row.bytes) } };
      },
    },
  );

  // Installation/authority/provider seams are deliberate substitutions. They
  // cannot establish real candidate, API/ZIP, prepared package or CF identity.
  mock.module(new URL("../../live-device-installation.ts", import.meta.url), {
    exports: {
      async loadLiveDeviceInstallation() {
        events.push("installed-loaded");
        return { installed, target, candidatePath: resolve(root, "candidate.json") };
      },
      async installLiveDeviceCandidate() {
        throw Error("Installation is outside this test");
      },
    },
  });
  mock.module(new URL("../../../packages/fortipi-cli/dist/assets.js", import.meta.url), {
    exports: {
      async verifyPrepared(path: string) {
        assert.equal(path, installed.prepared);
        events.push("prepared-rechecked");
        return {
          sourceCommit: c.sourceCommit,
          assetManifestSha256: c.assetManifestSha256,
          operator,
        };
      },
    },
  });
  mock.module(new URL("../../verify-release-gates.ts", import.meta.url), {
    cache: true,
    exports: {
      ...gates,
      githubRequest: () => request,
    },
  });
  mock.module(new URL("../../device-phase-artifacts.ts", import.meta.url), {
    exports: {
      currentDeviceJobContext: context,
      authorizeCurrentDeviceJob: authority,
      readDevicePhaseArtifact: readPhase,
      deviceTargetIdentitySha256: (value: gates.DeploymentIdentity) =>
        hash(gates.canonicalJson(stable(value))),
      async readDeviceCustodyArtifact(input: DevicePhaseReadInput) {
        assert.ok(artifactAuth);
        assert.equal(input.context.mode, "current");
        assert.equal(input.reference.runId, runId);
        assert.equal(input.mode, operation === "deploy" ? "perform" : "verify-existing");
        const custody = find(input.reference).metadata.custody;
        assert.ok(custody);
        const row = records.get(custody.reference.artifactId);
        assert.ok(row);
        assert.equal(row.reference.runId, runId);
        const document = JSON.parse(row.bytes.toString("utf8"));
        if (cipherSwap) document.roles.a = document.roles.b;
        events.push(`custody-auth:${runId}`);
        return {
          reference: row.reference,
          record: custody.record,
          base64: encoded(document).toString("base64"),
        };
      },
      async readDeviceOwnershipArtifact(input: {
        reference: gates.ArtifactReference;
        context: CurrentDeviceJobContext;
      }) {
        assert.ok(artifactAuth);
        assert.equal(input.context.job, "cleanup");
        assert.equal(input.reference.runId, runId);
        const row = records.get(input.reference.artifactId);
        assert.ok(row);
        events.push("ownership-auth");
        return {
          reference: row.reference,
          journal: JSON.parse(row.bytes.toString("utf8")),
          conclusion: initialConclusion,
        };
      },
    },
  });
  mock.module(new URL("../../deploy-smoke.ts", import.meta.url), {
    exports: {
      cloudflareRequest(actualAccount: string, actualHash: string, token: string) {
        assert.ok(
          actualAccount === account && actualHash === hash(account) && token === providerToken,
        );
        events.push("provider-read-port");
        return async () => {
          throw Error("Unexpected direct provider API call");
        };
      },
      async observeDeployment(
        _c: unknown,
        loadedHash: string,
        _target: unknown,
        _prepared: string,
        receipt: unknown,
      ) {
        assert.equal(loadedHash, candidateHash);
        assert.deepEqual(
          receipt,
          operation === "deploy" ? cli : { ...cli, workerVersionId: worker1 },
        );
        events.push(`provider-observed:${current.workerVersionId}`);
        keySerial = authSerial;
        return { ...current, checkedAt: new Date().toISOString() };
      },
    },
  });
  mock.module(new URL("../../application-recovery-retention.ts", import.meta.url), {
    exports: {
      async validateRecoveryRetention(input: { deployment: gates.DeploymentIdentity }) {
        assert.deepEqual(stable(input.deployment), stable(v1));
        events.push("original-recovery-auth");
      },
    },
  });
  mock.module(new URL("../../../tests/clients/live.ts", import.meta.url), {
    exports: {
      async liveContext(
        _installed: Installed,
        _deployment: gates.DeploymentIdentity,
        roles: RoleContext,
      ) {
        sideEffects++;
        events.push("seed-helper");
        const aux = () =>
          roles.issue({
            requestId: "seed-helper-opaque-request",
            role: "client",
            grants: [
              {
                grantId: "seed-helper-grant",
                version: 1,
                resources: {
                  agentIds: [],
                  conversationIds: [],
                  workspaceIds: [],
                  executorIds: [],
                  backendIds: [],
                  tools: [],
                  actions: [],
                },
              },
            ],
          });
        await aux();
        return {
          agent: { agentId: "agent" },
          conversations: [{ conversationId: "conversation" }],
          async workspace() {
            const writer = await aux(),
              reader = await aux();
            await roles.revoke(writer.credential.credentialId);
            await roles.revoke(reader.credential.credentialId);
            return {
              observation: {
                workspaceId: "workspace",
                publishedRevision: "r0",
                files: workspace("old-v1", "r0").files,
              },
            };
          },
        };
      },
    },
  });
  mock.module(new URL("../../../tests/clients/live-device.ts", import.meta.url), {
    cache: true,
    exports: {
      ...device,
      async runDeviceContinuityA(input: device.DevicePhaseInput) {
        assert.equal(operation, "deploy");
        assert.deepEqual(input.seed, seed);
        assert.deepEqual(stable(input.deployment), stable(current));
        assert.ok(Object.isFrozen(input.context));
        assert.deepEqual(Object.keys(input.context).sort(), [
          "candidateSha256",
          "readJobs",
          "runAttempt",
          "runId",
        ]);
        const jobs = await input.context.readJobs(1);
        assert.equal(jobs.jobs[0]?.run_id, runId);
        assert.deepEqual(input.clientRole, issued.get("client"));
        assert.deepEqual(input.executorRole, issued.get("a"));
        sideEffects++;
        events.push("perform-a");
        const replacementRole = issued.get("b");
        assert.ok(replacementRole);
        publicObservations = observations(
          seed,
          current,
          input.clientRole.credential,
          input.executorRole.credential,
          replacementRole.credential,
          runId,
        );
        return publicObservations.a;
      },
      async runDeviceContinuityB(
        input: device.DevicePhaseInput,
        previous: device.DeviceContinuityA,
      ) {
        assert.equal(operation, "deploy");
        assert.deepEqual(previous, publicObservations.a);
        assert.deepEqual(input.clientRole, issued.get("client"));
        assert.deepEqual(input.executorRole, issued.get("b"));
        sideEffects++;
        events.push("perform-b");
        if (failedB) throw Error("Controlled B loss");
        return {
          observation: publicObservations.b,
          oracle: "Controlled public continuation",
          sensitivity: [],
        };
      },
    },
  });
  mock.module(new URL("../../../tests/clients/device-observer.ts", import.meta.url), {
    cache: true,
    exports: {
      ...observer,
      async observeDeviceContinuation(input: {
        devices: observer.DeviceEvidenceData;
        deployment: gates.DeploymentIdentity;
        credential: CredentialRef;
        client: { credentials: () => Promise<string> };
      }) {
        assert.equal(operation, "verify");
        assert.deepEqual(input.devices, historical);
        assert.deepEqual(stable(input.deployment), stable(v1));
        assert.deepEqual(input.credential, issued.get("client")?.credential);
        assert.notEqual(input.credential.credentialId, historical?.a.clientCredential.credentialId);
        assert.ok((await input.client.credentials()) === issued.get("client")?.token);
        readonlyCalls++;
        events.push("readonly-continuation");
        return {
          observation: {
            freshReplacement: false,
            freshInterruption: false,
            currentProviderDeploymentId: v1.deploymentId,
            currentWorkerVersionId: v1.workerVersionId,
            references: historical?.references,
          },
          oracle: "Controlled read-only continuation",
          sensitivity: [],
        };
      },
    },
  });
  mock.module(new URL("../../../packages/fortipi-client/dist/node.js", import.meta.url), {
    exports: {
      FortiPiClient: class {
        readonly credentials;
        constructor(options: { endpoint: string; credentials: () => Promise<string> }) {
          assert.equal(options.endpoint, origin);
          this.credentials = options.credentials;
        }
      },
    },
  });
  const allocation = await import("../../live-device-allocation.ts");
  mock.module(new URL("../../live-device-allocation.ts", import.meta.url), {
    cache: true,
    exports: {
      ...allocation,
      async allocateLiveDeviceRoles(
        input: Parameters<typeof allocation.allocateLiveDeviceRoles>[0],
      ) {
        const actual = await allocation.allocateLiveDeviceRoles({
          ...input,
          async writeJournal(value) {
            await input.writeJournal(value);
            if (rejectReplacement) {
              rejectReplacement = false;
              const before = await readFile(journalPath);
              try {
                await input.writeJournal({ ...value, allocationId: "foreign-allocation" });
              } catch {
                replacementRejected = true;
              }
              assert.equal(replacementRejected, true, "Changed allocation must be rejected");
              assert.deepEqual(
                await readFile(journalPath),
                before,
                "Rejected allocation must preserve journal bytes",
              );
              throw Error("Controlled stop after exclusive journal check");
            }
          },
        });
        seed = actual.seed;
        return actual;
      },
    },
  });

  globalThis.fetch = async (url, init) => {
    assert.ok(new Headers(init?.headers).get("authorization") === `Bearer ${admin}`);
    const path = new URL(String(url)).pathname;
    const journal = gates.object(await gates.readJson(journalPath)).body as LiveDeviceOwnership;
    const bytes = await readFile(journalPath);
    assert.deepEqual(
      bytes,
      encoded(JSON.parse(bytes.toString("utf8"))),
      "Complete canonical durable journal before each public request",
    );
    assert.equal((await lstat(journalPath)).mode & 0o777, 0o600);
    assert.deepEqual(
      await readdir(resolve(journalPath, "..")),
      ["ownership.json"],
      "Atomic updates leave no sibling temporary files",
    );
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (path === "/v1/admin/credentials") {
      const row = journal.roles.find((row) => row.mintRequestId === body.requestId);
      assert.ok(row);
      assert.equal(row.issuance, "unknown");
      assert.equal(row.mintSha256, hash(gates.canonicalJson(body)));
      mintRequests.push(copy(body));
      events.push(`mint:${journal.kind}:${row.name}`);
      if (mintFault === row.name) throw Error("Controlled lost mint response");
      const role: IssuedRole = {
        state: "issued",
        credential: { credentialId: `${runId}-${row.name}`, generation: 1, grantVersion: 1 },
        token: `synthetic-device-${runId}-${row.name}-canary-${"x".repeat(32)}`,
        expiresAt: body.expiresAt,
        role: body.role,
      };
      issued.set(row.name, role);
      return Response.json(role);
    }
    if (path.endsWith("/revoke")) {
      const id = path.split("/").at(-2);
      const row = journal.roles.find((row) => row.credential?.credentialId === id);
      assert.ok(row?.credential);
      assert.deepEqual(body, {
        requestId: row.revokeRequestId,
        expectedGeneration: row.credential.generation,
      });
      revokeRequests.push({ requestId: body.requestId, credential: row.credential });
      events.push("revoke");
      return Response.json({
        operationId: `revoke-operation-${id}`,
        revocationId: `revocation-${id}`,
        state: pendingCleanup ? "pending" : "complete",
        pendingRecipients: pendingCleanup ? [{ kind: "workspace", id: "workspace" }] : [],
      });
    }
    assert.equal(path, "/v1/workspaces/workspace", "No unexpected coordinator network operation");
    return Response.json(workspace("old-v1", "r0").binding);
  };
  const coordinator = await import("../../live-device-evidence.ts");
  const installationPath = resolve(root, "installed-substitution.json"),
    deploymentPath = resolve(root, "deployment.json"),
    proofsPath = resolve(root, "proofs.json");
  const prepareDeployment = async () => {
    await gates.saveJson(deploymentPath, current, false);
    await gates.saveJson(
      `${deploymentPath}.cli.json`,
      operation === "deploy" ? cli : { ...cli, workerVersionId: worker1 },
      false,
    );
  };
  const setJob = (next: typeof job) => {
    job = next;
    keySerial = authSerial;
  };
  const publishOwnership = async () => {
    const bytes = await readFile(journalPath),
      ref = reference("device-ownership", bytes);
    records.set(ref.artifactId, { bytes, reference: ref });
    references.set(ref.artifactName, ref);
  };
  const publishPhase = async (phase: DevicePhase) => {
    const directory = resolve(out, phase === "initial" ? "initial" : phase);
    const metadataName = phase === "initial" ? "device-initial.json" : "device-phase.json";
    const metadataBytes = await readFile(resolve(directory, metadataName));
    const metadata = JSON.parse(metadataBytes.toString("utf8"));
    const ref = reference(
      phase === "initial" ? "deployment-initial" : `device-${phase}`,
      metadataBytes,
    );
    const payloads: DevicePhaseArtifact["payloads"] = Object.fromEntries(
      await Promise.all(
        metadata.files.map(async (record: gates.FileRecord) => {
          const bytes = await readFile(resolve(directory, record.path));
          assert.equal(hash(bytes), record.sha256);
          return [
            record.path,
            { record, base64: bytes.toString("base64"), data: JSON.parse(bytes.toString("utf8")) },
          ];
        }),
      ),
    );
    const artifact = {
      reference: ref,
      metadata,
      metadataBase64: metadataBytes.toString("base64"),
      metadataSha256: hash(metadataBytes),
      payloads,
      job: {
        producer: metadata.producer,
        checkedAt: metadata.checkedAt,
        job: {
          id: metadata.jobId,
          name: jobNames[phase],
          runnerId: 111,
          runnerName: `runner-${phase}`,
          labels: ["ubuntu-24.04"],
          startedAt: metadata.checkedAt,
          completedAt: metadata.checkedAt,
        },
      },
    };
    artifacts.set(ref.artifactId, artifact);
    references.set(ref.artifactName, ref);
    return artifact;
  };
  const initialize = async () => {
    setJob("initial");
    await prepareDeployment();
    await coordinator.initializeLiveDevices({ installationPath, deploymentPath, proofsPath, out });
    await publishOwnership();
    const bytes = await readFile(resolve(out, "custody/custody.json")),
      ref = reference("device-custody", bytes);
    records.set(ref.artifactId, { bytes, reference: ref });
    references.set(ref.artifactName, ref);
    await coordinator.finalizeInitialDevices({ installationPath, out, custodyId: ref.artifactId });
    return publishPhase("initial");
  };
  const runPhase = async (phase: "a" | "b") => {
    setJob(phase);
    await coordinator.runLiveDevicePhase({ installationPath, phase, out });
    return publishPhase(phase);
  };
  const cleanup = async () => {
    setJob("cleanup");
    await coordinator.cleanupLiveDevices({ installationPath, out });
    return publishPhase("cleanup");
  };
  const collect = async () => {
    setJob("operate");
    return coordinator.authenticateDeviceEvidence({
      loaded: { candidate: c, hash: candidateHash },
      context: context(),
      deployment: current,
    });
  };
  async function proofBundle(data: observer.DeviceEvidenceData) {
    const directory = resolve(root, "original-live");
    const claim = resolve(directory, "claims/claim.json");
    await gates.saveJson(claim, { observation: "synthetic retained live claim" });
    const claimRecord = bytesRecord("claim.json", await readFile(claim));
    const child: gates.GateReceipt = {
      schemaVersion: 1,
      kind: "live",
      sourceCommit: c.sourceCommit,
      candidateSha256: candidateHash,
      scope: c.scope,
      producer: { ...producer(), runId: 101 },
      checkedAt: new Date().toISOString(),
      deployments: [v1],
      platforms: [],
      claims: [{ id: "platform-recovery", outcome: "pass", result: claimRecord }],
      files: [claimRecord],
    };
    await gates.saveJson(resolve(directory, "claims/gate.json"), child);
    await gates.saveJson(resolve(directory, "device-phases/device-evidence.json"), data);
    const files = await gates.inventory(directory);
    const outer: gates.GateReceipt = {
      ...child,
      claims: [
        {
          id: "platform-recovery",
          outcome: "pass",
          result: { ...claimRecord, path: "claims/claim.json" },
        },
      ],
      files,
    };
    await gates.saveJson(resolve(directory, "gate.json"), outer);
    originalGate = {
      bytes: encoded(outer),
      reference: reference("live", encoded(outer)),
      at: Date.now(),
    };
    await gates.saveJson(proofsPath, {
      schemaVersion: 1,
      candidateArtifact: reference("candidate", encoded(c)),
      proofs: [{ artifact: originalGate.reference, directory }],
    });
  }
  function assertCustody(initial: DevicePhaseArtifact, destinations: readonly string[]) {
    const ownership = initial.payloads["ownership.json"]?.data as LiveDeviceOwnership;
    const ref = initial.metadata.custody?.reference;
    assert.ok(ref);
    const saved = records.get(ref.artifactId);
    assert.ok(saved);
    const envelope = JSON.parse(saved.bytes.toString("utf8")).roles as Record<
      string,
      LiveDeviceCustodyEnvelope
    >;
    assert.deepEqual(Object.keys(envelope).sort(), [...destinations].sort());
    for (const destination of destinations) {
      const row = ownership.roles.find((row) => row.name === destination);
      assert.ok(row?.credential);
      // Independent plan oracle: target/purpose/destination + actual public ref
      // and run bind the expected AAD, never the envelope's own frame.
      const expectedFrame: LiveDeviceCustodyFrame = {
        sourceCommit: c.sourceCommit,
        candidateSha256: candidateHash,
        repositoryId: gates.REPOSITORY_ID,
        runId,
        runAttempt: 1,
        targetIdentitySha256: hash(
          gates.canonicalJson({
            purpose: "fortipi-device-role-v1",
            target: hash(gates.canonicalJson(stable(current))),
            destination,
          }),
        ),
        credentialRef: row.credential,
        createdAt: ownership.createdAt,
        expiresAt: row.expiresAt,
      };
      assert.deepEqual(envelope[destination]?.frame, expectedFrame);
      assert.deepEqual(
        openLiveDeviceRole({
          key: admin,
          envelope: envelope[destination],
          expectedFrame,
          now: Date.now(),
        }),
        issued.get(destination),
      );
    }
    for (const role of issued.values()) assert.ok(!saved.bytes.includes(Buffer.from(role.token)));
    assert.ok(!saved.bytes.includes(Buffer.from(admin)));
  }
  try {
    await prepareDeployment();
    if (which === "golden") {
      const initial = await initialize();
      assertCustody(initial, ["client", "a", "b"]);
      const journalBytes = await readFile(journalPath),
        mintsBeforeReplay = mintRequests.length,
        keysBeforeReplay = protectedReads;
      await assert.rejects(
        coordinator.initializeLiveDevices({ installationPath, deploymentPath, proofsPath, out }),
        /EEXIST/,
      );
      assert.deepEqual(await readFile(journalPath), journalBytes);
      assert.equal(mintRequests.length, mintsBeforeReplay);
      assert.equal(protectedReads, keysBeforeReplay);
      await runPhase("a");
      await runPhase("b");
      await cleanup();
      const performed = await collect();
      observer.assertDeviceEvidenceData(performed.devices, v0);
      historical = copy(performed.devices);
      assert.equal(performed.devices.initial.deployment.workerVersionId, worker0);
      assert.equal(performed.devices.a.clientCredential.credentialId, "101-client");
      const retained = resolve(root, "retained-perform");
      await coordinator.retainDevicePhaseBytes(retained, performed);
      for (const artifact of performed.phases) {
        const directory = resolve(retained, artifact.metadata.phase);
        const names = await readdir(directory);
        assert.ok(!names.includes("custody.json"));
        for (const [name, payload] of Object.entries(artifact.payloads))
          assert.deepEqual(
            await readFile(resolve(directory, name)),
            Buffer.from(payload.base64, "base64"),
          );
      }
      const originalDataBytes = encoded(performed.devices),
        effectCount = sideEffects;
      await proofBundle(historical);
      runId = 201;
      operation = "verify";
      current = v1;
      out = resolve(root, "verify");
      journalPath = resolve(out, "ownership/ownership.json");
      issued.clear();
      const mintCount = mintRequests.length;
      const verifyInitial = await initialize();
      assertCustody(verifyInitial, ["client"]);
      const fresh = mintRequests.slice(mintCount);
      assert.equal(fresh.length, 1);
      assert.equal(fresh[0]?.role, "client");
      assert.deepEqual(fresh[0]?.grants[0]?.resources.actions, [
        "tickets.mint",
        "conversations.read",
        "events.read",
        "tasks.read",
        "jobs.read",
        "workspace.read",
        "workspaces.read",
      ]);
      await runPhase("a");
      await runPhase("b");
      await cleanup();
      const verified = await collect();
      assert.deepEqual(encoded(verified.devices), originalDataBytes);
      assert.equal(sideEffects, effectCount);
      assert.equal(readonlyCalls, 2);
      assert.ok(verified.phases.every((phase) => phase.reference.runId === 201));
      assert.ok(Object.values(verified.devices.references).every((ref) => ref.runId === 101));
      assert.ok(
        events.includes("original-live-producer") && events.includes("original-recovery-auth"),
      );
      assert.ok(events.includes("custody-auth:201"));
      assert.equal(
        events.filter((event) => event === "custody-auth:101").length,
        2,
        "Verify never opens original custody",
      );
      await coordinator.retainDevicePhaseBytes(resolve(root, "retained-verify"), verified);
      assert.deepEqual(
        await readFile(resolve(retained, "device-evidence.json")),
        originalDataBytes,
      );
      process.stdout.write(
        "Perform/verify orchestration preserved source history, fresh READ scope and exact retained bytes.\n",
      );
    } else if (which === "authority") {
      auth = false;
      const before = protectedReads;
      await assert.rejects(
        coordinator.initializeLiveDevices({ installationPath, deploymentPath, proofsPath, out }),
      );
      assert.equal(protectedReads, before);
      assert.equal(mintRequests.length, 0);
      auth = true;
      await initialize();
      setJob("a");
      artifactAuth = false;
      const reads = protectedReads;
      await assert.rejects(coordinator.runLiveDevicePhase({ installationPath, phase: "a", out }));
      assert.equal(protectedReads, reads);
      assert.equal(events.includes("perform-a"), false);
      artifactAuth = true;
      cipherSwap = true;
      const effects = sideEffects;
      await assert.rejects(
        coordinator.runLiveDevicePhase({ installationPath, phase: "a", out }),
        /custody unavailable/,
      );
      assert.equal(sideEffects, effects);
      cipherSwap = false;
      await runPhase("a");
      failedB = true;
      await assert.rejects(runPhase("b"), /Controlled B loss/);
      await cleanup();
      const complete = gates.object(
        await gates.readJson(resolve(out, "cleanup/device-cleanup.json")),
      );
      assert.equal(complete.state, "complete");
      const mints = mintRequests.length;
      await assert.rejects(collect());
      assert.equal(mintRequests.length, mints);
      process.stdout.write(
        "Source/artifact refusal preceded key access; wrong destination and failed B cannot yield passing device evidence.\n",
      );
    } else {
      assert.equal(which, "journal");
      rejectReplacement = true;
      await assert.rejects(
        coordinator.initializeLiveDevices({ installationPath, deploymentPath, proofsPath, out }),
      );
      assert.equal(replacementRejected, true);
      assert.equal(mintRequests.length, 0);
      const kept = gates.object(await gates.readJson(journalPath));
      assert.notEqual(gates.object(kept.body).allocationId, "foreign-allocation");
      out = resolve(root, "uncertain");
      journalPath = resolve(out, "ownership/ownership.json");
      mintFault = "a";
      await assert.rejects(
        coordinator.initializeLiveDevices({ installationPath, deploymentPath, proofsPath, out }),
      );
      await publishOwnership();
      initialConclusion = "failure";
      const mints = mintRequests.length;
      await assert.rejects(cleanup(), /Unknown or pending cleanup/);
      assert.equal(mintRequests.length, mints);
      const uncertain = gates.object(
        await gates.readJson(resolve(out, "cleanup/device-cleanup.json")),
      );
      assert.equal(uncertain.state, "unknown");
      assert.equal(
        gates.object((uncertain.roles as unknown[]).find((row) => gates.object(row).name === "a"))
          .state,
        "unknown",
      );
      process.stdout.write(
        "Exclusive fixed allocation journal and uncertain issuance cleanup remained fail closed.\n",
      );
    }
    for (const event of events) assert.ok(!event.includes(admin) && !event.includes(providerToken));
    assert.ok(
      revokeRequests.length === 0 || revokeRequests.every((row) => row.requestId.length > 0),
    );
  } finally {
    process.env = originalEnvironment;
    globalThis.fetch = originalFetch;
    mock.restoreAll();
    await rm(root, { recursive: true, force: true });
  }
}

const argument = process.argv.indexOf("--coordinator-case");
if (argument !== -1) {
  await controlled(process.argv[argument + 1] ?? "");
} else {
  for (const name of ["golden", "authority", "journal"])
    test(`controlled device coordinator ${name}`, { timeout: 30000 }, async () => {
      const result = await promisify(execFile)(
        process.execPath,
        ["--experimental-test-module-mocks", import.meta.filename, "--coordinator-case", name],
        { env: childEnvironment(), timeout: 25000, maxBuffer: 100000 },
      );
      assert.ok(
        result.stdout.includes(
          name === "golden"
            ? "exact retained bytes"
            : name === "authority"
              ? "preceded key access"
              : "fail closed",
        ),
      );
    });
}
