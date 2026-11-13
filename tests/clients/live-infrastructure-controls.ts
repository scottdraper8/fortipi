import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { Ajv } from "ajv";
import type { FortiPiClient, FortiPiError } from "../../packages/fortipi-client/dist/node.js";
import {
  type AdmissionReceipt,
  type Approval,
  type Configuration,
  canonicalJson,
  type DurableEvent,
  type InfrastructurePolicy,
  type InfrastructurePressure,
  type Manifest,
  type UploadBegin,
  type WorkspaceBinding,
  type WorkspaceOperationLease,
} from "../../packages/fortipi-contract/dist/index.js";
import {
  assertDeployment,
  type DeploymentIdentity,
  sha256,
} from "../../scripts/verify-release-gates.ts";
import type { Installed } from "../distribution/install.ts";
import type { Identity, ScenarioEvidence } from "./evidence.ts";
import {
  type LocalInfrastructureProofData,
  verifyLocalInfrastructureProof,
} from "./infrastructure-local-proof.ts";
import { deviceCanonicalBytes, deviceReadRequests } from "./live-device.ts";
import { publicRequestPressure } from "./live-pressure.ts";
import type { RecoveryWorkspaceCanary } from "./platform-recovery.ts";
import type { RoleContext } from "./roles.ts";

/** Read-only trusted-parent port. No CF key, API client, arbitrary URL, job
 * authority, env flag or serialized "verified" bit crosses this boundary.
 * Parent authenticates attribution/raw data and normalizes documented units. */
export interface InfrastructureReadRequest {
  accountBindingSha256: string;
  sourceCommit: string;
  candidateSha256: string;
  providerDeploymentId: string;
  workerVersionId: string;
  workerName: string;
  logicalApplicationId: string;
  agentId: string;
  workspaceId: string;
  // Complete UTC minute windows, [from, through).
  active: { from: number; through: number };
  idle: { from: number; through: number };
}
/** Closed dataset DTOs. Field names fix the aggregation and units: CPU is a
 * separate dataset SUM in milliseconds; memory is the provider-calculated P99
 * of isolate samples for the selected namespace/object scope, in bytes. Neither
 * is a peak, and individual object percentiles are never added. */
export interface InfrastructureCoverage {
  effectiveWindow: { from: number; through: number } | null;
  records: number;
  /** Actual returned rows: grouped records, or one undimensioned aggregate
   * queried over this exact window. No absent row is converted into a zero. */
  coverageKind?: "grouped-records" | "query-window-aggregate";
}
export interface InfrastructureInvocationStatus {
  status: string;
  requestsSum: number;
  errorsSum: number;
}
export interface InfrastructureWorkerMeasurements extends InfrastructureCoverage {
  quality: "adaptive-estimate" | "unavailable";
  scope: { workerName: string; workerVersionId: string };
  sampleInterval: number | null;
  requestsSum: number | null;
  workerCpuSumMs: number | null;
  statuses: InfrastructureInvocationStatus[] | null;
  aggregateErrorsSum?: number | null;
}
/** A binding-to-namespace metadata join is sufficient for namespace scope.
 * Object scope additionally requires an actual authenticated name/id mapping;
 * listing opaque object IDs is not such a mapping. No idFromName reconstruction
 * or product diagnostic route is implied. ControlPlane always includes its
 * whole namespace, covering quota/credential/revocation work. */
export type InfrastructureDurableObjectScope =
  | {
      kind: "namespace";
      resource: "control-plane" | "agent" | "workspace";
      namespaceId: string;
    }
  | {
      kind: "object";
      resource: "agent" | "workspace";
      namespaceId: string;
      objectId: string;
      logicalId: string;
    };
export interface InfrastructureDurableObjectMeasurements {
  scope: InfrastructureDurableObjectScope;
  invocations: InfrastructureCoverage & {
    quality: "adaptive-estimate" | "unavailable";
    sampleInterval: number | null;
    requestsSum: number | null;
    statuses: InfrastructureInvocationStatus[] | null;
    aggregateErrorsSum?: number | null;
  };
  periodic: InfrastructureCoverage & {
    quality: "periodic-counter" | "unavailable";
    sqlRowsReadSum: number | null;
    sqlRowsWrittenSum: number | null;
    doCpuSumMs: number | null;
    exceededCpuErrorsSum: number | null;
    exceededMemoryErrorsSum: number | null;
    fatalInternalErrorsSum: number | null;
  };
  isolateMemory: InfrastructureCoverage & {
    quality: "periodic-quantile" | "unavailable";
    doIsolateMemoryP99Bytes: number | null;
  };
}
export interface InfrastructureWindowMeasurements {
  worker: InfrastructureWorkerMeasurements;
  durableObjects: InfrastructureDurableObjectMeasurements[];
}
export type InfrastructureMeasurements =
  | {
      requestSha256: string;
      rawResponseSha256: string;
      schemaSha256: string;
      settingsSha256: string;
      attributionSha256: string;
      collectedAt: number;
      // Age of the requested window at collection is computable; analytics
      // delivery/completeness lag is NOT. Keep it explicitly unknown.
      deliveryLagMs: null;
      localInfrastructure?: LocalInfrastructureProofData | null;
      active: InfrastructureWindowMeasurements;
      idle: InfrastructureWindowMeasurements;
    }
  | { unavailable: "metrics-unavailable" | "ambiguous-resource-scope" | "incomplete-window" };
export interface InfrastructureObserver {
  read(input: InfrastructureReadRequest): Promise<unknown>;
}
export class InfrastructureEvidenceUnavailable extends Error {}
const keys = (value: object, expected: readonly string[]) =>
  assert.deepEqual(Reflect.ownKeys(value).sort(), [...expected].sort());
const count = (value: number) => assert.ok(Number.isSafeInteger(value) && value >= 0);
const numberOrNull = (value: number | null) =>
  assert.ok(value === null || (Number.isFinite(value) && value >= 0));

const nullableNumber = { anyOf: [{ type: "number" }, { type: "null" }] };
const coverageProperties = {
  effectiveWindow: {
    anyOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["from", "through"],
        properties: { from: { type: "number" }, through: { type: "number" } },
      },
      { type: "null" },
    ],
  },
  records: { type: "number" },
  coverageKind: { enum: ["grouped-records", "query-window-aggregate"] },
};
const statusProperties = {
  sampleInterval: nullableNumber,
  requestsSum: nullableNumber,
  aggregateErrorsSum: nullableNumber,
  statuses: {
    anyOf: [
      {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["status", "requestsSum", "errorsSum"],
          properties: {
            status: { type: "string" },
            requestsSum: { type: "number" },
            errorsSum: { type: "number" },
          },
        },
      },
      { type: "null" },
    ],
  },
};
function dataShape(
  properties: Record<string, unknown>,
  optional: string[] = ["coverageKind", "aggregateErrorsSum"],
) {
  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties).filter((key) => !optional.includes(key)),
    properties,
  };
}
const windowShape = dataShape({
  worker: dataShape({
    ...coverageProperties,
    ...statusProperties,
    quality: { enum: ["adaptive-estimate", "unavailable"] },
    scope: dataShape({ workerName: { type: "string" }, workerVersionId: { type: "string" } }),
    workerCpuSumMs: nullableNumber,
  }),
  durableObjects: {
    type: "array",
    items: dataShape({
      scope: {
        oneOf: [
          dataShape({
            kind: { const: "namespace" },
            resource: { enum: ["control-plane", "agent", "workspace"] },
            namespaceId: { type: "string" },
          }),
          dataShape({
            kind: { const: "object" },
            resource: { enum: ["agent", "workspace"] },
            namespaceId: { type: "string" },
            objectId: { type: "string" },
            logicalId: { type: "string" },
          }),
        ],
      },
      invocations: dataShape({
        ...coverageProperties,
        ...statusProperties,
        quality: { enum: ["adaptive-estimate", "unavailable"] },
      }),
      periodic: dataShape({
        ...coverageProperties,
        quality: { enum: ["periodic-counter", "unavailable"] },
        sqlRowsReadSum: nullableNumber,
        sqlRowsWrittenSum: nullableNumber,
        doCpuSumMs: nullableNumber,
        exceededCpuErrorsSum: nullableNumber,
        exceededMemoryErrorsSum: nullableNumber,
        fatalInternalErrorsSum: nullableNumber,
      }),
      isolateMemory: dataShape({
        ...coverageProperties,
        quality: { enum: ["periodic-quantile", "unavailable"] },
        doIsolateMemoryP99Bytes: nullableNumber,
      }),
    }),
  },
});
const measurementShape = dataShape(
  {
    requestSha256: { type: "string" },
    rawResponseSha256: { type: "string" },
    schemaSha256: { type: "string" },
    settingsSha256: { type: "string" },
    attributionSha256: { type: "string" },
    collectedAt: { type: "number" },
    deliveryLagMs: { type: "null" },
    localInfrastructure: {
      anyOf: [
        dataShape({
          reference: dataShape({
            runId: { type: "integer" },
            runAttempt: { type: "integer" },
            artifactId: { type: "integer" },
            artifactName: { type: "string" },
            artifactDigest: { type: "string" },
            candidateSha256: { type: "string" },
          }),
          gateJson: { type: "string" },
          resultJson: { type: "string" },
        }),
        { type: "null" },
      ],
    },
    active: windowShape,
    idle: windowShape,
  },
  ["localInfrastructure"],
);
const measurementData = new Ajv({ strict: true }).compile<InfrastructureMeasurements>({
  oneOf: [
    measurementShape,
    dataShape({
      unavailable: {
        enum: ["metrics-unavailable", "ambiguous-resource-scope", "incomplete-window"],
      },
    }),
  ],
});

