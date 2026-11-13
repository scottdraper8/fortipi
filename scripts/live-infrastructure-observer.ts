import assert from "node:assert/strict";
import type {
  InfrastructureDurableObjectMeasurements,
  InfrastructureMeasurements,
  InfrastructureReadRequest,
  InfrastructureWindowMeasurements,
} from "../tests/clients/live-infrastructure-controls.ts";
import type { InfrastructureNamespace } from "./live-infrastructure-identity.ts";
import type {
  InfrastructureAnalyticsCollection,
  InfrastructureDataset,
  RawInfrastructureObservation,
  UtcWindow,
} from "./live-infrastructure-provider.ts";
import {
  assertDeployment,
  canonicalJson,
  type DeploymentIdentity,
  object,
  sha256,
} from "./verify-release-gates.ts";

type Namespaces = { namespaces: readonly InfrastructureNamespace[]; metadataSha256: string };
type Windows = { active: UtcWindow; idle: UtcWindow };
const closed = (value: object, keys: readonly string[]) =>
  assert.deepEqual(Reflect.ownKeys(value).sort(), [...keys].sort());
const resources = {
  CONTROL_PLANE: "control-plane",
  AGENT_SESSIONS: "agent",
  WORKSPACES: "workspace",
} as const;
function present<T>(value: T | undefined | null): T {
  assert.ok(value !== undefined && value !== null);
  return value;
}

/** Data-only validation before a private reader is called. Logical names bind
 * the original request, but do not become physical object attribution. */
export function infrastructureRequest(
  input: unknown,
  deployment: DeploymentIdentity,
  now = Date.now(),
): InfrastructureReadRequest {
  const request = object(input);
  closed(request, [
    "accountBindingSha256",
    "sourceCommit",
    "candidateSha256",
    "providerDeploymentId",
    "workerVersionId",
    "workerName",
    "logicalApplicationId",
    "agentId",
    "workspaceId",
    "active",
    "idle",
  ]);
  for (const [key, expected] of Object.entries({
    accountBindingSha256: deployment.accountBindingSha256,
    sourceCommit: deployment.sourceCommit,
    candidateSha256: deployment.candidateSha256,
    providerDeploymentId: deployment.deploymentId,
    workerVersionId: deployment.workerVersionId,
    workerName: deployment.workerName,
  }))
    assert.equal(request[key], expected, "Infrastructure target mismatch");
  for (const key of ["logicalApplicationId", "agentId", "workspaceId"])
    assert.ok(typeof request[key] === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(request[key]));
  for (const name of ["active", "idle"] as const) {
    const window = object(request[name]);
    closed(window, ["from", "through"]);
    const { from, through } = window;
    assert.ok(typeof from === "number" && Number.isSafeInteger(from) && from >= 0);
    assert.ok(typeof through === "number" && Number.isSafeInteger(through));
    assert.ok(from % 60000 === 0 && through % 60000 === 0);
    assert.ok(through - from >= 60000 && through - from <= 86400000);
    assert.ok(through <= Math.floor(now / 60000) * 60000 && from >= now - 86400000);
  }
  const value = request as unknown as InfrastructureReadRequest;
  assert.ok(value.active.through <= value.idle.from);
  return structuredClone(value);
}

