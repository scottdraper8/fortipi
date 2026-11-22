import assert from "node:assert/strict";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type {
  ApplicationRecoveryBridge,
  ConfirmedPlatformRecovery,
} from "../tests/clients/platform-recovery.ts";
import { validateApplicationRecoveryCheckpoints } from "./application-recovery-checkpoints.ts";
import {
  type ProviderPhaseResult,
  type RecoveryInput,
  type RecoveryPorts,
  recoverProvider,
} from "./platform-recovery.ts";
import {
  assertDeployment,
  canonicalJson,
  commitPattern,
  digest,
  type FileRecord,
  saveJson,
  sha256,
} from "./verify-release-gates.ts";

export type ApplicationRecoveryCoordinatorInput = Omit<RecoveryInput, "beforeCheckpoint">;
/** Closed on-disk port, relative to the common evidence output root. Deployment
 * identities remain in the original checkpoint and authenticated transition. */
export interface ApplicationRecoveryProof {
  schemaVersion: 1;
  sourceCommit: string;
  candidateSha256: string;
  operationId: string;
  transitionSha256: string;
  before: FileRecord;
  after: FileRecord;
}
export const applicationRecoveryProofFile = "application-recovery.json";
/** A fresh protected reader is required per invocation: its existing 32-read
 * budget is not a shared lifetime budget for perform plus verify-existing. */
export type RecoveryPortsFactory = () => RecoveryPorts | Promise<RecoveryPorts>;
const reason = "Application recovery unavailable or inconsistent; no combined proof qualified";
function snapshot<T>(value: T): T {
  // Shared canonicalJson rejects accessors, non-JSON values and cycles.
  const copy: T = JSON.parse(canonicalJson(value));
  const freeze = (item: unknown): void => {
    if (!item || typeof item !== "object" || Object.isFrozen(item)) return;
    Object.values(item).forEach(freeze);
    Object.freeze(item);
  };
  freeze(copy);
  return copy;
}
function record(
  value: FileRecord,
  directory: string,
  name: "application-before.json" | "application-after.json",
): FileRecord {
  const file = snapshot(value);
  assert.deepEqual(Object.keys(file).sort(), ["mode", "path", "sha256", "size"]);
  assert.equal(file.path, resolve(directory, name));
  assert.ok(Number.isSafeInteger(file.size) && file.size > 0 && file.size <= 1048576);
  assert.equal(file.mode, 0o600);
  digest(file.sha256);
  return file;
}
function confirmed(
  provider: ProviderPhaseResult,
  input: ApplicationRecoveryCoordinatorInput,
  before: FileRecord,
): ConfirmedPlatformRecovery {
  const t = provider.transition;
  assert.equal(t.schemaVersion, 1);
  assert.equal(t.phase, "provider-confirmed");
  assert.equal(t.operationId, input.operationId);
  assert.equal(t.candidateSha256, input.candidateSha256);
  assert.equal(t.beforeCheckpointSha256, before.sha256);
  assert.deepEqual(t.before, input.before);
  assertDeployment(t.before);
  assertDeployment(t.after);
  assertDeployment(provider.current);
  assert.equal(t.after.sourceCommit, input.sourceCommit);
  assert.equal(t.after.candidateSha256, input.candidateSha256);
  assert.notEqual(t.before.workerVersionId, t.after.workerVersionId);
  assert.notEqual(t.before.deploymentId, t.after.deploymentId);
  assert.equal(t.requestedStrategy, "immediate");
  assert.equal(t.strategyReadBack, false);
  assert.equal(t.reset, "inferred-from-provider-contract");
  assert.equal(t.incarnation, "not-observed");
  assert.equal(t.eviction, "not-observed");
  assert.equal(t.physicalHostLoss, "not-observed");
  assert.equal(t.requiresApplicationVerification, true);
  assert.equal(sha256(`${canonicalJson(t)}\n`), digest(provider.transitionSha256));
  return snapshot({
    status: "operation-confirmed",
    before: t.before,
    after: t.after,
    requestedStrategy: t.requestedStrategy,
    strategyReadBack: t.strategyReadBack,
    reset: t.reset,
    incarnation: t.incarnation,
    eviction: t.eviction,
    physicalHostLoss: t.physicalHostLoss,
    operationEvidenceSha256: provider.transitionSha256,
  });
}

/** Perform-mode trusted-parent bridge. The application child supplies ONLY its
 * bound FileRecords. Actual public continuation/reads remain the trusted
 * application wrapper's responsibility, not conclusions inferred from flags. */
