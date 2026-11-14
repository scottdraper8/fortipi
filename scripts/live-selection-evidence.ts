import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { FortiPiClient } from "../packages/fortipi-client/dist/node.js";
import {
  type AdmissionReceipt,
  type CommitReceipt,
  type Configuration,
  type ControlReceipt,
  type CredentialMint,
  type CredentialRef,
  type DurableEvent,
  type Job,
  type MessageSubmit,
  manifestDigest,
  type ResourceScope,
  schemaRefs,
  schemaRegistry,
  type Task,
  type UploadBegin,
  type UploadCommit,
  type WorkspaceBinding,
  type WorkspaceLeaseAcquire,
  type WorkspaceOperationLease,
} from "../packages/fortipi-contract/dist/index.js";
import { deviceReadRequests } from "../tests/clients/live-device.ts";
import { openSelectionNativePeer } from "../tests/clients/live-execution-controls.ts";
import {
  emptySelectionScope,
  type NativeTarget,
  rawObject,
  type SelectionCase,
  type SelectionTranscript,
  selectionAttempt,
  selectionCases,
  selectionExport,
  selectionExportScope,
} from "../tests/clients/live-selection-tools.ts";
import type { RecoveryWorkspaceCanary } from "../tests/clients/platform-recovery.ts";
import { type IssuedRole, RoleContext } from "../tests/clients/roles.ts";
import type { Installed } from "../tests/distribution/install.ts";
import { assertTarget, operateDeployment, type TargetDescriptor } from "./deploy-smoke.ts";
import {
  authorizeCurrentDeviceJob,
  currentDeviceJobContext,
  type DeviceJobObservation,
  deviceTargetIdentitySha256,
  type LoadedDeviceCandidate,
  readSelectionCleanupArtifact,
  readSelectionOwnershipArtifacts,
} from "./device-phase-artifacts.ts";
import {
  type LiveDeviceCustodyEnvelope,
  type LiveDeviceCustodyFrame,
  openLiveDeviceRole,
  sealLiveDeviceRole,
} from "./live-device-custody.ts";
import { findReference, initial } from "./live-device-evidence.ts";
import { loadLiveDeviceInstallation } from "./live-device-installation.ts";
import { childEnvironment, execute } from "./prepare-release.ts";
import {
  type ArtifactReference,
  assertDeployment,
  canonicalJson,
  cliArgs,
  type DeploymentIdentity,
  githubRequest,
  object,
  REPOSITORY_ID,
  readJson,
  readProofBundle,
  regularBytes,
  saveJson,
  sha256,
  string,
  verifyPayload,
  verifyProducer,
} from "./verify-release-gates.ts";

const failure =
  "LIVE selection acceptance unavailable or inconsistent; qualification remains blocked";
