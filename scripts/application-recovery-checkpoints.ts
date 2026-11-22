import assert from "node:assert/strict";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  schemaRefs,
  schemaRegistry,
  validateRelativePath,
  wireLimits,
} from "../packages/fortipi-contract/dist/index.js";
import type {
  ApplicationRecoveryAfter,
  ApplicationRecoveryBefore,
} from "../tests/clients/platform-recovery.ts";
import type { ProviderPhaseResult } from "./platform-recovery.ts";
import {
  assertDeployment,
  canonicalJson,
  commitPattern,
  type DeploymentIdentity,
  digest,
  type FileRecord,
  object,
  sha256,
  string,
} from "./verify-release-gates.ts";

/** The parent supplies its authenticated cached result, never a child assertion
 * that a provider operation happened. This alias preserves the sidecar port. */
export type ApplicationRecoveryProviderResult = ProviderPhaseResult;

const maximum = 1048576;
const ajv = new Ajv2020({ strict: true, allErrors: false, validateFormats: false });
for (const schema of Object.values(schemaRegistry)) ajv.addSchema(schema);
const schemas = Object.fromEntries(
  (["AdmissionReceipt", "Approval", "BackendRef", "WorkspaceBinding"] as const).map((name) => [
    name,
    ajv.compile({ $ref: schemaRefs[name] }),
  ]),
);
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  const record = object(value);
  assert.deepEqual(Object.keys(record).sort(), keys.toSorted(), "Checkpoint fields differ");
  return record;
}
function id(value: unknown) {
  assert.match(string(value, 128), /^[A-Za-z0-9_-]+$/);
}
function time(value: unknown) {
  const text = string(value);
  assert.equal(new Date(text).toISOString(), text, "Invalid checkpoint time");
}
function files(value: unknown) {
  assert.ok(Array.isArray(value) && value.length > 0 && value.length <= 3);
  for (const entry of value) {
    const file = exact(entry, ["path", "size", "sha256"]);
    validateRelativePath(string(file.path, wireLimits.pathBytes));
    assert.ok(
      Number.isSafeInteger(file.size) &&
        Number(file.size) >= 0 &&
        Number(file.size) <= wireLimits.fileBytes,
    );
    digest(file.sha256);
  }
  assert.equal(new Set(value.map((file) => file.path)).size, value.length);
}
function beforeShape(value: unknown): asserts value is ApplicationRecoveryBefore {
  const before = exact(value, [
    "schemaVersion",
    "candidateSha256",
    "sourceCommit",
    "deploymentId",
    "workerVersionId",
    "capturedAt",
    "agentId",
    "conversationId",
    "admission",
    "requestId",
    "jobId",
    "approval",
    "target",
    "eventThrough",
    "eventPrefixSha256",
    "snapshotSha256",
    "workspace",
  ]);
  assert.equal(before.schemaVersion, 1);
  for (const key of ["agentId", "conversationId", "requestId", "jobId"]) id(before[key]);
  for (const [key, name] of [
    ["admission", "AdmissionReceipt"],
    ["approval", "Approval"],
    ["target", "BackendRef"],
  ] as const)
    assert.ok(schemas[name]?.(before[key]), `Invalid checkpoint ${key}`);
  digest(before.eventPrefixSha256);
  digest(before.snapshotSha256);
  assert.ok(
    Number.isSafeInteger(before.eventThrough) &&
      Number(before.eventThrough) >= 0 &&
      Number(before.eventThrough) <= 1000,
  );
  time(before.capturedAt);
  const workspace = exact(before.workspace, ["binding", "files"]);
  assert.ok(schemas.WorkspaceBinding?.(workspace.binding), "Invalid checkpoint workspace");
  files(workspace.files);
  const typed = value as ApplicationRecoveryBefore;
  assert.equal(typed.workspace.binding.config.kind, "computer");
  assert.equal(typed.target.kind, "executor");
  assert.equal(typed.approval.state, "pending");
  for (const key of ["agentId", "conversationId", "jobId"] as const)
    assert.equal(typed.approval[key], typed[key]);
  assert.equal(typed.approval.operation.workspaceId, typed.workspace.binding.workspaceId);
  assert.equal(typed.approval.operation.baseRevision, typed.workspace.binding.revision);
  assert.deepEqual(typed.approval.operation.target, typed.target);
  assert.ok(typed.admission.eventSeq <= typed.eventThrough);
}
function afterShape(value: unknown): asserts value is ApplicationRecoveryAfter {
  const after = exact(value, [
    "schemaVersion",
    "candidateSha256",
    "sourceCommit",
    "beforeCheckpointSha256",
    "workerVersionId",
    "originalTaskId",
    "originalJobId",
    "originalReceiptRetained",
    "originalEventPrefixSha256",
    "actualWorkspaceHashes",
    "continuation",
    "taskState",
    "executionIdentityAbsentBeforeAndAfter",
    "checkedAt",
  ]);
  assert.equal(after.schemaVersion, 1);
  for (const key of ["originalTaskId", "originalJobId"]) id(after[key]);
  digest(after.beforeCheckpointSha256);
  digest(after.originalEventPrefixSha256);
  files(after.actualWorkspaceHashes);
  assert.equal(after.originalReceiptRetained, true);
  assert.equal(after.executionIdentityAbsentBeforeAndAfter, true);
  assert.equal(after.continuation, "public-approval-rejection");
  assert.equal(after.taskState, "completed");
  time(after.checkedAt);
}

