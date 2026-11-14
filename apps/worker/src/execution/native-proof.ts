import { localIntentDigest, manifestDigest, validateManifest, wireLimits } from "fortipi-contract";
import { check, same } from "../api/common.js";
import { validate } from "../api/validation.js";
import type * as D from "../boundary/dto.js";
import { sameLeaseIdentity } from "./identity.js";
import type { JobState } from "./jobs.js";

export async function nativeContext(state: JobState) {
  const request = state.localRequest,
    prepared = state.localPreparation,
    intent = state.localIntent,
    identity = state.assignment?.identity,
    result = state.job.preparedResult;
  check(
    request?.kind === "prepare" &&
      request.mode.kind === "native-execution" &&
      prepared &&
      intent &&
      identity?.target.kind === "executor" &&
      result?.state === "succeeded",
    "conflict",
    "Native proof context unavailable",
  );
  const { kind: _kind, mode, commitId, expectedManifestHash, ...scope } = request;
  check(
    sameLeaseIdentity(result.identity.lease, identity.lease) &&
      same(result.identity, { ...identity, lease: state.resultLease ?? identity.lease }) &&
      same(state.job.execution, identity) &&
      same(scope, intent.scope) &&
      scope.workspaceId === state.job.workspaceId &&
      scope.bindingVersion === state.bindingVersion &&
      scope.rootBindingId === state.rootBindingId &&
      scope.baseRevision === state.job.baseRevision &&
      scope.operationId === state.operation.operationId &&
      scope.operationDigest === identity.operationDigest &&
      same(scope.lease, identity.lease) &&
      scope.executorId === identity.target.executorId &&
      scope.executorGeneration === identity.target.generation &&
      same(scope.credential, {
        credentialId: state.auth.credentialId,
        generation: state.auth.generation,
        grantVersion: state.auth.grantVersion,
      }) &&
      mode.jobId === state.job.jobId &&
      mode.executionId === identity.executionId &&
      mode.assignmentDigest === identity.assignmentDigest &&
      commitId === intent.commitId &&
      result.commitId === commitId &&
      prepared.preparationId === intent.preparationId &&
      prepared.operationId === scope.operationId &&
      prepared.operationDigest === scope.operationDigest &&
      expectedManifestHash === state.baseManifestHash &&
      prepared.preManifestHash === state.baseManifestHash &&
      intent.preManifestHash === state.baseManifestHash &&
      intent.intentDigest === (await localIntentDigest(intent)),
    "conflict",
    "Native preparation/intent differs from the execution",
  );
  return { request, prepared, intent, identity, result, scope };
}
export async function nativeProof(
  state: JobState,
  raw: unknown,
  policy: D.InfrastructurePolicy,
): Promise<{
  observation: Extract<D.LocalObservation, { state: "applied" }>;
  manifest?: D.Manifest;
}> {
  validate<D.LocalObservation>("LocalObservation", raw);
  const maximumId = "x".repeat(128);
  const envelope = {
    type: "workspace.response",
    requestId: maximumId,
    payload: { requestId: maximumId, correlationId: maximumId, response: raw },
  };
  check(
    new TextEncoder().encode(JSON.stringify(envelope)).length <= wireLimits.jsonBytes,
    "payload_too_large",
    "Local response exceeds full-frame bound",
  );
  const { scope, identity, prepared, intent, request } = await nativeContext(state);
  const commitId = request.commitId,
    result = state.job.preparedResult;
  check(result, "conflict", "Prepared result unavailable");
  check(
    raw.state === "applied" &&
      raw.executionId === identity.executionId &&
      raw.operationId === scope.operationId &&
      raw.operationDigest === scope.operationDigest &&
      raw.commitId === commitId &&
      raw.preparationId === prepared.preparationId &&
      raw.preManifestHash === state.baseManifestHash &&
      raw.postManifestHash === result.manifestHash &&
      raw.observationSeq > 0 &&
      (intent.expectedPostManifestHash === undefined ||
        intent.expectedPostManifestHash === raw.postManifestHash),
    "conflict",
    "Native observation is incomplete or differs from the job",
  );
  if (raw.postManifest) {
    validate<D.Manifest>("Manifest", raw.postManifest);
    validateManifest(raw.postManifest);
    const limits = state.executorTransferLimits;
    check(limits, "unavailable_executor", "Validated executor transfer limits required");
    validate<D.ExecutorTransferLimits>("ExecutorTransferLimits", limits);
    const entries = Math.min(
      policy.bounds.manifestEntries,
      wireLimits.manifestEntries,
      limits.manifestEntries,
    );
    const fileBytes = Math.min(policy.bounds.fileBytes, wireLimits.fileBytes, limits.fileBytes);
    const totalBytes = Math.min(
      policy.bounds.workspaceBytes,
      policy.bounds.snapshotBytes,
      wireLimits.revisionBytes,
      limits.snapshotBytes,
    );
    let bytes = 0;
    check(
      raw.postManifest.entries.length <= entries,
      "payload_too_large",
      "Native manifest entry bound exceeded",
    );
    for (const entry of raw.postManifest.entries)
      if (entry.type === "file") {
        check(entry.size <= fileBytes, "payload_too_large", "Native file bound exceeded");
        bytes += entry.size;
      }
    check(
      bytes <= totalBytes && (await manifestDigest(raw.postManifest)) === raw.postManifestHash,
      "conflict",
      "Native post-manifest hash or size differs",
    );
    return { observation: raw, manifest: raw.postManifest };
  }
  check(
    raw.postManifestHash === state.baseManifestHash,
    "unavailable",
    "Retained complete native post-manifest handoff required",
  );
  return { observation: raw };
}
