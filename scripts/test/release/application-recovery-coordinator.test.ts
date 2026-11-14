// Unit-only provider protocol fixtures; real staged packages/prepared modules, no CF operation.
import assert from "node:assert/strict";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
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
import { repository } from "../../build-workspaces.ts";
import { observeDeployment, type TargetDescriptor } from "../../deploy-smoke.ts";
import { generateNotices } from "../../generate-notices.ts";
import type { RecoveryInput, RecoveryPorts } from "../../platform-recovery.ts";
import { childEnvironment, execute, generateSbom, stageAndPack } from "../../prepare-release.ts";
import {
  type CandidateManifest,
  canonicalJson,
  inventory,
  object,
  readJson,
  regularBytes,
  saveJson,
  sha256,
} from "../../verify-release-gates.ts";
import { candidate, discard, httpFixture, temporary } from "./fixtures.ts";

// These source fixtures exercise local archives and mocked provider ports.
// Isolate their test worker from the hosting workflow's candidate-reader context.
const hostedWorkflow = process.env.GITHUB_ACTIONS;
before(() => {
  delete process.env.GITHUB_ACTIONS;
});
after(() => {
  if (hostedWorkflow === undefined) delete process.env.GITHUB_ACTIONS;
  else process.env.GITHUB_ACTIONS = hostedWorkflow;
});

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

before(async () => {
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
});
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

test("actual provider perform/verify plus matching files produces one closed relative combined proof, never qualifies on perform", {
  timeout: 120000,
}, async (t) => {
  const f = await fixture();
  try {
    const ports = factory(f);
    const input = binding(f);
    const bridge = createApplicationRecoveryCoordinator(input, () => ports.create());
    assert.equal(ports.counts.length, 0, "Constructor must not create/read provider authority");
    input.sourceCommit = "f".repeat(40); // Original trusted binding is snapshotted before awaits.
    const before = { ...f.input.beforeCheckpoint };
    const pending = bridge.perform(before);
    before.sha256 = sha256("later caller mutation");
    const operation = await pending;
    if (operation.status !== "operation-confirmed") assert.fail(operation.reason);
    assert.equal(operation.incarnation, "not-observed");
    assert.equal(operation.eviction, "not-observed");
    assert.equal(operation.physicalHostLoss, "not-observed");
    assert.equal(operation.reset, "inferred-from-provider-contract");
    assert.deepEqual(Object.keys(operation).sort(), [
      "after",
      "before",
      "eviction",
      "incarnation",
      "operationEvidenceSha256",
      "physicalHostLoss",
      "requestedStrategy",
      "reset",
      "status",
      "strategyReadBack",
    ]);
    assert.ok(Object.isFrozen(operation) && Object.isFrozen(operation.after));
    const transitionPath = resolve(f.input.journalDirectory, "transition.json");
    const history = await regularBytes(transitionPath);
    assert.equal(operation.operationEvidenceSha256, sha256(history));
    const after = await afterFile(f, operation);
    assert.deepEqual(await bridge.finish(after), {
      status: "qualified",
      operationEvidenceSha256: operation.operationEvidenceSha256,
    });
    const proofPath = resolve(f.input.journalDirectory, "application-recovery.json");
    const proofBytes = await regularBytes(proofPath);
    const proof = object(JSON.parse(proofBytes.toString()));
    assert.deepEqual(Object.keys(proof).sort(), [
      "after",
      "before",
      "candidateSha256",
      "operationId",
      "schemaVersion",
      "sourceCommit",
      "transitionSha256",
    ]);
    assert.deepEqual(proof.before, {
      ...f.input.beforeCheckpoint,
      path: "application-recovery/application-before.json",
    });
    assert.deepEqual(proof.after, {
      ...after,
      path: "application-recovery/application-after.json",
    });
    assert.equal(proof.sourceCommit, sourceCommit);
    assert.equal(proof.candidateSha256, manifestHash);
    assert.equal(proof.operationId, f.input.operationId);
    assert.equal(proof.transitionSha256, sha256(history));
    assert.deepEqual(
      await regularBytes(transitionPath),
      history,
      "Finish must not rewrite provider history",
    );
    assert.equal(f.calls.length, 2);
    assert.equal(ports.counts.length, 2);
    for (const forbidden of [
      admin,
      "synthetic-account",
      "synthetic-untrusted",
      f.input.preparedDirectory,
      f.evidenceRoot,
    ])
      assert.equal(proofBytes.includes(forbidden), false);
    assert.equal((await bridge.finish(after)).status, "unavailable");
    assert.equal((await bridge.perform(f.input.beforeCheckpoint)).status, "unavailable");
    assert.equal(ports.counts.length, 2);
    assert.equal(f.calls.length, 2);
    assert.deepEqual(await regularBytes(proofPath), proofBytes);
    t.diagnostic(JSON.stringify({ controlledMetadataReadsPerInvocation: ports.counts }));
  } finally {
    await f.close();
  }
});