export function verifyInfrastructureMeasurements(
  request: InfrastructureReadRequest,
  value: unknown,
) {
  assert.ok(measurementData(value), "Invalid closed infrastructure measurement data");
  if ("unavailable" in value) {
    keys(value, ["unavailable"]);
    assert.ok(
      ["metrics-unavailable", "ambiguous-resource-scope", "incomplete-window"].includes(
        value.unavailable,
      ),
    );
    throw new InfrastructureEvidenceUnavailable(
      "Required attributable provider observations unavailable",
    );
  }
  keys(value, [
    "requestSha256",
    "rawResponseSha256",
    "schemaSha256",
    "settingsSha256",
    "attributionSha256",
    "collectedAt",
    "deliveryLagMs",
    "active",
    "idle",
    ...(Object.hasOwn(value, "localInfrastructure") ? ["localInfrastructure"] : []),
  ]);
  assert.equal(
    value.requestSha256,
    sha256(canonicalJson(request)),
    "Provider observations must bind exact source/target/resources/windows",
  );
  for (const hash of [
    value.rawResponseSha256,
    value.schemaSha256,
    value.settingsSha256,
    value.attributionSha256,
  ])
    assert.match(hash, /^[a-f0-9]{64}$/);
  count(value.collectedAt);
  assert.ok(value.collectedAt >= request.idle.through);
  assert.equal(value.deliveryLagMs, null, "A stable delayed query is not a completeness SLA");
  for (const window of [request.active, request.idle]) {
    keys(window, ["from", "through"]);
    count(window.from);
    count(window.through);
    assert.ok(
      window.from % 60000 === 0 &&
        window.through % 60000 === 0 &&
        window.through - window.from >= 60000,
      "Use disjoint complete UTC minutes, with exclusive through",
    );
  }
  assert.ok(request.active.through <= request.idle.from);
  for (const name of ["active", "idle"] as const) {
    const observed: InfrastructureWindowMeasurements = value[name];
    keys(observed, ["worker", "durableObjects"]);
    const window = request[name];
    function coverage(metric: InfrastructureCoverage, unavailable: boolean, fullWindow = false) {
      count(metric.records);
      assert.ok(
        metric.coverageKind === undefined ||
          ["grouped-records", "query-window-aggregate"].includes(metric.coverageKind),
      );
      if (metric.coverageKind === "query-window-aggregate")
        assert.equal(metric.records, 1, "One actual undimensioned aggregate row is required");
      if (unavailable) {
        assert.equal(metric.effectiveWindow, null);
        assert.equal(metric.records, 0);
        return;
      }
      if (!metric.records || !metric.effectiveWindow)
        throw new InfrastructureEvidenceUnavailable(
          "Empty provider records cannot become observed zero",
        );
      keys(metric.effectiveWindow, ["from", "through"]);
      if (
        fullWindow &&
        (metric.effectiveWindow.from !== window.from ||
          metric.effectiveWindow.through !== window.through)
      )
        throw new InfrastructureEvidenceUnavailable(
          "Required request/write observations must cover the requested immutable window",
        );
      count(metric.effectiveWindow.from);
      count(metric.effectiveWindow.through);
      if (
        metric.effectiveWindow.from < window.from ||
        metric.effectiveWindow.through > window.through ||
        metric.effectiveWindow.from >= metric.effectiveWindow.through
      )
        throw new InfrastructureEvidenceUnavailable(
          "Effective buckets must stay inside the requested unmixed window",
        );
    }
    function invocations(
      metric:
        | InfrastructureWorkerMeasurements
        | InfrastructureDurableObjectMeasurements["invocations"],
    ) {
      assert.ok(["adaptive-estimate", "unavailable"].includes(metric.quality));
      coverage(metric, metric.quality === "unavailable", true);
      numberOrNull(metric.requestsSum);
      numberOrNull(metric.sampleInterval);
      if (metric.quality === "unavailable") {
        assert.equal(metric.requestsSum, null);
        assert.equal(metric.sampleInterval, null);
        assert.equal(metric.statuses, null);
        throw new InfrastructureEvidenceUnavailable(
          "Idle/active request observations are separately required",
        );
      }
      assert.ok(metric.requestsSum !== null);
      assert.ok(Array.isArray(metric.statuses) && metric.statuses.length <= 32);
      if (metric.statuses.length === 0) {
        if (
          metric.coverageKind !== "query-window-aggregate" ||
          metric.requestsSum !== 0 ||
          metric.aggregateErrorsSum !== 0
        )
          throw new InfrastructureEvidenceUnavailable(
            "Only an actually returned zero request/error aggregate can accompany an empty breakdown",
          );
        assert.ok(metric.sampleInterval === null || metric.sampleInterval >= 1);
        return;
      }
      assert.ok(metric.sampleInterval !== null && metric.sampleInterval >= 1);
      if (Object.hasOwn(metric, "aggregateErrorsSum")) assert.equal(metric.aggregateErrorsSum, 0);
      const names = new Set<string>();
      for (const status of metric.statuses) {
        keys(status, ["status", "requestsSum", "errorsSum"]);
        assert.match(status.status, /^[A-Za-z][A-Za-z0-9_-]{0,79}$/);
        assert.ok(!names.has(status.status));
        names.add(status.status);
        numberOrNull(status.requestsSum);
        numberOrNull(status.errorsSum);
        assert.ok(typeof status.requestsSum === "number" && typeof status.errorsSum === "number");
        assert.ok(status.errorsSum <= status.requestsSum);
        // Preserve unknown outcomes; they cannot be classified as success.
        if (
          !["success", "ok", "clientDisconnected", "canceled"].includes(status.status) &&
          status.requestsSum > 0
        )
          throw new InfrastructureEvidenceUnavailable(
            "Provider reported a non-success or unclassified invocation outcome",
          );
        assert.equal(status.errorsSum, 0, "Observed invocation errors block qualification");
      }
      assert.ok(
        Math.abs(
          metric.statuses.reduce((sum, status) => sum + status.requestsSum, 0) - metric.requestsSum,
        ) <=
          1e-6 * Math.max(1, metric.requestsSum),
        "Status breakdown must cover reported requests",
      );
    }
    const worker: InfrastructureWorkerMeasurements = observed.worker;
    keys(worker, [
      "quality",
      "scope",
      "sampleInterval",
      "requestsSum",
      "workerCpuSumMs",
      "statuses",
      "effectiveWindow",
      "records",
      ...(Object.hasOwn(worker, "coverageKind") ? ["coverageKind"] : []),
      ...(Object.hasOwn(worker, "aggregateErrorsSum") ? ["aggregateErrorsSum"] : []),
    ]);
    keys(worker.scope, ["workerName", "workerVersionId"]);
    assert.deepEqual(worker.scope, {
      workerName: request.workerName,
      workerVersionId: request.workerVersionId,
    });
    invocations(worker);
    numberOrNull(worker.workerCpuSumMs);
    if (name === "active")
      assert.ok(
        worker.requestsSum !== null && worker.requestsSum > 0,
        "The known active request workload needs a positive observation",
      );
    assert.ok(Array.isArray(observed.durableObjects) && observed.durableObjects.length === 3);
    const resources = new Set<string>();
    const namespaces = new Set<string>();
    for (const object of observed.durableObjects) {
      keys(object, ["scope", "invocations", "periodic", "isolateMemory"]);
      const scope = object.scope;
      assert.ok(["control-plane", "agent", "workspace"].includes(scope.resource));
      assert.ok(
        !resources.has(scope.resource),
        "Every application binding must be represented once",
      );
      resources.add(scope.resource);
      assert.match(scope.namespaceId, /^[A-Za-z0-9_-]{1,128}$/);
      assert.ok(
        !namespaces.has(scope.namespaceId),
        "Different application bindings must not reuse one namespace's counters",
      );
      namespaces.add(scope.namespaceId);
      if (scope.kind === "namespace") {
        keys(scope, ["kind", "resource", "namespaceId"]);
      } else {
        assert.equal(scope.kind, "object");
        keys(scope, ["kind", "resource", "namespaceId", "logicalId", "objectId"]);
        assert.ok(
          scope.resource === "agent" || scope.resource === "workspace",
          "ControlPlane requires its namespace, not a selected object's counters",
        );
        assert.equal(
          scope.logicalId,
          scope.resource === "agent" ? request.agentId : request.workspaceId,
        );
        assert.match(scope.objectId, /^[A-Za-z0-9_-]{1,128}$/);
      }
      if (name === "idle")
        assert.deepEqual(
          scope,
          value.active.durableObjects.find((other) => other.scope.resource === scope.resource)
            ?.scope,
          "Idle and active namespace/object attribution must agree",
        );
      keys(object.invocations, [
        "quality",
        "sampleInterval",
        "requestsSum",
        "statuses",
        "effectiveWindow",
        "records",
        ...(Object.hasOwn(object.invocations, "coverageKind") ? ["coverageKind"] : []),
        ...(Object.hasOwn(object.invocations, "aggregateErrorsSum") ? ["aggregateErrorsSum"] : []),
      ]);
      invocations(object.invocations);
      const periodic = object.periodic;
      keys(periodic, [
        "quality",
        "sqlRowsReadSum",
        "sqlRowsWrittenSum",
        "doCpuSumMs",
        "exceededCpuErrorsSum",
        "exceededMemoryErrorsSum",
        "fatalInternalErrorsSum",
        "effectiveWindow",
        "records",
        ...(Object.hasOwn(periodic, "coverageKind") ? ["coverageKind"] : []),
      ]);
      assert.ok(["periodic-counter", "unavailable"].includes(periodic.quality));
      coverage(periodic, periodic.quality === "unavailable", true);
      for (const key of [
        "sqlRowsReadSum",
        "sqlRowsWrittenSum",
        "doCpuSumMs",
        "exceededCpuErrorsSum",
        "exceededMemoryErrorsSum",
        "fatalInternalErrorsSum",
      ] as const)
        numberOrNull(periodic[key]);
      if (periodic.quality === "unavailable") {
        for (const key of [
          "sqlRowsReadSum",
          "sqlRowsWrittenSum",
          "doCpuSumMs",
          "exceededCpuErrorsSum",
          "exceededMemoryErrorsSum",
          "fatalInternalErrorsSum",
        ] as const)
          assert.equal(periodic[key], null);
        throw new InfrastructureEvidenceUnavailable(
          "Absent periodic records are not idle SQL-write observations",
        );
      }
      assert.ok(periodic.sqlRowsReadSum !== null && periodic.sqlRowsWrittenSum !== null);
      for (const key of [
        "exceededCpuErrorsSum",
        "exceededMemoryErrorsSum",
        "fatalInternalErrorsSum",
      ] as const) {
        assert.notEqual(periodic[key], null);
        assert.equal(periodic[key], 0, "Observed DO resource/internal errors block qualification");
      }
      if (
        periodic.coverageKind === "query-window-aggregate" &&
        (periodic.sqlRowsReadSum !== 0 ||
          periodic.sqlRowsWrittenSum !== 0 ||
          (periodic.doCpuSumMs !== null && periodic.doCpuSumMs !== 0))
      )
        throw new InfrastructureEvidenceUnavailable(
          "Nonzero periodic aggregate needs its grouped series; empty series cannot qualify it",
        );
      const memory = object.isolateMemory;
      keys(memory, [
        "quality",
        "doIsolateMemoryP99Bytes",
        "effectiveWindow",
        "records",
        ...(Object.hasOwn(memory, "coverageKind") ? ["coverageKind"] : []),
      ]);
      assert.notEqual(
        memory.coverageKind,
        "query-window-aggregate",
        "An empty-population aggregate cannot supply a memory percentile sample",
      );
      assert.ok(["periodic-quantile", "unavailable"].includes(memory.quality));
      coverage(memory, memory.quality === "unavailable");
      numberOrNull(memory.doIsolateMemoryP99Bytes);
      if (memory.quality === "unavailable") assert.equal(memory.doIsolateMemoryP99Bytes, null);
      else assert.notEqual(memory.doIsolateMemoryP99Bytes, null);
    }
  }
  assert.ok(
    value.active.durableObjects.some(
      (row) => row.periodic.sqlRowsWrittenSum !== null && row.periodic.sqlRowsWrittenSum > 0,
    ),
    "The known active write workload needs an attributable positive observation",
  );
  return structuredClone(value);
}