const stable = ({ checkedAt: _time, ...value }: DeploymentIdentity) => value;
const roleNames = [
  "writer",
  "peer-a",
  "peer-b",
  ...selectionCases.flatMap((name) => [`${name}-client`, `${name}-export`]),
] as const;
const ajv = new Ajv2020({ strict: true, validateFormats: false });
for (const schema of Object.values(schemaRegistry)) ajv.addSchema(schema);
const validators = new Map<string, ReturnType<typeof ajv.compile>>();
function wire(name: string, value: unknown) {
  let valid = validators.get(name);
  if (!valid) {
    valid = ajv.compile({ $ref: schemaRefs[name as keyof typeof schemaRefs] });
    validators.set(name, valid);
  }
  assert.ok(valid(value), failure);
}
export interface SelectionOwnedRole {
  name: string;
  issuance: "not-attempted" | "unknown" | "known";
  mintRequestId: string;
  revokeRequestId: string;
  mint?: CredentialMint;
  credential?: CredentialRef;
  mintSha256?: string;
  custodySha256?: string;
}
export interface SelectionStage {
  owner: string;
  workspaceId: string;
  acquire: WorkspaceLeaseAcquire;
  releaseRequestId: string;
  lease?: WorkspaceOperationLease;
  begin?: UploadBegin;
  uploadId?: string;
  commit?: UploadCommit;
  receipt?: CommitReceipt;
  released?: true;
  terminal?: "committed" | "aborted";
  renewals?: {
    requestId: string;
    lease: WorkspaceOperationLease;
    result?: WorkspaceOperationLease;
  }[];
}
export interface SelectionOwnedAdmission {
  name: SelectionCase;
  turn: "inspect" | "dispatch";
  conversationId: string;
  input: MessageSubmit;
  cancelRequestId: string;
  clientCredential: CredentialRef;
  state: "unknown" | "known";
  receipt?: AdmissionReceipt;
  task?: Task;
}
export interface SelectionOwnership {
  schemaVersion: 1;
  sourceCommit: string;
  candidateSha256: string;
  scope: string;
  producer: DeviceJobObservation["producer"];
  jobId: number;
  checkedAt: string;
  body: {
    mode: "perform" | "verify-existing";
    createdAt: number;
    issuanceDeployment?: DeploymentIdentity;
    reviewedTarget: TargetDescriptor;
    reviewedTargetSha256: string;
    executorIds: [string, string];
    agentRequestId: string;
    workspaceRequestId: string;
    conversationRequestIds: Record<SelectionCase, string>;
    agentId?: string;
    workspaceId?: string;
    conversations: Partial<Record<SelectionCase, string>>;
    phases: {
      phase: "a" | "b" | "f";
      target: TargetDescriptor;
      intentAt: string;
      deployment?: DeploymentIdentity;
    }[];
    roles: SelectionOwnedRole[];
    stages: SelectionStage[];
    jobs: { conversationId: string; jobId: string; taskId: string; cancelRequestId: string }[];
    admissions: SelectionOwnedAdmission[];
    exports: { conversationId: string; requestId: string; operationId?: string }[];
    executorRevocations: { target: NativeTarget; requestId: string; receipt?: unknown }[];
    nativeClosure: "not-started" | "running" | "closed" | "unknown";
    cleanup?: SelectionCleanup;
  };
}
export interface SelectionCleanup {
  schemaVersion: 1;
  state: "complete" | "blocked";
  roles: {
    name: string;
    state: "complete" | "unknown" | "not-issued";
    credential?: CredentialRef;
    receipt?: unknown;
  }[];
  stages: { index: number; state: "complete" | "unknown" }[];
  jobs: { jobId: string; state: "complete" | "unknown" }[];
  admissions: {
    name: SelectionCase;
    turn: "inspect" | "dispatch";
    clientRequestId: string;
    state: "complete" | "unknown";
    task?: Task;
    control?: ControlReceipt;
  }[];
  executors: {
    target: NativeTarget;
    state: "complete" | "unknown" | "not-issued";
    receipt?: unknown;
  }[];
  finalDeployment?: DeploymentIdentity;
}
export interface SelectionCaseProof {
  name: SelectionCase;
  agentId: string;
  conversationId: string;
  admission: AdmissionReceipt;
  task: Task;
  admittedAt: number;
  admittedEventSeq: number;
  inspectAdmission?: AdmissionReceipt;
  prompts: string[];
  before: RecoveryWorkspaceCanary;
  after: RecoveryWorkspaceCanary;
  selected: NativeTarget;
  expected: Parameters<typeof selectionAttempt>[1];
  calls: ReturnType<typeof selectionAttempt>;
  job?: Job;
  receipt?: CommitReceipt;
  intervention?:
    | { kind: "revision"; receipt: CommitReceipt }
    | { kind: "executor"; target: NativeTarget; receipt: unknown }
    | { kind: "expiry"; expiresAt: number; credential: CredentialRef };
  exportOperationId: string;
  native: unknown[];
  events: DurableEvent[];
  nativeWrite?: { jobId: string; executionId: string; size: number; sha256: string };
}
export interface SelectionEvidence {
  schemaVersion: 1;
  mode: "performed";
  sourceCommit: string;
  candidateSha256: string;
  reviewedTarget: TargetDescriptor;
  executorIds: [string, string];
  phases: { phase: "a" | "b" | "f"; target: TargetDescriptor; deployment: DeploymentIdentity }[];
  cases: SelectionCaseProof[];
  cleanup: SelectionCleanup;
  original?: { initial: ArtifactReference; cleanup: ArtifactReference };
}
export interface SelectionAcceptanceData {
  history: SelectionEvidence;
  observation: {
    providerDeploymentId: string;
    workerVersionId: string;
    casesSha256: string;
    checkedAt: string;
    cases: unknown[];
  };
  observedDeployment: DeploymentIdentity;
  initial: ArtifactReference;
  cleanup: ArtifactReference;
}
export function assertSelectionAcceptanceData(
  value: unknown,
  current: DeploymentIdentity,
): asserts value is SelectionAcceptanceData {
  const data = rawObject(value, [
    "history",
    "observation",
    "observedDeployment",
    "initial",
    "cleanup",
  ]);
  assertSelectionEvidence(data.history, current);
  assertDeployment(data.observedDeployment);
  const observation = rawObject(data.observation, [
    "providerDeploymentId",
    "workerVersionId",
    "casesSha256",
    "checkedAt",
    "cases",
  ]);
  assert.equal(observation.providerDeploymentId, data.observedDeployment.deploymentId);
  assert.equal(observation.workerVersionId, data.observedDeployment.workerVersionId);
  assert.equal(observation.casesSha256, sha256(canonicalJson(data.history.cases)));
  assert.ok(Array.isArray(observation.cases) && observation.cases.length === 6);
  assert.deepEqual(observation.cases.map((c) => object(c).name).sort(), [...selectionCases].sort());
  for (const phase of [data.observedDeployment])
    for (const key of [
      "candidateSha256",
      "sourceCommit",
      "origin",
      "workerName",
      "accountBindingSha256",
      "configSha256",
      "runtimeConfigSha256",
      "backend",
    ] as const)
      assert.equal(phase[key], current[key]);
}
export function selectionTarget(final: TargetDescriptor, ranked: string[]): TargetDescriptor {
  assertTarget(final);
  assert.equal(final.backend, "free");
  assert.ok(ranked.length === 2 && new Set(ranked).size === 2);
  for (const id of ranked) assert.match(id, /^[a-zA-Z0-9_-]{1,128}$/);
  const target = structuredClone(final),
    operator = object(target.operator),
    runtime = object(operator.runtime);
  runtime.routing = { kind: "prefer-local", targetIds: ranked };
  assertTarget(target);
  return target;
}
export function assertSelectionOwnership(value: unknown): asserts value is SelectionOwnership {
  const row = rawObject(value, [
    "schemaVersion",
    "sourceCommit",
    "candidateSha256",
    "scope",
    "producer",
    "jobId",
    "checkedAt",
    "body",
  ]);
  assert.equal(row.schemaVersion, 1);
  assert.match(string(row.sourceCommit), /^[a-f0-9]{40}$/);
  assert.match(string(row.candidateSha256), /^[a-f0-9]{64}$/);
  const body = rawObject(
    row.body,
    [
      "mode",
      "createdAt",
      "reviewedTarget",
      "reviewedTargetSha256",
      "executorIds",
      "agentRequestId",
      "workspaceRequestId",
      "conversationRequestIds",
      "conversations",
      "phases",
      "roles",
      "stages",
      "jobs",
      "admissions",
      "exports",
      "executorRevocations",
      "nativeClosure",
    ],
    ["agentId", "workspaceId", "cleanup", "issuanceDeployment"],
  );
  assertTarget(body.reviewedTarget);
  assert.ok(body.mode === "perform" || body.mode === "verify-existing");
  assert.ok(
    typeof body.createdAt === "number" &&
      Number.isSafeInteger(body.createdAt) &&
      body.createdAt > 0,
  );
  assert.ok(["not-started", "running", "closed", "unknown"].includes(String(body.nativeClosure)));
  assert.equal(body.reviewedTargetSha256, sha256(canonicalJson(body.reviewedTarget)));
  const ids = body.executorIds;
  assert.ok(Array.isArray(ids) && ids.length === 2 && ids[0] !== ids[1]);
  for (const id of ids) assert.match(id, /^[a-zA-Z0-9_-]{1,128}$/);
  assert.ok(Array.isArray(body.roles) && body.roles.length === roleNames.length);
  assert.deepEqual(
    body.roles.map((r) => r.name),
    roleNames,
  );
  for (const role of body.roles as SelectionOwnedRole[]) {
    rawObject(
      role,
      ["name", "issuance", "mintRequestId", "revokeRequestId"],
      ["mint", "credential", "mintSha256", "custodySha256"],
    );
    assert.ok(["not-attempted", "unknown", "known"].includes(role.issuance));
    if (role.credential) wire("CredentialRef", role.credential);
    assert.equal(role.issuance === "known", role.credential !== undefined);
    assert.equal(role.issuance !== "not-attempted", role.mint !== undefined);
    if (role.mint) {
      wire("CredentialMint", role.mint);
      assert.equal(role.mint.requestId, role.mintRequestId);
      assert.equal(role.mint.expiresAt, body.createdAt + 55 * 60000);
      assert.equal(
        role.mint.grants.length,
        role.name === "expired-grant-client" && body.mode === "perform" ? 2 : 1,
      );
      assert.equal(role.mintSha256, sha256(canonicalJson(role.mint)));
      for (const grant of role.mint.grants) {
        const resources = grant.resources;
        for (const values of Object.values(resources))
          assert.ok(Array.isArray(values) && !values.includes("*"));
        assert.ok(resources.agentIds.every((id) => id === body.agentId));
        assert.ok(
          resources.conversationIds.every((id) =>
            Object.values(body.conversations as object).includes(id),
          ),
        );
        assert.ok(resources.workspaceIds.every((id) => id === body.workspaceId));
        assert.ok(
          resources.executorIds.every((id) => ids.includes(id)) &&
            resources.backendIds.length === 0,
        );
        if (role.name.endsWith("-export"))
          assert.deepEqual(
            resources,
            selectionExportScope(
              string(body.agentId),
              string((body.conversations as Record<string, string>)[role.name.slice(0, -7)]),
            ),
          );
      }
    }
  }
  assert.ok(Array.isArray(body.executorRevocations) && body.executorRevocations.length === 2);
  for (const [index, revocation] of body.executorRevocations.entries())
    assert.deepEqual(revocation.target, {
      kind: "executor",
      executorId: ids[index],
      generation: 1,
    });
  assert.ok(Array.isArray(body.phases) && body.phases.length <= 3);
  for (const [index, phase] of (body.phases as SelectionOwnership["body"]["phases"]).entries()) {
    assert.equal(phase.phase, ["a", "b", "f"][index]);
    assert.deepEqual(
      phase.target,
      index === 2
        ? body.reviewedTarget
        : selectionTarget(body.reviewedTarget, index === 0 ? ids : [...ids].reverse()),
    );
    if (phase.deployment) assertDeployment(phase.deployment);
  }
  assert.ok(
    Array.isArray(body.stages) &&
      body.stages.length <= 2 &&
      Array.isArray(body.jobs) &&
      body.jobs.length <= 3 &&
      Array.isArray(body.exports) &&
      body.exports.length <= 15,
  );
  const admissions = body.admissions;
  assert.ok(Array.isArray(admissions) && admissions.length <= 9);
  assert.equal(new Set(admissions.map((row) => `${row.name}:${row.turn}`)).size, admissions.length);
  for (const row of admissions as SelectionOwnedAdmission[]) {
    rawObject(
      row,
      ["name", "turn", "conversationId", "input", "cancelRequestId", "clientCredential", "state"],
      ["receipt", "task"],
    );
    assert.ok(selectionCases.includes(row.name));
    assert.ok(
      row.turn === "dispatch" ||
        (row.turn === "inspect" &&
          !["preferred-a", "preferred-b", "override-a"].includes(row.name)),
    );
    assert.equal(row.conversationId, (body.conversations as Record<string, string>)[row.name]);
    wire("MessageSubmit", row.input);
    wire("CredentialRef", row.clientCredential);
    assert.deepEqual(
      row.clientCredential,
      (body.roles as SelectionOwnedRole[]).find((role) => role.name === `${row.name}-client`)
        ?.credential,
    );
    assert.ok(row.state === "unknown" || row.state === "known");
    assert.equal(row.state === "known", row.receipt !== undefined);
    if (row.receipt) wire("AdmissionReceipt", row.receipt);
    if (row.task) {
      wire("Task", row.task);
      assert.equal(row.task.taskId, row.receipt?.taskId);
      assert.equal(row.task.conversationId, row.conversationId);
    }
  }
  for (const stage of body.stages as SelectionStage[]) {
    assert.equal(stage.owner, "writer");
    assert.equal(stage.workspaceId, body.workspaceId);
    wire("WorkspaceLeaseAcquire", stage.acquire);
    if (stage.lease) wire("WorkspaceOperationLease", stage.lease);
    if (stage.begin) wire("UploadBegin", stage.begin);
    if (stage.commit) wire("UploadCommit", stage.commit);
    if (stage.receipt) wire("CommitReceipt", stage.receipt);
  }
}
export class SelectionJournal {
  readonly tokens: string[] = [];
  readonly custody: Record<string, LiveDeviceCustodyEnvelope> = {};
  readonly issued = new Map<string, IssuedRole>();
  readonly ownership: SelectionOwnership;
  readonly roles: RoleContext;
  readonly key: string;
  readonly persist: (
    ownership: SelectionOwnership,
    custody: Record<string, LiveDeviceCustodyEnvelope>,
  ) => Promise<void>;
  constructor(
    ownership: SelectionOwnership,
    roles: RoleContext,
    key: string,
    persist: SelectionJournal["persist"],
  ) {
    this.ownership = ownership;
    this.roles = roles;
    this.key = key;
    this.persist = persist;
  }
  async save() {
    this.ownership.checkedAt = new Date().toISOString();
    assertSelectionOwnership(this.ownership);
    this.roles.assertSanitized(this.ownership, this.tokens);
    await this.persist(structuredClone(this.ownership), structuredClone(this.custody));
  }
  frame(role: SelectionOwnedRole): LiveDeviceCustodyFrame {
    const deployment = this.ownership.body.issuanceDeployment;
    assert.ok(deployment && role.credential && role.mint?.expiresAt);
    return {
      sourceCommit: this.ownership.sourceCommit,
      candidateSha256: this.ownership.candidateSha256,
      repositoryId: REPOSITORY_ID,
      runId: this.ownership.producer.runId,
      runAttempt: this.ownership.producer.runAttempt,
      targetIdentitySha256: deviceTargetIdentitySha256(deployment),
      credentialRef: role.credential,
      createdAt: this.ownership.body.createdAt,
      expiresAt: role.mint.expiresAt,
    };
  }
  async mint(
    name: string,
    input: CredentialMint extends infer T
      ? T extends CredentialMint
        ? Omit<T, "requestId">
        : never
      : never,
  ): Promise<IssuedRole> {
    const row = this.ownership.body.roles.find((r) => r.name === name);
    assert.ok(row && row.issuance === "not-attempted");
    const mint = { ...input, requestId: row.mintRequestId } as CredentialMint;
    row.mint = structuredClone(mint);
    row.mintSha256 = sha256(canonicalJson(mint));
    row.issuance = "unknown";
    await this.save();
    // A failed/lost reply stays unknown. Never repeat this one-time issuance.
    const receipt = await this.roles.call({
      operationId: "mintCredential",
      path: {},
      query: {},
      body: mint,
    });
    if ("token" in receipt && typeof receipt.token === "string") this.tokens.push(receipt.token);
    wire("CredentialRef", receipt.credential);
    row.credential = structuredClone(receipt.credential);
    row.issuance = "known";
    await this.save();
    wire("CredentialReceipt", receipt);
    assert.equal(receipt.state, "issued");
    assert.equal(receipt.role, input.role);
    assert.equal(receipt.expiresAt, input.expiresAt);
    if (receipt.state !== "issued") throw new Error(failure);
    const envelope = sealLiveDeviceRole({
      key: this.key,
      role: receipt,
      frame: this.frame(row),
      now: Date.now(),
    });
    this.custody[name] = envelope;
    row.custodySha256 = sha256(canonicalJson(envelope));
    await this.save();
    this.issued.set(name, receipt);
    return receipt;
  }
}

/** Save original send coordinates before requesting admission, then its actual
 * receipt before waiting for approval. Unknown replies are never resent. */