export function createApplicationRecoveryCoordinator(
  input: ApplicationRecoveryCoordinatorInput,
  portsFactory: RecoveryPortsFactory,
): ApplicationRecoveryBridge {
  let bound: ApplicationRecoveryCoordinatorInput;
  try {
    assert.equal(typeof portsFactory, "function");
    bound = snapshot(input);
    assert.deepEqual(Object.keys(bound).sort(), [
      "before",
      "candidatePath",
      "candidateSha256",
      "checkpointDirectory",
      "journalDirectory",
      "operationId",
      "preparedDirectory",
      "sourceCommit",
      "target",
    ]);
    digest(bound.candidateSha256);
    assert.match(bound.sourceCommit, commitPattern);
    assert.match(bound.operationId, /^[a-f0-9]{32}$/);
    assertDeployment(bound.before);
    for (const path of [
      bound.candidatePath,
      bound.preparedDirectory,
      bound.journalDirectory,
      bound.checkpointDirectory,
    ])
      assert.ok(isAbsolute(path) && resolve(path) === path);
    assert.equal(basename(bound.checkpointDirectory), "application-recovery");
    assert.equal(basename(bound.journalDirectory), "provider-recovery");
    assert.equal(dirname(bound.checkpointDirectory), dirname(bound.journalDirectory));
  } catch {
    throw new Error(reason);
  }
  type Phase = "ready" | "performing" | "performed" | "finishing" | "finished" | "failed";
  let phase: Phase = "ready";
  let before: FileRecord | undefined;
  let provider: ProviderPhaseResult | undefined;
  const unavailable = () => ({ status: "unavailable" as const, reason });
  const enter = (from: Phase, to: Phase): boolean => {
    if (phase !== from) {
      if (phase !== "finished" && phase !== "failed") phase = "failed";
      return false;
    }
    phase = to;
    return true;
  };
  // Calls can be invalidated by a second phase request while an await is pending.
  const owns = (expected: Phase) => assert.equal(phase, expected, "Recovery phase superseded");
  const relativeRecord = (file: FileRecord): FileRecord => ({
    ...file,
    path: relative(dirname(bound.checkpointDirectory), file.path).split(sep).join("/"),
  });
  return Object.freeze({
    async perform(file: FileRecord) {
      if (!enter("ready", "performing")) return unavailable();
      try {
        before = record(file, bound.checkpointDirectory, "application-before.json");
        const ports = await portsFactory();
        owns("performing");
        const result = await recoverProvider(
          { ...bound, beforeCheckpoint: before, mode: "perform" },
          ports,
        );
        owns("performing");
        const saved = snapshot(result);
        const view = confirmed(saved, bound, before);
        provider = saved;
        phase = "performed";
        return view;
      } catch {
        phase = "failed";
        return unavailable();
      }
    },
    async finish(file: FileRecord) {
      if (!enter("performed", "finishing")) return unavailable();
      try {
        assert.ok(before && provider);
        const originalBefore = before;
        const originalProvider = provider;
        const after = record(file, bound.checkpointDirectory, "application-after.json");
        const ports = await portsFactory();
        owns("finishing");
        const current = await recoverProvider(
          {
            ...bound,
            beforeCheckpoint: originalBefore,
            mode: "verify-existing",
            retainedTransitionSha256: originalProvider.transitionSha256,
          },
          ports,
        );
        owns("finishing");
        assert.equal(current.transitionSha256, originalProvider.transitionSha256);
        assert.deepEqual(current.transition, originalProvider.transition);
        const validated = await validateApplicationRecoveryCheckpoints({
          checkpointDirectory: bound.checkpointDirectory,
          candidateSha256: bound.candidateSha256,
          sourceCommit: bound.sourceCommit,
          before: originalBefore,
          after,
          provider: { ...originalProvider, current: current.current },
        });
        owns("finishing");
        const proof: ApplicationRecoveryProof = {
          schemaVersion: 1,
          sourceCommit: bound.sourceCommit,
          candidateSha256: bound.candidateSha256,
          operationId: bound.operationId,
          transitionSha256: originalProvider.transitionSha256,
          before: relativeRecord(validated.before.record),
          after: relativeRecord(validated.after.record),
        };
        await saveJson(resolve(bound.journalDirectory, applicationRecoveryProofFile), proof);
        owns("finishing");
        phase = "finished";
        return {
          status: "qualified" as const,
          operationEvidenceSha256: originalProvider.transitionSha256,
        };
      } catch {
        phase = "failed";
        return unavailable();
      }
    },
  });
}