/** Independent frozen application defaults, not an implementation comparator or
 * a promise of account-wide Cloudflare remaining capacity. */
export const infrastructureFixtureBounds = {
  objectBytes: 134217728,
  installBytes: 536870912,
  headroomFraction: 0.25,
  fileBytes: 4194304,
  snapshotBytes: 16777216,
  stagingBytesPerWorkspace: 16777216,
  manifestEntries: 512,
  retainedVersions: 8,
  workspaceBytes: 67108864,
  inlineTailBytes: 32768,
  artifactBytes: 1048576,
  outputBytesPerJob: 8388608,
  conversationEvents: 2000,
  conversationBytes: 8388608,
  activeMutatingJobs: 1,
  queuedAdmissions: 4,
  requestsPerPrincipalMinute: 30,
  requestsPerInstallMinute: 120,
  sqlPageRows: 100,
  transferConcurrency: 4,
} as const;
export function assertInfrastructurePressure(pressure: InfrastructurePressure) {
  assert.ok(pressure.reason.length > 0);
  if (pressure.measurement === "unknown") {
    assert.equal(pressure.remaining, undefined, "Unknown capacity is not a balance");
  }
  if (pressure.resource === "storage") {
    assert.notEqual(
      pressure.action,
      "retry-later",
      "Storage restoration requires reclamation/configuration, not a daily reset",
    );
    assert.equal(pressure.resetAt, undefined);
  }
  // Scope alone does not classify a provider failure as daily versus transient.
  // Preserve a reported reset; never invent a UTC reset for unknown exhaustion.
  if (pressure.resetAt !== undefined)
    assert.ok(Number.isSafeInteger(pressure.resetAt) && pressure.resetAt > 0);
}
export function allocationDeclaration(
  resource: "file" | "snapshot" | "entries",
  delta: -1 | 0 | 1,
) {
  const bounds = infrastructureFixtureBounds;
  const limit =
    resource === "file"
      ? bounds.fileBytes
      : resource === "snapshot"
        ? bounds.snapshotBytes
        : bounds.manifestEntries;
  const declared = limit + delta;
  const sizes =
    resource === "file"
      ? [declared]
      : resource === "snapshot"
        ? [bounds.fileBytes, bounds.fileBytes, bounds.fileBytes, declared - 3 * bounds.fileBytes]
        : Array<number>(declared).fill(1);
  const hashes = new Map<number, string>();
  const manifest: Manifest = {
    version: 1,
    entries: sizes.map((size, i) => {
      if (!hashes.has(size)) hashes.set(size, sha256(Buffer.alloc(size, 101)));
      return {
        path: `edge-${String(i).padStart(4, "0")}.bin`,
        type: "file",
        mode: 420,
        size,
        sha256: hashes.get(size)!,
      };
    }),
  };
  // Above-snapshot must not also exceed the individual file limit.
  if (resource === "snapshot" && delta === 1) {
    const last = manifest.entries.at(-1);
    assert.ok(last?.type === "file");
    last.size = bounds.fileBytes;
    last.sha256 = sha256(Buffer.alloc(last.size, 101));
    manifest.entries.push({
      path: "edge-0004.bin",
      type: "file",
      mode: 420,
      size: 1,
      sha256: sha256(Buffer.from([101])),
    });
  }
  return {
    limit,
    declared,
    manifest,
    manifestHash: sha256(`fortipi:manifest:v1\n${canonicalJson(manifest)}`),
  };
}
async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean) {
  const end = Date.now() + 120000;
  while (Date.now() < end) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(250);
  }
  throw new Error("Public infrastructure observation deadline exceeded");
}
export function classifyInfrastructureRace(
  outcomes: readonly PromiseSettledResult<AdmissionReceipt>[],
  describe: (error: unknown) => {
    status: number | undefined;
    code: string;
    pressure: InfrastructurePressure | undefined;
  },
) {
  assert.equal(outcomes.length, 2);
  assert.equal(
    outcomes.filter((result) => result.status === "fulfilled").length,
    1,
    "The actual default final admission slot must admit only one contender",
  );
  const accepted = outcomes.findIndex((result) => result.status === "fulfilled"),
    refused = 1 - accepted;
  const winner = outcomes[accepted],
    loser = outcomes[refused];
  assert.ok(winner?.status === "fulfilled" && loser?.status === "rejected");
  const rejected = describe(loser.reason);
  assert.equal(rejected.status, 429);
  assert.equal(rejected.code, "quota_exceeded");
  const pressure = rejected.pressure;
  assert.ok(pressure);
  assertInfrastructurePressure(pressure);
  assert.equal(pressure.resource, "concurrency");
  assert.equal(pressure.scope.kind, "install");
  assert.equal(pressure.source, "policy");
  assert.equal(pressure.measurement, "observed");
  assert.equal(pressure.limit, 1);
  assert.equal(pressure.remaining, 0);
  return {
    accepted,
    refused,
    admission: winner.value,
    refusal: { status: rejected.status, pressure },
  };
}