function sameFile(actual: Stats, expected: Stats) {
  for (const key of ["dev", "ino", "size", "mode", "nlink", "mtimeMs", "ctimeMs"] as const)
    assert.equal(actual[key], expected[key], "Checkpoint changed during read");
}
async function checkpoint(directory: string, name: string, record: FileRecord) {
  exact(record, ["path", "size", "mode", "sha256"]);
  const path = resolve(directory, name);
  assert.equal(record.path, path, "Unexpected checkpoint path");
  assert.equal(record.mode, 0o600);
  assert.ok(Number.isSafeInteger(record.size) && record.size > 0 && record.size <= maximum);
  digest(record.sha256);
  assert.equal(await realpath(path), path, "Linked checkpoint path");
  const stat = await lstat(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, "Nonregular checkpoint");
  assert.equal(stat.mode & 0o7777, record.mode);
  assert.equal(stat.size, record.size);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    sameFile(await handle.stat(), stat);
    // One allocation with an extra EOF byte. Growth cannot cause an unbounded read.
    const buffer = Buffer.alloc(record.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    assert.equal(length, record.size, "Checkpoint length differs");
    sameFile(await handle.stat(), stat);
    sameFile(await lstat(path), stat);
    assert.equal(await realpath(path), path, "Linked checkpoint path");
    const bytes = buffer.subarray(0, length);
    assert.equal(sha256(bytes), record.sha256, "Checkpoint hash differs");
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    assert.equal(bytes.toString("utf8"), `${canonicalJson(value)}\n`, "Noncanonical checkpoint");
    return value;
  } finally {
    await handle.close();
  }
}
function deployment(value: unknown): asserts value is DeploymentIdentity {
  assertDeployment(value);
  exact(value.capabilities, ["plan", "loaders", "containers"]);
  time(value.checkedAt);
}
const withoutTime = ({ checkedAt: _time, ...value }: DeploymentIdentity) => value;
const stableIdentity = ({
  checkedAt: _time,
  workerVersionId: _version,
  deploymentId: _deployment,
  versions: _versions,
  ...value
}: DeploymentIdentity) => value;

/** Facts for parent artifact composition, NOT provider/application authentication.
 * The parent prebinds this directory, source/candidate, perform's before record
 * and cached provider result. It must authenticate actual IPC/completed producer
 * and application execution before using these facts to qualify bridge.finish. */