export async function sendSelectionTurn(
  journal: SelectionJournal,
  client: { conversations: Pick<FortiPiClient["conversations"], "send"> },
  name: SelectionCase,
  turn: SelectionOwnedAdmission["turn"],
  content: string,
  clientCredential: CredentialRef,
) {
  const body = journal.ownership.body;
  assert.ok(
    !body.admissions.some((row) => row.name === name && row.turn === turn),
    "An uncertain or acknowledged original send cannot be replaced",
  );
  const conversationId = body.conversations[name];
  assert.ok(conversationId);
  const row: SelectionOwnedAdmission = {
    name,
    turn,
    conversationId,
    input: { clientRequestId: randomUUID(), content, busyBehavior: "followUp" },
    cancelRequestId: randomUUID(),
    clientCredential,
    state: "unknown",
  };
  body.admissions.push(row);
  await journal.save();
  const receipt = await deviceReadRequests()(() =>
    client.conversations.send(conversationId, row.input),
  );
  wire("AdmissionReceipt", receipt);
  row.receipt = structuredClone(receipt);
  row.state = "known";
  await journal.save();
  return { receipt, row };
}
export async function cleanupSelectionResources(input: {
  ownership: SelectionOwnership;
  roles: RoleContext;
  settleStage: (stage: SelectionStage) => Promise<void>;
}): Promise<SelectionCleanup> {
  assertSelectionOwnership(input.ownership);
  const body = input.ownership.body;
  const final =
    body.mode === "verify-existing" ? body.issuanceDeployment : body.phases[2]?.deployment;
  const result: SelectionCleanup = {
    schemaVersion: 1,
    state: "complete",
    roles: [],
    stages: [],
    jobs: [],
    admissions: [],
    executors: [],
    ...(final ? { finalDeployment: final } : {}),
  };
  for (const [index, stage] of body.stages.entries()) {
    let state: "complete" | "unknown" = "unknown";
    try {
      await input.settleStage(stage);
      state = "complete";
    } catch {
      /* Continue every known owned resource. */
    }
    result.stages.push({ index, state });
  }
  for (const admission of body.admissions) {
    let task = admission.task,
      control: ControlReceipt | undefined;
    let state: "complete" | "unknown" = "unknown";
    try {
      assert.ok(admission.state === "known" && admission.receipt);
      // Recorded terminal public Tasks are immutable closure, not new reads.
      // Every accepted task lacking that observation is visited before any job
      // lookup, including interruption before approval/job discovery.
      if (!task || !["completed", "cancelled", "failed"].includes(task.status.state)) {
        task = await input.roles.call({
          operationId: "describeTask",
          path: { id: admission.receipt.taskId },
          query: {},
          body: undefined,
        });
        assert.equal(task.conversationId, admission.conversationId);
        if (!["completed", "cancelled", "failed"].includes(task.status.state)) {
          control = await input.roles.call({
            operationId: "cancelTask",
            path: { id: admission.receipt.taskId },
            query: {},
            body: { requestId: admission.cancelRequestId },
          });
          wire("ControlReceipt", control);
          assert.ok(
            control.disposition.state !== "unknown" &&
              control.disposition.possibleExternalEffects === false,
            "Cancellation uncertainty remains blocking",
          );
          task = await until(
            () =>
              input.roles.call({
                operationId: "describeTask",
                path: { id: admission.receipt!.taskId },
                query: {},
                body: undefined,
              }),
            (current) =>
              ["completed", "cancelled", "failed", "interrupted"].includes(current.status.state),
          );
        }
      }
      wire("Task", task);
      assert.equal(task.taskId, admission.receipt.taskId);
      assert.equal(task.conversationId, admission.conversationId);
      assert.ok(["completed", "cancelled", "failed"].includes(task.status.state));
      state = "complete";
    } catch {
      /* Unknown send/closure blocks but never prevents known cleanup. */
    }
    result.admissions.push({
      name: admission.name,
      turn: admission.turn,
      clientRequestId: admission.input.clientRequestId,
      state,
      ...(task ? { task } : {}),
      ...(control ? { control } : {}),
    });
  }
  for (const job of body.jobs) {
    let state: "complete" | "unknown" = "unknown";
    try {
      let current = await input.roles.call({
        operationId: "describeJob",
        path: { id: job.jobId },
        query: {},
        body: undefined,
      });
      if (
        [
          "created",
          "awaiting_approval",
          "authorized",
          "queued",
          "waiting_for_executor",
          "waiting_for_local_policy",
        ].includes(current.state) &&
        !current.execution
      ) {
        await input.roles.call({
          operationId: "cancelTask",
          path: { id: job.taskId },
          query: {},
          body: { requestId: job.cancelRequestId },
        });
        current = await until(
          () =>
            input.roles.call({
              operationId: "describeJob",
              path: { id: job.jobId },
              query: {},
              body: undefined,
            }),
          (value) =>
            ["cancelled", "completed", "failed", "requires_reconciliation"].includes(value.state),
        );
      }
      // Unknown effects are never acknowledged/replayed by fixture cleanup.
      assert.ok(["completed", "cancelled", "failed"].includes(current.state));
      state = "complete";
    } catch {
      /* A live or uncertain job blocks cleanup, even if roles revoke. */
    }
    result.jobs.push({ jobId: job.jobId, state });
  }
  for (const [index, row] of body.executorRevocations.entries()) {
    const issued = body.roles.find((r) => r.name === (index === 0 ? "peer-a" : "peer-b"))!;
    if (issued.issuance === "not-attempted") {
      result.executors.push({ target: row.target, state: "not-issued" });
      continue;
    }
    let receipt: unknown;
    try {
      const revoke = () =>
        input.roles.call({
          operationId: "revokeExecutor",
          path: { id: row.target.executorId },
          query: {},
          body: { requestId: row.requestId, expectedGeneration: row.target.generation },
        });
      let current = await revoke();
      const end = Date.now() + 15000;
      while (current.state !== "complete" && Date.now() < end) {
        await delay(100);
        current = await revoke();
      }
      assert.equal(current.state, "complete");
      assert.equal(current.pendingRecipients.length, 0);
      receipt = current;
    } catch {
      /* A partial enrollment remains owned and blocking. */
    }
    result.executors.push({
      target: row.target,
      state: receipt ? "complete" : "unknown",
      ...(receipt ? { receipt } : {}),
    });
  }
  for (const row of body.roles) {
    if (row.issuance === "not-attempted") {
      result.roles.push({ name: row.name, state: "not-issued" });
      continue;
    }
    if (!row.credential) {
      result.roles.push({ name: row.name, state: "unknown" });
      continue;
    }
    let receipt: unknown;
    try {
      const revoke = () =>
        input.roles.call({
          operationId: "revokeCredential",
          path: { id: row.credential!.credentialId },
          query: {},
          body: { requestId: row.revokeRequestId, expectedGeneration: row.credential!.generation },
        });
      let current = await revoke();
      const end = Date.now() + 15000;
      while (current.state !== "complete" && Date.now() < end) {
        await delay(100);
        current = await revoke();
      }
      assert.equal(current.state, "complete");
      assert.equal(current.pendingRecipients.length, 0);
      receipt = current;
    } catch {
      /* Record uncertainty and continue. */
    }
    result.roles.push({
      name: row.name,
      state: receipt ? "complete" : "unknown",
      credential: row.credential,
      ...(receipt ? { receipt } : {}),
    });
  }
  if (
    !result.finalDeployment ||
    !["closed", "not-started"].includes(body.nativeClosure) ||
    result.roles.some((r) => r.state === "unknown") ||
    result.executors.some((r) => r.state === "unknown") ||
    result.stages.some((r) => r.state === "unknown") ||
    result.jobs.some((r) => r.state === "unknown") ||
    result.admissions.some((row) => row.state === "unknown")
  )
    result.state = "blocked";
  return result;
}