type InfrastructureRequest = <T>(
  operation: () => Promise<T>,
  lease?: WorkspaceOperationLease,
) => Promise<T>;
interface ComputerProbe {
  client: FortiPiClient;
  errorType: typeof FortiPiError;
  request: InfrastructureRequest;
}
const infrastructureCanaryBytes = Buffer.from("old-v1\n");
function uploadDeclaration(
  binding: WorkspaceBinding,
  lease: WorkspaceOperationLease,
  manifest: Manifest,
  remove: string[] = [],
): UploadBegin {
  return {
    requestId: randomUUID(),
    operationId: lease.operationId,
    commitId: randomUUID(),
    lease,
    baseRevision: binding.revision,
    manifest,
    manifestHash: sha256(`fortipi:manifest:v1\n${canonicalJson(manifest)}`),
    mutations: [
      ...remove.map((path) => ({ kind: "delete" as const, path })),
      ...manifest.entries.map((entry) => {
        assert.ok(entry.type === "file");
        return {
          kind: "put" as const,
          path: entry.path,
          mode: entry.mode,
          size: entry.size,
          sha256: entry.sha256,
        };
      }),
    ],
  };
}
async function releaseProbeLease(input: ComputerProbe, lease: WorkspaceOperationLease) {
  const body = { requestId: randomUUID(), lease, reason: "cancelled" as const };
  const receipt = await input.request(() =>
    input.client.operations.releaseWorkspaceLease({
      path: { workspaceId: lease.workspaceId, leaseId: lease.leaseId },
      query: {},
      body,
    }),
  );
  assert.equal(receipt.leaseId, lease.leaseId);
  assert.equal(receipt.released, true);
  return receipt;
}
export async function abortInfrastructureStage(
  input: ComputerProbe,
  lease: WorkspaceOperationLease,
  uploadId: string,
) {
  let conflictStatus: 409 | null = null;
  try {
    await input.request(() => input.client.uploads.abort(lease.workspaceId, uploadId), lease);
  } catch (error) {
    assert.ok(error instanceof input.errorType);
    assert.equal(error.status, 409);
    assert.equal(error.code, "interrupted");
    conflictStatus = 409;
  }
  const after = await input.request(
    () => input.client.uploads.get(lease.workspaceId, uploadId),
    lease,
  );
  assert.equal(after.uploadId, uploadId);
  assert.equal(after.state, "aborted", "Unknown or nonterminal upload cleanup is not accepted");
  return {
    uploadId,
    state: after.state,
    conflictStatus,
    acknowledgment: conflictStatus === null ? "direct" : "recovered-by-current-scoped-status",
  };
}
export function assertKnownSnapshotRefusal(delta: -1 | 0 | 1, error: FortiPiError) {
  assert.equal(error.status, 429);
  assert.equal(error.code, "quota_exceeded");
  assert.equal(error.retryable, false);
  const pressure = error.details?.pressure;
  assert.ok(pressure);
  assertInfrastructurePressure(pressure);
  assert.equal(pressure.resource, "storage");
  assert.equal(pressure.scope.kind, "object");
  assert.equal(pressure.source, "policy");
  assert.equal(pressure.measurement, "estimated");
  assert.equal(pressure.action, "reclaim-storage");
  assert.equal(pressure.resetAt, undefined);
  assert.equal(
    pressure.reason,
    delta > 0
      ? "Snapshot exceeds effective workspace bounds"
      : "Workspace physical copies and unspent growth exhaust the shared pool",
  );
  return structuredClone(pressure);
}
/** Actual tiny publication provides an independently hashed same-workspace
 * canary; declaration stages must never change its revision, manifest or bytes. */
export async function seedInfrastructureWorkspace(
  input: ComputerProbe,
  binding: WorkspaceBinding,
): Promise<RecoveryWorkspaceCanary> {
  const lease = await input.request(() =>
    input.client.operations.acquireWorkspaceLease({
      path: { workspaceId: binding.workspaceId },
      query: {},
      body: {
        requestId: randomUUID(),
        operationId: randomUUID(),
        bindingVersion: binding.bindingVersion,
        baseRevision: binding.revision,
        deadline: Date.now() + 120000,
      },
    }),
  );
  let uploadId: string | undefined,
    committed = false;
  try {
    const entry = {
      path: "notes.txt",
      type: "file" as const,
      mode: 420 as const,
      size: infrastructureCanaryBytes.length,
      sha256: sha256(infrastructureCanaryBytes),
    };
    const body = uploadDeclaration(binding, lease, { version: 1, entries: [entry] });
    const opened = await input.request(
      () => input.client.uploads.begin(binding.workspaceId, body),
      lease,
    );
    uploadId = opened.uploadId;
    await input.request(
      () =>
        input.client.uploads.chunk({
          path: {
            workspaceId: binding.workspaceId,
            uploadId: opened.uploadId,
            sha256: entry.sha256,
            chunkIndex: 0,
          },
          query: { length: entry.size, sha256: entry.sha256 },
          body: infrastructureCanaryBytes,
        }),
      lease,
    );
    const validated = await input.request(
      () => input.client.uploads.validate(binding.workspaceId, opened.uploadId),
      lease,
    );
    const receipt = await input.request(
      () =>
        input.client.uploads.commit(binding.workspaceId, opened.uploadId, {
          requestId: randomUUID(),
          operationId: lease.operationId,
          workspaceId: binding.workspaceId,
          uploadId: opened.uploadId,
          commitId: body.commitId,
          stageId: validated.stageId,
          lease,
          baseRevision: binding.revision,
          manifestHash: body.manifestHash,
        }),
      lease,
    );
    committed = true;
    assert.equal(receipt.providerKind, "computer");
    assert.equal(receipt.manifestHash, body.manifestHash);
    const current = await input.request(
      () => input.client.workspaces.get(binding.workspaceId),
      lease,
    );
    assert.equal(current.revision, receipt.revision);
    assert.equal(current.manifestHash, receipt.manifestHash);
    return {
      binding: current,
      files: [{ path: entry.path, size: entry.size, sha256: entry.sha256 }],
    };
  } finally {
    try {
      if (uploadId && !committed) await abortInfrastructureStage(input, lease, uploadId);
    } finally {
      await releaseProbeLease(input, lease);
    }
  }
}
/** Same public SDK path used live and by the real local regression. Bounds
 * intersect: snapshot descriptors below/at16MiB still exceed the reserved pool. */