function windows(request: InfrastructureReadRequest): Windows {
  const utc = (value: { from: number; through: number }) => ({
    start: new Date(value.from).toISOString(),
    end: new Date(value.through).toISOString(),
  });
  return { active: utc(request.active), idle: utc(request.idle) };
}
function number(
  record: Record<string, Record<string, string | number>>,
  group: string,
  key: string,
) {
  const value = record[group]?.[key];
  assert.ok(typeof value === "number" && Number.isFinite(value) && value >= 0);
  return value;
}
function available(value: RawInfrastructureObservation) {
  return value.unavailable === null && value.records !== null && value.records.length > 0;
}
function coverage(value: RawInfrastructureObservation) {
  if (!available(value) || !value.recordedWindow) return { records: 0, effectiveWindow: null };
  const from = Date.parse(value.recordedWindow.start),
    through = Date.parse(value.recordedWindow.end);
  assert.ok(Number.isSafeInteger(from) && Number.isSafeInteger(through) && from < through);
  return { records: present(value.records).length, effectiveWindow: { from, through } };
}
function aggregate(dataset: InfrastructureDataset, phase: "active" | "idle") {
  const value = dataset[phase];
  if (!available(value.aggregate) || !available(value.series) || !value.series.recordedWindow)
    return null;
  const records = present(value.aggregate.records);
  assert.equal(records.length, 1);
  return present(records[0]);
}
function invocations(dataset: InfrastructureDataset, phase: "active" | "idle") {
  const row = aggregate(dataset, phase);
  if (!row)
    return {
      quality: "unavailable" as const,
      records: 0,
      effectiveWindow: null,
      sampleInterval: null,
      requestsSum: null,
      statuses: null,
    };
  const statuses = new Map<string, { status: string; requestsSum: number; errorsSum: number }>();
  for (const record of present(dataset[phase].series.records)) {
    const status = record.dimensions?.status;
    assert.ok(typeof status === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(status));
    const current = statuses.get(status) ?? { status, requestsSum: 0, errorsSum: 0 };
    current.requestsSum += number(record, "sum", "requests");
    current.errorsSum += number(record, "sum", "errors");
    statuses.set(status, current);
  }
  const errors = number(row, "sum", "errors");
  assert.ok(
    Math.abs([...statuses.values()].reduce((sum, value) => sum + value.errorsSum, 0) - errors) <=
      1e-6 * Math.max(1, errors),
    "Aggregate errors must remain represented",
  );
  return {
    quality: "adaptive-estimate" as const,
    ...coverage(dataset[phase].series),
    sampleInterval: number(row, "avg", "sampleInterval"),
    requestsSum: number(row, "sum", "requests"),
    statuses: [...statuses.values()].sort((a, b) => a.status.localeCompare(b.status)),
  };
}

/** Normalize only authenticated fixed-query results. This function grants no
 * release authority, exact-zero/complete-ingestion claim or physical object map. */