async function selectionSetup(
  installationPath: string,
  expected: "initial" | "cleanup" | "operate",
) {
  const state = await loadLiveDeviceInstallation(installationPath),
    context = currentDeviceJobContext();
  assert.equal(context.job, expected);
  const loaded = { candidate: state.installed.candidate, hash: state.installed.hash };
  const job = await authorizeCurrentDeviceJob(
    { loaded, context },
    githubRequest(process.env.GITHUB_TOKEN),
  );
  return { ...state, loaded, context, job };
}
type Setup = Awaited<ReturnType<typeof selectionSetup>>;
function adminKey() {
  const key = process.env.FORTIPI_ADMIN_TOKEN;
  assert.ok(key && key.length >= 32);
  return key;
}
async function phaseConfiguration(
  state: Pick<Setup, "loaded">,
  deployment: DeploymentIdentity,
  roles: RoleContext,
) {
  assert.equal(deployment.sourceCommit, state.loaded.candidate.sourceCommit);
  assert.equal(deployment.candidateSha256, state.loaded.hash);
  const configuration = await roles.call({
    operationId: "getConfiguration",
    path: {},
    query: {},
    body: undefined,
  });
  assert.equal(configuration.version, deployment.publicConfigurationVersion);
  assert.equal(sha256(canonicalJson(configuration)), deployment.runtimeConfigSha256);
  return configuration;
}
export function createSelectionOwnership(
  state: Pick<Setup, "loaded" | "target" | "job">,
  ids: [string, string] = [randomUUID(), randomUUID()],
): SelectionOwnership {
  return {
    schemaVersion: 1,
    sourceCommit: state.loaded.candidate.sourceCommit,
    candidateSha256: state.loaded.hash,
    scope: state.loaded.candidate.scope,
    producer: state.job.producer,
    jobId: state.job.job.id,
    checkedAt: new Date().toISOString(),
    body: {
      mode: "perform",
      createdAt: Date.now(),
      reviewedTarget: structuredClone(state.target),
      reviewedTargetSha256: sha256(canonicalJson(state.target)),
      executorIds: ids,
      agentRequestId: randomUUID(),
      workspaceRequestId: randomUUID(),
      conversationRequestIds: Object.fromEntries(
        selectionCases.map((name) => [name, randomUUID()]),
      ) as Record<SelectionCase, string>,
      conversations: {},
      phases: [],
      stages: [],
      jobs: [],
      admissions: [],
      exports: [],
      nativeClosure: "not-started",
      roles: roleNames.map((name) => ({
        name,
        issuance: "not-attempted",
        mintRequestId: randomUUID(),
        revokeRequestId: randomUUID(),
      })),
      executorRevocations: ids.map((executorId) => ({
        target: { kind: "executor", executorId, generation: 1 },
        requestId: randomUUID(),
      })),
    },
  };
}
async function preparePhase(
  state: Setup,
  phase: "a" | "b",
  target: TargetDescriptor,
  directory: string,
) {
  const operatorPath = resolve(directory, `${phase}-operator.json`),
    prepared = resolve(state.installed.directory, `selection-${phase}-prepared`),
    installation = resolve(directory, `${phase}-installation.json`);
  await saveJson(operatorPath, target.operator);
  const result = await execute(
    process.execPath,
    [
      state.installed.cliBin,
      "prepare",
      "--config",
      operatorPath,
      "--directory",
      prepared,
      "--non-interactive",
      "--json",
    ],
    state.installed.consumer,
    childEnvironment(),
    120000,
  );
  assert.ok(result.code === 0 && !result.timedOut, failure);
  const receipt = object(JSON.parse(result.stdout));
  assert.equal(receipt.assetManifestSha256, state.loaded.candidate.assetManifestSha256);
  const original = object(await readJson(resolve(directory, "original-installation.json")));
  await saveJson(installation, { ...original, prepared, target });
  await state.installed.verifyUnchanged();
  return installation;
}
export async function operateSelection(input: {
  installationPath: string;
  out: string;
  proofsPath: string;
  confirmation: string;
  previous?: string;
  directory: string;
}) {
  const state = await selectionSetup(input.installationPath, "initial");
  if (state.target.backend !== "free") {
    await operateDeployment(
      state.context.operation,
      input.installationPath,
      input.out,
      input.confirmation,
      input.proofsPath,
      input.previous,
    );
    if (state.context.operation === "verify") {
      assert.ok(input.previous);
      await cp(input.previous, `${input.out}.cli.json`);
    }
    return;
  }
  await mkdir(input.directory, { recursive: true, mode: 0o700 });
  await saveJson(
    resolve(input.directory, "original-installation.json"),
    await readJson(input.installationPath),
  );
  const owned = createSelectionOwnership(state),
    declared = object(object(state.target.operator).deployment),
    key = adminKey();
  const roles = new RoleContext(string(declared.origin), key);
  const journal = new SelectionJournal(owned, roles, key, async (ownership, custody) => {
    await saveJson(
      resolve(input.directory, "custody/selection-custody.json"),
      {
        schemaVersion: 1,
        sourceCommit: ownership.sourceCommit,
        candidateSha256: ownership.candidateSha256,
        scope: ownership.scope,
        producer: ownership.producer,
        jobId: ownership.jobId,
        checkedAt: ownership.checkedAt,
        body: { roles: custody },
      },
      false,
    );
    await saveJson(
      resolve(input.directory, "ownership/selection-ownership.json"),
      ownership,
      false,
    );
  });
  // Both empty custody and ownership survive a failure before the first rollout.
  await journal.save();
  if (state.context.operation === "verify") {
    owned.body.mode = "verify-existing";
    await journal.save();
    await operateDeployment(
      "verify",
      input.installationPath,
      input.out,
      input.confirmation,
      input.proofsPath,
      input.previous,
    );
    assert.ok(input.previous);
    await cp(input.previous, `${input.out}.cli.json`);
    const current = await readJson(input.out);
    assertDeployment(current);
    const history = await originalSelection(state.loaded, input.proofsPath, current);
    owned.body.issuanceDeployment = current;
    owned.body.executorIds = history.executorIds;
    owned.body.executorRevocations = history.executorIds.map((executorId) => ({
      target: { kind: "executor", executorId, generation: 1 },
      requestId: randomUUID(),
    }));
    owned.body.agentId = history.cases[0]!.agentId;
    owned.body.workspaceId = history.cases[0]!.before.binding.workspaceId;
    owned.body.conversations = Object.fromEntries(
      history.cases.map((c) => [c.name, c.conversationId]),
    );
    await journal.save();
    let observation: unknown;
    try {
      observation = await verifyExistingSelection(state.installed, journal, current, history);
    } finally {
      owned.body.cleanup = await cleanupSelectionResources({
        ownership: owned,
        roles,
        settleStage: (stage) => settleOwnedStage(journal, state.installed, stage),
      });
      await journal.save();
    }
    assert.equal(owned.body.cleanup.state, "complete");
    await saveJson(resolve(input.directory, "selection.json"), { history, observation });
    return;
  }
  const peers: NativePeer[] = [],
    cases: SelectionCaseProof[] = [];
  let observation: unknown;
  async function rollout(phase: "a" | "b" | "f") {
    const target =
      phase === "f"
        ? state.target
        : selectionTarget(
            state.target,
            phase === "a" ? owned.body.executorIds : [...owned.body.executorIds].reverse(),
          );
    const installationPath =
      phase === "f"
        ? input.installationPath
        : await preparePhase(state, phase, target, input.directory);
    const record: SelectionOwnership["body"]["phases"][number] = {
      phase,
      target,
      intentAt: new Date().toISOString(),
    };
    owned.body.phases.push(record);
    await journal.save();
    const out = phase === "f" ? input.out : resolve(input.directory, `${phase}-deployment.json`);
    await operateDeployment("deploy", installationPath, out, input.confirmation, input.proofsPath);
    const deployment = await readJson(out);
    assertDeployment(deployment);
    record.deployment = deployment;
    await journal.save();
    const configuration = await phaseConfiguration(state, deployment, roles);
    if (phase !== "f")
      assert.deepEqual(configuration.routing, {
        kind: "prefer-local",
        targetIds: phase === "a" ? owned.body.executorIds : [...owned.body.executorIds].reverse(),
      });
    return { deployment, configuration };
  }
  try {
    const a = await rollout("a");
    owned.body.issuanceDeployment = a.deployment;
    await journal.save();
    const config = a.configuration;
    assert.equal(config.workspace.kind, "computer");
    let models = await roles.call({
      operationId: "listModels",
      path: {},
      query: { limit: 100 },
      body: undefined,
    });
    const cursors = new Set<string>();
    let model = config.models.find(
      (m) =>
        m.providerId === "cloudflare" &&
        models.items.some(
          (v) => v.available && v.providerId === m.providerId && v.modelId === m.modelId,
        ),
    );
    while (!model && models.nextPageToken) {
      assert.ok(!cursors.has(models.nextPageToken));
      cursors.add(models.nextPageToken);
      models = await roles.call({
        operationId: "listModels",
        path: {},
        query: { limit: 100, pageToken: models.nextPageToken },
        body: undefined,
      });
      model = config.models.find(
        (m) =>
          m.providerId === "cloudflare" &&
          models.items.some(
            (v) => v.available && v.providerId === m.providerId && v.modelId === m.modelId,
          ),
      );
    }
    assert.ok(model, failure);
    const agent = await roles.call({
      operationId: "createAgent",
      path: {},
      query: {},
      body: { requestId: owned.body.agentRequestId, name: "selection-acceptance", model },
    });
    owned.body.agentId = agent.agentId;
    await journal.save();
    for (const name of selectionCases) {
      const conversation = await roles.call({
        operationId: "createConversation",
        path: { agentId: agent.agentId },
        query: {},
        body: { requestId: owned.body.conversationRequestIds[name], title: `selection-${name}` },
      });
      owned.body.conversations[name] = conversation.conversationId;
      await journal.save();
    }
    const binding = await roles.call({
      operationId: "createWorkspace",
      path: {},
      query: {},
      body: { requestId: owned.body.workspaceRequestId, config: { kind: "computer" } },
    });
    owned.body.workspaceId = binding.workspaceId;
    await journal.save();
    const writerScope = {
      ...emptySelectionScope(),
      workspaceIds: [binding.workspaceId],
      actions: ["workspace.write", "workspace.read", "workspaces.read"],
    };
    const writerRole = await scopedRole(journal, "writer", writerScope),
      writer = await installedClient(state.installed, roles.endpoint, writerRole.token);
    let workspace = (
      await publishNotes(journal, writer, binding, Buffer.from(`selection-input:${randomUUID()}\n`))
    ).workspace;
    const logical = (await writer.negotiate()).deploymentId;
    for (const [index, executorId] of owned.body.executorIds.entries()) {
      const resources: ResourceScope = {
        ...emptySelectionScope(),
        agentIds: [agent.agentId],
        conversationIds: Object.values(owned.body.conversations),
        workspaceIds: [binding.workspaceId],
        executorIds: [executorId],
        tools: ["shell"],
        actions: [
          "tickets.mint",
          "executors.register",
          "transfers.input",
          "transfers.output",
          "transfers.status",
          "workspace.read",
          "workspace.write",
          "artifacts.read",
        ],
      };
      const role = await scopedRole(
        journal,
        index === 0 ? "peer-a" : "peer-b",
        resources,
        "executor",
        executorId,
      );
      owned.body.nativeClosure = "running";
      await journal.save();
      peers.push(
        await openSelectionNativePeer({
          installed: state.installed,
          roles,
          role,
          executorId,
          resources,
          workspace,
          logicalApplicationId: logical,
        }),
      );
    }
    const pair = peers as [NativePeer, NativePeer];
    async function perform(name: SelectionCase, configuration: Configuration) {
      const proof = await runCase({
        journal,
        installed: state.installed,
        name,
        workspace,
        peers: pair,
        configuration,
        writer,
      });
      cases.push(proof);
      workspace = proof.after;
    }
    await perform("preferred-a", a.configuration);
    await Promise.all(peers.map((p) => p.settled()));
    const beforeRollout = await Promise.all(peers.map((p) => p.snapshot()));
    const b = await rollout("b");
    assert.deepEqual(await Promise.all(peers.map((p) => p.snapshot())), beforeRollout);
    await perform("preferred-b", b.configuration);
    await perform("override-a", b.configuration);
    await perform("stale-revision", b.configuration);
    await perform("expired-grant", b.configuration);
    await perform("stale-executor", b.configuration);
    await Promise.all(peers.map((p) => p.settled()));
    const f = await rollout("f");
    observation = await verifyExistingSelection(state.installed, journal, f.deployment, { cases });
  } finally {
    const closure = await Promise.allSettled(peers.map((peer) => peer.close()));
    owned.body.nativeClosure = closure.every((row) => row.status === "fulfilled")
      ? "closed"
      : "unknown";
    await journal.save();
    owned.body.cleanup = await cleanupSelectionResources({
      ownership: owned,
      roles,
      settleStage: (stage) => settleOwnedStage(journal, state.installed, stage),
    });
    await journal.save();
  }
  const current = owned.body.phases[2]?.deployment;
  assert.ok(current);
  const evidence: SelectionEvidence = {
    schemaVersion: 1,
    mode: "performed",
    sourceCommit: owned.sourceCommit,
    candidateSha256: owned.candidateSha256,
    reviewedTarget: state.target,
    executorIds: owned.body.executorIds,
    phases: owned.body.phases.map((p) => {
      assert.ok(p.deployment);
      return { phase: p.phase, target: p.target, deployment: p.deployment };
    }),
    cases,
    cleanup: owned.body.cleanup!,
  };
  assertSelectionEvidence(evidence, current);
  roles.assertSanitized(evidence, journal.tokens);
  assert.ok(observation);
  await saveJson(resolve(input.directory, "selection.json"), { history: evidence, observation });
  await state.installed.verifyUnchanged();
}

export async function verifyExistingSelection(
  installed: Installed,
  journal: SelectionJournal,
  current: DeploymentIdentity,
  evidence: Pick<SelectionEvidence, "cases">,
) {
  const request = deviceReadRequests(),
    observations: unknown[] = [];
  await phaseConfiguration(
    { loaded: { candidate: installed.candidate, hash: installed.hash } },
    current,
    journal.roles,
  );
  for (const proof of evidence.cases) {
    const resources = {
      ...caseScope(journal, proof.name),
      actions: [
        "conversations.read",
        "tasks.read",
        "jobs.read",
        "events.read",
        "workspace.read",
        "workspaces.read",
      ],
    };
    const role =
      journal.issued.get(`${proof.name}-client`) ??
      (await scopedRole(journal, `${proof.name}-client`, resources));
    const exportRole =
      journal.issued.get(`${proof.name}-export`) ??
      (await scopedRole(
        journal,
        `${proof.name}-export`,
        selectionExportScope(proof.agentId, proof.conversationId),
        "admin",
      ));
    const client = await installedClient(installed, current.origin, role.token),
      exporter = await installedClient(installed, current.origin, exportRole.token);
    const task = await request(() => client.tasks.get(proof.admission.taskId));
    assert.equal(task.conversationId, proof.conversationId);
    assert.deepEqual(task, proof.task);
    const fresh = await exported(journal, exporter, proof.name),
      calls = selectionAttempt(fresh.transcript, proof.expected);
    assert.deepEqual(calls, proof.calls);
    assert.deepEqual(
      fresh.transcript.messages.map((m) => m.content),
      proof.prompts,
    );
    assert.equal(fresh.transcript.messages.at(-1)?.messageId, proof.admission.messageId);
    if (proof.job) {
      const job = await request(() => client.jobs.get(proof.job!.jobId));
      assert.deepEqual(job, proof.job);
      assert.ok(proof.receipt);
      const receipt = await request(() =>
        client.uploads.receipt(proof.receipt!.workspaceId, proof.receipt!.commitId, {
          commitDigest: proof.receipt!.commitDigest,
        }),
      );
      assert.deepEqual(receipt, proof.receipt);
    }
    await publicBytes(client, proof.before);
    await publicBytes(client, proof.after);
    const through = Math.max(
      ...proof.events.map((event) => event.eventSeq),
      proof.admission.eventSeq,
      proof.admittedEventSeq,
    );
    assert.ok(through <= 1000);
    let after = 0;
    const events: DurableEvent[] = [];
    while (after < through) {
      const page = await request(() =>
        client.conversations.events(proof.conversationId, { after }),
      );
      assert.ok(page.retainedFloor <= 1);
      const previous = after;
      for (const event of page.events.filter((e) => e.eventSeq <= through)) {
        assert.equal(event.eventSeq, after + 1);
        after = event.eventSeq;
        events.push(event);
      }
      assert.ok(after > previous && (after >= through || page.hasMore));
    }
    for (const event of proof.events)
      assert.deepEqual(
        events.find((current) => current.eventSeq === event.eventSeq),
        event,
      );
    const admitted = events.find((event) => event.eventSeq === proof.admittedEventSeq);
    assert.ok(admitted && admitted.type === "message.committed");
    assert.equal(admitted.timestamp, proof.admittedAt);
    assert.equal(object(admitted.payload).messageId, proof.admission.messageId);
    observations.push({
      name: proof.name,
      conversationId: proof.conversationId,
      taskId: task.taskId,
      exportOperationId: fresh.operationId,
      callFactsSha256: sha256(canonicalJson(calls)),
      before: proof.before.files,
      after: proof.after.files,
      ...(proof.job
        ? { jobId: proof.job.jobId, receiptSha256: sha256(canonicalJson(proof.receipt)) }
        : { refusal: proof.expected.refusal }),
      credential: role.credential,
      exportCredential: exportRole.credential,
    });
  }
  const last = evidence.cases.at(-1)!;
  const binding = await journal.roles.call({
    operationId: "describeWorkspace",
    path: { workspaceId: last.after.binding.workspaceId },
    query: {},
    body: undefined,
  });
  assert.deepEqual(binding, last.after.binding);
  return {
    providerDeploymentId: current.deploymentId,
    workerVersionId: current.workerVersionId,
    casesSha256: sha256(canonicalJson(evidence.cases)),
    checkedAt: new Date().toISOString(),
    cases: observations,
  };
}