export async function observeComputerDeclaration(
  input: ComputerProbe & {
    canary: RecoveryWorkspaceCanary;
    resource: "file" | "snapshot" | "entries";
    delta: -1 | 0 | 1;
  },
) {
  const { client, canary, resource, delta, request } = input,
    binding = canary.binding;
  const fixture = allocationDeclaration(resource, delta);
  const lease = await request(() =>
    client.operations.acquireWorkspaceLease({
      path: { workspaceId: binding.workspaceId },
      query: {},
      body: {
        requestId: randomUUID(),
        operationId: randomUUID(),
        bindingVersion: binding.bindingVersion,
        baseRevision: binding.revision,
        deadline: Date.now() + 120000,
      },
    }),
  );
  let open: Awaited<ReturnType<typeof client.uploads.begin>> | undefined,
    observation: Record<string, unknown> | undefined,
    release: Awaited<ReturnType<typeof releaseProbeLease>> | undefined;
  async function canonical() {
    assert.deepEqual(
      await request(() => client.workspaces.get(binding.workspaceId), lease),
      binding,
    );
    const described = await request(
      () => client.workspaces.manifest(binding.workspaceId, { revision: binding.revision }),
      lease,
    );
    assert.equal(
      sha256(`fortipi:manifest:v1\n${canonicalJson(described.manifest)}`),
      binding.manifestHash,
    );
    for (const file of canary.files) {
      const bytes = await request(
        () =>
          client.workspaces.read(binding.workspaceId, {
            revision: binding.revision,
            path: file.path,
          }),
        lease,
      );
      assert.equal(bytes.length, file.size);
      assert.equal(sha256(bytes), file.sha256);
    }
  }
  try {
    const body = uploadDeclaration(
      binding,
      lease,
      fixture.manifest,
      canary.files.map((file) => file.path),
    );
    let rejected: unknown;
    try {
      open = await request(() => client.uploads.begin(binding.workspaceId, body), lease);
    } catch (error) {
      rejected = error;
    }
    let pressure: InfrastructurePressure | undefined,
      ordinary: Record<string, unknown> | undefined,
      abort: Awaited<ReturnType<typeof abortInfrastructureStage>> | undefined;
    if (delta <= 0 && resource !== "snapshot") {
      if (rejected) throw rejected;
      assert.ok(open);
      assert.equal(open.state, "open");
      assert.equal(open.manifestHash, fixture.manifestHash);
      const uploadId = open.uploadId;
      const status = await request(() => client.uploads.get(binding.workspaceId, uploadId), lease);
      assert.equal(status.uploadId, open.uploadId);
      assert.equal(status.state, "open");
      assert.deepEqual(status.receivedChunks, []);
      abort = await abortInfrastructureStage(input, lease, open.uploadId);
      open = undefined;
    } else {
      assert.ok(!open, "A declaration required to refuse was admitted");
      assert.ok(rejected instanceof input.errorType);
      assert.equal(rejected.status, 429);
      assert.equal(rejected.code, "quota_exceeded");
      assert.ok(rejected.details?.pressure);
      assertInfrastructurePressure(rejected.details.pressure);
      pressure =
        resource === "snapshot"
          ? assertKnownSnapshotRefusal(delta, rejected)
          : structuredClone(rejected.details.pressure);
      await canonical();
      if (resource === "snapshot") {
        const size = 2 * 1024 * 1024;
        const manifest: Manifest = {
          version: 1,
          entries: [
            {
              path: "ordinary.bin",
              type: "file",
              mode: 420,
              size,
              sha256: sha256(Buffer.alloc(size, 101)),
            },
          ],
        };
        const feasible = uploadDeclaration(
          binding,
          lease,
          manifest,
          canary.files.map((file) => file.path),
        );
        open = await request(() => client.uploads.begin(binding.workspaceId, feasible), lease);
        assert.equal(open.state, "open");
        assert.equal(open.manifestHash, feasible.manifestHash);
        const uploadId = open.uploadId;
        const status = await request(
          () => client.uploads.get(binding.workspaceId, uploadId),
          lease,
        );
        assert.equal(status.uploadId, open.uploadId);
        assert.equal(status.state, "open");
        assert.deepEqual(status.receivedChunks, []);
        abort = await abortInfrastructureStage(input, lease, open.uploadId);
        ordinary = {
          declaredBytes: size,
          state: status.state,
          manifestHash: status.manifestHash,
          chunksDelivered: 0,
          abort,
        };
        open = undefined;
      }
    }
    await canonical();
    observation = {
      resource,
      relation: delta < 0 ? "below" : delta === 0 ? "at" : "above",
      limit: fixture.limit,
      declared: fixture.declared,
      outcome:
        resource === "snapshot" && delta <= 0
          ? "combined-budget-refusal"
          : delta > 0
            ? "descriptor-refusal"
            : "opened-and-aborted",
      pressure,
      ordinary,
      abort,
      chunksDelivered: 0,
      publishedRevision: binding.revision,
      publishedManifestHash: binding.manifestHash,
      canonicalFiles: canary.files,
    };
  } finally {
    try {
      if (open) await abortInfrastructureStage(input, lease, open.uploadId);
    } finally {
      release = await releaseProbeLease(input, lease);
    }
  }
  assert.ok(observation);
  assert.ok(release);
  return { ...observation, leaseRelease: release };
}

