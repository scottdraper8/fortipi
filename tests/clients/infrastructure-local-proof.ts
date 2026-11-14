import assert from "node:assert/strict";
import {
  canonicalJson,
  freeInfrastructurePolicy,
} from "../../packages/fortipi-contract/dist/index.js";
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
    "defaultComputerDeclarations",
  ]);
  assert.equal(detail.schemaVersion, 1);
  same(detail.baseBoundsSha256, baseBoundsSha256);
  verifyDefaultComputerDeclarations(detail.defaultComputerDeclarations);
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

/** Closed original-LOCAL contribution; consistency is not producer authority. */
export function verifyDefaultComputerDeclarations(value: unknown) {
  const detail = closed(value, [
    "schemaVersion",
    "scope",
    "defaultPolicySha256",
    "fixturePolicySha256",
    "cadence",
    "installations",
    "cases",
    "limitations",
  ]);
  assert.equal(detail.schemaVersion, 1);
  assert.equal(detail.scope, "LOCAL separate installations per resource");
  same(detail.defaultPolicySha256, sha256(canonicalJson(freeInfrastructurePolicy)));
  const fixturePolicy = structuredClone(freeInfrastructurePolicy);
  fixturePolicy.bounds.requestsPerPrincipalMinute = 10000;
  fixturePolicy.bounds.requestsPerInstallMinute = 10000;
  same(detail.fixturePolicySha256, sha256(canonicalJson(fixturePolicy)));
  assert.deepEqual(
    closed(detail.cadence, ["requestsPerPrincipalMinute", "requestsPerInstallMinute"]),
    { requestsPerPrincipalMinute: 10000, requestsPerInstallMinute: 10000 },
  );
  const limits = { file: 4194304, snapshot: 16777216, entries: 512 };
  const canaryFile = { path: "notes.txt", size: 7, sha256: sha256("old-v1\n") };
  const manifestHash = (
    entries: { path: string; type: "file"; mode: 420; size: number; sha256: string }[],
  ) => sha256(`fortipi:manifest:v1\n${canonicalJson({ version: 1, entries })}`);
  const expectedCanaryHash = manifestHash([{ ...canaryFile, type: "file", mode: 420 }]);
  const hashes = new Map<number, string>();
  const blobHash = (size: number) => {
    let hash = hashes.get(size);
    if (!hash) {
      hash = sha256(Buffer.alloc(size, 101));
      hashes.set(size, hash);
    }
    return hash;
  };
  const expectedDeclaration = (resource: keyof typeof limits, delta: number) => {
    const size = limits[resource] + delta;
    const sizes =
      resource === "file"
        ? [size]
        : resource === "snapshot"
          ? delta > 0
            ? [4194304, 4194304, 4194304, 4194304, 1]
            : [4194304, 4194304, 4194304, size - 3 * 4194304]
          : Array<number>(size).fill(1);
    return manifestHash(
      sizes.map((size, index) => ({
        path: `edge-${String(index).padStart(4, "0")}.bin`,
        type: "file",
        mode: 420,
        size,
        sha256: blobHash(size),
      })),
    );
  };
  const ordinaryHash = manifestHash([
    { path: "ordinary.bin", type: "file", mode: 420, size: 2097152, sha256: blobHash(2097152) },
  ]);
  assert.ok(Array.isArray(detail.installations) && detail.installations.length === 3);
  const installations = new Map<
    string,
    { applicationId: string; storagePathSha256: string; credentials: Set<string> }
  >();
  for (const input of detail.installations) {
    const row = closed(input, [
      "resource",
      "applicationId",
      "storagePathSha256",
      "credentialCleanup",
    ]);
    const resource = string(row.resource);
    assert.ok(Object.hasOwn(limits, resource) && !installations.has(resource));
    const applicationId = string(row.applicationId, 192);
    assert.ok(Array.isArray(row.credentialCleanup) && row.credentialCleanup.length > 0);
    const credentials = new Set<string>();
    for (const input of row.credentialCleanup) {
      const cleanup = closed(input, ["credentialId", "generation", "state", "pendingRecipients"]);
      const id = string(cleanup.credentialId, 192);
      assert.ok(!credentials.has(id));
      credentials.add(id);
      assert.ok(count(cleanup.generation) > 0);
      assert.equal(cleanup.state, "complete");
      assert.equal(cleanup.pendingRecipients, 0);
    }
    assert.match(string(row.storagePathSha256), /^[a-f0-9]{64}$/);
    installations.set(resource, {
      applicationId,
      storagePathSha256: string(row.storagePathSha256),
      credentials,
    });
  }
  assert.equal(new Set([...installations.values()].map((row) => row.storagePathSha256)).size, 3);
  assert.ok(Array.isArray(detail.cases) && detail.cases.length === 9);
  const seen = new Set<string>();
  const used = new Map<string, Set<string>>();
  const checkAbort = (value: unknown, uploadId: unknown) => {
    const row = closed(value, ["uploadId", "state", "conflictStatus", "acknowledgment"]);
    assert.equal(string(row.uploadId), uploadId);
    assert.equal(row.state, "aborted");
    assert.ok(row.conflictStatus === null || row.conflictStatus === 409);
    assert.equal(
      row.acknowledgment,
      row.conflictStatus === null ? "direct" : "recovered-by-current-scoped-status",
    );
  };
  for (const input of detail.cases) {
    const row = closed(input, [
      "resource",
      "relation",
      "limit",
      "declared",
      "outcome",
      "workspaceId",
      "leaseId",
      "requestedManifestHash",
      "beginStatus",
      "beginCode",
      "beginRetryable",
      "pressure",
      "admission",
      "ordinary",
      "abort",
      "chunksDelivered",
      "publishedRevision",
      "publishedManifestHash",
      "canonicalFiles",
      "leaseRelease",
      "applicationId",
      "storagePathSha256",
      "credentialId",
    ]);
    const resource = string(row.resource);
    assert.ok(resource === "file" || resource === "snapshot" || resource === "entries");
    const relation = string(row.relation);
    assert.ok(relation === "below" || relation === "at" || relation === "above");
    const key = `${resource}/${relation}`;
    assert.ok(!seen.has(key));
    seen.add(key);
    const delta = relation === "below" ? -1 : relation === "above" ? 1 : 0;
    assert.equal(row.limit, limits[resource]);
    assert.equal(row.declared, limits[resource] + delta);
    same(row.requestedManifestHash, expectedDeclaration(resource, delta));
    string(row.workspaceId, 192);
    string(row.leaseId, 192);
    string(row.publishedRevision, 192);
    same(row.publishedManifestHash, expectedCanaryHash);
    assert.deepEqual(row.canonicalFiles, [canaryFile]);
    assert.equal(row.chunksDelivered, 0);
    const installation = installations.get(resource);
    assert.ok(installation);
    assert.equal(row.applicationId, installation.applicationId);
    same(row.storagePathSha256, installation.storagePathSha256);
    const credential = string(row.credentialId, 192);
    assert.ok(installation.credentials.has(credential));
    if (!used.has(resource)) used.set(resource, new Set());
    used.get(resource)?.add(credential);
    const release = closed(row.leaseRelease, ["leaseId", "released"]);
    assert.equal(release.leaseId, row.leaseId);
    assert.equal(release.released, true);
    const admitted = resource !== "snapshot" && delta <= 0;
    assert.equal(
      row.outcome,
      admitted
        ? "opened-and-aborted"
        : resource === "snapshot" && delta <= 0
          ? "combined-budget-refusal"
          : "descriptor-refusal",
    );
    if (admitted) {
      assert.equal(row.beginStatus, 201);
      assert.equal(row.beginCode, null);
      assert.equal(row.beginRetryable, null);
      assert.equal(row.pressure, null);
      assert.equal(row.ordinary, null);
      const admission = closed(row.admission, [
        "uploadId",
        "state",
        "manifestHash",
        "baseRevision",
      ]);
      string(admission.uploadId, 192);
      assert.equal(admission.state, "open");
      same(admission.manifestHash, row.requestedManifestHash);
      assert.equal(admission.baseRevision, row.publishedRevision);
      checkAbort(row.abort, admission.uploadId);
    } else {
      assert.equal(row.beginStatus, 429);
      assert.equal(row.beginCode, "quota_exceeded");
      assert.equal(row.beginRetryable, false);
      assert.equal(row.admission, null);
      const pressure = closed(row.pressure, [
        "resource",
        "scope",
        "source",
        "measurement",
        "reason",
        "action",
      ]);
      assert.equal(pressure.resource, "storage");
      assert.deepEqual(closed(pressure.scope, ["kind"]), { kind: "object" });
      assert.equal(pressure.source, "policy");
      assert.equal(pressure.measurement, "estimated");
      assert.equal(pressure.action, "reclaim-storage");
      assert.equal(
        pressure.reason,
        resource === "snapshot" && delta <= 0
          ? "Workspace physical copies and unspent growth exhaust the shared pool"
          : "Snapshot exceeds effective workspace bounds",
      );
      if (resource === "snapshot") {
        const ordinary = closed(row.ordinary, [
          "declaredBytes",
          "status",
          "workspaceId",
          "uploadId",
          "requestedManifestHash",
          "baseRevision",
          "state",
          "manifestHash",
          "chunksDelivered",
          "abort",
        ]);
        assert.equal(ordinary.declaredBytes, 2097152);
        assert.equal(ordinary.status, 201);
        assert.equal(ordinary.workspaceId, row.workspaceId);
        assert.equal(ordinary.baseRevision, row.publishedRevision);
        assert.equal(ordinary.state, "open");
        assert.equal(ordinary.chunksDelivered, 0);
        same(ordinary.requestedManifestHash, ordinaryHash);
        same(ordinary.manifestHash, ordinaryHash);
        string(ordinary.uploadId, 192);
        checkAbort(ordinary.abort, ordinary.uploadId);
        assert.deepEqual(row.abort, ordinary.abort);
      } else {
        assert.equal(row.ordinary, null);
        assert.equal(row.abort, null);
      }
    }
  }
  for (const [resource, installation] of installations)
    assert.deepEqual(used.get(resource), installation.credentials);
  strings(detail.limitations);
  return structuredClone(detail);
}
