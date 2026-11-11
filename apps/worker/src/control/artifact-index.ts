import { validateChunkInventory } from "fortipi-contract";
import type * as D from "../boundary/dto.js";
import { emptyScope } from "./authorization.js";
import type { Directory } from "./directory.js";
import { type DispatchRecord, sameExecution } from "./dispatch.js";
import { check, json, type Store, same } from "./store.js";
import type { ExecutorState } from "./tickets.js";

/** Immutable metadata only. A result's transport receipt and these rows share one SQLite transaction. */
export interface NativeArtifact {
  reference: D.ByteReference;
  identity: D.ExecutionIdentity;
  operationId: string;
  bindingVersion: number;
  agentId: string;
  conversationId: string;
}
function artifactEndpointMatches(reference: D.ByteReference, path: string): boolean {
  if (reference.endpoint.split("?")[0] !== path || reference.endpoint.includes("#")) return false;
  try {
    const endpoint = new URL(reference.endpoint, "https://control.internal");
    const query = [...endpoint.searchParams];
    return (
      endpoint.origin === "https://control.internal" &&
      endpoint.pathname === path &&
      query.length <= 1 &&
      query.every(([key, value]) => key === "revision" && value === reference.revision)
    );
  } catch {
    return false;
  }
}
export function artifactScope(row: NativeArtifact): D.ResourceScope {
  return {
    ...emptyScope(),
    workspaceIds: [row.reference.workspaceId],
    agentIds: [row.agentId],
    conversationIds: [row.conversationId],
    executorIds: [row.reference.owner.executorId ?? ""],
    actions: ["artifacts.read"],
  };
}
export function indexArtifacts(store: Store, directory: Directory, result: D.PreparedResult): void {
  const dispatch = store.get<DispatchRecord>("dispatch", result.identity.executionId);
  check(
    dispatch?.attempted && sameExecution(dispatch.intent.assignment.identity, result.identity),
    "conflict",
    "Artifact execution is not assigned",
  );
  const reservation = dispatch.intent.reservation;
  const target = result.identity.target;
  check(
    target.kind === "executor" &&
      reservation.target.kind === "executor" &&
      reservation.executionId === result.identity.executionId,
    "conflict",
    "Artifact reservation mismatch",
  );
  const executor = store.get<ExecutorState>("executor", target.executorId);
  const caps = executor?.description?.transferLimits;
  check(
    executor && executor.generation === target.generation && executor.status !== "revoked" && caps,
    "unavailable_executor",
    "Artifact publisher unavailable",
  );
  check(
    result.output.artifacts.length <= 16 &&
      new TextEncoder().encode(result.output.tail).length <=
        directory.policy().bounds.inlineTailBytes,
    "payload_too_large",
    "Artifact result exceeds bounds",
  );
  const originalSet = store.get<D.ByteReference[]>(
    "native_artifact_set",
    result.identity.executionId,
  );
  check(
    !originalSet || same(originalSet, result.output.artifacts),
    "conflict",
    "Execution artifact membership changed",
  );
  let total = 0;
  const rows: NativeArtifact[] = [];
  const ids = new Set<string>();
  for (const reference of result.output.artifacts) {
    check(
      reference.artifactId &&
        !ids.has(reference.artifactId) &&
        reference.owner.kind === "local" &&
        reference.owner.executorId === target.executorId &&
        reference.workspaceId === reservation.workspaceId &&
        reference.revision === result.identity.baseRevision &&
        reference.outputSource &&
        reference.chunks &&
        artifactEndpointMatches(
          reference,
          `/v1/workspaces/${reservation.workspaceId}/artifacts/${reference.artifactId}`,
        ),
      "conflict",
      "Artifact metadata does not match its execution",
    );
    ids.add(reference.artifactId);
    validateChunkInventory(reference.chunks, reference.size);
    check(
      reference.chunks.chunkBytes <= caps.chunkBytes &&
        reference.size <= caps.artifactBytes &&
        (reference.owner.expiresAt === undefined || reference.owner.expiresAt > Date.now()),
      "payload_too_large",
      "Artifact exceeds registered bounds or retention",
    );
    total += reference.size;
    const row: NativeArtifact = {
      reference,
      identity: result.identity,
      operationId: reservation.operationId,
      bindingVersion: reservation.bindingVersion,
      agentId: reservation.agentId,
      conversationId: reservation.conversationId,
    };
    const old = store.get<NativeArtifact>("native_artifact", reference.artifactId);
    check(!old || same(old, row), "conflict", "Artifact identity or metadata changed");
    if (!old) rows.push(row);
  }
  check(
    total <= Math.min(directory.policy().bounds.artifactBytes, caps.artifactBytes),
    "payload_too_large",
    "Aggregate artifacts exceed effective bounds",
  );
  const bytes = rows.reduce(
    (sum, row) => sum + new TextEncoder().encode(json(row)).length * 3 + 4096,
    originalSet ? 0 : new TextEncoder().encode(json(result.output.artifacts)).length * 3 + 4096,
  );
  const policy = directory.policy().bounds;
  check(
    store.storage.sql.databaseSize + bytes <=
      Math.min(store.admissionBytes, policy.objectBytes * (1 - policy.headroomFraction)),
    "quota_exceeded",
    "Artifact metadata admission preserves repair headroom",
  );
  for (const row of rows)
    store.put("native_artifact", row.reference.artifactId ?? "", row, result.identity.executionId);
  if (!originalSet)
    store.put("native_artifact_set", result.identity.executionId, result.output.artifacts);
}
export function artifactForDescriptor(store: Store, d: D.TransferDescriptor): NativeArtifact {
  check(
    d.purpose === "output" && d.content.kind === "job-output",
    "unauthorized",
    "Output artifact required",
  );
  const row = store.get<NativeArtifact>("native_artifact", d.content.artifactId);
  check(
    row &&
      row.identity.target.kind === "executor" &&
      d.jobId === row.identity.jobId &&
      d.executionId === row.identity.executionId &&
      d.operationId === row.operationId &&
      d.operationDigest === row.identity.operationDigest &&
      d.workspaceId === row.reference.workspaceId &&
      d.bindingVersion === row.bindingVersion &&
      d.baseRevision === row.identity.baseRevision &&
      d.executorId === row.identity.target.executorId &&
      d.executorGeneration === row.identity.target.generation &&
      d.content.stream === row.reference.outputSource?.stream &&
      d.fileSha256 === row.reference.sha256 &&
      d.size === row.reference.size &&
      same({ chunkBytes: d.chunkBytes, chunkHashes: d.chunkHashes }, row.reference.chunks) &&
      !d.lease &&
      (row.reference.owner.expiresAt === undefined || row.reference.owner.expiresAt > Date.now()),
    "unauthorized",
    "Output transfer is not an indexed artifact member",
  );
  return row;
}