export async function runLiveInfrastructureControls(input: {
  installed: Installed;
  roles: RoleContext;
  deployment: DeploymentIdentity;
  agentId: string;
  workspace: RecoveryWorkspaceCanary;
}) {
  const { installed, roles, deployment, agentId, workspace } = input;
  assertDeployment(deployment);
  assert.equal(new URL(roles.endpoint).protocol, "https:");
  assert.equal(roles.endpoint, deployment.origin);
  assert.equal(installed.hash, deployment.candidateSha256);
  assert.equal(installed.candidate.sourceCommit, deployment.sourceCommit);
  const configuration = await roles.call({
    operationId: "getConfiguration",
    path: {},
    query: {},
    body: undefined,
  });
  assert.equal(configuration.version, deployment.publicConfigurationVersion);
  assert.equal(sha256(canonicalJson(configuration)), deployment.runtimeConfigSha256);
  const policy: InfrastructurePolicy = configuration.infrastructure;
  assert.deepEqual(
    policy.bounds,
    infrastructureFixtureBounds,
    "Different operator allocations need independently reviewed boundary fixtures, never a policy override",
  );
  assert.ok(
    policy.accountPlan === "unknown" || policy.accountPlan === deployment.capabilities.plan,
  );
  const sdk = (await import(
    pathToFileURL(installed.resolveExport(`@${installed.candidate.scope}/fortipi-client/node`)).href
  )) as typeof import("../../packages/fortipi-client/dist/node.js");
  const deadline = Date.now() + 25 * 60000;
  let rateWaits = 0;
  async function request<T>(
    operation: () => Promise<T>,
    lease?: WorkspaceOperationLease,
  ): Promise<T> {
    for (;;) {
      if (lease && lease.expiresAt <= Date.now() + 5000)
        throw new InfrastructureEvidenceUnavailable(
          "The original lease cannot survive a public request-window wait",
        );
      try {
        return await operation();
      } catch (error) {
        if (
          !(error instanceof sdk.FortiPiError) ||
          error.status !== 429 ||
          error.code !== "rate_limited" ||
          !error.retryable
        )
          throw error;
        const wait = error.retryAfterMs ?? error.details?.retryAfterMs;
        assert.ok(
          wait &&
            Number.isSafeInteger(wait) &&
            wait > 0 &&
            wait <= 60000 &&
            ++rateWaits <= 16 &&
            Date.now() + wait < deadline,
        );
        if (lease && lease.expiresAt <= Date.now() + wait + 5000)
          throw new InfrastructureEvidenceUnavailable(
            "Rate window cannot outlive the original lease",
          );
        await delay(wait);
      }
    }
  }
  const issued: string[] = [];
  const cleanup: { credentialId: string; state: string; pendingRecipients: number }[] = [];
  let cleaned = false;
  async function revokeIssued() {
    if (cleaned) return;
    const dispositions = await Promise.allSettled(
      issued.map(async (id) => {
        const receipt = await roles.revokeAndWait(id);
        return {
          credentialId: id,
          state: receipt.state,
          pendingRecipients: receipt.pendingRecipients.length,
        };
      }),
    );
    cleanup.splice(0, cleanup.length);
    for (const result of dispositions)
      if (result.status === "fulfilled") cleanup.push(result.value);
    assert.ok(
      dispositions.every((result) => result.status === "fulfilled") &&
        cleanup.every((row) => row.state === "complete" && row.pendingRecipients === 0),
      "Infrastructure role cleanup is pending/unknown",
    );
    cleaned = true;
  }
  async function issue(
    resources: Parameters<RoleContext["issue"]>[0]["grants"][number]["resources"],
  ) {
    const role = await roles.issue({
      requestId: randomUUID(),
      role: "client",
      expiresAt: Date.now() + 30 * 60000,
      grants: [{ grantId: randomUUID(), version: 1, resources }],
    });
    issued.push(role.credential.credentialId);
    return {
      role,
      client: new sdk.FortiPiClient({
        endpoint: roles.endpoint,
        credentials: async () => role.token,
      }),
    };
  }
  const empty = {
    agentIds: [],
    conversationIds: [],
    workspaceIds: [],
    executorIds: [],
    backendIds: [],
    tools: [],
    actions: [],
  };
  try {
    const probe = await roles.call({
      operationId: "createConversation",
      path: { agentId },
      query: {},
      body: { requestId: randomUUID(), title: "seed1010-infrastructure-read-binding" },
    });
    const { client: reader, role: readRole } = await issue({
      ...empty,
      agentIds: [agentId],
      conversationIds: [probe.conversationId],
      workspaceIds: [workspace.binding.workspaceId],
      actions: [
        "agents.read",
        "conversations.read",
        "events.read",
        "workspace.read",
        "workspaces.read",
        "tickets.mint",
      ],
    });
    const protocol = await request(() => reader.negotiate());
    assert.deepEqual(protocol.infrastructure, policy);
    const ticket = await request(() => reader.tickets.mint(agentId, probe.conversationId));
    assert.equal(ticket.identity.role, "client");
    assert.equal(ticket.identity.deploymentId, protocol.deploymentId);
    assert.deepEqual(ticket.identity.credential, readRole.credential);
    const leases: { leaseId: string; released: boolean }[] = [];
    const declarations: Record<string, unknown>[] = [];
    const capabilityRefusals: { kind: string; status: number; unchangedVersion: number }[] = [];
    const started = Date.now();
    const snapshots: Record<string, unknown>[] = [];
    async function usage(phase: string) {
      const observedAt = Date.now();
      const health = await roles.call({
        operationId: "getAdminHealth",
        path: {},
        query: {},
        body: undefined,
      });
      const values = await roles.call({
        operationId: "getUsage",
        path: {},
        query: {},
        body: undefined,
      });
      assert.deepEqual(values.policy, policy);
      assert.ok(
        Number.isSafeInteger(values.reservedBytes) &&
          values.reservedBytes >= 0 &&
          Number.isSafeInteger(values.observedBytes) &&
          values.observedBytes >= 0,
      );
      for (const pressure of [...health.pressure, ...values.pressure])
        assertInfrastructurePressure(pressure);
      snapshots.push({
        phase,
        observedAt,
        health: health.state,
        pressure: values.pressure,
        reservedBytes: values.reservedBytes,
        observedBytes: values.observedBytes,
        providerCpu: "not-observed",
        providerSqlWrites: "not-observed",
        sharedAccountRemaining: "unknown",
      });
    }
    let failure: unknown;
    let publicControls: ScenarioEvidence | undefined;
    let concurrency: Record<string, unknown> | undefined;
    let pressure: ScenarioEvidence | undefined;
    try {
      if (deployment.backend === "free") {
        assert.equal(configuration.execution.kind, "native");
        assert.equal(deployment.capabilities.loaders, false);
        assert.equal(deployment.capabilities.containers, false);
        for (const kind of ["cloud-js", "linux"] as const) {
          const advertised = protocol.backends.find((backend) => backend.kind === kind);
          assert.ok(advertised && !advertised.available && advertised.reason);
          const proposed: Configuration = {
            ...structuredClone(configuration),
            version: configuration.version + 1,
            execution:
              kind === "cloud-js"
                ? {
                    kind,
                    backendId: `seed1010-unavailable-${randomUUID()}`,
                    modules: [],
                    egress: [],
                    onInterrupt: "fail",
                  }
                : {
                    kind,
                    backendId: `seed1010-unavailable-${randomUUID()}`,
                    host: `seed1010-unavailable-host-${randomUUID()}`,
                    imageDigest: installed.candidate.image.builtManifestDigest,
                    runtime: { cpuMs: 1000, memoryBytes: 1048576, timeoutMs: 1000 },
                  },
          };
          await assert.rejects(
            () =>
              roles.call({
                operationId: "patchConfiguration",
                path: {},
                query: {},
                body: {
                  requestId: randomUUID(),
                  expectedVersion: configuration.version,
                  configuration: proposed,
                },
              }),
            (error) =>
              error instanceof assert.AssertionError &&
              error.message ===
                "Trusted public coordinator operation failed: patchConfiguration (501)",
          );
          const retained = await roles.call({
            operationId: "getConfiguration",
            path: {},
            query: {},
            body: undefined,
          });
          assert.deepEqual(
            retained,
            configuration,
            "Unavailable capability selection must not mutate the installation",
          );
          capabilityRefusals.push({ kind, status: 501, unchangedVersion: retained.version });
        }
      }
      await usage("before");
      await deviceCanonicalBytes(reader, workspace, request);
      const allocationGroups = [];
      for (const resource of ["file", "snapshot", "entries"] as const) {
        const binding = await roles.call({
          operationId: "createWorkspace",
          path: {},
          query: {},
          body: { requestId: randomUUID(), config: { kind: "computer" } },
        });
        const { client } = await issue({
          ...empty,
          workspaceIds: [binding.workspaceId],
          actions: ["workspace.write", "workspace.read", "workspaces.read"],
        });
        const probe = { client, errorType: sdk.FortiPiError, request };
        const canary = await seedInfrastructureWorkspace(probe, binding);
        allocationGroups.push({ resource, canary, client });
      }
      for (const delta of [-1, 0, 1] as const) {
        // Preserve the three original scopes and real quiet rounds. A quiet
        // request window never bypasses child-role or install storage limits;
        // those still refuse admission and leave this claim nonpassing.
        const quietFrom = Date.now();
        await delay(60000);
        const quietThrough = Date.now();
        assert.ok(quietThrough - quietFrom >= 60000);
        for (const { resource, canary, client } of allocationGroups) {
          const observation = await observeComputerDeclaration({
            client,
            errorType: sdk.FortiPiError,
            request,
            resource,
            delta,
            canary,
          });
          leases.push(observation.leaseRelease);
          declarations.push({
            ...observation,
            quietWindow: { from: quietFrom, through: quietThrough },
          });
        }
        await deviceCanonicalBytes(reader, workspace, request);
      }
      concurrency = await publicConcurrency({ installed, roles, agentId, workspace });
      pressure = await publicRequestPressure({
        installed,
        roles,
        agentId,
        onRole: (ref) => issued.push(ref.credentialId),
      });
      await deviceCanonicalBytes(reader, workspace, request);
      await usage("after-active");
      publicControls = {
        observation: {
          providerDeploymentId: deployment.deploymentId,
          logicalApplicationId: protocol.deploymentId,
          policySha256: sha256(canonicalJson(policy)),
          fixtureBounds: infrastructureFixtureBounds,
          declarations,
          capabilityRefusals,
          leases,
          concurrency,
          requestWindow: pressure.observation,
          applicationUsage: snapshots,
          cleanup,
          canonicalFiles: workspace.files,
          sharedAccountRemaining: "unknown",
          uploadedBoundaryChunks: 0,
          rateWaits,
        },
        oracle:
          "Actual default-policy public declaration boundaries, last-slot admission/refused-key recovery and request-window recovery preserve independently hashed canonical bytes; application accounting never invents provider CPU, SQL writes, reset or shared headroom",
        sensitivity: [
          "Feasible file/entry declarations require real stages; snapshot descriptors require the exact policy storage cause and a same-workspace2MiB positive, with original hashes and fresh confirmed cleanup. No cleanup failure is begin-refusal evidence",
          "Public refused contender creates no accepted receipt/canonical message or assignment before its exact key becomes admissible after settlement",
        ],
        limitations: [
          "Allocation/declaration boundaries only; default snapshot pool refusals do not certify a maximum transferable snapshot or provider/account exhaustion",
          "Original canary bytes are freshly read; local reduced-cap tests, SQL/CPU counters, physical reclamation and event/output maxima are not aliased into this row",
          "Three real60s quiet rounds cover separate declaration principals/workspaces; sequential stages avoid adding shared-pool contention, and original short leases are acquired only after each wait",
        ],
      };
    } catch (error) {
      failure = error;
    } finally {
      await revokeIssued();
    }
    if (failure) throw failure;
    assert.ok(publicControls && concurrency && pressure);
    roles.assertSanitized(publicControls);
    const active = {
      from: Math.ceil(started / 60000) * 60000,
      through: Math.floor(Date.now() / 60000) * 60000,
    };
    assert.ok(active.through - active.from >= 60000);
    // No client stream, model task, lease or owned role is left active here.
    // These byte snapshots alone do NOT establish absence of idle SQL writes.
    const idleFrom = Math.ceil((Date.now() + 10000) / 60000) * 60000;
    await delay(idleFrom - Date.now());
    const idle = { from: idleFrom, through: idleFrom + 60000 };
    await delay(idle.through - Date.now());
    const readRequest: InfrastructureReadRequest = {
      accountBindingSha256: deployment.accountBindingSha256,
      sourceCommit: installed.candidate.sourceCommit,
      candidateSha256: installed.hash,
      providerDeploymentId: deployment.deploymentId,
      workerVersionId: deployment.workerVersionId,
      workerName: deployment.workerName,
      logicalApplicationId: protocol.deploymentId,
      agentId,
      workspaceId: workspace.binding.workspaceId,
      active,
      idle,
    };
    await installed.verifyUnchanged();
    const capturedControls = structuredClone(publicControls);
    let localData: unknown;
    let measuredEvidence: ScenarioEvidence | undefined;
    return {
      publicControls: structuredClone(capturedControls),
      readRequest: structuredClone(readRequest),
      async qualify(observer?: InfrastructureObserver): Promise<ScenarioEvidence> {
        if (!observer)
          throw new InfrastructureEvidenceUnavailable(
            "Actual read-only provider observer is required; no environment/data flag can replace it",
          );
        const observed = verifyInfrastructureMeasurements(
          readRequest,
          await observer.read(structuredClone(readRequest)),
        );
        localData = observed.localInfrastructure;
        // Retain only measurements in this supporting row. Original LOCAL JSON
        // is consumed/hashes checked by the separate composite below.
        const provider = { ...observed };
        delete provider.localInfrastructure;
        const evidence: ScenarioEvidence = {
          observation: {
            publicControls: capturedControls.observation,
            provider,
            windows: readRequest,
            windowAgeAtCollectionMs: {
              active: observed.collectedAt - readRequest.active.through,
              idle: observed.collectedAt - readRequest.idle.through,
            },
            comparison: {
              worker: {
                activeRequestsSum: observed.active.worker.requestsSum,
                idleRequestsSum: observed.idle.worker.requestsSum,
                activeDurationMs: readRequest.active.through - readRequest.active.from,
                idleDurationMs: readRequest.idle.through - readRequest.idle.from,
                activeRequestsPerSecond:
                  observed.active.worker.requestsSum! /
                  ((readRequest.active.through - readRequest.active.from) / 1000),
                idleRequestsPerSecond:
                  observed.idle.worker.requestsSum! /
                  ((readRequest.idle.through - readRequest.idle.from) / 1000),
                activeQuality: observed.active.worker.quality,
                idleQuality: observed.idle.worker.quality,
              },
              durableObjects: observed.active.durableObjects.map((object) => {
                const idleObject = observed.idle.durableObjects.find(
                  (row) => row.scope.resource === object.scope.resource,
                )!;
                return {
                  scope: object.scope,
                  activeRequestsSum: object.invocations.requestsSum,
                  idleRequestsSum: idleObject.invocations.requestsSum,
                  activeSqlRowsWrittenSum: object.periodic.sqlRowsWrittenSum,
                  idleSqlRowsWrittenSum: idleObject.periodic.sqlRowsWrittenSum,
                  activeDurationMs: readRequest.active.through - readRequest.active.from,
                  idleDurationMs: readRequest.idle.through - readRequest.idle.from,
                  activeRequestsPerSecond:
                    object.invocations.requestsSum! /
                    ((readRequest.active.through - readRequest.active.from) / 1000),
                  idleRequestsPerSecond:
                    idleObject.invocations.requestsSum! /
                    ((readRequest.idle.through - readRequest.idle.from) / 1000),
                  activeSqlWritesPerSecond:
                    object.periodic.sqlRowsWrittenSum! /
                    ((readRequest.active.through - readRequest.active.from) / 1000),
                  idleSqlWritesPerSecond:
                    idleObject.periodic.sqlRowsWrittenSum! /
                    ((readRequest.idle.through - readRequest.idle.from) / 1000),
                  quality: {
                    requests: object.invocations.quality,
                    sqlWrites: object.periodic.quality,
                  },
                };
              }),
              interpretation:
                "Separate scoped per-second request/write observations over fully covered effective durations; sampling/lag and other traffic require disposition of unexplained recurring work, not an invented ratio or exact-zero threshold",
            },
            durableObjectCoverage: observed.active.durableObjects.every(
              (row) => row.scope.kind === "namespace",
            )
              ? "all-three-bound-namespaces"
              : "control-plane-namespace-and-selected-agent-workspace-scopes",
            supportingMeasurements: {
              workerCpu: {
                unit: "milliseconds",
                statistic: "sum",
                active: {
                  value: observed.active.worker.workerCpuSumMs,
                  quality:
                    observed.active.worker.workerCpuSumMs === null
                      ? "unavailable"
                      : observed.active.worker.quality,
                },
                idle: {
                  value: observed.idle.worker.workerCpuSumMs,
                  quality:
                    observed.idle.worker.workerCpuSumMs === null
                      ? "unavailable"
                      : observed.idle.worker.quality,
                },
              },
              durableObjects: observed.active.durableObjects.map((active) => {
                const idle = observed.idle.durableObjects.find(
                  (row) => row.scope.resource === active.scope.resource,
                )!;
                return {
                  scope: active.scope,
                  cpu: {
                    unit: "milliseconds",
                    statistic: "sum",
                    active: {
                      value: active.periodic.doCpuSumMs,
                      quality:
                        active.periodic.doCpuSumMs === null
                          ? "unavailable"
                          : active.periodic.quality,
                    },
                    idle: {
                      value: idle.periodic.doCpuSumMs,
                      quality:
                        idle.periodic.doCpuSumMs === null ? "unavailable" : idle.periodic.quality,
                    },
                  },
                  memory: {
                    unit: "bytes",
                    statistic: "p99",
                    active: {
                      value: active.isolateMemory.doIsolateMemoryP99Bytes,
                      quality: active.isolateMemory.quality,
                    },
                    idle: {
                      value: idle.isolateMemory.doIsolateMemoryP99Bytes,
                      quality: idle.isolateMemory.quality,
                    },
                  },
                };
              }),
            },
            exactIdleWriteAbsence: "not-established",
            hardCpuOrMemoryPeak: "not-established",
            sharedAccountRemaining: "unknown",
          },
          oracle:
            "The exact target records required active/idle request and SQL-write observations at explicit namespace/object scope including ControlPlane; optional Worker/DO CPU sums and isolate-memory P99 retain unavailable nulls in either window, and reported zero never becomes exact absence or a hard maximum",
          sensitivity: [
            "Missing required request/write observations, wrong source/target/scope/window, resource errors and unknown statuses refuse the observation port",
          ],
          limitations: [
            ...capturedControls.limitations,
            "Adaptive estimates and periodic records have unknown delivery/completeness lag; absent records remain unavailable and observed zero does not prove exact idle-write absence",
            "CPU is a dataset sum; memory is the provider-calculated P99 of isolate samples in the selected namespace/object scope, not added per-object percentiles or a hard maximum; CPU/memory may be unavailable in either window",
            "Namespace counters include all objects and other traffic/versions sharing the namespace; Worker-version attribution does not make DO counters version-specific or per-agent measurements",
            "Object scope requires a parent-authenticated logical/physical mapping; namespace scope never invents that mapping, and selected objects cannot certify whole-namespace usage",
            "Parent owns actual resource attribution, primary-schema unit normalization/raw-data custody and provider read-only transport; this callback/data never grants job/deployment/archive authority",
            "No deliberate provider exhaustion, guaranteed account remaining balance or physical storage-reclamation claim; all other approved component/release proofs remain required",
          ],
        };
        roles.assertSanitized(evidence);
        measuredEvidence = structuredClone(evidence);
        return evidence;
      },
      composite(identity: Identity): ScenarioEvidence {
        if (!measuredEvidence || !localData)
          throw new InfrastructureEvidenceUnavailable(
            "Authenticated detailed LOCAL predecessor and actual Free observations are both required",
          );
        assert.equal(
          deployment.backend,
          "free",
          "This composite qualifies the actual Free target; Paid backend evidence remains separate",
        );
        if (measuredEvidence.observation.durableObjectCoverage !== "all-three-bound-namespaces")
          throw new InfrastructureEvidenceUnavailable(
            "Full Free infrastructure composition needs all three bound namespaces; selected objects remain a narrower observation",
          );
        assert.equal(identity.sourceCommit, deployment.sourceCommit);
        assert.equal(identity.candidateSha256, installed.hash);
        const local = verifyLocalInfrastructureProof(localData, {
          ...identity,
          scope: installed.candidate.scope,
          baseBoundsSha256: sha256(canonicalJson(infrastructureFixtureBounds)),
        });
        const evidence: ScenarioEvidence = {
          observation: {
            local,
            free: measuredEvidence.observation,
            sharedAccountRemaining: "unknown",
          },
          oracle:
            "Detailed original same-candidate LOCAL reduced-cap/fault/retention/reclamation observations compose with fresh actual default-policy Free public controls and scoped measurements; neither alone closes infrastructure",
          sensitivity: [
            ...measuredEvidence.sensitivity,
            "Partial/mismatched/uninventoried LOCAL claims and substituted result bytes refuse composition",
          ],
          limitations: [
            ...measuredEvidence.limitations,
            ...local.limitations,
            "Parent authenticates the completed original producer/artifact before this DATA handoff and reauthenticates it before retention; child hashes do not grant authority",
            "LOCAL fault/exhaustion is not live provider/account exhaustion; no account draining, hard peak, exact idle zero or guaranteed headroom claim",
          ],
        };
        roles.assertSanitized(evidence);
        return evidence;
      },
    };
  } finally {
    await revokeIssued();
  }
}