export async function validateApplicationRecoveryCheckpoints(input: {
  checkpointDirectory: string;
  candidateSha256: string;
  sourceCommit: string;
  before: FileRecord;
  after: FileRecord;
  provider: ApplicationRecoveryProviderResult;
}) {
  // Snapshot all caller objects before filesystem awaits; canonicalJson rejects accessors/non-JSON.
  const bound = JSON.parse(canonicalJson(input)) as typeof input;
  exact(bound, [
    "checkpointDirectory",
    "candidateSha256",
    "sourceCommit",
    "before",
    "after",
    "provider",
  ]);
  digest(bound.candidateSha256);
  assert.match(string(bound.sourceCommit), commitPattern);
  exact(bound.provider, ["transition", "transitionSha256", "current"]);
  const { transition, transitionSha256, current } = bound.provider;
  exact(transition, [
    "schemaVersion",
    "phase",
    "operationId",
    "intentSha256",
    "candidateSha256",
    "beforeCheckpointSha256",
    "before",
    "after",
    "requestedStrategy",
    "strategyReadBack",
    "reset",
    "incarnation",
    "eviction",
    "physicalHostLoss",
    "requiresApplicationVerification",
  ]);
  assert.equal(
    sha256(`${canonicalJson(transition)}\n`),
    digest(transitionSha256),
    "Transition digest differs",
  );
  assert.equal(transition.schemaVersion, 1);
  assert.equal(transition.phase, "provider-confirmed");
  assert.match(string(transition.operationId), /^[a-f0-9]{32}$/);
  digest(transition.intentSha256);
  assert.equal(transition.requiresApplicationVerification, true);
  assert.equal(transition.requestedStrategy, "immediate");
  assert.equal(transition.strategyReadBack, false);
  assert.equal(transition.reset, "inferred-from-provider-contract");
  for (const key of ["incarnation", "eviction", "physicalHostLoss"] as const)
    assert.equal(transition[key], "not-observed");
  for (const identity of [transition.before, transition.after, current]) {
    deployment(identity);
    assert.equal(identity.sourceCommit, bound.sourceCommit);
    assert.equal(identity.candidateSha256, bound.candidateSha256);
  }
  assert.equal(transition.candidateSha256, bound.candidateSha256);
  assert.equal(transition.beforeCheckpointSha256, bound.before.sha256);
  assert.deepEqual(
    withoutTime(current),
    withoutTime(transition.after),
    "Current deployment differs",
  );
  assert.notEqual(transition.before.workerVersionId, transition.after.workerVersionId);
  assert.notEqual(transition.before.deploymentId, transition.after.deploymentId);
  // Compare all identity fields except the explicitly changed rollout IDs and observation time.
  assert.deepEqual(
    stableIdentity(transition.after),
    stableIdentity(transition.before),
    "Recovery configuration differs",
  );

  const directory = string(bound.checkpointDirectory, 4096);
  assert.equal(
    resolve(directory),
    directory,
    "Checkpoint directory must be prebound absolute path",
  );
  assert.equal(await realpath(directory), directory, "Linked checkpoint directory");
  const directoryStat = await lstat(directory);
  assert.ok(
    directoryStat.isDirectory() && (directoryStat.mode & 0o022) === 0,
    "Unprotected checkpoint directory",
  );
  const before = await checkpoint(directory, "application-before.json", bound.before);
  beforeShape(before);
  const after = await checkpoint(directory, "application-after.json", bound.after);
  afterShape(after);
  assert.equal(await realpath(directory), directory);
  const finalDirectory = await lstat(directory);
  for (const key of ["dev", "ino", "mode"] as const)
    assert.equal(finalDirectory[key], directoryStat[key]);
  for (const value of [before, after]) {
    assert.equal(value.candidateSha256, bound.candidateSha256);
    assert.equal(value.sourceCommit, bound.sourceCommit);
  }
  assert.equal(before.deploymentId, transition.before.deploymentId);
  assert.equal(before.workerVersionId, transition.before.workerVersionId);
  assert.equal(after.beforeCheckpointSha256, bound.before.sha256);
  assert.equal(after.workerVersionId, current.workerVersionId);
  assert.equal(after.originalTaskId, before.admission.taskId);
  assert.equal(after.originalJobId, before.jobId);
  assert.equal(after.originalEventPrefixSha256, before.eventPrefixSha256);
  assert.deepEqual(after.actualWorkspaceHashes, before.workspace.files);
  assert.ok(Date.parse(after.checkedAt) >= Date.parse(before.capturedAt));
  return {
    before: { record: bound.before, checkpoint: before },
    after: { record: bound.after, checkpoint: after },
    provider: bound.provider,
  };
}
