import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import {
  type AdmissionReceipt,
  type CredentialRef,
  canonicalJson,
  type InfrastructurePressure,
} from "../../packages/fortipi-contract/dist/index.js";
import { sha256 } from "../../scripts/verify-release-gates.ts";
import {
  allocationDeclaration,
  assertInfrastructurePressure,
  classifyInfrastructureRace,
  InfrastructureEvidenceUnavailable,
  type InfrastructureMeasurements,
  type InfrastructureReadRequest,
  type InfrastructureWindowMeasurements,
  verifyInfrastructureMeasurements,
} from "./live-infrastructure-controls.ts";
import { publicRequestPressure } from "./live-pressure.ts";
import { RoleContext } from "./roles.ts";

test("fixed provider datasets preserve unknown idle CPU/memory and sampled zeros without certifying exact absence or peaks", () => {
  const request: InfrastructureReadRequest = {
    accountBindingSha256: "e".repeat(64),
    sourceCommit: "a".repeat(40),
    candidateSha256: "b".repeat(64),
    providerDeploymentId: "provider-v0",
    workerVersionId: "worker-v0",
    workerName: "controlled",
    logicalApplicationId: "logical",
    agentId: "agent",
    workspaceId: "workspace",
    active: { from: 60000, through: 180000 },
    idle: { from: 240000, through: 300000 },
  };
  const statuses = (n: number) => [{ status: "success", requestsSum: n, errorsSum: 0 }];
  const window = (name: "active" | "idle"): InfrastructureWindowMeasurements => ({
    worker: {
      quality: "adaptive-estimate" as const,
      scope: { workerName: "controlled", workerVersionId: "worker-v0" },
      sampleInterval: 2,
      requestsSum: name === "active" ? 10 : 0,
      workerCpuSumMs: name === "active" ? 20 : null,
      statuses: statuses(name === "active" ? 10 : 0),
      effectiveWindow: request[name],
      records: 2,
    },
    durableObjects: (["control-plane", "agent", "workspace"] as const).map((resource) => ({
      scope: {
        kind: "namespace",
        resource,
        namespaceId: `namespace-${resource}`,
      },
      invocations: {
        quality: "adaptive-estimate" as const,
        sampleInterval: 3,
        requestsSum: name === "active" ? 12 : 0,
        statuses: statuses(name === "active" ? 12 : 0),
        effectiveWindow: request[name],
        records: 2,
      },
      periodic: {
        quality: "periodic-counter" as const,
        sqlRowsReadSum: name === "active" ? 40 : 0,
        sqlRowsWrittenSum: name === "active" ? 30 : 0,
        doCpuSumMs: name === "active" ? 7 : null,
        exceededCpuErrorsSum: 0,
        exceededMemoryErrorsSum: 0,
        fatalInternalErrorsSum: 0,
        effectiveWindow: request[name],
        records: 2,
      },
      isolateMemory:
        name === "active"
          ? {
              quality: "periodic-quantile" as const,
              doIsolateMemoryP99Bytes: 1048576,
              effectiveWindow: request[name],
              records: 2,
            }
          : {
              quality: "unavailable" as const,
              doIsolateMemoryP99Bytes: null,
              effectiveWindow: null,
              records: 0,
            },
    })),
  });
  const original: Exclude<InfrastructureMeasurements, { unavailable: string }> = {
    requestSha256: sha256(canonicalJson(request)),
    rawResponseSha256: "d".repeat(64),
    schemaSha256: "c".repeat(64),
    settingsSha256: "f".repeat(64),
    attributionSha256: "e".repeat(64),
    collectedAt: 600000,
    deliveryLagMs: null,
    active: window("active"),
    idle: window("idle"),
  };
  // These are observations, never a full infrastructure GateReceipt. Periodic
  // records can report zero writes without becoming an exact transaction ledger.
  assert.deepEqual(verifyInfrastructureMeasurements(request, original), original);
  // The documented binding/namespace join needs no private object-name hash
  // or fabricated physical/logical mapping. All three namespaces participate.
  assert.deepEqual(
    original.active.durableObjects.map((row) => row.scope.resource),
    ["control-plane", "agent", "workspace"],
  );
  assert.ok(
    original.active.durableObjects.every(
      (row) => !("objectId" in row.scope) && !("logicalId" in row.scope),
    ),
  );
  const selectedObject = structuredClone(original);
  for (const name of ["active", "idle"] as const) {
    selectedObject[name].durableObjects[1]!.scope = {
      kind: "object",
      resource: "agent",
      logicalId: request.agentId,
      namespaceId: "namespace-agent",
      objectId: "controlled-authenticated-object",
    };
  }
  // Controlled mapping DATA tests only; real mapping authentication remains a
  // trusted-parent obligation. Its object scope is not namespace coverage.
  assert.deepEqual(verifyInfrastructureMeasurements(request, selectedObject), selectedObject);
  const foreignObject = structuredClone(selectedObject);
  const foreignScope = foreignObject.active.durableObjects[1]!.scope;
  assert.equal(foreignScope.kind, "object");
  if (foreignScope.kind === "object") foreignScope.logicalId = "foreign-agent";
  assert.throws(() => verifyInfrastructureMeasurements(request, foreignObject));
  const withObservedIdleWrite = structuredClone(original);
  withObservedIdleWrite.idle.durableObjects[0]!.periodic.sqlRowsWrittenSum = 1;
  assert.equal(
    verifyInfrastructureMeasurements(request, withObservedIdleWrite).idle.durableObjects[0]
      ?.periodic.sqlRowsWrittenSum,
    1,
  );
  const reject = (change: (value: typeof original) => void) => {
    const value = structuredClone(original);
    change(value);
    assert.throws(() => verifyInfrastructureMeasurements(request, value));
  };
  reject((v) => {
    v.requestSha256 = sha256(canonicalJson({ ...request, providerDeploymentId: "foreign" }));
  });
  reject((v) => {
    v.active.worker.scope.workerVersionId = "foreign";
  });
  reject((v) => {
    v.idle.durableObjects[0]!.scope.namespaceId = "different-target";
  });
  reject((v) => {
    Object.assign(v.active.durableObjects[1]!.scope, { logicalId: "invented-logical-mapping" });
  });
  reject((v) => {
    v.active.durableObjects.splice(0, 1); // Missing ControlPlane cannot cover app usage.
  });
  reject((v) => {
    Object.assign(v.active.durableObjects[0]!.scope, {
      kind: "object",
      logicalId: "logical",
      objectId: "opaque-cp",
    });
  });
  reject((v) => {
    Object.assign(v.active.durableObjects[2]!.scope, { objectId: "invented-from-name" });
  });
  reject((v) => {
    v.active.durableObjects[2]!.scope.namespaceId = v.active.durableObjects[1]!.scope.namespaceId;
  });
  reject((v) => {
    v.active.durableObjects[0]!.scope.resource = "workspace"; // Duplicate drops CP.
  });
  reject((v) => {
    v.idle.durableObjects[0]!.periodic.records = 0;
  });
  reject((v) => {
    v.idle.worker.effectiveWindow = { from: 180000, through: 300000 };
  });
  reject((v) => {
    v.active.worker.workerCpuSumMs = null;
  });
  reject((v) => {
    v.active.durableObjects[0]!.periodic.doCpuSumMs = 0;
  });
  reject((v) => {
    v.active.durableObjects[0]!.isolateMemory.doIsolateMemoryP99Bytes = 0;
  });
  reject((v) => {
    v.active.durableObjects[0]!.periodic.exceededMemoryErrorsSum = 1;
  });
  reject((v) => {
    assert.ok(v.active.worker.statuses);
    v.active.worker.statuses[0]!.status = "exceededResources";
  });
  reject((v) => {
    assert.ok(v.active.worker.statuses);
    v.active.worker.statuses[0]!.status = "newUnclassifiedOutcome";
  });
  reject((v) => {
    assert.ok(v.active.worker.statuses);
    v.active.worker.statuses[0]!.requestsSum = 9;
  });
  reject((v) => {
    v.schemaSha256 = "unretained-schema";
  });
  reject((v) => {
    Object.assign(v, { deliveryLagMs: 0 });
  });
  reject((v) => {
    Object.assign(v.active.worker, { workerCpuPeakMs: 1 });
  });
  assert.throws(() =>
    verifyInfrastructureMeasurements(
      { ...request, idle: { from: 240001, through: 300001 } },
      original,
    ),
  );
  assert.throws(
    () => verifyInfrastructureMeasurements(request, { unavailable: "metrics-unavailable" }),
    InfrastructureEvidenceUnavailable,
  );
  const unknown: InfrastructurePressure = {
    resource: "storage",
    scope: { kind: "account" },
    source: "provider",
    measurement: "unknown",
    reason: "reported storage refusal",
    action: "reclaim-storage",
  };
  assertInfrastructurePressure(unknown);
  assert.throws(() => assertInfrastructurePressure({ ...unknown, remaining: 0 }));
  assert.throws(() => assertInfrastructurePressure({ ...unknown, resetAt: 86400000 }));
  assert.throws(() => assertInfrastructurePressure({ ...unknown, action: "retry-later" }));
});