async function publicConcurrency(input: {
  installed: Installed;
  roles: RoleContext;
  agentId: string;
  workspace: RecoveryWorkspaceCanary;
}): Promise<Record<string, unknown>> {
  const { roles, installed, agentId, workspace } = input;
  const roleIds: string[] = [];
  try {
    const executorId = randomUUID();
    const offline = await roles.issue({
      requestId: randomUUID(),
      role: "executor",
      executorId,
      expiresAt: Date.now() + 15 * 60000,
      grants: [
        {
          grantId: randomUUID(),
          version: 1,
          resources: {
            agentIds: [],
            conversationIds: [],
            workspaceIds: [],
            executorIds: [executorId],
            backendIds: [],
            tools: [],
            actions: ["tickets.mint", "executors.register"],
          },
        },
      ],
    });
    roleIds.push(offline.credential.credentialId);
    const conversations = await Promise.all(
      [0, 1].map((i) =>
        roles.call({
          operationId: "createConversation",
          path: { agentId },
          query: {},
          body: { requestId: randomUUID(), title: `seed1010-infrastructure-contender-${i}` },
        }),
      ),
    );
    const role = await roles.issue({
      requestId: randomUUID(),
      role: "client",
      expiresAt: Date.now() + 15 * 60000,
      grants: [
        {
          grantId: randomUUID(),
          version: 1,
          resources: {
            agentIds: [agentId],
            conversationIds: conversations.map((c) => c.conversationId),
            workspaceIds: [workspace.binding.workspaceId],
            executorIds: [executorId],
            backendIds: [],
            tools: ["shell"],
            actions: [
              "tickets.mint",
              "conversations.read",
              "messages.submit",
              "events.read",
              "tasks.read",
              "tasks.cancel",
              "jobs.dispatch",
              "jobs.read",
              "approvals.read",
              "approvals.decide",
              "workspace.read",
              "workspaces.read",
            ],
          },
        },
      ],
    });
    roleIds.push(role.credential.credentialId);
    const sdk = (await import(
      pathToFileURL(installed.resolveExport(`@${installed.candidate.scope}/fortipi-client/node`))
        .href
    )) as typeof import("../../packages/fortipi-client/dist/node.js");
    const client = new sdk.FortiPiClient({
      endpoint: roles.endpoint,
      credentials: async () => role.token,
    });
    const request = deviceReadRequests();
    const events: DurableEvent[] = [];
    const streams = conversations.map((c) =>
      client.conversations.subscribe(c.conversationId, {
        agentId,
        maxReconnects: 0,
        onSnapshot() {},
        onEvent(e) {
          if (e.durability === "durable") events.push(structuredClone(e));
        },
      }),
    );
    const known: AdmissionReceipt[] = [];
    const dispatch = {
      tool: "shell",
      arguments: { command: "echo seed1010-infrastructure-never-start" },
      workspaceId: workspace.binding.workspaceId,
      baseRevision: workspace.binding.revision,
      target: { kind: "executor", executorId, generation: 1 },
      capabilities: ["shell"],
    };
    const bodies = conversations.map(() => ({
      clientRequestId: randomUUID(),
      busyBehavior: "reject" as const,
      content: `Call fortipi_dispatch exactly once with these exact arguments: ${canonicalJson(dispatch)}. Wait for the human decision. If rejected, report briefly; do not invoke another tool.`,
    }));
    async function settle(index: number, admission: AdmissionReceipt) {
      const event = await until(
        async () =>
          events.find((e) => e.type === "approval.requested" && e.taskId === admission.taskId),
        Boolean,
      );
      assert.ok(
        event?.jobId &&
          event.payload &&
          typeof event.payload === "object" &&
          "approvalId" in event.payload &&
          typeof event.payload.approvalId === "string",
      );
      const approvalId = event.payload.approvalId;
      const approval: Approval = await request(() => client.approvals.get(approvalId));
      assert.equal(approval.state, "pending");
      assert.deepEqual(approval.operation.arguments, dispatch.arguments);
      assert.deepEqual(approval.operation.target, dispatch.target);
      const job = await request(() => client.jobs.get(approval.jobId));
      assert.equal(job.taskId, admission.taskId);
      assert.equal(job.state, "awaiting_approval");
      assert.equal(job.execution, undefined);
      const waiting = await request(() => client.tasks.get(admission.taskId));
      assert.equal(waiting.status.state, "waiting");
      await request(() =>
        client.approvals.decide(approvalId, {
          requestId: randomUUID(),
          expectedVersion: approval.version,
          operationDigest: approval.operation.operationDigest,
          decision: "reject",
        }),
      );
      await until(
        async () =>
          events.some(
            (e) =>
              e.taskId === admission.taskId &&
              ["task.completed", "task.interrupted"].includes(e.type),
          ),
        Boolean,
      );
      const terminal = await request(() => client.tasks.get(admission.taskId));
      assert.ok(["completed", "failed", "cancelled"].includes(terminal.status.state));
      const cancelled = await request(() => client.jobs.get(job.jobId));
      assert.equal(cancelled.state, "cancelled");
      assert.equal(cancelled.execution, undefined);
      assert.equal(
        events.filter((e) => e.type === "approval.requested" && e.taskId === admission.taskId)
          .length,
        1,
      );
      assert.equal(
        conversations[index]?.conversationId,
        (await request(() => client.conversations.get(conversations[index]!.conversationId)))
          .conversation.conversationId,
      );
      return {
        jobId: job.jobId,
        taskId: admission.taskId,
        approvalId,
        state: cancelled.state,
        executionAbsent: true,
      };
    }
    try {
      await Promise.all(streams.map((s) => s.ready));
      const before = await Promise.all(
        conversations.map((c) => request(() => client.conversations.get(c.conversationId))),
      );
      await delay(60000);
      const raced = await Promise.allSettled(
        conversations.map((c, i) => client.conversations.send(c.conversationId, bodies[i]!)),
      );
      for (const result of raced) if (result.status === "fulfilled") known.push(result.value);
      const race = classifyInfrastructureRace(raced, (error) => {
        assert.ok(error instanceof sdk.FortiPiError);
        return { status: error.status, code: error.code, pressure: error.details?.pressure };
      });
      const { accepted, refused } = race;
      assert.deepEqual(
        await request(() => client.conversations.get(conversations[refused]!.conversationId)),
        before[refused],
      );
      assert.deepEqual(
        await request(() =>
          client.conversations.send(conversations[accepted]!.conversationId, bodies[accepted]!),
        ),
        race.admission,
      );
      const first = await settle(accepted, race.admission);
      const restored = await until(async () => {
        try {
          return await request(() =>
            client.conversations.send(conversations[refused]!.conversationId, bodies[refused]!),
          );
        } catch (error) {
          if (
            error instanceof sdk.FortiPiError &&
            error.status === 429 &&
            error.code === "quota_exceeded" &&
            error.details?.pressure?.resource === "concurrency"
          )
            return undefined;
          throw error;
        }
      }, Boolean);
      assert.ok(restored);
      known.push(restored);
      const second = await settle(refused, restored);
      await deviceCanonicalBytes(client, workspace, request);
      return {
        acceptedBeforeSettlement: race.admission,
        refusal: race.refusal,
        first,
        restoredOriginalRequestId: bodies[refused]!.clientRequestId,
        restored,
        second,
        refusedCanonicalProjectionUnchanged: true,
        nativeExecutorNeverConnected: true,
        limitation:
          "Public canonical facts only; private Pi-table absence and shared account capacity are not observed",
      };
    } finally {
      for (const s of streams) s.close();
      await Promise.allSettled(streams.map((s) => s.done));
      const cancelled = await Promise.allSettled(
        known.map((admission) =>
          request(() =>
            client.tasks.cancel(admission.taskId, {
              requestId: randomUUID(),
              reason: "seed1010-infrastructure-finally",
            }),
          ),
        ),
      );
      assert.ok(
        cancelled.every((result) => result.status === "fulfilled"),
        "Known task cleanup remains uncertain",
      );
    }
  } finally {
    const cleanup = await Promise.allSettled(roleIds.map((id) => roles.revokeAndWait(id)));
    assert.ok(
      cleanup.every(
        (result) =>
          result.status === "fulfilled" &&
          result.value.state === "complete" &&
          result.value.pendingRecipients.length === 0,
      ),
      "Concurrency fixture cleanup pending/unknown",
    );
  }
}
