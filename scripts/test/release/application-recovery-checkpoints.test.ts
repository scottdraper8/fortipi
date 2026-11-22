import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";
import type {
  ApplicationRecoveryAfter,
  ApplicationRecoveryBefore,
} from "../../../tests/clients/platform-recovery.ts";
import {
  type ApplicationRecoveryProviderResult,
  validateApplicationRecoveryCheckpoints as validate,
} from "../../application-recovery-checkpoints.ts";
import {
  canonicalJson,
  type DeploymentIdentity,
  type FileRecord,
  sha256,
} from "../../verify-release-gates.ts";

// Synthetic IDs/provider result test local binding only; no actual recovery claim.
const candidateSha256 = sha256("checkpoint candidate");
const sourceCommit = "a".repeat(40);
const capturedAt = "2026-11-12T23:00:00.000Z";
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
async function write(path: string, value: unknown): Promise<FileRecord> {
  const bytes = Buffer.from(`${canonicalJson(value)}\n`);
  await fs.writeFile(path, bytes, { mode: 0o600 });
  return { path, size: bytes.length, mode: 0o600, sha256: sha256(bytes) };
}
async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(resolve(await fs.realpath(tmpdir()), "fortipi-checkpoints-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
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

test("binds actual checkpoint bytes to cached transition and returns only composition facts", async (t) => {
  const { input, before, after } = await fixture(t);
  const result = await validate(input);
  assert.deepEqual(result, {
    before: { record: input.before, checkpoint: before },
    after: { record: input.after, checkpoint: after },
    provider: input.provider,
  });
  assert.equal(Object.hasOwn(result, "status"), false);
  assert.equal(Object.hasOwn(result, "claims"), false);
});

test("substituted checkpoints, stale rollout and changed original task/prefix/workspace cannot compose", async (t) => {
  const { input, before, after, saveAfter } = await fixture(t);
  const original = structuredClone(input);
  const originalAfter = structuredClone(after);
  const [originalWorkspaceFile] = before.workspace.files;
  assert.ok(originalWorkspaceFile);
  const substituted = { ...before, requestId: "substituted-request" };
  input.before = await write(input.before.path, substituted);
  await assert.rejects(validate(input)); // even the attacker's correct new FileRecord is not the perform anchor
  input.before = await write(original.before.path, before);
  const cases: Partial<ApplicationRecoveryAfter>[] = [
    { originalTaskId: "substituted-task" },
    { originalJobId: "substituted-job" },
    { originalEventPrefixSha256: sha256("substituted prefix") },
    {
      actualWorkspaceHashes: [{ ...originalWorkspaceFile, sha256: sha256("substituted bytes") }],
    },
    { workerVersionId: deployment(1).workerVersionId },
    { sourceCommit: "c".repeat(40) },
    { candidateSha256: sha256("different candidate") },
    { beforeCheckpointSha256: sha256("different checkpoint") },
  ];
  for (const change of cases) {
    Object.assign(after, originalAfter);
    Object.assign(after, change);
    await saveAfter();
    await assert.rejects(validate(input), JSON.stringify(change));
  }
  Object.assign(after, originalAfter);
  await saveAfter();
  input.provider.current = deployment(1);
  await assert.rejects(validate(input), /Current deployment differs/);
  input.provider.current = original.provider.current;
  input.provider.transition.after.checkedAt = "2026-11-12T23:01:00.000Z";
  await assert.rejects(validate(input), /Transition digest differs/);
});

test("closed shapes, exact paths, protected files and actual after proof fail closed", async (t) => {
  const { input, after, saveAfter } = await fixture(t);
  const original = structuredClone(after);
  for (const change of [
    { extra: true },
    { originalReceiptRetained: false },
    { executionIdentityAbsentBeforeAndAfter: false },
    { continuation: "child-pass" },
    { taskState: "waiting" },
    { actualWorkspaceHashes: [] },
    {
      actualWorkspaceHashes: after.actualWorkspaceHashes.map((file) => ({ ...file, extra: true })),
    },
  ]) {
    input.after = await write(input.after.path, { ...original, ...change });
    await assert.rejects(validate(input));
  }
  Object.assign(after, original);
  await saveAfter();
  const valid = structuredClone(input.after);
  input.after.size = 1048577;
  await assert.rejects(validate(input));
  input.after = structuredClone(valid);
  input.after.path = resolve(input.checkpointDirectory, "..", "application-after.json");
  await assert.rejects(validate(input), /checkpoint path/);
  input.after = valid;
  await fs.chmod(valid.path, 0o644);
  await assert.rejects(validate(input));
  await fs.chmod(valid.path, 0o600);
  const elsewhere = resolve(input.checkpointDirectory, "elsewhere.json");
  await fs.rename(valid.path, elsewhere);
  await fs.symlink(elsewhere, valid.path);
  await assert.rejects(validate(input), /Linked checkpoint path/);
  await fs.unlink(valid.path);
  await fs.link(elsewhere, valid.path);
  await assert.rejects(validate(input), /Nonregular checkpoint/);
  await fs.unlink(valid.path);
  await assert.rejects(validate(input), /ENOENT/);
});

test("input mutation across awaits cannot replace the cached anchor; filesystem replacement is rejected", async (t) => {
  const { input } = await fixture(t);
  const original = structuredClone(input);
  const pending = validate(input);
  input.provider.transition.beforeCheckpointSha256 = sha256("later anchor");
  input.provider.transitionSha256 = sha256(`${canonicalJson(input.provider.transition)}\n`);
  input.after.sha256 = sha256("later record");
  const result = await pending;
  assert.deepEqual(result.provider, original.provider);
  assert.deepEqual(result.after.record, original.after);

  const actualOpen = fs.open;
  let replaced = false;
  const hook = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await actualOpen(...args);
    if (String(args[0]) === original.before.path && !replaced) {
      replaced = true;
      await fs.rename(original.before.path, `${original.before.path}.old`);
      await fs.copyFile(`${original.before.path}.old`, original.before.path);
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(validate(original), /Checkpoint changed during read/);
    assert.equal(replaced, true);
  } finally {
    hook.mock.restore();
    syncBuiltinESMExports();
  }
});