test("declaration fixtures exceed only the intended allocation, not a different file or wire constraint", () => {
  const limits = { file: 4194304, snapshot: 16777216, entries: 512 };
  for (const resource of ["file", "snapshot", "entries"] as const) {
    for (const delta of [-1, 0, 1] as const) {
      const fixture = allocationDeclaration(resource, delta);
      const sizes = fixture.manifest.entries.map((entry) => {
        assert.equal(entry.type, "file");
        if (entry.type !== "file") throw Error("file fixture");
        return entry.size;
      });
      const observed = {
        file: Math.max(...sizes),
        snapshot: sizes.reduce((a, b) => a + b, 0),
        entries: sizes.length,
      };
      assert.equal(observed[resource], limits[resource] + delta);
      for (const other of ["file", "snapshot", "entries"] as const)
        if (other !== resource) assert.ok(observed[other] <= limits[other]);
      const expected = JSON.stringify({
        entries: fixture.manifest.entries.map((entry) => {
          assert.equal(entry.type, "file");
          if (entry.type !== "file") throw Error("file fixture");
          return {
            mode: entry.mode,
            path: entry.path,
            sha256: entry.sha256,
            size: entry.size,
            type: entry.type,
          };
        }),
        version: 1,
      });
      assert.equal(fixture.manifestHash, sha256(`fortipi:manifest:v1\n${expected}`));
      assert.ok(Buffer.byteLength(expected) < 512 * 1024);
    }
  }
});

