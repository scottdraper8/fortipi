import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalJson,
  freeInfrastructurePolicy,
} from "../../packages/fortipi-contract/dist/index.js";
import { integratedClaims, sha256 } from "../../scripts/verify-release-gates.ts";
import {
  type InfrastructureLocalTarget,
  verifyLocalInfrastructureProof,
} from "./infrastructure-local-proof.ts";
import {
  allocationDeclaration,
  infrastructureFixtureBounds,
} from "./live-infrastructure-controls.ts";

// Controlled DATA only: these tests make no candidate, actual job/artifact,
// authenticated producer or passing runEvidence Gate. Parent authentication is
// outside this pure parser and cannot be conferred by these positive IDs.
const target: InfrastructureLocalTarget = {
  sourceCommit: "a".repeat(40),
  candidateSha256: "b".repeat(64),
  scope: "fortipi-ci-test",
  assetManifestSha256: "c".repeat(64),
  lockSha256: "d".repeat(64),
  toolchainPolicySha256: "e".repeat(64),
  fixtureSha256: "f".repeat(64),
  baseBoundsSha256: sha256(canonicalJson(infrastructureFixtureBounds)),
  node: "26.13.1",
};
function controlledDefaultDeclarations() {
  const resources = ["file", "snapshot", "entries"] as const;
  const relations = ["below", "at", "above"] as const;
  const policy = structuredClone(freeInfrastructurePolicy);
  policy.bounds.requestsPerPrincipalMinute = 10000;
  policy.bounds.requestsPerInstallMinute = 10000;
  const canary = { path: "notes.txt", size: 7, sha256: sha256("old-v1\n") };
  const manifestHash = (entries: unknown[]) =>
    sha256(`fortipi:manifest:v1\n${canonicalJson({ version: 1, entries })}`);
  const canaryHash = manifestHash([{ ...canary, type: "file", mode: 420 }]);
  const ordinaryHash = manifestHash([
    {
      path: "ordinary.bin",
      type: "file",
      mode: 420,
      size: 2097152,
      sha256: sha256(Buffer.alloc(2097152, 101)),
    },
  ]);
  const cases = resources.flatMap((resource) =>
    relations.map((relation) => {
      const delta = relation === "below" ? -1 : relation === "above" ? 1 : 0;
      const fixture = allocationDeclaration(resource, delta);
      const admitted = resource !== "snapshot" && delta <= 0;
      const uploadId = `controlled-${resource}-${relation}`;
      const abort = {
        uploadId,
        state: "aborted",
        conflictStatus: 409,
        acknowledgment: "recovered-by-current-scoped-status",
      };
      const workspaceId = `workspace-${uploadId}`,
        publishedRevision = `revision-${uploadId}`,
        leaseId = `lease-${uploadId}`;
      return {
        resource,
        relation,
        limit: fixture.limit,
        declared: fixture.declared,
        outcome: admitted
          ? "opened-and-aborted"
          : resource === "snapshot" && delta <= 0
            ? "combined-budget-refusal"
            : "descriptor-refusal",
        workspaceId,
        leaseId,
        requestedManifestHash: fixture.manifestHash,
        beginStatus: admitted ? 201 : 429,
        beginCode: admitted ? null : "quota_exceeded",
        beginRetryable: admitted ? null : false,
        pressure: admitted
          ? null
          : {
              resource: "storage",
              scope: { kind: "object" },
              source: "policy",
              measurement: "estimated",
              reason:
                resource === "snapshot" && delta <= 0
                  ? "Workspace physical copies and unspent growth exhaust the shared pool"
                  : "Snapshot exceeds effective workspace bounds",
              action: "reclaim-storage",
            },
        admission: admitted
          ? {
              uploadId,
              state: "open",
              manifestHash: fixture.manifestHash,
              baseRevision: publishedRevision,
            }
          : null,
        ordinary:
          resource === "snapshot"
            ? {
                declaredBytes: 2097152,
                status: 201,
                workspaceId,
                uploadId,
                requestedManifestHash: ordinaryHash,
                baseRevision: publishedRevision,
                state: "open",
                manifestHash: ordinaryHash,
                chunksDelivered: 0,
                abort,
              }
            : null,
        abort: admitted || resource === "snapshot" ? abort : null,
        chunksDelivered: 0,
        publishedRevision,
        publishedManifestHash: canaryHash,
        canonicalFiles: [canary],
        leaseRelease: { leaseId, released: true },
        applicationId: "controlled-local",
        storagePathSha256: sha256(resource),
        credentialId: uploadId,
      };
    }),
  );
  return {
    schemaVersion: 1,
    scope: "LOCAL separate installations per resource",
    defaultPolicySha256: sha256(canonicalJson(freeInfrastructurePolicy)),
    fixturePolicySha256: sha256(canonicalJson(policy)),
    cadence: { requestsPerPrincipalMinute: 10000, requestsPerInstallMinute: 10000 },
    installations: resources.map((resource) => ({
      resource,
      applicationId: "controlled-local",
      storagePathSha256: sha256(resource),
      credentialCleanup: relations.map((relation) => ({
        credentialId: `controlled-${resource}-${relation}`,
        generation: 1,
        state: "complete",
        pendingRecipients: 0,
      })),
    })),
    cases,
    limitations: [
      "Controlled parser fixture only; no actual producer, job, candidate, provider or passing Gate authority",
    ],
  };
}

