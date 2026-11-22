import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  ConfirmedPlatformRecovery,
  ExistingApplicationRecoveryBridge,
} from "../tests/clients/platform-recovery.ts";
import { validateApplicationRecoveryCheckpoints } from "./application-recovery-checkpoints.ts";
import {
  type ApplicationRecoveryProof,
  applicationRecoveryProofFile,
  type RecoveryPortsFactory,
} from "./application-recovery-coordinator.ts";
import { assertTarget, type TargetDescriptor } from "./deploy-smoke.ts";
import { type ProviderPhaseResult, recoverProvider } from "./platform-recovery.ts";
import { loadWorkflowCandidate } from "./prepare-release.ts";
import {
  assertDeployment,
  assertGate,
  canonicalJson,
  commitPattern,
  type DeploymentIdentity,
  digest,
  type FileRecord,
  freshness,
  type GitHubRequest,
  object,
  type ProofInput,
  regularBytes,
  sha256,
  verifyPayload,
  verifyProducer,
} from "./verify-release-gates.ts";

export interface ExistingApplicationRecoveryInput {
  candidatePath: string;
  candidateSha256: string;
  sourceCommit: string;
  preparedDirectory: string;
  target: TargetDescriptor;
  current: DeploymentIdentity;
  proof: ProofInput;
  proofsRoot: string;
}
/** The caller disposes only after its child finishes fresh public reads. */
export interface ExistingApplicationRecoveryCoordinator extends ExistingApplicationRecoveryBridge {
  dispose(): Promise<void>;
}

const reason = "Original application recovery unavailable or inconsistent";
const maximum = 1048576;
const claims = "claims";
const journal = `${claims}/provider-recovery`;
const beforePath = "application-recovery/application-before.json";
const afterPath = "application-recovery/application-after.json";
const journalNames = [
  "intent.json",
  "upload-attempt.json",
  "deployment-attempt.json",
  "transition.json",
] as const;
const withoutTime = ({ checkedAt: _time, ...value }: DeploymentIdentity) => value;
function closed(value: object, keys: string[]) {
  assert.deepEqual(Object.keys(value).sort(), keys.toSorted());
}
function snapshot<T>(value: T): T {
  const copy: T = JSON.parse(canonicalJson(value));
  const freeze = (item: unknown): void => {
    if (!item || typeof item !== "object" || Object.isFrozen(item)) return;
    Object.values(item).forEach(freeze);
    Object.freeze(item);
  };
  freeze(copy);
  return copy;
}
function canonical(bytes: Buffer): unknown {
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  assert.equal(bytes.toString("utf8"), `${canonicalJson(value)}\n`);
  return value;
}
function checkpointRecord(file: FileRecord, path: string) {
  closed(file, ["path", "size", "mode", "sha256"]);
  assert.equal(file.path, path);
  assert.equal(file.mode, 0o600);
  assert.ok(Number.isSafeInteger(file.size) && file.size > 0 && file.size <= maximum);
  digest(file.sha256);
}

/** Constructor data is not authority. Every successful call authenticates the
 * original completed live producer and copied bytes before any provider read.
 * No upload/deploy capability is passed to the readonly provider replay. */
