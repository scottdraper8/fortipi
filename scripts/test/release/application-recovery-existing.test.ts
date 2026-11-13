// Provider setup adapted from the existing coordinator fixture. HTTP/ZIP lineage facts
// and provider effects are synthetic; package/prepare/history/file operations are real.
import assert from "node:assert/strict";
import { chmod, copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { after, before, test } from "node:test";
import type {
  ApplicationRecoveryAfter,
  ApplicationRecoveryBefore,
  ConfirmedPlatformRecovery,
} from "../../../tests/clients/platform-recovery.ts";
import {
  type ApplicationRecoveryCoordinatorInput,
  createApplicationRecoveryCoordinator,
} from "../../application-recovery-coordinator.ts";
import {
  createExistingApplicationRecoveryCoordinator,
  type ExistingApplicationRecoveryInput,
} from "../../application-recovery-existing.ts";
import { repository } from "../../build-workspaces.ts";
import { observeDeployment, type TargetDescriptor } from "../../deploy-smoke.ts";
import { generateNotices } from "../../generate-notices.ts";
import type { RecoveryInput, RecoveryPorts } from "../../platform-recovery.ts";
import { childEnvironment, execute, generateSbom, stageAndPack } from "../../prepare-release.ts";
import {
  type ArtifactReference,
  type CandidateManifest,
  canonicalJson,
  type DeploymentIdentity,
  type GateReceipt,
  githubRequest,
  inventory,
  object,
  type ProofInput,
  REPOSITORY_ID,
  readJson,
  regularBytes,
  saveJson,
  sha256,
} from "../../verify-release-gates.ts";
import { candidate, directoryArchive, discard, httpFixture, temporary } from "./fixtures.ts";

const v0 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const v1 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const other = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const d0 = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const d1 = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const admin = "synthetic-application-only";
let root: string;
let prepared: string;
let manifestPath: string;
let manifestHash: string;
let sourceCommit: string;
let target: TargetDescriptor;
let config: Record<string, unknown>;
let preparedReceipt: Record<string, unknown>;
let nextOperation = 0;
let retainedCandidate: CandidateManifest;

async function preparePackages() {
  root = await temporary("fortipi-recovery-protocol-");
  const directory = resolve(root, "candidate");
  await mkdir(directory);
  const c = candidate(); // API identity only is synthetic; all five package archives below are actual.
  const packed = await stageAndPack(repository, resolve(directory, "packs"), c.scope, c.version);
  await generateSbom(repository, directory, c.scope, c.version, await generateNotices());
  await mkdir(resolve(directory, "image"));
  for (const name of ["image-metadata.json", "sources-and-notices.tar"])
    await copyFile(
      resolve(repository, "apps/worker/dist/container", name),
      resolve(directory, "image", name),
      1,
    );
  const assets = object(
    await readJson(resolve(repository, "packages/fortipi-cli/worker-assets/asset-manifest.json")),
  );
  c.sourceCommit = String(assets.sourceCommit);
  c.assetManifestSha256 = packed.assetManifestSha256;
  const image = object(await readJson(resolve(directory, "image/image-metadata.json")));
  c.image = {
    sourceCommit: String(image.sourceCommit),
    metadataSha256: sha256(await regularBytes(resolve(directory, "image/image-metadata.json"))),
    imageId: String(image.imageId),
    builtManifestDigest: String(image.builtManifestDigest),
    sourceKitSha256: String(image.sourceKitSha256),
  };
  c.packages = packed.packages;
  c.files = await inventory(directory);
  manifestPath = resolve(directory, "candidate.json");
  await saveJson(manifestPath, c);
  manifestHash = sha256(await regularBytes(manifestPath));
  sourceCommit = c.sourceCommit;
  retainedCandidate = c;
  const operator = await readJson(
    resolve(repository, "packages/fortipi-cli/templates/operator-config.example.json"),
  );
  target = {
    schemaVersion: 1,
    backend: "free",
    accountBindingSha256: sha256("synthetic-account"),
    operator,
  };
  prepared = resolve(root, "prepared");
  const result = await execute(
    process.execPath,
    [
      resolve(repository, "packages/fortipi-cli/dist/bin.js"),
      "prepare",
      "--config",
      resolve(repository, "packages/fortipi-cli/templates/operator-config.example.json"),
      "--directory",
      prepared,
      "--non-interactive",
      "--json",
    ],
    root,
    childEnvironment(),
    120000,
  );
  assert.equal(result.code, 0);
  preparedReceipt = object(JSON.parse(result.stdout));
  config = object(await readJson(resolve(prepared, "wrangler.json")));
}
after(async () => {
  if (root) await discard(root);
});

async function fixture(fault = "") {
  const operationId = (++nextOperation).toString(16).padStart(32, "0");
  const evidenceRoot = resolve(root, operationId);
  const journalDirectory = resolve(evidenceRoot, "provider-recovery");
  const runtime = object(object(target.operator).runtime);
  const durable = object(config.durable_objects).bindings;
  assert.ok(Array.isArray(durable));
  let ids = [v0];
  let active = v0;
  let deploymentId = d0;
  let annotation = "";
  let unavailable = false;
  const calls: string[][] = [];
  const server = await httpFixture((request, response) => {
    assert.equal(
      request.headers.authorization,
      request.url === "/health" ? undefined : `Bearer ${admin}`,
    );
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        request.url === "/health" ? { status: "ok", protocolVersion: "1.0" } : runtime,
      ),
    );
  });
  const read: RecoveryPorts["read"] = async (path) => {
    if (unavailable) throw new Error("synthetic-provider-secret-do-not-retain");
    if (path === "/workers/subdomain") return { subdomain: "example" };
    if (path.endsWith("/subdomain")) return { enabled: true };
    if (path.endsWith("/deployments"))
      return {
        deployments: [
          {
            id: deploymentId,
            strategy: "percentage",
            versions: [{ version_id: active, percentage: 100 }],
          },
        ],
      };
    if (path.endsWith("/versions?per_page=100")) return { items: ids.map((id) => ({ id })) };
    if (path === "/workers/durable_objects/namespaces?page=1&per_page=1000")
      return durable.map((raw, i) => ({
        class: object(raw).class_name,
        script: object(object(target.operator).deployment).name,
        id: sha256(
          `namespace-${i}${fault === "namespace" && ids.length > 1 ? "-replacement" : ""}`,
        ),
        use_sqlite: true,
      }));
    const id = path.split("/").at(-1);
    assert.ok(id === v0 || id === v1 || id === other);
    const changed = id === v1;
    const migrations = config.migrations;
    assert.ok(Array.isArray(migrations));
    return {
      id,
      annotations: { "workers/tag": annotation },
      resources: {
        script: {
          etag: changed && fault === "bytes" ? "different-modules" : "same-provider-module-hash",
          named_handlers: ["ControlPlane", "AgentSession", "WorkspaceObject", "WorkspaceProxy"].map(
            (name) => ({ name, handlers: ["fetch"] }),
          ),
        },
        script_runtime: {
          compatibility_date: config.compatibility_date,
          compatibility_flags: config.compatibility_flags,
          migration_tag: object(migrations.at(-1)).tag,
          exports: Object.fromEntries(
            durable.map((raw) => [
              String(object(raw).class_name),
              {
                type: "durable-object",
                storage: "sqlite",
                ...(changed ? { state: "created" } : {}),
              },
            ]),
          ),
        },
        bindings: [
          ...durable.map((raw) => ({ type: "durable_object_namespace", ...object(raw) })),
          { type: "ai", name: "AI" },
          { type: "json", name: "FORTIPI_CONFIG", json: runtime },
          ...(changed && fault === "secret"
            ? []
            : [{ type: "secret_text", name: "FORTIPI_ADMIN_TOKEN" }]),
          ...(changed && fault === "binding"
            ? [{ type: "kv_namespace", name: "OTHER", namespace_id: "unrelated" }]
            : []),
        ],
      },
    };
  };
  const beforeIdentity = await observeDeployment(
    retainedCandidate,
    manifestHash,
    target,
    prepared,
    {
      workerName: object(object(target.operator).deployment).name,
      origin: object(object(target.operator).deployment).origin,
      targets: [object(object(target.operator).deployment).origin],
      workerVersionId: v0,
      sourceCommit,
      packageVersion: "0.1.0",
      assetManifestSha256: preparedReceipt.assetManifestSha256,
      configSha256: preparedReceipt.configSha256,
    },
    read,
    server.transport,
    admin,
  );
  const checkpointDirectory = resolve(evidenceRoot, "application-recovery");
  const beforePath = resolve(checkpointDirectory, "application-before.json");
  // Synthetic public canary DTOs qualify only this local coordinator protocol.
  const targetBackend = {
    kind: "executor" as const,
    executorId: "offline-executor",
    generation: 1,
  };
  const publicBefore: ApplicationRecoveryBefore = {
    schemaVersion: 1,
    candidateSha256: manifestHash,
    sourceCommit,
    deploymentId: d0,
    workerVersionId: v0,
    capturedAt: new Date().toISOString(),
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
        target: targetBackend,
        trust: "host",
        capabilities: ["shell"],
        policyVersion: 1,
        grantVersion: 1,
        expiresAt: Date.now() + 600_000,
      },
    },
    target: targetBackend,
    eventThrough: 1,
    eventPrefixSha256: sha256("retained-event-prefix"),
    snapshotSha256: sha256("snapshot"),
    workspace: {
      binding: {
        workspaceId: "original-workspace",
        bindingVersion: 1,
        revision: "r1",
        manifestHash: sha256("manifest"),
        config: { kind: "computer" },
        availability: "available",
      },
      files: [{ path: "canary.txt", size: 6, sha256: sha256("canary") }],
    },
  };
  await saveJson(beforePath, publicBefore);
  const beforeBytes = await regularBytes(beforePath);
  const input: RecoveryInput = {
    candidatePath: manifestPath,
    candidateSha256: manifestHash,
    sourceCommit,
    preparedDirectory: prepared,
    target,
    before: beforeIdentity,
    operationId,
    journalDirectory,
    checkpointDirectory,
    beforeCheckpoint: {
      path: beforePath,
      size: beforeBytes.length,
      mode: 0o600,
      sha256: sha256(beforeBytes),
    },
  };
  const ports: RecoveryPorts = {
    read,
    applicationTransport: server.transport,
    applicationAdminToken: admin,
    wrangler: {
      async run(request) {
        // Both write intents must be real, durable and exclusive before entering this effect port.
        const intent = object(await readJson(resolve(journalDirectory, "intent.json")));
        assert.equal(intent.candidateSha256, manifestHash);
        assert.equal(intent.beforeCheckpointSha256, input.beforeCheckpoint.sha256);
        const upload = request.args[1] === "upload";
        await regularBytes(
          resolve(journalDirectory, upload ? "upload-attempt.json" : "deployment-attempt.json"),
        );
        assert.equal(request.cwd, prepared);
        assert.equal(request.deploymentAuth, true);
        assert.equal(request.input, undefined);
        assert.equal(request.outputFile, undefined);
        calls.push(request.args);
        if (upload) {
          assert.deepEqual(request.args, [
            "versions",
            "upload",
            "--config",
            resolve(prepared, "wrangler.json"),
            "--tag",
            `fortipi-recovery-${operationId}`,
          ]);
          annotation = `fortipi-recovery-${operationId}`;
          if (fault !== "same" && fault !== "upload-absent")
            ids = [v1, ...(fault === "latest" ? [other] : []), v0];
          if (fault === "ambiguous-upload") {
            unavailable = true;
            throw new Error("synthetic-runner-secret-do-not-retain");
          }
          if (fault === "upload-absent") throw new Error("uncertain-not-observed");
        } else {
          assert.deepEqual(request.args, [
            "versions",
            "deploy",
            `${v1}@100%`,
            "--config",
            resolve(prepared, "wrangler.json"),
            "--durable-objects-code-update-mode",
            "immediate",
            "--yes",
          ]);
          active = v1;
          deploymentId = d1;
          if (fault === "ambiguous-deploy") {
            unavailable = true;
            throw new Error("synthetic-runner-secret-do-not-retain");
          }
        }
        return "synthetic-untrusted-stdout-do-not-retain";
      },
    },
  };
  return {
    input,
    ports,
    publicBefore,
    evidenceRoot,
    calls,
    close: server.close,
    reconnect() {
      unavailable = false;
    },
    unrelated() {
      ids.unshift(other);
    },
    wrongActive() {
      active = v0;
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function binding(f: Fixture): ApplicationRecoveryCoordinatorInput {
  const { beforeCheckpoint: _beforeCheckpoint, ...input } = f.input;
  return input;
}
function factory(f: Fixture) {
  const counts: number[] = [];
  return {
    counts,
    async create(): Promise<RecoveryPorts> {
      const i = counts.push(0) - 1;
      return {
        ...f.ports,
        read: async (path) => {
          counts[i] = (counts[i] ?? 0) + 1;
          assert.ok(
            (counts[i] ?? 0) <= 32,
            "Each actual provider invocation has its own32-read budget",
          );
          return f.ports.read(path);
        },
      };
    },
  };
}
async function afterFile(f: Fixture, operation: ConfirmedPlatformRecovery) {
  const value: ApplicationRecoveryAfter = {
    schemaVersion: 1,
    candidateSha256: manifestHash,
    sourceCommit,
    beforeCheckpointSha256: f.input.beforeCheckpoint.sha256,
    workerVersionId: operation.after.workerVersionId,
    originalTaskId: f.publicBefore.admission.taskId,
    originalJobId: f.publicBefore.jobId,
    originalReceiptRetained: true,
    originalEventPrefixSha256: f.publicBefore.eventPrefixSha256,
    actualWorkspaceHashes: f.publicBefore.workspace.files,
    continuation: "public-approval-rejection",
    taskState: "completed",
    executionIdentityAbsentBeforeAndAfter: true,
    checkedAt: new Date().toISOString(),
  };
  const path = resolve(f.input.checkpointDirectory, "application-after.json");
  await saveJson(path, value);
  const bytes = await regularBytes(path);
  return { path, size: bytes.length, mode: 0o600, sha256: sha256(bytes) };
}

let historical: Fixture;
let currentIdentity: DeploymentIdentity;
before(async () => {
  await preparePackages();
  historical = await fixture();
  const ports = factory(historical);
  const bridge = createApplicationRecoveryCoordinator(binding(historical), () => ports.create());
  const operation = await bridge.perform(historical.input.beforeCheckpoint);
  assert.equal(operation.status, "operation-confirmed");
  if (operation.status !== "operation-confirmed") throw Error("Fixture perform failed");
  const after = await afterFile(historical, operation);
  assert.equal((await bridge.finish(after)).status, "qualified");
  currentIdentity = object(
    await readJson(resolve(historical.input.journalDirectory, "transition.json")),
  ).after as DeploymentIdentity;
  assert.equal(historical.calls.length, 2);
});
after(async () => {
  await historical?.close();
});

const proofPath = "claims/provider-recovery/application-recovery.json";
let proofNumber = 0;
async function retained(fault = "") {
  const proofsRoot = resolve(root, "proofs");
  await mkdir(proofsRoot, { recursive: true, mode: 0o700 });
  const directory = resolve(proofsRoot, `original-${++proofNumber}`);
  await mkdir(directory, { mode: 0o700 });
  await cp(historical.evidenceRoot, resolve(directory, "claims"), {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  const proofFile = resolve(directory, proofPath);
  if (fault === "missing-proof") await rm(proofFile);
  if (fault === "proof-lookalike") {
    await mkdir(resolve(directory, "claims/unrelated"));
    await copyFile(proofFile, resolve(directory, "claims/unrelated/application-recovery.json"));
    await rm(proofFile);
  }
  if (fault === "checkpoint-rehashed") {
    const path = resolve(directory, "claims/application-recovery/application-after.json");
    const value = object(await readJson(path));
    value.originalTaskId = "another-task";
    await writeFile(path, `${canonicalJson(value)}\n`);
    const proof = object(await readJson(proofFile));
    const bytes = await regularBytes(path);
    proof.after = { ...object(proof.after), size: bytes.length, sha256: sha256(bytes) };
    await writeFile(proofFile, `${canonicalJson(proof)}\n`);
  }
  if (fault === "history-changed") {
    const path = resolve(directory, "claims/provider-recovery/intent.json");
    const value = object(await readJson(path));
    value.unrelated = true;
    await writeFile(path, `${canonicalJson(value)}\n`);
  }
  if (fault === "transition-digest") {
    const proof = object(await readJson(proofFile));
    proof.transitionSha256 = sha256("different transition");
    await writeFile(proofFile, `${canonicalJson(proof)}\n`);
  }
  const files = await inventory(directory);
  const result = files.find((f) => f.path === "claims/application-recovery/application-after.json");
  assert.ok(result);
  const workflow = await regularBytes(resolve(repository, ".github/workflows/deploy.yml"));
  const gate: GateReceipt = {
    schemaVersion: 1,
    kind: "live",
    candidateSha256: manifestHash,
    sourceCommit,
    scope: retainedCandidate.scope,
    producer: {
      workflowPath: ".github/workflows/deploy.yml",
      workflowSha256: sha256(workflow),
      workflowId: 71,
      runId: 81,
      runAttempt: 1,
    },
    checkedAt: new Date().toISOString(),
    claims: [{ id: "platform-recovery", outcome: "pass", result }],
    platforms: [],
    deployments: [currentIdentity],
    files,
  };
  await saveJson(resolve(directory, "gate.json"), gate);
  // Match GitHub extraction: regular transport modes change, saved receipts do not.
  for (const file of [...files, { path: "gate.json" }])
    await chmod(resolve(directory, file.path), 0o644);
  const zip = await directoryArchive(directory);
  const reference: ArtifactReference = {
    runId: 81,
    runAttempt: 1,
    artifactId: 83,
    artifactName: `live-${sourceCommit}-${retainedCandidate.scope}-81-1`,
    artifactDigest: `sha256:${sha256(fault === "bad-zip-digest" ? "different ZIP" : zip.bytes)}`,
    candidateSha256:
      fault === "wrong-candidate-reference" ? sha256("another candidate") : manifestHash,
  };
  if (fault === "cached-gate-changed") {
    gate.checkedAt = new Date(Date.parse(gate.checkedAt) + 1).toISOString();
    await writeFile(resolve(directory, "gate.json"), `${canonicalJson(gate)}\n`);
  }
  const now = Date.now();
  let downloads = 0;
  const urls: string[] = [];
  const server = await httpFixture((req, res) => {
    assert.equal(req.method, "GET");
    assert.equal(req.headers.authorization, undefined);
    const route = req.url ?? "";
    urls.push(route);
    if (route.endsWith("/zip")) {
      res.writeHead(302, { location: "https://fixture.blob.core.windows.net/proof.zip" });
      res.end();
      return;
    }
    if (route === "/proof.zip") {
      downloads++;
      res.end(zip.bytes);
      return;
    }
    const common = {
      id: 81,
      run_attempt: fault === "superseded" ? 2 : 1,
      workflow_id: 71,
      head_sha: sourceCommit,
      head_branch: "main",
      event: "workflow_dispatch",
      path: ".github/workflows/deploy.yml",
      repository: { id: REPOSITORY_ID },
      head_repository: { id: REPOSITORY_ID },
      status: "completed",
      conclusion: fault === "failed-producer" ? "failure" : "success",
      run_started_at: new Date(now - 10000).toISOString(),
      updated_at: new Date(now - 1000).toISOString(),
    };
    let value: unknown;
    if (route.endsWith("/actions/workflows/71"))
      value = { id: 71, path: ".github/workflows/deploy.yml", state: "active" };
    else if (route.includes("/contents/"))
      value = { encoding: "base64", content: workflow.toString("base64") };
    else if (route.includes("/jobs?"))
      value = {
        total_count: 1,
        jobs: [
          {
            id: 91,
            name: "operate",
            status: "completed",
            conclusion: "success",
            started_at: new Date(now - 5000).toISOString(),
            completed_at: common.updated_at,
          },
        ],
      };
    else if (route.endsWith("/actions/artifacts/83"))
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
          head_repository_id: fault === "foreign-artifact" ? 1 : REPOSITORY_ID,
          head_sha: sourceCommit,
          head_branch: "main",
        },
      };
    else if (route.includes("/actions/runs/81")) value = common;
    else {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(value));
  });
  const proof: ProofInput = { artifact: reference, receipt: gate, directory };
  const input: ExistingApplicationRecoveryInput = {
    candidatePath: manifestPath,
    candidateSha256: manifestHash,
    sourceCommit,
    preparedDirectory: prepared,
    target,
    current: currentIdentity,
    proof,
    proofsRoot,
  };
  return {
    input,
    reference,
    directory,
    urls,
    downloads: () => downloads,
    request: githubRequest(undefined, server.transport),
    async close() {
      await server.close();
      await zip.close();
    },
  };
}
async function snapshotFiles(directory: string) {
  return inventory(directory);
}
function readonlyFactory(stale = false) {
  const counts: number[] = [];
  return {
    counts,
    async create(): Promise<RecoveryPorts> {
      const i = counts.push(0) - 1;
      const ports: RecoveryPorts = {
        applicationTransport: historical.ports.applicationTransport,
        applicationAdminToken: historical.ports.applicationAdminToken,
        read: async (path) => {
          counts[i] = (counts[i] ?? 0) + 1;
          assert.ok((counts[i] ?? 0) <= 32);
          if (stale && path.endsWith("/deployments"))
            return {
              deployments: [
                { id: d0, strategy: "percentage", versions: [{ version_id: v0, percentage: 100 }] },
              ],
            };
          return historical.ports.read(path);
        },
      };
      Object.defineProperty(ports, "wrangler", {
        get() {
          throw Error("Wrangler capability must not be accessed");
        },
      });
      return ports;
    },
  };
}

test("completed live HTTP/ZIP lineage replays readonly from private mode-restored copies kept until explicit disposal", {
  timeout: 120000,
}, async () => {
  const f = await retained();
  const factory = readonlyFactory();
  const beforeFiles = await snapshotFiles(f.directory);
  const originalTransition = await readFile(
    resolve(f.directory, "claims/provider-recovery/transition.json"),
  );
  const bridge = createExistingApplicationRecoveryCoordinator(f.input, f.request, () =>
    factory.create(),
  );
  assert.equal(f.urls.length, 0);
  assert.equal(factory.counts.length, 0);
  try {
    const result = await bridge.verifyExisting();
    assert.equal(result.status, "lineage-confirmed");
    if (result.status !== "lineage-confirmed") throw Error("Original lineage unavailable");
    assert.equal(f.downloads(), 1);
    assert.equal(factory.counts.length, 1);
    assert.equal(historical.calls.length, 2, "Readonly verification must not upload/deploy");
    assert.deepEqual(result.evidence, f.reference);
    assert.equal(result.operation.operationEvidenceSha256, sha256(originalTransition));
    const original = object(JSON.parse(originalTransition.toString()));
    assert.deepEqual(result.operation.before, original.before);
    assert.deepEqual(result.operation.after, original.after);
    assert.equal(result.current.workerVersionId, v1);
    assert.equal(result.current.deploymentId, d1);
    assert.ok(Date.parse(result.current.checkedAt) >= Date.parse(currentIdentity.checkedAt));
    for (const record of [result.before, result.after]) {
      const bytes = await regularBytes(record.path);
      assert.equal(bytes.length, record.size);
      assert.equal(sha256(bytes), record.sha256);
      assert.equal(record.mode, 0o600);
      assert.ok(!record.path.startsWith(f.directory));
    }
    const copiedRoot = dirname(dirname(result.before.path));
    const copies = await inventory(copiedRoot);
    assert.deepEqual(
      copies.map((file) => file.path),
      [
        "application-recovery/application-after.json",
        "application-recovery/application-before.json",
        "provider-recovery/deployment-attempt.json",
        "provider-recovery/intent.json",
        "provider-recovery/transition.json",
        "provider-recovery/upload-attempt.json",
      ],
    );
    assert.ok(copies.every((file) => file.mode === 0o600));
    assert.deepEqual(
      await snapshotFiles(f.directory),
      beforeFiles,
      "Original transport modes/bytes must remain untouched",
    );
    assert.equal((await bridge.verifyExisting()).status, "unavailable");
    await bridge.dispose();
    await assert.rejects(regularBytes(result.before.path), { code: "ENOENT" });
    assert.deepEqual(await snapshotFiles(f.directory), beforeFiles);
  } finally {
    await bridge.dispose();
    await f.close();
  }
});

test("failed/superseded producer, foreign/different ZIP, cached-gate substitution and missing or tampered retained facts fail before provider reads", {
  timeout: 180000,
}, async () => {
  for (const fault of [
    "failed-producer",
    "superseded",
    "foreign-artifact",
    "wrong-candidate-reference",
    "bad-zip-digest",
    "cached-gate-changed",
    "missing-proof",
    "proof-lookalike",
    "checkpoint-rehashed",
    "history-changed",
    "transition-digest",
  ]) {
    const f = await retained(fault);
    const ports = readonlyFactory();
    const bridge = createExistingApplicationRecoveryCoordinator(f.input, f.request, () =>
      ports.create(),
    );
    try {
      assert.deepEqual(
        await bridge.verifyExisting(),
        {
          status: "unavailable",
          reason: "Original application recovery unavailable or inconsistent",
        },
        fault,
      );
      assert.equal(
        ports.counts.length,
        0,
        `${fault} reached provider before original evidence authentication`,
      );
      assert.equal(historical.calls.length, 2);
      if (
        ["failed-producer", "superseded", "foreign-artifact", "wrong-candidate-reference"].includes(
          fault,
        )
      )
        assert.equal(f.downloads(), 0);
      else assert.equal(f.downloads(), 1);
    } finally {
      await bridge.dispose();
      await f.close();
    }
  }
});

test("fresh provider V0 drift refuses lineage without writes or changes to the original journal", {
  timeout: 120000,
}, async () => {
  const f = await retained();
  const ports = readonlyFactory(true);
  const original = await snapshotFiles(f.directory);
  const bridge = createExistingApplicationRecoveryCoordinator(f.input, f.request, () =>
    ports.create(),
  );
  try {
    assert.equal((await bridge.verifyExisting()).status, "unavailable");
    assert.equal(ports.counts.length, 1);
    assert.equal(historical.calls.length, 2);
    assert.deepEqual(await snapshotFiles(f.directory), original);
  } finally {
    await bridge.dispose();
    await f.close();
  }
});