test("out-of-order/concurrent phases and uncertain perform never trigger automatic new effects", {
  timeout: 120000,
}, async () => {
  const f = await fixture();
  try {
    const ports = factory(f);
    const bridge = createApplicationRecoveryCoordinator(binding(f), () => ports.create());
    assert.equal(
      (
        await bridge.finish({
          ...f.input.beforeCheckpoint,
          path: resolve(f.input.checkpointDirectory, "application-after.json"),
        })
      ).status,
      "unavailable",
    );
    assert.equal((await bridge.perform(f.input.beforeCheckpoint)).status, "unavailable");
    assert.equal(ports.counts.length, 0);
    assert.equal(f.calls.length, 0);
    let release: () => void = () => {
      throw new Error("Missing held factory");
    };
    let entered: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const concurrent = createApplicationRecoveryCoordinator(binding(f), async () => {
      entered();
      await hold;
      return ports.create();
    });
    const first = concurrent.perform(f.input.beforeCheckpoint);
    await acquired;
    assert.equal((await concurrent.perform(f.input.beforeCheckpoint)).status, "unavailable");
    release();
    assert.equal((await first).status, "unavailable");
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
  const uncertain = await fixture("ambiguous-upload");
  try {
    const ports = factory(uncertain);
    const bridge = createApplicationRecoveryCoordinator(binding(uncertain), () => ports.create());
    assert.equal((await bridge.perform(uncertain.input.beforeCheckpoint)).status, "unavailable");
    uncertain.reconnect();
    assert.equal((await bridge.perform(uncertain.input.beforeCheckpoint)).status, "unavailable");
    assert.equal(ports.counts.length, 1);
    assert.equal(uncertain.calls.length, 1);
    assert.equal(uncertain.calls[0]?.[1], "upload");
    await assert.rejects(
      regularBytes(resolve(uncertain.input.journalDirectory, "application-recovery.json")),
    );
  } finally {
    await uncertain.close();
  }
});

test("matching provider flags cannot qualify missing after files or replaced original before anchors", {
  timeout: 120000,
}, async () => {
  for (const fault of ["missing-after", "replaced-before"]) {
    const f = await fixture();
    try {
      const ports = factory(f);
      const before = { ...f.input.beforeCheckpoint };
      const bridge = createApplicationRecoveryCoordinator(binding(f), () => ports.create());
      const operation = await bridge.perform(before);
      if (operation.status !== "operation-confirmed") assert.fail(operation.reason);
      let after = {
        path: resolve(f.input.checkpointDirectory, "application-after.json"),
        size: 2,
        mode: 0o600,
        sha256: sha256("{}"),
      };
      if (fault === "replaced-before") {
        after = await afterFile(f, operation);
        const changed = { ...f.publicBefore, snapshotSha256: sha256("substituted snapshot") };
        await writeFile(before.path, `${canonicalJson(changed)}\n`);
        const changedBytes = await regularBytes(before.path);
        before.sha256 = sha256(changedBytes);
        before.size = changedBytes.length;
      }
      assert.equal((await bridge.finish(after)).status, "unavailable");
      assert.equal(ports.counts.length, 2);
      assert.equal(f.calls.length, 2);
      await assert.rejects(
        regularBytes(resolve(f.input.journalDirectory, "application-recovery.json")),
      );
      assert.equal((await bridge.finish(after)).status, "unavailable");
      assert.equal(ports.counts.length, 2);
    } finally {
      await f.close();
    }
  }
});