function packet() {
  const producer = {
    workflowPath: ".github/workflows/ci.yml",
    workflowSha256: "1".repeat(64),
    workflowId: 12,
    runId: 34,
    runAttempt: 1,
  };
  const limits = { outputBytesPerJob: 256, inlineTailBytes: 32, artifactBytes: 64 };
  const outputEdge = (n: number) => ({
    producedBytes: n,
    retainedBytes: Math.min(256, n),
    tailBytes: 32,
    artifactBytes: 64,
    truncated: n > 256,
  });
  const stageEdge = (resource: string, configuredLimit: number) => ({
    resource,
    configuredLimit,
    scope: "local-schema-valid-allocation",
    below: { attempted: configuredLimit - 1, accepted: configuredLimit - 1, status: 200 },
    at: { attempted: configuredLimit, accepted: configuredLimit, status: 200 },
    above: {
      attempted: configuredLimit + 1,
      accepted: resource === "stagingBytesPerWorkspace" ? 0 : configuredLimit,
      status: 429,
    },
    canonicalHashBefore: "2".repeat(64),
    canonicalHashAfter: "2".repeat(64),
  });
  const result = {
    id: "infrastructure-boundaries",
    outcome: "pass",
    identity: { ...target, producer, seed: 1010, deployments: [] },
    command: ["/controlled/node", "/controlled/run-evidence.ts", "local"],
    oracle: "Controlled observed cases for the parser only",
    sensitivity: [],
    limitations: ["LOCAL controlled DTO; no actual producer/job/provider proof"],
    observation: {
      admissions: {
        contenders: 2,
        finalSlots: 1,
        acceptedBeforeRelease: 1,
        rejectedBeforeRelease: 1,
        rejectedPiInputs: 0,
        duplicatePreservedReceipt: true,
        sameRefusedKeyAdmittedAfterSettlement: true,
        actualFreeAccountExhaustion: false,
      },
      workspaceAllocations: {
        oldPublishedBytesAndRevisionsPreservedOnRefusal: true,
        discoveredConfiguredBounds: { fileBytes: 8192, snapshotBytes: 16384, manifestEntries: 3 },
        actualPublicComputerByteBoundaries: [
          { resource: "file", below: 8191, at: 8192, above: 8193, rejectedStatus: 429 },
          { resource: "snapshot", below: 16383, at: 16384, above: 16385, rejectedStatus: 429 },
          { resource: "entries", below: 2, at: 3, above: 4, rejectedStatus: 429 },
        ],
      },
      localInfrastructureDetails: {
        schemaVersion: 1,
        baseBoundsSha256: target.baseBoundsSha256,
        defaultComputerDeclarations: controlledDefaultDeclarations(),
        retention: {
          lowerFixtureRetainedEvents: 6,
          retainedOriginalEvents: 5,
          retainedFloor: 2,
          expiredStatus: 410,
          expiredCode: "cursor.expired",
          futureStatus: 400,
          futureCode: "cursor.invalid",
          actualFreeCeilingClaim: false,
        },
        output: {
          limits,
          below: outputEdge(255),
          at: outputEdge(256),
          above: outputEdge(257),
          bodyHashBefore: "3".repeat(64),
          bodyHashAfterReopen: "3".repeat(64),
        },
        refusalRestoration: {
          fault: "local-sqlite-capacity-insert-abort",
          rowsBefore: 0,
          rowsAfterRefusal: 0,
          requestRowsAfterRefusal: 0,
          restoredReservationId: "original",
          retryReservationId: "original",
          unknownStorageReset: null,
          knownRetryAt: 123456,
          retainedRetryAtAfterReopen: 123456,
        },
        retirement: {
          actualComputerAndSqlite: true,
          realGraceMs: 60000,
          graceProtected: true,
          actualDeallocation: true,
          disposableMeasuredBytesBefore: 131072,
          disposableMeasuredBytesAfter: 4096,
          tombstonePreserved: true,
          unreferencedPublicReadStatus: 404,
          publishedIndependentHashesPreserved: true,
        },
        headroom: {
          scope: "LOCAL actual CP/SQLite default request meter",
          applicationLimit: 90,
          repairLimit: 30,
          applicationSuccesses: 90,
          completionSuccesses: 30,
          newAdmissionCode: "rate_limited",
          unknownReservationCode: "rate_limited",
          finalContenders: 2,
          finalAccepted: 1,
          nextRetryCode: "rate_limited",
          reservationRows: 1,
          originalReservationId: "controlled-original",
          limitation: "LOCAL component, not shared account",
          retainedCleanup: {
            scope: "LOCAL registered-owner CP/SQLite; synthetic executor replies",
            originalExecutionId: "controlled-execution",
            originalJobId: "controlled-job",
            applicationBefore: 90,
            applicationAfter: 90,
            repairBefore: 0,
            repairAfterQuery: 1,
            repairAfterCancel: 2,
            unregisteredQueryCode: "rate_limited",
            unregisteredCancelCode: "rate_limited",
            queryState: "running",
            cancelState: "stopped",
            possibleExternalEffects: true,
            assignmentFrames: 1,
            queryFrames: 1,
            cancelFrames: 1,
            sameOriginalIdentity: true,
            limitation: "Controlled protocol packet; not executed native effects",
          },
        },
        stagingAndHistory: [
          stageEdge("stagingBytesPerWorkspace", 8192),
          stageEdge("retainedVersions", 2),
        ],
      },
    },
  };
  const resultJson = JSON.stringify(result, null, 2) + "\n";
  const claims = integratedClaims.map((id) => ({
    id,
    outcome: "pass",
    result: {
      path: `claims/${id}.json`,
      size: id === result.id ? Buffer.byteLength(resultJson) : 0,
      mode: 0o600,
      sha256: id === result.id ? sha256(resultJson) : sha256(""),
    },
  }));
  const gate = {
    schemaVersion: 1,
    kind: "integrated",
    candidateSha256: target.candidateSha256,
    sourceCommit: target.sourceCommit,
    scope: target.scope,
    producer,
    checkedAt: "2026-11-13T00:00:00.000Z",
    claims,
    platforms: [],
    deployments: [],
    files: claims.map((row) => row.result),
  };
  const reference = {
    runId: 34,
    runAttempt: 1,
    artifactId: 56,
    artifactName: "controlled-integrated",
    artifactDigest: `sha256:${"4".repeat(64)}`,
    candidateSha256: target.candidateSha256,
  };
  return { reference, gate, result, resultJson };
}
function data(p: ReturnType<typeof packet>) {
  return { reference: p.reference, gateJson: JSON.stringify(p.gate), resultJson: p.resultJson };
}
function rebind(p: ReturnType<typeof packet>) {
  p.resultJson = JSON.stringify(p.result, null, 2) + "\n";
  const row = p.gate.claims.find((row) => row.id === "infrastructure-boundaries");
  assert.ok(row);
  row.result.size = Buffer.byteLength(p.resultJson);
  row.result.sha256 = sha256(p.resultJson);
}
test("original LOCAL result bytes, producer/candidate identity and each detailed case remain mandatory data boundaries", () => {
  const original = packet();
  const observed = verifyLocalInfrastructureProof(data(original), target);
  assert.equal(observed.result.sha256, sha256(original.resultJson));
  assert.match(observed.interpretation, /LOCAL/);
  const reject = (change: (p: ReturnType<typeof packet>) => void, bind = true) => {
    const p = packet();
    change(p);
    if (bind) rebind(p);
    assert.throws(() => verifyLocalInfrastructureProof(data(p), target));
  };
  reject((p) => {
    p.resultJson += " ";
  }, false);
  reject((p) => {
    p.result.identity.sourceCommit = "9".repeat(40);
  });
  reject((p) => {
    p.gate.kind = "native";
  });
  reject((p) => {
    p.gate.producer.runId = 0;
  });
  reject((p) => {
    p.reference.runAttempt = 2;
  });
  reject((p) => {
    p.gate.claims.pop();
    p.gate.files.pop();
  });
  reject((p) => {
    Object.assign(p.result.observation, { localInfrastructureDetails: undefined });
  });
  reject((p) => {
    p.result.observation.localInfrastructureDetails.output.above.retainedBytes = 257;
  });
  reject((p) => {
    p.result.observation.localInfrastructureDetails.refusalRestoration.rowsAfterRefusal = 1;
  });
  reject((p) => {
    p.result.observation.localInfrastructureDetails.refusalRestoration.retryReservationId =
      "new-identity";
  });
  reject((p) => {
    p.result.observation.localInfrastructureDetails.retirement.disposableMeasuredBytesAfter = 131072;
  });
  reject((p) => {
    p.result.observation.localInfrastructureDetails.stagingAndHistory[0]!.above.status = 200;
  });
  reject((p) => {
    p.result.observation.localInfrastructureDetails.stagingAndHistory.pop();
  });
  reject((p) => {
    p.result.observation.localInfrastructureDetails.headroom.retainedCleanup.repairAfterCancel = 1;
  });
  reject((p) => {
    p.result.observation.localInfrastructureDetails.headroom.retainedCleanup.possibleExternalEffects = false;
  });
  reject((p) => {
    Object.assign(p.result.observation.localInfrastructureDetails, {
      defaultComputerDeclarations: undefined,
    });
  });
  reject((p) => {
    const rows = p.result.observation.localInfrastructureDetails.defaultComputerDeclarations.cases;
    const first = rows[0];
    assert.ok(first);
    rows[1] = first;
  });
  reject((p) => {
    const row =
      p.result.observation.localInfrastructureDetails.defaultComputerDeclarations.cases[0];
    assert.ok(row);
    row.canonicalFiles[0] = { path: "notes.txt", size: 7, sha256: "0".repeat(64) };
  });
  reject((p) => {
    const row =
      p.result.observation.localInfrastructureDetails.defaultComputerDeclarations.cases.find(
        (row) => row.ordinary,
      );
    assert.ok(row?.ordinary);
    row.ordinary.workspaceId = "foreign-workspace";
  });
  reject((p) => {
    const row =
      p.result.observation.localInfrastructureDetails.defaultComputerDeclarations.cases[0];
    assert.ok(row);
    row.leaseRelease.leaseId = "foreign-lease";
  });
  reject((p) => {
    const installation =
      p.result.observation.localInfrastructureDetails.defaultComputerDeclarations.installations[0];
    assert.ok(installation);
    const cleanup = installation.credentialCleanup[0];
    assert.ok(cleanup);
    cleanup.state = "pending";
  });
  reject((p) => {
    p.result.observation.localInfrastructureDetails.defaultComputerDeclarations.cadence.requestsPerPrincipalMinute = 30;
  });
  reject((p) => {
    const row =
      p.result.observation.localInfrastructureDetails.defaultComputerDeclarations.cases[0];
    assert.ok(row);
    Object.assign(row, { resource: "unknown" });
  });
  reject((p) => {
    const row =
      p.result.observation.localInfrastructureDetails.defaultComputerDeclarations.cases.find(
        (row) => row.resource === "snapshot" && row.relation === "at",
      );
    assert.ok(row?.pressure);
    row.pressure.source = "provider";
  });
  const flagged = { ...data(packet()), verified: true };
  assert.throws(() => verifyLocalInfrastructureProof(flagged, target));
});