async function originalSelection(
  loaded: LoadedDeviceCandidate,
  proofsPath: string,
  current: DeploymentIdentity,
): Promise<SelectionEvidence> {
  const bundle = await readProofBundle(proofsPath),
    matches = bundle.proofs.filter((proof) => proof.receipt.kind === "live");
  assert.equal(matches.length, 1);
  const proof = matches[0]!;
  assert.equal(proof.receipt.candidateSha256, loaded.hash);
  const gate = await regularBytes(resolve(proof.directory, "gate.json"));
  await verifyProducer(
    loaded.candidate,
    "live",
    proof.receipt.producer,
    proof.artifact,
    githubRequest(process.env.GITHUB_TOKEN),
    Date.now(),
    sha256(gate),
  );
  await verifyPayload(proof.directory, proof.receipt.files, ["gate.json"]);
  assert.deepEqual(proof.receipt.deployments.map(stable), [stable(current)]);
  const claim = proof.receipt.claims.find((c) => c.id === "selection-acceptance");
  assert.ok(claim?.outcome === "pass");
  const path = "device-phases/initial/selection.json",
    file = proof.receipt.files.find((file) => file.path === path);
  assert.ok(file);
  const bytes = await regularBytes(resolve(proof.directory, path), 1048576);
  assert.equal(bytes.length, file.size);
  assert.equal(sha256(bytes), file.sha256);
  const document = rawObject(JSON.parse(bytes.toString("utf8")), ["history", "observation"]);
  assertSelectionEvidence(document.history, current);
  return document.history;
}

export async function cleanupLiveSelection(input: { installationPath: string; out: string }) {
  const state = await selectionSetup(input.installationPath, "cleanup");
  if (state.target.backend !== "free") return;
  const ownership = await findReference("selection-ownership", state.loaded, state.context),
    custody = await findReference("selection-custody", state.loaded, state.context);
  const authenticated = await readSelectionOwnershipArtifacts(
    { loaded: state.loaded, context: state.context, ownership, custody },
    githubRequest(process.env.GITHUB_TOKEN),
  );
  const saved = authenticated.ownership.value;
  assertSelectionOwnership(saved);
  assert.deepEqual(saved.body.reviewedTarget, state.target);
  const declared = object(object(state.target.operator).deployment),
    deployment = saved.body.issuanceDeployment;
  if (deployment) {
    assert.equal(deployment.origin, declared.origin);
    assert.equal(deployment.workerName, declared.name);
    assert.equal(deployment.accountBindingSha256, state.target.accountBindingSha256);
  }
  const document = rawObject(authenticated.custody.value, [
    "schemaVersion",
    "sourceCommit",
    "candidateSha256",
    "scope",
    "producer",
    "jobId",
    "checkedAt",
    "body",
  ]);
  const envelopes = rawObject(document.body, ["roles"]).roles as Record<
    string,
    LiveDeviceCustodyEnvelope
  >;
  assert.ok(envelopes && typeof envelopes === "object" && !Array.isArray(envelopes));
  for (const [name, envelope] of Object.entries(envelopes)) {
    const owned: SelectionOwnedRole | undefined = saved.body.roles.find(
      (role) => role.name === name,
    );
    assert.ok(owned?.credential && owned.custodySha256);
    assert.equal(sha256(canonicalJson(envelope)), owned.custodySha256);
  }
  // No successful initial metadata or device allocation was needed above.
  // Only after authenticating both archives do protected keys enter custody.
  const key = adminKey(),
    roles = new RoleContext(string(declared.origin), key);
  const journal = new SelectionJournal(saved, roles, key, async () => {});
  Object.assign(journal.custody, envelopes);
  const result = await cleanupSelectionResources({
    ownership: saved,
    roles,
    settleStage: (stage) => settleOwnedStage(journal, state.installed, stage),
  });
  await saveJson(resolve(input.out, "selection-cleanup.json"), {
    schemaVersion: 1,
    sourceCommit: saved.sourceCommit,
    candidateSha256: saved.candidateSha256,
    scope: saved.scope,
    producer: state.job.producer,
    jobId: state.job.job.id,
    checkedAt: new Date().toISOString(),
    ownership,
    custody,
    body: result,
  });
  assert.equal(result.state, "complete", failure);
}

export async function authenticateSelectionEvidence(input: {
  loaded: LoadedDeviceCandidate;
  deployment: DeploymentIdentity;
}) {
  const context = currentDeviceJobContext();
  assert.equal(context.job, "operate");
  if (input.deployment.backend !== "free") return undefined;
  const started = await initial(input.loaded, context);
  const document = rawObject(
    started.artifact.payloads["selection.json"]?.data,
    ["history"],
    ["observation"],
  );
  assertSelectionEvidence(document.history, input.deployment);
  const reference = await findReference("selection-cleanup", input.loaded, context);
  const cleanup = await readSelectionCleanupArtifact(
    { loaded: input.loaded, context, reference },
    githubRequest(process.env.GITHUB_TOKEN),
  );
  const result = cleanup.body as SelectionCleanup;
  assert.equal(result.state, "complete");
  const ownership = await readSelectionOwnershipArtifacts(
    {
      loaded: input.loaded,
      context,
      ownership: cleanup.ownership as ArtifactReference,
      custody: cleanup.custody as ArtifactReference,
    },
    githubRequest(process.env.GITHUB_TOKEN),
  );
  assertSelectionOwnership(ownership.ownership.value);
  const owned = ownership.ownership.value;
  assert.equal(owned.body.mode, context.operation === "deploy" ? "perform" : "verify-existing");
  assert.deepEqual(owned.body.reviewedTarget, document.history.reviewedTarget);
  assert.equal(result.roles.length, owned.body.roles.length);
  for (const [index, row] of result.roles.entries()) {
    const saved = owned.body.roles[index];
    assert.ok(saved);
    assert.equal(row.name, saved.name);
    if (saved.issuance === "not-attempted") assert.equal(row.state, "not-issued");
    else {
      assert.equal(saved.issuance, "known");
      assert.equal(row.state, "complete");
      assert.deepEqual(row.credential, saved.credential);
      wire("RevocationReceipt", row.receipt);
      assert.equal(object(row.receipt).state, "complete");
      assert.deepEqual(object(row.receipt).pendingRecipients, []);
    }
  }
  assert.equal(result.executors.length, 2);
  assert.equal(result.admissions.length, owned.body.admissions.length);
  for (const [index, row] of result.admissions.entries()) {
    const saved = owned.body.admissions[index];
    assert.ok(saved?.receipt && row.task);
    assert.equal(row.name, saved.name);
    assert.equal(row.turn, saved.turn);
    assert.equal(row.clientRequestId, saved.input.clientRequestId);
    assert.equal(row.state, "complete");
    wire("Task", row.task);
    assert.equal(row.task.taskId, saved.receipt.taskId);
    assert.equal(row.task.conversationId, saved.conversationId);
  }
  assert.equal(result.stages.length, owned.body.stages.length);
  assert.equal(result.jobs.length, owned.body.jobs.length);
  const observation = object(document.observation);
  assert.ok(Array.isArray(observation.cases));
  for (const original of document.history.cases) {
    assert.equal(owned.body.conversations[original.name], original.conversationId);
    const fresh: Record<string, unknown> | undefined = observation.cases
      .map(object)
      .find((c) => c.name === original.name);
    assert.ok(fresh);
    assert.deepEqual(
      fresh.credential,
      result.roles.find((row) => row.name === `${original.name}-client`)?.credential,
    );
    assert.deepEqual(
      fresh.exportCredential,
      result.roles.find((row) => row.name === `${original.name}-export`)?.credential,
    );
  }
  assert.ok(
    result.roles.every((role) => role.state !== "unknown") &&
      result.executors.every((row) => row.state !== "unknown") &&
      result.stages.every((row) => row.state === "complete") &&
      result.jobs.every((row) => row.state === "complete"),
    // Admission closure is separately bound to saved original task identity.
  );
  if (context.operation === "deploy") assert.deepEqual(result, document.history.cleanup);
  else assert.ok(document.observation);
  const data = {
    history: document.history,
    observation: document.observation,
    observedDeployment: started.deployment,
    initial: started.artifact.reference,
    cleanup: reference,
  };
  assertSelectionAcceptanceData(data, input.deployment);
  return data;
}

if (import.meta.main) {
  try {
    const args = cliArgs(),
      installationPath = resolve(string(args.installation)),
      out = resolve(string(args.out));
    if (process.argv[2] === "operate")
      await operateSelection({
        installationPath,
        out,
        directory: resolve(string(args.directory)),
        proofsPath: resolve(string(args.proofs)),
        confirmation: string(args.confirm),
        ...(process.env.FORTIPI_PREVIOUS_CLI_RECEIPT
          ? { previous: resolve(process.env.FORTIPI_PREVIOUS_CLI_RECEIPT) }
          : {}),
      });
    else if (process.argv[2] === "cleanup") await cleanupLiveSelection({ installationPath, out });
    else throw new Error(failure);
  } catch {
    process.stderr.write(`${failure}.\n`);
    process.exitCode = 1;
  }
}

