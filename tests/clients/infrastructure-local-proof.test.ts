import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson } from "../../packages/fortipi-contract/dist/index.js";
import { integratedClaims, sha256 } from "../../scripts/verify-release-gates.ts";
import {
  type InfrastructureLocalTarget,
  verifyLocalInfrastructureProof,
} from "./infrastructure-local-proof.ts";
import { infrastructureFixtureBounds } from "./live-infrastructure-controls.ts";

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
  const flagged = { ...data(packet()), verified: true };
  assert.throws(() => verifyLocalInfrastructureProof(flagged, target));
});