test("last-slot oracle refuses double acceptance, transport/rate failures and unrelated storage quota", () => {
  const admission: AdmissionReceipt = {
    operationId: "op",
    messageId: "message",
    taskId: "task",
    revision: "r0",
    eventSeq: 1,
  };
  const pressure: InfrastructurePressure = {
    resource: "concurrency",
    scope: { kind: "install" },
    source: "policy",
    measurement: "observed",
    limit: 1,
    remaining: 0,
    reason: "slot occupied",
    action: "retry-later",
  };
  const accepted: PromiseFulfilledResult<AdmissionReceipt> = {
    status: "fulfilled",
    value: admission,
  };
  class ControlledRefusal {
    status: number;
    code: string;
    pressure: InfrastructurePressure;
    constructor(status: number, code: string, detail: InfrastructurePressure) {
      this.status = status;
      this.code = code;
      this.pressure = detail;
    }
  }
  const refused = (
    status: number,
    code: string,
    detail: InfrastructurePressure = pressure,
  ): PromiseRejectedResult => ({
    status: "rejected",
    reason: new ControlledRefusal(status, code, detail),
  });
  const describe = (value: unknown) => {
    assert.ok(value instanceof ControlledRefusal);
    return value;
  };
  const result = classifyInfrastructureRace([accepted, refused(429, "quota_exceeded")], describe);
  assert.equal(result.admission, admission);
  assert.equal(result.refused, 1);
  for (const outcomes of [
    [accepted, accepted],
    [refused(429, "quota_exceeded"), refused(429, "quota_exceeded")],
    [accepted, refused(503, "unavailable")],
    [accepted, refused(429, "rate_limited")],
  ])
    assert.throws(() => classifyInfrastructureRace(outcomes, describe));
  assert.throws(() =>
    classifyInfrastructureRace(
      [accepted, refused(429, "quota_exceeded", { ...pressure, resource: "storage" })],
      describe,
    ),
  );
});

test("pressure probe exposes only its public role ref before an installed-consumer failure so enclosing cleanup can revoke it", async () => {
  const admin = `synthetic-admin-${"a".repeat(48)}`,
    token = `synthetic-pressure-${"b".repeat(48)}`;
  const ref: CredentialRef = { credentialId: "pressure-ref", generation: 1, grantVersion: 1 };
  let revoked = false;
  const server = createServer((request, response) => {
    request.resume();
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/v1/admin/credentials")
      response.end(
        JSON.stringify({
          state: "issued",
          role: "client",
          credential: ref,
          token,
          expiresAt: Date.now() + 300000,
        }),
      );
    else if (request.url === "/v1/admin/credentials/pressure-ref/revoke") {
      revoked = true;
      response.end(
        JSON.stringify({
          operationId: "revoke",
          revocationId: "revocation",
          state: "complete",
          pendingRecipients: [],
        }),
      );
    } else {
      response.statusCode = 404;
      response.end("{}");
    }
  });
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const roles = new RoleContext(`http://127.0.0.1:${address.port}`, admin),
    refs: CredentialRef[] = [];
  try {
    await assert.rejects(
      () =>
        publicRequestPressure({
          installed: {
            get candidate(): never {
              throw Error("controlled consumer unavailable");
            },
            resolveExport(): never {
              throw Error("unreachable");
            },
          },
          roles,
          agentId: "agent",
          onRole: (credential) => refs.push(credential),
        }),
      /controlled consumer unavailable/,
    );
    assert.deepEqual(refs, [ref]);
    assert.ok(!JSON.stringify(refs).includes(token));
    assert.equal((await roles.revokeAndWait(ref.credentialId)).state, "complete");
    assert.equal(revoked, true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((accept) => server.close(() => accept()));
  }
});