export async function settleOwnedStage(
  journal: SelectionJournal,
  installed: Installed,
  stage: SelectionStage,
) {
  if (stage.terminal === "committed" && stage.released && stage.receipt) {
    const receipt = await journal.roles.call({
      operationId: "getCommitReceipt",
      path: { workspaceId: stage.workspaceId, commitId: stage.receipt.commitId },
      query: { commitDigest: stage.receipt.commitDigest },
      body: undefined,
    });
    assert.deepEqual(receipt, stage.receipt);
    return;
  }
  const row = journal.ownership.body.roles.find((r) => r.name === stage.owner);
  assert.ok(row?.credential && row.custodySha256);
  const envelope = journal.custody[stage.owner];
  assert.ok(envelope && sha256(canonicalJson(envelope)) === row.custodySha256);
  const role = openLiveDeviceRole({
    key: journal.key,
    envelope,
    expectedFrame: journal.frame(row),
    now: Date.now(),
  });
  const client = await installedClient(installed, journal.roles.endpoint, role.token),
    request = deviceReadRequests();
  stage.lease ??= await request(() =>
    client.operations.acquireWorkspaceLease({
      path: { workspaceId: stage.workspaceId },
      query: {},
      body: stage.acquire,
    }),
  );
  for (const renewal of stage.renewals ?? [])
    if (!renewal.result) {
      renewal.result = await request(() =>
        client.operations.renewWorkspaceLease({
          path: { workspaceId: stage.workspaceId, leaseId: renewal.lease.leaseId },
          query: {},
          body: { requestId: renewal.requestId, lease: renewal.lease },
        }),
      );
      stage.lease = renewal.result;
    }
  if (stage.begin) {
    if (!stage.uploadId)
      stage.uploadId = (
        await request(() => client.uploads.begin(stage.workspaceId, stage.begin!))
      ).uploadId;
    const status = await request(() =>
      client.operations.getUpload({
        path: { workspaceId: stage.workspaceId, uploadId: stage.uploadId! },
        query: {},
        body: undefined,
      }),
    );
    if (status.state === "committed") {
      assert.ok(stage.commit);
      stage.receipt = await request(() =>
        client.uploads.commit(stage.workspaceId, stage.uploadId!, stage.commit!),
      );
      assert.equal(stage.receipt.commitId, stage.commit.commitId);
      stage.terminal = "committed";
    } else {
      if (status.state !== "aborted")
        await request(() =>
          client.operations.abortUpload({
            path: { workspaceId: stage.workspaceId, uploadId: stage.uploadId! },
            query: {},
            body: undefined,
          }),
        );
      const terminal = await request(() =>
        client.operations.getUpload({
          path: { workspaceId: stage.workspaceId, uploadId: stage.uploadId! },
          query: {},
          body: undefined,
        }),
      );
      assert.equal(terminal.state, "aborted");
      stage.terminal = "aborted";
    }
  }
  const released = await request(() =>
    client.operations.releaseWorkspaceLease({
      path: { workspaceId: stage.workspaceId, leaseId: stage.lease!.leaseId },
      query: {},
      body: {
        requestId: stage.releaseRequestId,
        lease: stage.lease!,
        reason: stage.terminal === "committed" ? "completed" : "cancelled",
      },
    }),
  );
  assert.equal(released.released, true);
  stage.released = true;
}

export function assertSelectionEvidence(
  value: unknown,
  current: DeploymentIdentity,
): asserts value is SelectionEvidence {
  assertDeployment(current);
  const v = rawObject(
    value,
    [
      "schemaVersion",
      "mode",
      "sourceCommit",
      "candidateSha256",
      "reviewedTarget",
      "executorIds",
      "phases",
      "cases",
      "cleanup",
    ],
    ["original"],
  );
  assert.equal(v.schemaVersion, 1);
  assert.equal(v.mode, "performed");
  assert.equal(v.sourceCommit, current.sourceCommit);
  assert.equal(v.candidateSha256, current.candidateSha256);
  assertTarget(v.reviewedTarget);
  assert.equal(v.reviewedTarget.backend, "free");
  const evidence = value as SelectionEvidence;
  assert.equal(evidence.executorIds.length, 2);
  assert.notEqual(evidence.executorIds[0], evidence.executorIds[1]);
  assert.equal(evidence.phases.length, 3);
  for (const [index, phase] of evidence.phases.entries()) {
    assert.equal(phase.phase, ["a", "b", "f"][index]);
    assert.deepEqual(
      phase.target,
      index === 2
        ? evidence.reviewedTarget
        : selectionTarget(
            evidence.reviewedTarget,
            index === 0 ? evidence.executorIds : [...evidence.executorIds].reverse(),
          ),
    );
    assertDeployment(phase.deployment);
    for (const field of [
      "candidateSha256",
      "sourceCommit",
      "origin",
      "workerName",
      "accountBindingSha256",
      "slot",
      "backend",
      "imageDigest",
      "capabilities",
      "assetManifestSha256",
      "publicConfigurationVersion",
    ] as const)
      assert.deepEqual(phase.deployment[field], current[field]);
  }
  assert.equal(new Set(evidence.phases.map((p) => p.deployment.workerVersionId)).size, 3);
  assert.equal(new Set(evidence.phases.map((p) => p.deployment.deploymentId)).size, 3);
  const final = evidence.phases[2]!.deployment;
  for (const key of ["configSha256", "runtimeConfigSha256"] as const)
    assert.equal(final[key], current[key]);
  assert.equal(evidence.cases.length, selectionCases.length);
  assert.deepEqual([...evidence.cases.map((c) => c.name)].sort(), [...selectionCases].sort());
  for (const proof of evidence.cases) {
    wire("AdmissionReceipt", proof.admission);
    wire("Task", proof.task);
    assert.equal(proof.task.taskId, proof.admission.taskId);
    assert.equal(proof.task.conversationId, proof.conversationId);
    wire("WorkspaceBinding", proof.before.binding);
    wire("WorkspaceBinding", proof.after.binding);
    assert.equal(proof.agentId.length > 0, true);
    assert.ok(proof.conversationId.length > 0);
    const reconstructed: SelectionTranscript = {
      agentId: proof.agentId,
      conversationId: proof.conversationId,
      through: 1,
      piEntryThrough: proof.calls.dispatch.resultEntryId,
      messages: [],
      calls: [proof.calls.context, proof.calls.dispatch],
      tasks: [],
      jobs: proof.job ? [proof.job] : [],
    };
    assert.deepEqual(selectionAttempt(reconstructed, proof.expected), proof.calls);
    assert.equal(proof.expected.workspaceId, proof.before.binding.workspaceId);
    assert.equal(proof.expected.baseRevision, proof.before.binding.revision);
    assert.deepEqual(
      proof.expected.targets,
      evidence.executorIds.map((executorId) => ({ kind: "executor", executorId, generation: 1 })),
    );
    assert.deepEqual(proof.expected.selected, proof.selected);
    assert.equal(
      proof.expected.mode,
      proof.name === "preferred-a" || proof.name === "preferred-b" ? "omitted" : "explicit",
    );
    assert.deepEqual(
      proof.expected.ranked,
      proof.name === "preferred-a" ? evidence.executorIds : [...evidence.executorIds].reverse(),
    );
    const positive = ["preferred-a", "preferred-b", "override-a"].includes(proof.name);
    const closedDispatch = evidence.cleanup.admissions.find(
      (row) => row.name === proof.name && row.turn === "dispatch",
    );
    assert.ok(closedDispatch?.task);
    assert.equal(closedDispatch.task.taskId, proof.admission.taskId);
    if (!positive) {
      assert.ok(proof.inspectAdmission);
      const closedInspect = evidence.cleanup.admissions.find(
        (row) => row.name === proof.name && row.turn === "inspect",
      );
      assert.ok(closedInspect?.task);
      assert.equal(closedInspect.task.taskId, proof.inspectAdmission.taskId);
      assert.equal(closedInspect.task.status.state, "completed");
    }
    assert.equal(positive, proof.job !== undefined);
    if (positive) {
      assert.equal(proof.expected.refusal, undefined);
      assert.equal(proof.task.status.state, "completed");
      assert.deepEqual(proof.selected, {
        kind: "executor",
        executorId: evidence.executorIds[proof.name === "preferred-b" ? 1 : 0],
        generation: 1,
      });
    } else {
      assert.equal(
        proof.expected.refusal,
        proof.name === "stale-revision"
          ? "Workspace base changed"
          : "No currently eligible configured target accepts these tool arguments",
      );
      assert.equal(
        proof.intervention?.kind,
        proof.name === "stale-revision"
          ? "revision"
          : proof.name === "stale-executor"
            ? "executor"
            : "expiry",
      );
      const context = JSON.parse(
        proof.calls.context.result.content.map((item) => item.text).join("\n"),
      );
      assert.deepEqual(proof.selected, context.targets[0].target);
      if (proof.intervention?.kind === "expiry") {
        assert.ok(
          proof.calls.context.resultTimestamp < proof.intervention.expiresAt &&
            proof.admittedAt >= proof.intervention.expiresAt &&
            proof.calls.dispatch.resultTimestamp >= proof.intervention.expiresAt,
        );
      }
    }
    if (proof.job) {
      wire("Job", proof.job);
      assert.equal(proof.job.taskId, proof.admission.taskId);
      assert.equal(proof.job.conversationId, proof.conversationId);
      assert.equal(proof.job.state, "completed");
      assert.ok(proof.receipt);
      wire("CommitReceipt", proof.receipt);
      assert.ok(proof.nativeWrite);
      assert.equal(proof.nativeWrite.jobId, proof.job.jobId);
      assert.equal(proof.nativeWrite.executionId, proof.job.execution?.executionId);
      assert.equal(proof.nativeWrite.size, proof.after.files[0]?.size);
      assert.equal(proof.nativeWrite.sha256, proof.after.files[0]?.sha256);
    } else assert.ok(proof.intervention && proof.expected.refusal);
  }
  assert.equal(evidence.cleanup.state, "complete");
  assert.equal(evidence.cleanup.roles.length, roleNames.length);
  assert.equal(evidence.cleanup.admissions.length, 9);
  assert.ok(evidence.cleanup.admissions.every((row) => row.state === "complete"));
  assert.ok(
    evidence.cleanup.roles.every((r) => r.state === "complete") &&
      evidence.cleanup.executors.every((r) => r.state === "complete") &&
      evidence.cleanup.stages.every((r) => r.state === "complete") &&
      evidence.cleanup.jobs.every((r) => r.state === "complete"),
  );
  assert.deepEqual(stable(evidence.cleanup.finalDeployment!), stable(final));
}

