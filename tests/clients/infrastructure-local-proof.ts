import assert from "node:assert/strict";
import {
  type ArtifactReference,
  assertGate,
  integratedClaims,
  object,
  sha256,
  string,
} from "../../scripts/verify-release-gates.ts";

/** Original JSON DATA delivered only after the trusted parent authenticates the
 * completed integrated producer/artifact/payload. Hashes are consistency checks,
 * not authority; no serialized verified flag can replace that authentication. */
export interface LocalInfrastructureProofData {
  reference: ArtifactReference;
  gateJson: string;
  resultJson: string;
}
export interface InfrastructureLocalTarget {
  sourceCommit: string;
  candidateSha256: string;
  scope: string;
  assetManifestSha256: string;
  lockSha256: string;
  toolchainPolicySha256: string;
  fixtureSha256: string;
  baseBoundsSha256: string;
  node: string;
}
function closed(value: unknown, fields: readonly string[]) {
  const row = object(value);
  assert.deepEqual(Reflect.ownKeys(row).sort(), [...fields].sort());
  return row;
}
function count(value: unknown) {
  assert.ok(typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
  return value;
}
function same(left: unknown, right: unknown) {
  assert.match(string(left), /^[a-f0-9]{64}$/);
  assert.equal(left, right);
}
function strings(value: unknown) {
  assert.ok(Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string"));
  return value;
}
export function verifyLocalInfrastructureProof(value: unknown, target: InfrastructureLocalTarget) {
  const input = closed(value, ["reference", "gateJson", "resultJson"]);
  assert.ok(typeof input.gateJson === "string" && typeof input.resultJson === "string");
  assert.ok(
    Buffer.byteLength(input.gateJson) + Buffer.byteLength(input.resultJson) <= 750_000,
    "Bounded claim JSON only; never an archive parse port",
  );
  const reference = closed(input.reference, [
    "runId",
    "runAttempt",
    "artifactId",
    "artifactName",
    "artifactDigest",
    "candidateSha256",
  ]);
  for (const field of ["runId", "runAttempt", "artifactId"]) assert.ok(count(reference[field]) > 0);
  string(reference.artifactName, 256);
  assert.match(string(reference.artifactDigest), /^sha256:[a-f0-9]{64}$/);
  same(reference.candidateSha256, target.candidateSha256);
  const gate: unknown = JSON.parse(input.gateJson);
  assertGate(gate);
  assert.equal(gate.kind, "integrated");
  assert.equal(gate.sourceCommit, target.sourceCommit);
  assert.equal(gate.candidateSha256, target.candidateSha256);
  assert.equal(gate.scope, target.scope);
  assert.equal(gate.producer.workflowPath, ".github/workflows/ci.yml");
  assert.equal(gate.producer.runId, reference.runId);
  assert.equal(gate.producer.runAttempt, reference.runAttempt);
  assert.deepEqual(gate.deployments, []);
  assert.deepEqual(gate.platforms, []);
  for (const id of integratedClaims)
    assert.ok(
      gate.claims.some((row) => row.id === id && row.outcome === "pass"),
      "A partial integrated gate is not a predecessor",
    );
  const claim = gate.claims.find((row) => row.id === "infrastructure-boundaries");
  assert.ok(claim);
  assert.equal(claim.result.path, "claims/infrastructure-boundaries.json");
  assert.equal(claim.result.size, Buffer.byteLength(input.resultJson));
  assert.equal(claim.result.sha256, sha256(input.resultJson));
  const result = closed(JSON.parse(input.resultJson), [
    "id",
    "outcome",
    "identity",
    "command",
    "observation",
    "oracle",
    "sensitivity",
    "limitations",
  ]);
  assert.equal(result.id, "infrastructure-boundaries");
  assert.equal(result.outcome, "pass");
  const identity = object(result.identity);
  for (const key of [
    "sourceCommit",
    "candidateSha256",
    "assetManifestSha256",
    "lockSha256",
    "toolchainPolicySha256",
    "fixtureSha256",
    "node",
  ] as const)
    assert.equal(identity[key], target[key]);
  assert.deepEqual(identity.producer, gate.producer);
  assert.deepEqual(identity.deployments, []);
  assert.equal(identity.seed, 1010);
  assert.equal(
    strings(result.command)[2],
    "local",
    "Only an original LOCAL observation contributes here",
  );
  strings(result.limitations);
  string(result.oracle, 8192);
  assert.ok(Array.isArray(result.sensitivity));
  const observation = verifyLocalInfrastructureObservation(
    result.observation,
    target.baseBoundsSha256,
  );
  return {
    scope: "LOCAL reduced-allocation/fault/physical-storage component observations",
    reference: structuredClone(reference),
    gateSha256: sha256(input.gateJson),
    result: claim.result,
    producer: gate.producer,
    command: strings(result.command),
    observation: structuredClone(observation),
    oracle: string(result.oracle, 8192),
    sensitivity: result.sensitivity,
    limitations: strings(result.limitations),
    interpretation:
      "Original authenticated LOCAL observations retained as LOCAL; not a live account-exhaustion or account-ceiling claim",
  };
}

/** The LOCAL producer uses the same semantic checks before writing its claim;
 * this function is not artifact/producer authentication. */
export function verifyLocalInfrastructureObservation(input: unknown, baseBoundsSha256: string) {
  const observation = object(input);
  const admissions = object(observation.admissions);
  assert.equal(admissions.contenders, 2);
  assert.equal(admissions.finalSlots, 1);
  assert.equal(admissions.acceptedBeforeRelease, 1);
  assert.equal(admissions.rejectedBeforeRelease, 1);
  assert.equal(admissions.rejectedPiInputs, 0);
  assert.equal(admissions.duplicatePreservedReceipt, true);
  assert.equal(admissions.sameRefusedKeyAdmittedAfterSettlement, true);
  assert.equal(admissions.actualFreeAccountExhaustion, false);
  const workspace = object(observation.workspaceAllocations);
  assert.equal(workspace.oldPublishedBytesAndRevisionsPreservedOnRefusal, true);
  const bounds = object(workspace.discoveredConfiguredBounds);
  const edges = workspace.actualPublicComputerByteBoundaries;
  assert.ok(Array.isArray(edges) && edges.length === 3);
  for (const [resource, field] of [
    ["file", "fileBytes"],
    ["snapshot", "snapshotBytes"],
    ["entries", "manifestEntries"],
  ] as const) {
    const edge = object(edges.find((row) => object(row).resource === resource));
    const limit = count(bounds[field]);
    assert.ok(limit > 0);
    assert.equal(edge.below, limit - 1);
    assert.equal(edge.at, limit);
    assert.equal(edge.above, limit + 1);
    assert.equal(edge.rejectedStatus, 429);
  }
  // These details must be produced by the genuine LOCAL scenario. The old
  // two-case claim deliberately fails here; neither its label nor a root-test
  // success supplies the missing observed cases.
  const detail = closed(observation.localInfrastructureDetails, [
    "schemaVersion",
    "baseBoundsSha256",
    "retention",
    "output",
    "refusalRestoration",
    "retirement",
    "stagingAndHistory",
    "headroom",
  ]);
  assert.equal(detail.schemaVersion, 1);
  same(detail.baseBoundsSha256, baseBoundsSha256);
  const retention = object(detail.retention);
  assert.ok(count(retention.lowerFixtureRetainedEvents) > 0);
  assert.ok(count(retention.retainedOriginalEvents) <= count(retention.lowerFixtureRetainedEvents));
  assert.ok(count(retention.retainedFloor) > 0);
  assert.equal(retention.expiredStatus, 410);
  assert.equal(retention.expiredCode, "cursor.expired");
  assert.equal(retention.futureStatus, 400);
  assert.equal(retention.futureCode, "cursor.invalid");
  assert.equal(retention.actualFreeCeilingClaim, false);
  const output = closed(detail.output, [
    "limits",
    "below",
    "at",
    "above",
    "bodyHashBefore",
    "bodyHashAfterReopen",
  ]);
  const limits = closed(output.limits, ["outputBytesPerJob", "inlineTailBytes", "artifactBytes"]);
  const limit = count(limits.outputBytesPerJob);
  assert.ok(limit > 1);
  for (const [name, delta] of [
    ["below", -1],
    ["at", 0],
    ["above", 1],
  ] as const) {
    const edge = closed(output[name], [
      "producedBytes",
      "retainedBytes",
      "tailBytes",
      "artifactBytes",
      "truncated",
    ]);
    assert.equal(count(edge.producedBytes), limit + delta);
    assert.equal(count(edge.retainedBytes), Math.min(limit, limit + delta));
    assert.ok(count(edge.tailBytes) <= count(limits.inlineTailBytes));
    assert.ok(count(edge.artifactBytes) <= count(limits.artifactBytes));
    assert.equal(edge.truncated, delta > 0);
  }
  same(output.bodyHashBefore, output.bodyHashAfterReopen);
  const refusal = closed(detail.refusalRestoration, [
    "fault",
    "rowsBefore",
    "rowsAfterRefusal",
    "requestRowsAfterRefusal",
    "restoredReservationId",
    "retryReservationId",
    "unknownStorageReset",
    "knownRetryAt",
    "retainedRetryAtAfterReopen",
  ]);
  assert.equal(refusal.fault, "local-sqlite-capacity-insert-abort");
  assert.equal(count(refusal.rowsBefore), 0);
  assert.equal(count(refusal.rowsAfterRefusal), 0);
  assert.equal(count(refusal.requestRowsAfterRefusal), 0);
  assert.equal(string(refusal.restoredReservationId), refusal.retryReservationId);
  assert.equal(refusal.unknownStorageReset, null);
  assert.ok(count(refusal.knownRetryAt) > 0);
  assert.equal(refusal.knownRetryAt, refusal.retainedRetryAtAfterReopen);
  assert.ok(Array.isArray(detail.stagingAndHistory) && detail.stagingAndHistory.length === 2);
  for (const resource of ["stagingBytesPerWorkspace", "retainedVersions"]) {
    const edge = closed(
      detail.stagingAndHistory.find((row) => object(row).resource === resource),
      [
        "resource",
        "configuredLimit",
        "below",
        "at",
        "above",
        "canonicalHashBefore",
        "canonicalHashAfter",
        "scope",
      ],
    );
    const configured = count(edge.configuredLimit);
    assert.ok(configured > 1);
    assert.equal(edge.scope, "local-schema-valid-allocation");
    for (const [name, delta] of [
      ["below", -1],
      ["at", 0],
      ["above", 1],
    ] as const) {
      const observed = closed(edge[name], ["attempted", "accepted", "status"]);
      assert.equal(count(observed.attempted), configured + delta);
      assert.equal(
        count(observed.accepted),
        delta > 0 ? (resource === "stagingBytesPerWorkspace" ? 0 : configured) : configured + delta,
      );
      assert.equal(observed.status, delta > 0 ? 429 : 200);
    }
    same(edge.canonicalHashBefore, edge.canonicalHashAfter);
  }
  const headroom = object(detail.headroom);
  assert.equal(headroom.scope, "LOCAL actual CP/SQLite default request meter");
  assert.equal(headroom.applicationLimit, 90);
  assert.equal(headroom.repairLimit, 30);
  assert.equal(headroom.applicationSuccesses, 90);
  assert.equal(headroom.completionSuccesses, 30);
  assert.equal(headroom.newAdmissionCode, "rate_limited");
  assert.equal(headroom.unknownReservationCode, "rate_limited");
  assert.equal(headroom.finalContenders, 2);
  assert.equal(headroom.finalAccepted, 1);
  assert.equal(headroom.nextRetryCode, "rate_limited");
  assert.equal(headroom.reservationRows, 1);
  string(headroom.originalReservationId);
  string(headroom.limitation, 4096);
  const cleanup = closed(headroom.retainedCleanup, [
    "scope",
    "originalExecutionId",
    "originalJobId",
    "applicationBefore",
    "applicationAfter",
    "repairBefore",
    "repairAfterQuery",
    "repairAfterCancel",
    "unregisteredQueryCode",
    "unregisteredCancelCode",
    "queryState",
    "cancelState",
    "possibleExternalEffects",
    "assignmentFrames",
    "queryFrames",
    "cancelFrames",
    "sameOriginalIdentity",
    "limitation",
  ]);
  assert.equal(cleanup.scope, "LOCAL registered-owner CP/SQLite; synthetic executor replies");
  string(cleanup.originalExecutionId);
  string(cleanup.originalJobId);
  assert.equal(cleanup.applicationBefore, 90);
  assert.equal(cleanup.applicationAfter, cleanup.applicationBefore);
  assert.equal(count(cleanup.repairAfterQuery), count(cleanup.repairBefore) + 1);
  assert.equal(count(cleanup.repairAfterCancel), count(cleanup.repairAfterQuery) + 1);
  assert.equal(cleanup.unregisteredQueryCode, "rate_limited");
  assert.equal(cleanup.unregisteredCancelCode, "rate_limited");
  assert.equal(cleanup.queryState, "running");
  assert.equal(cleanup.cancelState, "stopped");
  assert.equal(cleanup.possibleExternalEffects, true);
  assert.equal(cleanup.assignmentFrames, 1);
  assert.equal(cleanup.queryFrames, 1);
  assert.equal(cleanup.cancelFrames, 1);
  assert.equal(cleanup.sameOriginalIdentity, true);
  string(cleanup.limitation, 4096);
  const retirement = object(detail.retirement);
  assert.equal(retirement.actualComputerAndSqlite, true);
  assert.equal(retirement.realGraceMs, 60000);
  assert.equal(retirement.graceProtected, true);
  assert.equal(retirement.actualDeallocation, true);
  assert.ok(
    count(retirement.disposableMeasuredBytesAfter) <
      count(retirement.disposableMeasuredBytesBefore),
  );
  assert.equal(retirement.tombstonePreserved, true);
  assert.equal(retirement.unreferencedPublicReadStatus, 404);
  assert.equal(retirement.publishedIndependentHashesPreserved, true);
  return structuredClone(observation);
}