export function createExistingApplicationRecoveryCoordinator(
  input: ExistingApplicationRecoveryInput,
  request: GitHubRequest,
  portsFactory: RecoveryPortsFactory,
): ExistingApplicationRecoveryCoordinator {
  let bound: ExistingApplicationRecoveryInput;
  try {
    bound = snapshot(input);
    closed(bound, [
      "candidatePath",
      "candidateSha256",
      "sourceCommit",
      "preparedDirectory",
      "target",
      "current",
      "proof",
      "proofsRoot",
    ]);
    digest(bound.candidateSha256);
    assert.match(bound.sourceCommit, commitPattern);
    assertTarget(bound.target);
    assertDeployment(bound.current);
    assert.equal(bound.current.sourceCommit, bound.sourceCommit);
    assert.equal(bound.current.candidateSha256, bound.candidateSha256);
    assert.equal(bound.current.accountBindingSha256, bound.target.accountBindingSha256);
    assert.equal(bound.current.backend, bound.target.backend);
    const deployment = object(object(bound.target.operator).deployment);
    assert.equal(bound.current.workerName, deployment.name);
    assert.equal(bound.current.origin, deployment.origin);
    assert.equal(bound.current.slot, bound.target.slot ?? "production");
    closed(bound.proof, ["artifact", "receipt", "directory"]);
    assert.ok(typeof request === "function" && typeof request.verifyArtifact === "function");
    assert.equal(typeof portsFactory, "function");
    for (const path of [
      bound.candidatePath,
      bound.preparedDirectory,
      bound.proofsRoot,
      bound.proof.directory,
    ])
      assert.ok(isAbsolute(path) && resolve(path) === path);
  } catch {
    throw new Error(reason);
  }
  let phase: "ready" | "verifying" | "verified" | "failed" | "disposed" = "ready";
  let directory: string | undefined;
  let pending: ReturnType<ExistingApplicationRecoveryBridge["verifyExisting"]> | undefined;
  const unavailable = () => ({ status: "unavailable" as const, reason });
  const owns = () => assert.equal(phase, "verifying");
  const clean = async () => {
    if (directory)
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  };
  const verify = async (): ReturnType<ExistingApplicationRecoveryBridge["verifyExisting"]> => {
    try {
      const loaded = await loadWorkflowCandidate(bound.candidatePath);
      owns();
      assert.equal(loaded.hash, bound.candidateSha256);
      assert.equal(loaded.candidate.sourceCommit, bound.sourceCommit);
      assert.equal(bound.proof.artifact.candidateSha256, bound.candidateSha256);
      assert.equal(await realpath(bound.proofsRoot), bound.proofsRoot);
      assert.equal(await realpath(bound.proof.directory), bound.proof.directory);
      const within = relative(bound.proofsRoot, bound.proof.directory);
      assert.ok(within && !isAbsolute(within) && within !== ".." && !within.startsWith(`..${sep}`));
      const gateBytes = await regularBytes(resolve(bound.proof.directory, "gate.json"), 8_000_000);
      const gate = canonical(gateBytes);
      assertGate(gate);
      assert.deepEqual(gate, bound.proof.receipt);
      assert.equal(gate.kind, "live");
      assert.equal(gate.sourceCommit, bound.sourceCommit);
      assert.equal(gate.candidateSha256, bound.candidateSha256);
      assert.equal(gate.scope, loaded.candidate.scope);
      assert.ok(gate.claims.every((claim) => claim.outcome === "pass"));
      assert.equal(gate.deployments.length, 1);
      const deployment = gate.deployments[0];
      assert.ok(deployment);
      assert.deepEqual(withoutTime(deployment), withoutTime(bound.current));
      freshness(gate.checkedAt, 6);
      await verifyProducer(
        loaded.candidate,
        "live",
        gate.producer,
        bound.proof.artifact,
        request,
        Date.now(),
        sha256(gateBytes),
      );
      owns();
      await verifyPayload(bound.proof.directory, gate.files, ["gate.json"]);
      owns();
      const member = async (path: string, limit = maximum) => {
        const selected = gate.files.filter((file) => file.path === path);
        assert.equal(selected.length, 1);
        const record = selected[0];
        assert.ok(record);
        assert.ok(record.size > 0 && record.size <= limit);
        const bytes = await regularBytes(resolve(bound.proof.directory, path), limit);
        assert.equal(bytes.length, record.size);
        assert.equal(sha256(bytes), record.sha256);
        return bytes;
      };
      const proof = canonical(
        await member(`${journal}/${applicationRecoveryProofFile}`),
      ) as ApplicationRecoveryProof;
      closed(proof, [
        "schemaVersion",
        "sourceCommit",
        "candidateSha256",
        "operationId",
        "transitionSha256",
        "before",
        "after",
      ]);
      assert.equal(proof.schemaVersion, 1);
      assert.equal(proof.sourceCommit, bound.sourceCommit);
      assert.equal(proof.candidateSha256, bound.candidateSha256);
      assert.match(proof.operationId, /^[a-f0-9]{32}$/);
      digest(proof.transitionSha256);
      checkpointRecord(proof.before, beforePath);
      checkpointRecord(proof.after, afterPath);
      const buffers = new Map<string, Buffer>();
      for (const name of journalNames)
        buffers.set(`provider-recovery/${name}`, await member(`${journal}/${name}`));
      for (const record of [proof.before, proof.after]) {
        const bytes = await member(`${claims}/${record.path}`);
        assert.equal(bytes.length, record.size);
        assert.equal(sha256(bytes), record.sha256);
        buffers.set(record.path, bytes);
      }
      const transitionBytes = buffers.get("provider-recovery/transition.json");
      const intentBytes = buffers.get("provider-recovery/intent.json");
      assert.ok(transitionBytes && intentBytes);
      assert.equal(sha256(transitionBytes), proof.transitionSha256);
      const transition = canonical(transitionBytes) as ProviderPhaseResult["transition"];
      assert.equal(transition.operationId, proof.operationId);
      assert.equal(transition.candidateSha256, bound.candidateSha256);
      assert.equal(transition.beforeCheckpointSha256, proof.before.sha256);
      assert.equal(transition.intentSha256, sha256(intentBytes));
      owns();
      const copiedDirectory = await mkdtemp(
        resolve(await realpath(tmpdir()), "fortipi-existing-recovery-"),
      );
      directory = copiedDirectory;
      assert.equal(await realpath(copiedDirectory), copiedDirectory);
      await mkdir(resolve(copiedDirectory, "provider-recovery"), { mode: 0o700 });
      await mkdir(resolve(copiedDirectory, "application-recovery"), { mode: 0o700 });
      for (const [path, bytes] of buffers)
        await writeFile(resolve(directory, path), bytes, { flag: "wx", mode: 0o600 });
      const before = { ...proof.before, path: resolve(directory, beforePath) };
      const after = { ...proof.after, path: resolve(directory, afterPath) };
      const validate = (provider: ProviderPhaseResult) =>
        validateApplicationRecoveryCheckpoints({
          checkpointDirectory: resolve(copiedDirectory, "application-recovery"),
          candidateSha256: bound.candidateSha256,
          sourceCommit: bound.sourceCommit,
          before,
          after,
          provider,
        });
      await validate({
        transition,
        transitionSha256: proof.transitionSha256,
        current: bound.current,
      });
      owns();
      const ports = await portsFactory();
      owns();
      const provider = await recoverProvider(
        {
          candidatePath: bound.candidatePath,
          candidateSha256: bound.candidateSha256,
          sourceCommit: bound.sourceCommit,
          preparedDirectory: bound.preparedDirectory,
          target: bound.target,
          before: transition.before,
          operationId: proof.operationId,
          journalDirectory: resolve(directory, "provider-recovery"),
          checkpointDirectory: resolve(directory, "application-recovery"),
          beforeCheckpoint: before,
          mode: "verify-existing",
          retainedTransitionSha256: proof.transitionSha256,
        },
        {
          read: ports.read,
          applicationTransport: ports.applicationTransport,
          applicationAdminToken: ports.applicationAdminToken,
        },
      );
      owns();
      assert.equal(provider.transitionSha256, proof.transitionSha256);
      assert.deepEqual(provider.transition, transition);
      assert.deepEqual(withoutTime(provider.current), withoutTime(bound.current));
      await validate(provider);
      for (const [path, bytes] of buffers)
        assert.deepEqual(await regularBytes(resolve(directory, path), maximum), bytes);
      freshness(gate.checkedAt, 6);
      owns();
      const operation: ConfirmedPlatformRecovery = {
        status: "operation-confirmed",
        before: provider.transition.before,
        after: provider.transition.after,
        requestedStrategy: provider.transition.requestedStrategy,
        strategyReadBack: provider.transition.strategyReadBack,
        reset: provider.transition.reset,
        incarnation: provider.transition.incarnation,
        eviction: provider.transition.eviction,
        physicalHostLoss: provider.transition.physicalHostLoss,
        operationEvidenceSha256: provider.transitionSha256,
      };
      phase = "verified";
      return snapshot({
        status: "lineage-confirmed" as const,
        operation,
        before,
        after,
        evidence: bound.proof.artifact,
        current: provider.current,
      });
    } catch {
      if (phase !== "disposed") phase = "failed";
      await clean().catch(() => {});
      return unavailable();
    }
  };
  return Object.freeze({
    verifyExisting() {
      if (phase !== "ready") return Promise.resolve(unavailable());
      phase = "verifying";
      pending = verify();
      return pending;
    },
    async dispose() {
      phase = "disposed";
      await pending;
      try {
        await clean();
      } catch {
        throw new Error(reason);
      }
    },
  });
}