async function installedClient(
  installed: Installed,
  endpoint: string,
  token: string,
): Promise<FortiPiClient> {
  const sdk = (await import(
    pathToFileURL(installed.resolveExport(`@${installed.candidate.scope}/fortipi-client/node`)).href
  )) as typeof import("../packages/fortipi-client/dist/node.js");
  return new sdk.FortiPiClient({ endpoint, credentials: async () => token });
}
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean) {
  const end = Date.now() + 120000;
  do {
    const value = await read();
    if (accept(value)) return value;
    await delay(250);
  } while (Date.now() < end);
  throw new Error(failure);
}
async function publishNotes(
  journal: SelectionJournal,
  client: FortiPiClient,
  binding: WorkspaceBinding,
  bytes: Buffer,
): Promise<{ workspace: RecoveryWorkspaceCanary; receipt: CommitReceipt }> {
  assert.ok(bytes.length > 0 && bytes.length <= 4096);
  const request = deviceReadRequests();
  const entry = {
    type: "file" as const,
    path: "notes.txt",
    mode: 420 as const,
    size: bytes.length,
    sha256: sha256(bytes),
  };
  const manifest = { version: 1 as const, entries: [entry] },
    manifestHash = await manifestDigest(manifest);
  const stage: SelectionStage = {
    owner: "writer",
    workspaceId: binding.workspaceId,
    acquire: {
      requestId: randomUUID(),
      operationId: randomUUID(),
      bindingVersion: binding.bindingVersion,
      baseRevision: binding.revision,
      deadline: Date.now() + 120000,
    },
    releaseRequestId: randomUUID(),
  };
  journal.ownership.body.stages.push(stage);
  await journal.save();
  stage.lease = await request(() =>
    client.operations.acquireWorkspaceLease({
      path: { workspaceId: binding.workspaceId },
      query: {},
      body: stage.acquire,
    }),
  );
  await journal.save();
  stage.begin = {
    requestId: randomUUID(),
    operationId: stage.lease.operationId,
    commitId: randomUUID(),
    lease: stage.lease,
    baseRevision: binding.revision,
    manifest,
    manifestHash,
    mutations: [
      { kind: "put", path: entry.path, mode: entry.mode, size: entry.size, sha256: entry.sha256 },
    ],
    blobs: [{ sha256: entry.sha256, chunks: { chunkBytes: 262144, chunkHashes: [entry.sha256] } }],
  };
  await journal.save();
  const opened = await request(() => client.uploads.begin(binding.workspaceId, stage.begin!));
  stage.uploadId = opened.uploadId;
  await journal.save();
  async function pace() {
    await delay(15000);
    assert.ok(stage.lease && Date.now() + 1000 < stage.lease.expiresAt);
    if (stage.lease.expiresAt - Date.now() < 25000) {
      const renewal = { requestId: randomUUID(), lease: stage.lease };
      const saved: NonNullable<SelectionStage["renewals"]>[number] = { ...renewal };
      stage.renewals ??= [];
      stage.renewals.push(saved);
      await journal.save();
      saved.result = await request(() =>
        client.operations.renewWorkspaceLease({
          path: { workspaceId: binding.workspaceId, leaseId: renewal.lease.leaseId },
          query: {},
          body: renewal,
        }),
      );
      stage.lease = saved.result;
      await journal.save();
    }
  }
  // Existing live workspace transfer cadence: one active transfer per 15s.
  await pace();
  await request(() =>
    client.uploads.chunk({
      path: {
        workspaceId: binding.workspaceId,
        uploadId: opened.uploadId,
        sha256: entry.sha256,
        chunkIndex: 0,
      },
      query: { length: bytes.length, sha256: entry.sha256 },
      body: bytes,
    }),
  );
  await pace();
  const validated = await request(() =>
    client.uploads.validate(binding.workspaceId, opened.uploadId),
  );
  stage.commit = {
    requestId: randomUUID(),
    operationId: stage.lease.operationId,
    workspaceId: binding.workspaceId,
    uploadId: opened.uploadId,
    commitId: stage.begin!.commitId,
    stageId: validated.stageId,
    lease: stage.lease,
    baseRevision: binding.revision,
    manifestHash,
  };
  await journal.save();
  await pace();
  stage.commit!.lease = stage.lease!;
  await journal.save();
  const receipt = await request(() =>
    client.uploads.commit(binding.workspaceId, opened.uploadId, stage.commit!),
  );
  stage.receipt = receipt;
  stage.terminal = "committed";
  await journal.save();
  assert.equal(receipt.providerKind, "computer");
  assert.equal(receipt.baseRevision, binding.revision);
  assert.equal(receipt.manifestHash, manifestHash);
  const released = await request(() =>
    client.operations.releaseWorkspaceLease({
      path: { workspaceId: binding.workspaceId, leaseId: stage.lease!.leaseId },
      query: {},
      body: { requestId: stage.releaseRequestId, lease: stage.lease!, reason: "completed" },
    }),
  );
  assert.equal(released.released, true);
  stage.released = true;
  await journal.save();
  const current = await request(() => client.workspaces.get(binding.workspaceId));
  assert.equal(current.revision, receipt.revision);
  const got = await request(() =>
    client.workspaces.read(binding.workspaceId, { path: "notes.txt", revision: receipt.revision }),
  );
  assert.equal(sha256(got), entry.sha256);
  return {
    receipt,
    workspace: {
      binding: current,
      files: [{ path: entry.path, size: entry.size, sha256: entry.sha256 }],
    },
  };
}

