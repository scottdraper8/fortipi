import assert from "node:assert/strict";
import test from "node:test";
import { verifyInfrastructureMeasurements } from "../../../tests/clients/live-infrastructure-controls.ts";
import type { InfrastructureNamespace } from "../../live-infrastructure-identity.ts";
import {
  createInfrastructureObserver,
  infrastructureRequest,
  normalizeInfrastructure,
} from "../../live-infrastructure-observer.ts";
import type {
  InfrastructureAnalyticsCollection,
  InfrastructureDataset,
  RawInfrastructureObservation,
} from "../../live-infrastructure-provider.ts";
import { canonicalJson, type DeploymentIdentity, sha256 } from "../../verify-release-gates.ts";

const now = Math.floor(Date.now() / 60000) * 60000;
const deployment: DeploymentIdentity = {
  schemaVersion: 1,
  candidateSha256: sha256("candidate"),
  sourceCommit: "a".repeat(40),
  accountBindingSha256: sha256("synthetic-account"),
  slot: "production",
  workerName: "observer-fixture",
  origin: "https://observer-fixture.example.workers.dev",
  workerVersionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  deploymentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  versions: [{ versionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", percentage: 100 }],
  configSha256: sha256("config"),
  runtimeConfigSha256: sha256("runtime"),
  assetManifestSha256: sha256("assets"),
  publicConfigurationVersion: 1,
  capabilities: { plan: "free", loaders: false, containers: false },
  backend: "free",
  imageDigest: null,
  checkedAt: new Date().toISOString(),
};
const namespaces: { namespaces: InfrastructureNamespace[]; metadataSha256: string } = {
  metadataSha256: sha256("actual-metadata-fixture"),
  namespaces: [
    { binding: "CONTROL_PLANE", className: "ControlPlane", namespaceId: "1".repeat(32) },
    { binding: "AGENT_SESSIONS", className: "AgentSession", namespaceId: "2".repeat(32) },
    { binding: "WORKSPACES", className: "WorkspaceObject", namespaceId: "3".repeat(32) },
  ],
};
const request = {
  accountBindingSha256: deployment.accountBindingSha256,
  sourceCommit: deployment.sourceCommit,
  candidateSha256: deployment.candidateSha256,
  providerDeploymentId: deployment.deploymentId,
  workerVersionId: deployment.workerVersionId,
  workerName: deployment.workerName,
  logicalApplicationId: "logical-control",
  agentId: "logical-agent",
  workspaceId: "logical-workspace",
  active: { from: now - 240000, through: now - 180000 },
  idle: { from: now - 120000, through: now - 60000 },
};
function raw(): InfrastructureAnalyticsCollection {
  const requestedWindows = Object.fromEntries(
    (["active", "idle"] as const).map((phase) => [
      phase,
      {
        start: new Date(request[phase].from).toISOString(),
        end: new Date(request[phase].through).toISOString(),
      },
    ]),
  ) as InfrastructureAnalyticsCollection["requestedWindows"];
  const datasets: InfrastructureDataset[] = [];
  for (const kind of ["worker", "invocations", "periodic", "memory"] as const) {
    for (const namespace of kind === "worker" ? [null] : namespaces.namespaces) {
      const phase = (name: "active" | "idle") => {
        const metrics: Record<string, Record<string, string | number>> = kind === "worker"
          ? { sum: { requests: 2, errors: 0, cpuTimeUs: 3500 }, avg: { sampleInterval: 1 } }
          : kind === "invocations"
            ? { sum: { requests: 2, errors: 0 }, avg: { sampleInterval: 1 } }
            : kind === "periodic"
              ? {
                  sum: {
                    rowsRead: 4,
                    rowsWritten: name === "idle" ? 1 : 7,
                    cpuTime: 2500,
                    exceededCpuErrors: 0,
                    exceededMemoryErrors: 0,
                    fatalInternalErrors: 0,
                  },
                }
              : { quantiles: { memoryUsageBytesP99: 8192 } };
        const dimensions = {
          ...(namespace
            ? { namespaceId: namespace.namespaceId }
            : { scriptName: deployment.workerName, scriptVersion: deployment.workerVersionId }),
          ...(kind === "worker" || kind === "invocations" ? { status: "ok" } : {}),
          datetimeMinute: requestedWindows[name].start,
        };
        const aggregate: RawInfrastructureObservation = {
          unavailable: null,
          records: [structuredClone(metrics)],
          recordedWindow: null,
          recordedMinutes: null,
        };
        return {
          aggregate,
          series: {
            unavailable: null,
            records: [{ ...structuredClone(metrics), dimensions }],
            recordedWindow: requestedWindows[name],
            recordedMinutes: [requestedWindows[name].start],
          },
        };
      };
      datasets.push({
        kind,
        namespace,
        dataset: kind,
        quality:
          kind === "periodic"
            ? "periodic-counter"
            : kind === "memory"
              ? "periodic-quantile"
              : "adaptive-estimate",
        units: {},
        active: phase("active"),
        idle: phase("idle"),
      });
    }
  }
  return {
    accountBindingSha256: deployment.accountBindingSha256,
    worker: { name: deployment.workerName, versionId: deployment.workerVersionId },
    namespaceMetadataSha256: namespaces.metadataSha256,
    requestedWindows,
    schema: { synthetic: "schema" },
    settings: { synthetic: "settings" },
    schemaUnavailable: null,
    settingsUnavailable: null,
    schemaSha256: sha256(canonicalJson({ synthetic: "schema" })),
    settingsSha256: sha256(canonicalJson({ synthetic: "settings" })),
    responses: [],
    rawResponseSha256: sha256(canonicalJson([])),
    datasets,
    collectedAt: new Date(now).toISOString(),
  };
}
function first<T>(items: T[]): T {
  const value = items[0];
  assert.ok(value !== undefined);
  return value;
}

test("private fixed observations preserve namespace scope, CPU units, unknown lag and an actual idle write", () => {
  const observed = normalizeInfrastructure(request, namespaces, raw());
  const result = verifyInfrastructureMeasurements(request, observed);
  assert.equal(result.active.worker.workerCpuSumMs, 3.5);
  assert.equal(result.deliveryLagMs, null);
  assert.equal(first(result.active.durableObjects).periodic.doCpuSumMs, 2.5);
  assert.equal(first(result.active.durableObjects).isolateMemory.doIsolateMemoryP99Bytes, 8192);
  assert.equal(first(result.idle.durableObjects).periodic.sqlRowsWrittenSum, 1);
  assert.deepEqual(
    result.active.durableObjects.map((row) => row.scope.kind),
    ["namespace", "namespace", "namespace"],
  );
  assert.equal(result.requestSha256, sha256(canonicalJson(request)));
});

test("empty records stay unavailable, aggregate quantiles are not added, and errors cannot disappear", () => {
  const data = raw(),
    memory = first(data.datasets.filter((value) => value.kind === "memory"));
  first(memory.active.series.records ?? []).quantiles = { memoryUsageBytesP99: 4096 };
  const normalized = normalizeInfrastructure(request, namespaces, data);
  assert.ok(!("unavailable" in normalized));
  assert.equal(first(normalized.active.durableObjects).isolateMemory.doIsolateMemoryP99Bytes, 8192);
  memory.idle.aggregate = {
    unavailable: "empty",
    records: null,
    recordedWindow: null,
    recordedMinutes: null,
  };
  const missing = normalizeInfrastructure(request, namespaces, data);
  assert.ok(!("unavailable" in missing));
  assert.equal(first(missing.idle.durableObjects).isolateMemory.quality, "unavailable");
  assert.equal(first(missing.idle.durableObjects).isolateMemory.doIsolateMemoryP99Bytes, null);
  const worker = first(data.datasets.filter((value) => value.kind === "worker"));
  first(worker.active.aggregate.records ?? []).sum = { requests: 2, errors: 1, cpuTimeUs: 3500 };
  assert.throws(() => normalizeInfrastructure(request, namespaces, data), /errors/);
});

test("an actual returned zero aggregate covers its query window without inventing samples or memory", () => {
  const data = raw();
  for (const dataset of data.datasets) {
    const row = first(dataset.idle.aggregate.records ?? []);
    if (row.sum) for (const field of Object.keys(row.sum)) row.sum[field] = 0;
    if (row.avg) row.avg.sampleInterval = 0;
    dataset.idle.series = {
      unavailable: "empty",
      records: null,
      recordedWindow: null,
      recordedMinutes: null,
    };
  }
  const observed = verifyInfrastructureMeasurements(
    request,
    normalizeInfrastructure(request, namespaces, data),
  );
  assert.equal(observed.idle.worker.requestsSum, 0);
  assert.equal(observed.idle.worker.aggregateErrorsSum, 0);
  assert.equal(observed.idle.worker.sampleInterval, null);
  assert.deepEqual(observed.idle.worker.statuses, []);
  assert.equal(observed.idle.worker.coverageKind, "query-window-aggregate");
  assert.equal(observed.idle.worker.records, 1);
  assert.deepEqual(observed.idle.worker.effectiveWindow, request.idle);
  for (const resource of observed.idle.durableObjects) {
    assert.equal(resource.periodic.sqlRowsWrittenSum, 0);
    assert.equal(resource.periodic.coverageKind, "query-window-aggregate");
    assert.equal(resource.isolateMemory.quality, "unavailable");
    assert.equal(resource.isolateMemory.doIsolateMemoryP99Bytes, null);
  }
  // The same empty series with a positive aggregate must not borrow that scope.
  const worker = first(data.datasets.filter((value) => value.kind === "worker"));
  first(worker.idle.aggregate.records ?? []).sum = { requests: 1, errors: 0, cpuTimeUs: 1 };
  const positive = normalizeInfrastructure(request, namespaces, data);
  assert.ok(!("unavailable" in positive));
  assert.equal(positive.idle.worker.quality, "unavailable");
  assert.equal(positive.idle.worker.records, 0);
  assert.throws(() => verifyInfrastructureMeasurements(request, positive));
  worker.idle.aggregate = {
    unavailable: "empty",
    records: null,
    recordedWindow: null,
    recordedMinutes: null,
  };
  const absent = normalizeInfrastructure(request, namespaces, data);
  assert.ok(!("unavailable" in absent));
  assert.equal(absent.idle.worker.requestsSum, null);
  assert.equal(absent.idle.worker.effectiveWindow, null);
});

test("foreign target, scope, windows and missing schema cannot qualify provider measurements", () => {
  for (const mutate of [
    (data: InfrastructureAnalyticsCollection) => {
      data.worker.versionId = "foreign";
    },
    (data: InfrastructureAnalyticsCollection) => {
      data.accountBindingSha256 = sha256("foreign");
    },
    (data: InfrastructureAnalyticsCollection) => {
      data.namespaceMetadataSha256 = sha256("foreign");
    },
    (data: InfrastructureAnalyticsCollection) => {
      data.requestedWindows.active.end = data.requestedWindows.idle.end;
    },
    (data: InfrastructureAnalyticsCollection) => {
      data.datasets.pop();
    },
    (data: InfrastructureAnalyticsCollection) => {
      data.datasets[1] = structuredClone(first(data.datasets));
    },
  ]) {
    const data = raw();
    mutate(data);
    assert.throws(() => normalizeInfrastructure(request, namespaces, data));
  }
  const data = raw();
  data.schemaSha256 = null;
  assert.deepEqual(normalizeInfrastructure(request, namespaces, data), {
    unavailable: "metrics-unavailable",
  });
});

test("closed one-shot request validation precedes provider reads and contains private reader failures", async () => {
  for (const change of [
    { workerVersionId: "foreign" },
    { candidateSha256: sha256("foreign") },
    { url: "https://elsewhere.invalid" },
    { active: { ...request.active, from: request.active.from + 1 } },
    { idle: { from: now, through: now + 60000 } },
    { agentId: "bad\nname" },
  ]) {
    let reads = 0;
    const observer = createInfrastructureObserver({
      deployment,
      read: async () => {
        reads++;
        return { namespaces, raw: raw() };
      },
    });
    await assert.rejects(
      observer.read({ ...request, ...change }),
      /^Error: Infrastructure observation unavailable$/,
    );
    assert.equal(reads, 0);
    await assert.rejects(observer.read(request), /one-shot/);
  }
  assert.deepEqual(infrastructureRequest(request, deployment, now), request);
  let reads = 0;
  const successful = createInfrastructureObserver({
    deployment,
    read: async (windows) => {
      reads++;
      const collection = raw();
      assert.deepEqual(windows, collection.requestedWindows);
      return { namespaces, raw: collection };
    },
  });
  const observed = await successful.read(request);
  verifyInfrastructureMeasurements(request, observed);
  assert.ok(
    !JSON.stringify(observed).includes("synthetic"),
    "Private schema/settings bodies stay in the parent",
  );
  await assert.rejects(successful.read(request), /one-shot/);
  assert.equal(reads, 1);
  const observer = createInfrastructureObserver({
    deployment,
    read: async () => {
      throw new Error("synthetic-private-token");
    },
  });
  await assert.rejects(observer.read(request), /^Error: Infrastructure observation unavailable$/);
});