export function normalizeInfrastructure(
  request: InfrastructureReadRequest,
  namespaces: Namespaces,
  raw: InfrastructureAnalyticsCollection,
): InfrastructureMeasurements {
  assert.equal(raw.accountBindingSha256, request.accountBindingSha256);
  assert.deepEqual(raw.worker, { name: request.workerName, versionId: request.workerVersionId });
  assert.equal(raw.namespaceMetadataSha256, namespaces.metadataSha256);
  assert.deepEqual(raw.requestedWindows, windows(request));
  if (
    !raw.schema ||
    !raw.settings ||
    !raw.schemaSha256 ||
    !raw.settingsSha256 ||
    raw.schemaUnavailable !== null ||
    raw.settingsUnavailable !== null
  )
    return { unavailable: "metrics-unavailable" };
  assert.equal(raw.schemaSha256, sha256(canonicalJson(raw.schema)));
  assert.equal(raw.settingsSha256, sha256(canonicalJson(raw.settings)));
  assert.equal(raw.rawResponseSha256, sha256(canonicalJson(raw.responses)));
  assert.equal(namespaces.namespaces.length, 3);
  assert.equal(new Set(namespaces.namespaces.map((value) => value.namespaceId)).size, 3);
  assert.deepEqual(
    namespaces.namespaces.map((value) => value.binding).sort(),
    Object.keys(resources).sort(),
  );
  assert.equal(raw.datasets.length, 10);
  const select = (
    kind: InfrastructureDataset["kind"],
    namespace: InfrastructureNamespace | null,
  ) => {
    const matches = raw.datasets.filter(
      (row) => row.kind === kind && canonicalJson(row.namespace) === canonicalJson(namespace),
    );
    assert.equal(matches.length, 1, "Missing or duplicated analytics scope");
    return present(matches[0]);
  };
  const output = (phase: "active" | "idle"): InfrastructureWindowMeasurements => {
    const worker = select("worker", null),
      workerRow = aggregate(worker, phase);
    return {
      worker: {
        ...invocations(worker, phase),
        scope: { workerName: request.workerName, workerVersionId: request.workerVersionId },
        workerCpuSumMs: workerRow ? number(workerRow, "sum", "cpuTimeUs") / 1000 : null,
      },
      durableObjects: namespaces.namespaces.map<InfrastructureDurableObjectMeasurements>(
        (namespace) => {
          const periodic = select("periodic", namespace),
            row = aggregate(periodic, phase);
          const memory = select("memory", namespace),
            memoryRow = aggregate(memory, phase);
          return {
            scope: {
              kind: "namespace",
              resource: resources[namespace.binding],
              namespaceId: namespace.namespaceId,
            },
            invocations: invocations(select("invocations", namespace), phase),
            periodic: {
              quality: row ? "periodic-counter" : "unavailable",
              ...(row ? coverage(periodic[phase].series) : { records: 0, effectiveWindow: null }),
              sqlRowsReadSum: row ? number(row, "sum", "rowsRead") : null,
              sqlRowsWrittenSum: row ? number(row, "sum", "rowsWritten") : null,
              doCpuSumMs: row ? number(row, "sum", "cpuTime") / 1000 : null,
              exceededCpuErrorsSum: row ? number(row, "sum", "exceededCpuErrors") : null,
              exceededMemoryErrorsSum: row ? number(row, "sum", "exceededMemoryErrors") : null,
              fatalInternalErrorsSum: row ? number(row, "sum", "fatalInternalErrors") : null,
            },
            isolateMemory: {
              quality: memoryRow ? "periodic-quantile" : "unavailable",
              ...(memoryRow
                ? coverage(memory[phase].series)
                : { records: 0, effectiveWindow: null }),
              doIsolateMemoryP99Bytes: memoryRow
                ? number(memoryRow, "quantiles", "memoryUsageBytesP99")
                : null,
            },
          };
        },
      ),
    };
  };
  const collectedAt = Date.parse(raw.collectedAt);
  assert.ok(Number.isSafeInteger(collectedAt) && collectedAt >= request.idle.through);
  return {
    requestSha256: sha256(canonicalJson(request)),
    rawResponseSha256: raw.rawResponseSha256,
    schemaSha256: raw.schemaSha256,
    settingsSha256: raw.settingsSha256,
    attributionSha256: sha256(canonicalJson({ worker: raw.worker, namespaces })),
    collectedAt,
    deliveryLagMs: null,
    active: output("active"),
    idle: output("idle"),
  };
}

/** Capability supplied by the authenticated outer process; no file/env flag can
 * instantiate provider authority in a child. Request validation precedes reads. */
export function createInfrastructureObserver(input: {
  deployment: DeploymentIdentity;
  read(
    windows: Windows,
  ): Promise<{ namespaces: Namespaces; raw: InfrastructureAnalyticsCollection }>;
}): { read(input: unknown): Promise<InfrastructureMeasurements> } {
  const deployment = structuredClone(input.deployment);
  assertDeployment(deployment);
  assert.equal(deployment.backend, "free");
  let used = false;
  return Object.freeze({
    read: async (request: unknown) => {
      assert.equal(used, false, "Infrastructure observation is one-shot");
      used = true;
      try {
        const bound = infrastructureRequest(request, deployment);
        const { namespaces, raw } = await input.read(windows(bound));
        return normalizeInfrastructure(bound, namespaces, raw);
      } catch {
        throw new Error("Infrastructure observation unavailable");
      }
    },
  });
}