const clientActions = [
  "tickets.mint",
  "conversations.read",
  "messages.submit",
  "events.read",
  "tasks.read",
  "tasks.cancel",
  "jobs.read",
  "jobs.dispatch",
  "approvals.read",
  "approvals.decide",
  "executors.list",
  "workspace.read",
  "workspace.write",
  "workspaces.read",
];
type NativePeer = Awaited<ReturnType<typeof openSelectionNativePeer>>;
async function scopedRole(
  journal: SelectionJournal,
  name: string,
  resources: ResourceScope,
  role: "client" | "executor" | "admin" = "client",
  executorId?: string,
  grants?: CredentialMint["grants"],
) {
  const shared = {
    expiresAt: journal.ownership.body.createdAt + 55 * 60000,
    grants: grants ?? [{ grantId: randomUUID(), version: 1, resources }],
  };
  if (role === "executor") {
    assert.ok(executorId);
    return journal.mint(name, { ...shared, role, executorId });
  }
  return journal.mint(name, { ...shared, role });
}
function caseScope(journal: SelectionJournal, name: SelectionCase): ResourceScope {
  const body = journal.ownership.body;
  return {
    ...emptySelectionScope(),
    agentIds: [body.agentId!],
    conversationIds: [body.conversations[name]!],
    workspaceIds: [body.workspaceId!],
    executorIds: [...body.executorIds],
    tools: ["shell"],
    actions: clientActions,
  };
}
async function exported(journal: SelectionJournal, client: FortiPiClient, name: SelectionCase) {
  const body = journal.ownership.body,
    requestId = randomUUID();
  const row = {
    conversationId: body.conversations[name]!,
    requestId,
    operationId: undefined as string | undefined,
  };
  body.exports.push({ conversationId: row.conversationId, requestId });
  await journal.save();
  const selected = await selectionExport(
    client,
    body.agentId!,
    row.conversationId,
    [
      journal.key,
      ...journal.tokens,
      ...[process.env.GITHUB_TOKEN, process.env.CLOUDFLARE_API_TOKEN].filter(
        (s): s is string => !!s,
      ),
    ],
    requestId,
  );
  body.exports[body.exports.length - 1]!.operationId = selected.operationId;
  await journal.save();
  return selected;
}
async function caseClient(journal: SelectionJournal, installed: Installed, name: SelectionCase) {
  const resources = caseScope(journal, name);
  const expiry = name === "expired-grant" ? Date.now() + 120000 : undefined;
  const grants = expiry
    ? [
        {
          grantId: randomUUID(),
          version: 1,
          resources: {
            ...resources,
            actions: resources.actions.filter(
              (a) => a !== "jobs.dispatch" && a !== "workspace.write",
            ),
          },
        },
        {
          grantId: randomUUID(),
          version: 1,
          expiresAt: expiry,
          resources: { ...resources, actions: ["jobs.dispatch", "workspace.write"] },
        },
      ]
    : undefined;
  const role = await scopedRole(journal, `${name}-client`, resources, "client", undefined, grants);
  const reader = await scopedRole(
    journal,
    `${name}-export`,
    selectionExportScope(journal.ownership.body.agentId!, resources.conversationIds[0]!),
    "admin",
  );
  return {
    role,
    client: await installedClient(installed, journal.roles.endpoint, role.token),
    exporter: await installedClient(installed, journal.roles.endpoint, reader.token),
    expiry,
  };
}
async function publicBytes(client: FortiPiClient, workspace: RecoveryWorkspaceCanary) {
  const request = deviceReadRequests();
  const manifest = (
    await request(() =>
      client.workspaces.manifest(workspace.binding.workspaceId, {
        revision: workspace.binding.revision,
      }),
    )
  ).manifest;
  assert.equal(await manifestDigest(manifest), workspace.binding.manifestHash);
  assert.deepEqual(
    manifest.entries,
    workspace.files.map((file) => ({ type: "file", mode: 420, ...file })),
  );
  const bytes = Buffer.from(
    await request(() =>
      client.workspaces.read(workspace.binding.workspaceId, {
        revision: workspace.binding.revision,
        path: "notes.txt",
      }),
    ),
  );
  assert.equal(bytes.length, workspace.files[0]!.size);
  assert.equal(sha256(bytes), workspace.files[0]!.sha256);
  return bytes;
}
async function runCase(input: {
  journal: SelectionJournal;
  installed: Installed;
  name: SelectionCase;
  workspace: RecoveryWorkspaceCanary;
  peers: [NativePeer, NativePeer];
  configuration: Configuration;
  writer: FortiPiClient;
}): Promise<SelectionCaseProof> {
  const { journal, installed, name, workspace, peers, configuration, writer } = input,
    body = journal.ownership.body;
  const { client, exporter, expiry, role } = await caseClient(journal, installed, name);
  const request = deviceReadRequests(),
    cid = body.conversations[name]!,
    agentId = body.agentId!;
  await until(
    async () => {
      const all = [];
      let pageToken: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await request(() =>
          client.operations.listExecutors({
            path: {},
            query: { limit: 100, ...(pageToken ? { pageToken } : {}) },
            body: undefined,
          }),
        );
        all.push(...page.items);
        pageToken = page.nextPageToken;
        if (pageToken) {
          assert.ok(seen.size < 20 && !seen.has(pageToken));
          seen.add(pageToken);
        }
      } while (pageToken);
      assert.ok(
        all.every((peer) => body.executorIds.includes(peer.executorId)),
        "Only the exact scoped peer inventory may be visible",
      );
      return all;
    },
    (rows) => rows.length === 2 && rows.every((peer) => peer.state === "online"),
  );
  const fresh = await request(() => client.conversations.get(cid));
  assert.equal(fresh.messages.length, 0);
  assert.equal(fresh.conversation.agentId, agentId);
  const events: DurableEvent[] = [];
  const stream = client.conversations.subscribe(cid, {
    agentId,
    maxReconnects: 0,
    onSnapshot() {},
    onEvent(event) {
      if (event.durability === "durable") events.push(structuredClone(event));
    },
  });
  await request(() => stream.ready);
  async function terminalTask(taskId: string) {
    await until(
      async () =>
        events.some(
          (event) =>
            event.taskId === taskId &&
            ["task.completed", "task.failed", "task.cancelled", "task.interrupted"].includes(
              event.type,
            ),
        ),
      Boolean,
    );
    return request(() => client.tasks.get(taskId));
  }
  async function projectedTools(count: number) {
    await until(
      async () =>
        events.filter(
          (event) =>
            event.type === "message.committed" &&
            event.payload &&
            typeof event.payload === "object" &&
            !Array.isArray(event.payload) &&
            "role" in event.payload &&
            event.payload.role === "tool",
        ).length >= count,
      Boolean,
    );
    const projection = await request(() => client.conversations.get(cid));
    assert.ok(projection.messages.filter((message) => message.role === "tool").length >= count);
  }
  const before = structuredClone(workspace),
    previous = await publicBytes(client, before),
    snapshots = await Promise.all(peers.map((p) => p.snapshot()));
  const stale = name.startsWith("stale-") || name === "expired-grant";
  const positivePrompt =
    name === "override-a"
      ? "Read notes.txt in the configured workspace. In one operation append the line override-a-verified using the other available local device instead of the configured preferred device. Save the file, show the complete saved text and finish. Leave every other file unchanged."
      : `Read notes.txt in the configured workspace. In one operation append the line ${name}-verified using the configured execution preference. Save the file, show the complete saved text and finish. Leave every other file unchanged.`;
  const inspectPrompt =
    "Inspect the configured workspace and both available local devices for shell execution. Remember the workspace revision and first listed device for the next turn. Do not execute or change any file yet.";
  const cachedPrompt =
    "Using exactly the workspace revision and first listed device inspected in the preceding turn, try once to append the line cached-attempt-verified to notes.txt and save it. Do not refresh discovery, change the revision, substitute a device or retry after refusal.";
  let inspectAdmission: AdmissionReceipt | undefined,
    cached: SelectionTranscript | undefined,
    intervention: SelectionCaseProof["intervention"];
  let selected = name === "preferred-b" ? peers[1].target : peers[0].target;
  let after = before;
  const observationAbort = new AbortController();
  let nativeWrite: SelectionCaseProof["nativeWrite"];
  try {
    if (stale) {
      const inspected = await sendSelectionTurn(
        journal,
        client,
        name,
        "inspect",
        inspectPrompt,
        role.credential,
      );
      inspectAdmission = inspected.receipt;
      const task = await terminalTask(inspectAdmission.taskId);
      inspected.row.task = task;
      await journal.save();
      assert.equal(task.status.state, "completed");
      await projectedTools(1);
      cached = (await exported(journal, exporter, name)).transcript;
      assert.equal(cached.calls.length, 1);
      assert.equal(cached.calls[0]!.name, "fortipi_context");
      assert.equal(cached.calls[0]!.result.isError, false);
      assert.equal(cached.jobs.length, 0);
      const context = JSON.parse(cached.calls[0]!.result.content.map((c) => c.text).join("\n"));
      selected = context.targets[0].target;
      assert.ok(peers.some((peer) => canonicalJson(peer.target) === canonicalJson(selected)));
      if (name === "stale-revision") {
        const publication = await publishNotes(
          journal,
          writer,
          workspace.binding,
          Buffer.concat([previous, Buffer.from("revision-intervention\n")]),
        );
        after = publication.workspace;
        intervention = { kind: "revision", receipt: publication.receipt };
      } else if (name === "stale-executor") {
        const revocation = body.executorRevocations.find(
          (row) => row.target.executorId === selected.executorId,
        )!;
        const intent = { requestId: revocation.requestId, expectedGeneration: selected.generation };
        await journal.save();
        let receipt = await journal.roles.call({
          operationId: "revokeExecutor",
          path: { id: selected.executorId },
          query: {},
          body: intent,
        });
        const end = Date.now() + 15000;
        while (receipt.state !== "complete" && Date.now() < end) {
          await delay(100);
          receipt = await journal.roles.call({
            operationId: "revokeExecutor",
            path: { id: selected.executorId },
            query: {},
            body: intent,
          });
        }
        assert.equal(receipt.state, "complete");
        assert.equal(receipt.pendingRecipients.length, 0);
        revocation.receipt = receipt;
        await journal.save();
        intervention = { kind: "executor", target: selected, receipt };
      } else {
        assert.ok(expiry && Date.now() < expiry, "Discovery must precede actual grant expiry");
        await delay(expiry - Date.now() + 100);
        intervention = { kind: "expiry", expiresAt: expiry, credential: role.credential };
      }
    }
    const prompt = stale ? cachedPrompt : positivePrompt;
    const sent = await sendSelectionTurn(
      journal,
      client,
      name,
      "dispatch",
      prompt,
      role.credential,
    );
    const admission = sent.receipt;
    let job: Job | undefined, receipt: CommitReceipt | undefined, approvedArguments: unknown;
    if (!stale) {
      const event = await until(
        async () =>
          events.find((e) => e.type === "approval.requested" && e.taskId === admission.taskId),
        Boolean,
      );
      assert.ok(
        event?.jobId &&
          event.payload &&
          typeof event.payload === "object" &&
          !Array.isArray(event.payload),
      );
      const approvalId = string(object(event.payload).approvalId);
      body.jobs.push({
        conversationId: cid,
        taskId: admission.taskId,
        jobId: event.jobId,
        cancelRequestId: sent.row.cancelRequestId,
      });
      await journal.save();
      const approval = await request(() => client.approvals.get(approvalId));
      assert.equal(approval.state, "pending");
      assert.equal(approval.conversationId, cid);
      assert.equal(approval.agentId, agentId);
      assert.equal(approval.operation.workspaceId, before.binding.workspaceId);
      assert.equal(approval.operation.baseRevision, before.binding.revision);
      assert.equal(approval.operation.tool, "shell");
      assert.deepEqual(approval.operation.target, selected);
      approvedArguments = approval.operation.arguments;
      const pending = await request(() => client.jobs.get(approval.jobId));
      assert.equal(pending.taskId, admission.taskId);
      assert.equal(pending.state, "awaiting_approval");
      assert.equal(pending.execution, undefined);
      const remote = await request(() =>
        client.approvals.decide(approvalId, {
          requestId: randomUUID(),
          expectedVersion: approval.version,
          operationDigest: approval.operation.operationDigest,
          decision: "approve",
        }),
      );
      assert.equal(remote.state, "approved");
      const peer = peers.find((p) => canonicalJson(p.target) === canonicalJson(selected))!;
      const expectedBytes = Buffer.concat([previous, Buffer.from(`${name}-verified\n`)]);
      const nativeObservation = peer.observeNotes(
        approval.jobId,
        expectedBytes,
        observationAbort.signal,
      );
      void nativeObservation.catch(() => {});
      const executionId = await peer.consent(approval);
      nativeWrite = await nativeObservation;
      assert.ok(nativeWrite);
      assert.equal(nativeWrite.executionId, executionId);
      await until(
        async () =>
          events.some(
            (event) =>
              event.type === "job.state.changed" &&
              event.jobId === approval.jobId &&
              event.payload &&
              typeof event.payload === "object" &&
              !Array.isArray(event.payload) &&
              "state" in event.payload &&
              ["completed", "failed", "cancelled", "requires_reconciliation"].includes(
                String(event.payload.state),
              ),
          ),
        Boolean,
      );
      job = await request(() => client.jobs.get(approval.jobId));
      assert.equal(job.state, "completed");
      if (job.state !== "completed" || job.evidence.kind !== "committed") throw new Error(failure);
      receipt = job.evidence.receipt;
      assert.equal(job.execution?.executionId, executionId);
      assert.deepEqual(job.execution?.target, selected);
      assert.equal(job.preparedResult?.state, "succeeded");
      assert.equal(job.preparedResult?.identity.executionId, executionId);
      assert.equal(job.preparedResult?.manifestHash, receipt.manifestHash);
      assert.equal(job.preparedResult?.commitId, receipt.commitId);
      assert.equal(job.operationDigest, approval.operation.operationDigest);
      assert.equal(job.execution?.operationDigest, approval.operation.operationDigest);
      assert.equal(receipt.operationId, approval.operation.operationId);
      assert.equal(receipt.workspaceId, before.binding.workspaceId);
      assert.equal(receipt.baseRevision, before.binding.revision);
      assert.equal(receipt.providerKind, "computer");
      const bytes = Buffer.concat([previous, Buffer.from(`${name}-verified\n`)]);
      const binding = await request(() => client.workspaces.get(before.binding.workspaceId));
      assert.equal(binding.revision, receipt.revision);
      assert.equal(binding.manifestHash, receipt.manifestHash);
      after = {
        binding,
        files: [{ path: "notes.txt", size: bytes.length, sha256: sha256(bytes) }],
      };
      assert.deepEqual(await publicBytes(client, after), bytes);
      await Promise.all(peers.map((p) => p.settled()));
    }
    const task = await terminalTask(admission.taskId);
    sent.row.task = task;
    await journal.save();
    assert.ok(
      stale
        ? ["completed", "failed"].includes(task.status.state)
        : task.status.state === "completed",
    );
    // A projected tool result/task boundary, not a guessed eventSeq ordering.
    await projectedTools(2);
    const exportedCase = await exported(journal, exporter, name),
      transcript = exportedCase.transcript;
    assert.deepEqual(
      transcript.messages.map((m) => m.content),
      stale ? [inspectPrompt, cachedPrompt] : [positivePrompt],
    );
    assert.equal(transcript.messages.at(-1)?.messageId, admission.messageId);
    assert.deepEqual(
      transcript.tasks.find((value) => object(value).taskId === admission.taskId),
      task,
    );
    if (inspectAdmission)
      assert.equal(transcript.messages[0]?.messageId, inspectAdmission.messageId);
    const expected: Parameters<typeof selectionAttempt>[1] = {
      workspaceId: before.binding.workspaceId,
      baseRevision: before.binding.revision,
      targets: peers.map((p) => p.target),
      ranked: configuration.routing.targetIds,
      selected,
      mode: stale || name === "override-a" ? "explicit" : "omitted",
      ...(stale
        ? {
            refusal:
              name === "stale-revision"
                ? ("Workspace base changed" as const)
                : ("No currently eligible configured target accepts these tool arguments" as const),
          }
        : {}),
    };
    const calls = selectionAttempt(transcript, expected);
    const admitted = await until(
      async () =>
        events.find(
          (event) =>
            event.type === "message.committed" &&
            event.payload &&
            typeof event.payload === "object" &&
            !Array.isArray(event.payload) &&
            "messageId" in event.payload &&
            event.payload.messageId === admission.messageId,
        ),
      Boolean,
    );
    assert.ok(admitted);
    if (intervention?.kind === "expiry")
      assert.ok(
        calls.context.resultTimestamp < intervention.expiresAt &&
          admitted.timestamp >= intervention.expiresAt &&
          calls.dispatch.resultTimestamp >= intervention.expiresAt,
      );
    if (cached) assert.deepEqual(calls.context, cached.calls[0]);
    if (job) {
      const exportedJob = transcript.jobs[0] as Job;
      assert.equal(exportedJob.jobId, job.jobId);
      assert.equal(exportedJob.taskId, admission.taskId);
      assert.deepEqual(calls.arguments.arguments, approvedArguments);
    } else {
      assert.ok(!events.some((event) => event.type === "approval.requested" || event.jobId));
      assert.deepEqual(await Promise.all(peers.map((p) => p.snapshot())), snapshots);
      assert.deepEqual(
        await request(() => client.workspaces.get(after.binding.workspaceId)),
        after.binding,
      );
      await publicBytes(client, after);
    }
    const proof: SelectionCaseProof = {
      name,
      agentId,
      conversationId: cid,
      admission,
      task,
      admittedAt: admitted.timestamp,
      admittedEventSeq: admitted.eventSeq,
      ...(inspectAdmission ? { inspectAdmission } : {}),
      prompts: transcript.messages.map((m) => m.content),
      before,
      after,
      selected,
      expected,
      calls,
      ...(job ? { job } : {}),
      ...(receipt ? { receipt } : {}),
      ...(intervention ? { intervention } : {}),
      exportOperationId: exportedCase.operationId,
      native: await Promise.all(peers.map((p) => p.snapshot())),
      events: events.filter(
        (event) =>
          event.type !== "message.committed" &&
          ["approval.requested", "job.state.changed", "task.state.changed"].includes(event.type),
      ),
      ...(nativeWrite ? { nativeWrite } : {}),
    };
    journal.roles.assertSanitized(proof, journal.tokens);
    return proof;
  } finally {
    observationAbort.abort();
    stream.close();
    await stream.done.catch(() => {});
  }
}
