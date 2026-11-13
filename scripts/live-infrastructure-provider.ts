import assert from "node:assert/strict";
import type { InfrastructureNamespace } from "./live-infrastructure-identity.ts";
import {
  assertDeployment,
  canonicalJson,
  type DeploymentIdentity,
  object,
  sha256,
} from "./verify-release-gates.ts";

export interface UtcWindow {
  start: string;
  end: string;
}
type Reason =
  | "schema"
  | "settings"
  | "disabled"
  | "field"
  | "window"
  | "limit"
  | "transport"
  | "http"
  | "graphql"
  | "response"
  | "full-page"
  | "empty"
  | "unsafe";
type RawRecord = Record<string, Record<string, string | number>>;
export interface RawInfrastructureObservation {
  unavailable: Reason | null;
  records: RawRecord[] | null;
  /** Observed bucket span only; gaps/lag are not evidence of completeness. */
  recordedWindow: UtcWindow | null;
  recordedMinutes: string[] | null;
}
export interface InfrastructureDataset {
  kind: "worker" | "invocations" | "periodic" | "memory";
  dataset: string;
  namespace: InfrastructureNamespace | null;
  quality: "adaptive-estimate" | "periodic-counter" | "periodic-quantile";
  units: Readonly<Record<string, string>>;
  active: { aggregate: RawInfrastructureObservation; series: RawInfrastructureObservation };
  idle: { aggregate: RawInfrastructureObservation; series: RawInfrastructureObservation };
}
export interface InfrastructureAnalyticsCollection {
  accountBindingSha256: string;
  worker: { name: string; versionId: string };
  namespaceMetadataSha256: string;
  requestedWindows: { active: UtcWindow; idle: UtcWindow };
  schema: Record<string, unknown> | null;
  settings: Record<string, unknown> | null;
  schemaUnavailable: Reason | null;
  settingsUnavailable: Reason | null;
  schemaSha256: string | null;
  settingsSha256: string | null;
  /** Hashes of complete HTTP response bytes, in request order; bodies stay private. */
  responses: { request: string; sha256: string }[];
  rawResponseSha256: string;
  datasets: InfrastructureDataset[];
  collectedAt: string;
}
export interface InfrastructureAnalyticsInput {
  account: string;
  accountBindingSha256: string;
  token: string;
  deployment: DeploymentIdentity;
  /** Exact result of the authenticated namespace reader; caller supplies authority. */
  namespaces: { namespaces: readonly InfrastructureNamespace[]; metadataSha256: string };
  transport?: typeof fetch;
}

const endpoint = "https://api.cloudflare.com/client/v4/graphql";
const required = [
  ["CONTROL_PLANE", "ControlPlane"],
  ["AGENT_SESSIONS", "AgentSession"],
  ["WORKSPACES", "WorkspaceObject"],
] as const;
type Spec = {
  kind: InfrastructureDataset["kind"];
  node: string;
  type: string;
  filter: string;
  metrics: Record<string, Record<string, string>>;
  dimensions: Record<string, string>;
  quality: InfrastructureDataset["quality"];
  units: Record<string, string>;
};
// Primary field/unit contracts: infrastructure-observer-primary-handoff.md.
// These are fixed selections, not a query language exposed to children.
const specs: Spec[] = [
  {
    kind: "worker",
    node: "workersInvocationsAdaptive",
    type: "AccountWorkersInvocationsAdaptive",
    filter: "datetime",
    quality: "adaptive-estimate",
    metrics: {
      sum: { requests: "uint64", errors: "uint64", cpuTimeUs: "uint64" },
      avg: { sampleInterval: "float64" },
      quantiles: { cpuTimeP99: "float64" },
    },
    dimensions: {
      scriptName: "string",
      scriptVersion: "string",
      status: "string",
      datetimeMinute: "Time",
    },
    units: {
      requests: "count",
      errors: "count",
      cpuTimeUs: "microseconds",
      cpuTimeP99: "microseconds",
      sampleInterval: "ratio",
    },
  },
  {
    kind: "invocations",
    node: "durableObjectsInvocationsAdaptiveGroups",
    type: "AccountDurableObjectsInvocationsAdaptiveGroups",
    filter: "datetime",
    quality: "adaptive-estimate",
    metrics: { sum: { requests: "uint64", errors: "uint64" }, avg: { sampleInterval: "float64" } },
    dimensions: { namespaceId: "string", status: "string", datetimeMinute: "Time" },
    units: { requests: "count", errors: "count", sampleInterval: "ratio" },
  },
  {
    kind: "periodic",
    node: "durableObjectsPeriodicGroups",
    type: "AccountDurableObjectsPeriodicGroups",
    filter: "datetimeMinute",
    quality: "periodic-counter",
    metrics: {
      sum: {
        rowsRead: "uint64",
        rowsWritten: "uint64",
        cpuTime: "uint64",
        exceededCpuErrors: "uint64",
        exceededMemoryErrors: "uint64",
        fatalInternalErrors: "uint64",
      },
    },
    dimensions: { namespaceId: "string", datetimeMinute: "Time" },
    units: {
      rowsRead: "rows",
      rowsWritten: "rows",
      cpuTime: "microseconds",
      exceededCpuErrors: "count",
      exceededMemoryErrors: "count",
      fatalInternalErrors: "count",
    },
  },
  {
    kind: "memory",
    node: "durableObjectsPeriodicGroups",
    type: "AccountDurableObjectsPeriodicGroups",
    filter: "datetimeMinute",
    quality: "periodic-quantile",
    metrics: { quantiles: { memoryUsageBytesP99: "float64|uint64" } },
    dimensions: { namespaceId: "string", datetimeMinute: "Time" },
    units: { memoryUsageBytesP99: "bytes (whole-isolate P99, not a maximum)" },
  },
];
const typeNames = [
  ...new Set([
    "account",
    "AccountSettings",
    "Settings",
    ...specs.flatMap((s) => [
      s.type,
      `${s.type}Filter_InputObject`,
      `${s.type}Dimensions`,
      ...Object.keys(s.metrics).map((g) => `${s.type}${g[0]?.toUpperCase()}${g.slice(1)}`),
    ]),
  ]),
];
const typeRef = "kind name ofType { kind name ofType { kind name ofType { kind name } } }";
const schemaQuery = `query FortiPiInfrastructureSchema {
  ${typeNames.map((name, i) => `t${i}: __type(name: "${name}") { name kind fields(includeDeprecated: true) { name description isDeprecated type { ${typeRef} } args { name type { ${typeRef} } } } inputFields { name type { ${typeRef} } } }`).join("\n")}
}`;
const settingsQuery = `query FortiPiInfrastructureSettings($account: string!) {
  viewer { accounts(filter: { accountTag: $account }) { accountTag settings {
    workersInvocationsAdaptive { enabled availableFields maxPageSize maxDuration notOlderThan maxNumberOfFields }
    durableObjectsInvocationsAdaptiveGroups { enabled availableFields maxPageSize maxDuration notOlderThan maxNumberOfFields }
    durableObjectsPeriodicGroups { enabled availableFields maxPageSize maxDuration notOlderThan maxNumberOfFields }
  } } }
}`;
function selection(groups: Record<string, Record<string, string>>): string {
  return Object.entries(groups)
    .map(([g, fields]) => `${g} { ${Object.keys(fields).join(" ")} }`)
    .join(" ");
}
// Built once exclusively from the fixed table above. All runtime identities/times
// are GraphQL variables; no URL, query, field or object-ID input is accepted.
const queries = specs.map((s) => {
  const scope =
    s.kind === "worker"
      ? "scriptName: $worker, scriptVersion: $version"
      : "namespaceId: $namespace";
  const filter = `${scope}, ${s.filter}_geq: $start, ${s.filter}_lt: $end`;
  const metrics = selection(s.metrics);
  return `query FortiPiInfrastructure${s.kind}($account: string!, ${s.kind === "worker" ? "$worker: string!, $version: string!" : "$namespace: string!"}, $start: Time!, $end: Time!, $limit: uint64!) {
    viewer { accounts(filter: { accountTag: $account }) { accountTag
      aggregate: ${s.node}(filter: { ${filter} }, limit: $limit) { ${metrics} }
      series: ${s.node}(filter: { ${filter} }, limit: $limit) { ${metrics} dimensions { ${Object.keys(s.dimensions).join(" ")} }
    } }
  }`;
});
class Unavailable extends Error {
  readonly reason: Reason;
  constructor(reason: Reason) {
    super(`Infrastructure analytics unavailable: ${reason}`);
    this.reason = reason;
  }
}
function fail(reason: Reason): never {
  throw new Unavailable(reason);
}
function reason(error: unknown): Reason {
  return error instanceof Unavailable ? error.reason : "response";
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail("response");
  return value;
}
function present<T>(value: T | undefined): T {
  if (value === undefined) fail("response");
  return value;
}
function leaf(value: unknown): { name: string; kind: string } {
  let ref = object(value);
  for (let i = 0; i < 4; i++) {
    if (ref.kind !== "NON_NULL" && ref.kind !== "LIST") {
      if (typeof ref.name !== "string" || typeof ref.kind !== "string") fail("schema");
      return { name: ref.name, kind: ref.kind };
    }
    ref = object(ref.ofType);
  }
  return fail("schema");
}
function schemaField(schema: Record<string, unknown>, type: string, name: string, input = false) {
  const definition = object(schema[type]);
  if (definition.name !== type || definition.kind !== (input ? "INPUT_OBJECT" : "OBJECT"))
    fail("schema");
  const matches = array(input ? definition.inputFields : definition.fields, 2000)
    .map(object)
    .filter((f) => f.name === name);
  if (matches.length !== 1 || matches[0]?.isDeprecated === true) fail("schema");
  return present(matches[0]);
}
function unwrapped(value: unknown) {
  const ref = object(value);
  return ref.kind === "NON_NULL" ? object(ref.ofType) : ref;
}
function scalar(
  schema: Record<string, unknown>,
  type: string,
  name: string,
  expected: string,
  input = false,
  list = false,
) {
  const value = schemaField(schema, type, name, input).type;
  const outer = unwrapped(value),
    ref = leaf(value);
  if (
    (outer.kind === "LIST") !== list ||
    ref.kind !== "SCALAR" ||
    !expected.split("|").includes(ref.name)
  )
    fail("schema");
}
function supported(
  s: Spec,
  schema: Record<string, unknown>,
  settings: Record<string, unknown>,
  windows: UtcWindow[],
  now: number,
): number {
  scalar(schema, "account", "accountTag", "string");
  const dataset = schemaField(schema, "account", s.node);
  if (unwrapped(dataset.type).kind !== "LIST" || leaf(dataset.type).name !== s.type) fail("schema");
  const args = array(dataset.args, 16).map(object);
  for (const [name, type] of [
    ["limit", "uint64"],
    ["filter", `${s.type}Filter_InputObject`],
  ]) {
    const matches = args.filter((a) => a.name === name);
    if (
      matches.length !== 1 ||
      unwrapped(matches[0]?.type).kind === "LIST" ||
      leaf(matches[0]?.type).name !== type
    )
      fail("schema");
  }
  const inputType = `${s.type}Filter_InputObject`;
  for (const suffix of ["_geq", "_lt"]) scalar(schema, inputType, s.filter + suffix, "Time", true);
  for (const name of s.kind === "worker" ? ["scriptName", "scriptVersion"] : ["namespaceId"])
    scalar(schema, inputType, name, "string", true);
  for (const [group, fields] of Object.entries({ ...s.metrics, dimensions: s.dimensions })) {
    const type = `${s.type}${group[0]?.toUpperCase()}${group.slice(1)}`;
    const ref = schemaField(schema, s.type, group).type;
    if (unwrapped(ref).kind !== "OBJECT" || leaf(ref).name !== type) fail("schema");
    for (const [field, expected] of Object.entries(fields)) scalar(schema, type, field, expected);
  }
  for (const [name, expected] of Object.entries({
    enabled: "bool",
    availableFields: "string",
    maxPageSize: "int64",
    maxDuration: "int64",
    notOlderThan: "int64",
    maxNumberOfFields: "int64",
  }))
    scalar(schema, "Settings", name, expected, false, name === "availableFields");
  if (leaf(schemaField(schema, "AccountSettings", s.node).type).name !== "Settings") fail("schema");
  const config = object(settings[s.node]);
  if (config.enabled !== true) fail("disabled");
  const fields = array(config.availableFields, 2000);
  if (!fields.every((f) => typeof f === "string")) fail("settings");
  const selected = Object.entries({ ...s.metrics, dimensions: s.dimensions }).flatMap(([g, fs]) =>
    Object.keys(fs).map((f) => `${g}_${f}`),
  );
  if (!selected.every((f) => fields.includes(f))) fail("field");
  for (const key of ["maxPageSize", "maxDuration", "notOlderThan", "maxNumberOfFields"])
    if (!Number.isSafeInteger(config[key]) || Number(config[key]) < 1) fail("settings");
  if (Number(config.maxNumberOfFields) < selected.length) fail("limit");
  if (
    windows.some(
      (w) =>
        (Date.parse(w.end) - Date.parse(w.start)) / 1000 > Number(config.maxDuration) ||
        (now - Date.parse(w.start)) / 1000 > Number(config.notOlderThan),
    )
  )
    fail("window");
  const limit = Math.min(1000, Number(config.maxPageSize));
  if (limit < 2) fail("limit");
  return limit;
}
function unavailable(why: Reason): RawInfrastructureObservation {
  return { unavailable: why, records: null, recordedWindow: null, recordedMinutes: null };
}
function observation(
  raw: unknown,
  s: Spec,
  scope: InfrastructureNamespace | null,
  worker: { name: string; versionId: string },
  window: UtcWindow,
  limit: number,
  grouped: boolean,
): RawInfrastructureObservation {
  try {
    const rows = array(raw, limit);
    if (rows.length === limit) fail("full-page");
    if (!rows.length) fail("empty");
    if (!grouped && rows.length !== 1) fail("response");
    const groups = grouped ? { ...s.metrics, dimensions: s.dimensions } : s.metrics;
    const keys = new Set<string>(),
      minutes = new Set<string>();
    const records = rows.map((rawRow) => {
      const row = object(rawRow),
        result: RawRecord = {};
      if (Object.keys(row).length !== Object.keys(groups).length) fail("response");
      for (const [group, fields] of Object.entries(groups)) {
        const values = object(row[group]),
          copied: Record<string, string | number> = {};
        if (Object.keys(values).length !== Object.keys(fields).length) fail("response");
        for (const [name, type] of Object.entries(fields)) {
          const value = values[name];
          if (type === "uint64" || type.startsWith("float64")) {
            if (
              typeof value !== "number" ||
              !Number.isFinite(value) ||
              value < 0 ||
              (type === "uint64" && !Number.isSafeInteger(value))
            )
              fail("response");
          } else if (
            typeof value !== "string" ||
            value.length > 128 ||
            [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
          )
            fail("response");
          copied[name] = value as string | number;
        }
        result[group] = copied;
      }
      if (grouped) {
        const dim = present(result.dimensions);
        if (
          scope
            ? dim.namespaceId !== scope.namespaceId
            : dim.scriptName !== worker.name || dim.scriptVersion !== worker.versionId
        )
          fail("response");
        const minute = Date.parse(String(dim.datetimeMinute));
        if (
          !/Z$/.test(String(dim.datetimeMinute)) ||
          !Number.isFinite(minute) ||
          minute % 60000 ||
          minute < Date.parse(window.start) ||
          minute >= Date.parse(window.end)
        )
          fail("response");
        minutes.add(new Date(minute).toISOString());
        const key = canonicalJson(dim);
        if (keys.has(key)) fail("response");
        keys.add(key);
      }
      return result;
    });
    const ordered = [...minutes].sort();
    return {
      unavailable: null,
      records,
      recordedMinutes: grouped ? ordered : null,
      recordedWindow: grouped
        ? {
            start: present(ordered[0]),
            end: new Date(Date.parse(present(ordered.at(-1))) + 60000).toISOString(),
          }
        : null,
    };
  } catch (error) {
    return unavailable(reason(error));
  }
}
async function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((accept, reject) => {
    const abort = () => reject(new Unavailable("transport"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        accept(value);
      },
      () => {
        signal.removeEventListener("abort", abort);
        reject(new Unavailable("transport"));
      },
    );
    if (signal.aborted) abort();
  });
}

/** Trusted parent only. Namespace metrics cover all traffic/objects/versions in
 * each namespace. Raw records/quantiles never establish exact-zero, completeness,
 * maximum usage, physical incarnation, deployment authority or a GateReceipt. */
export function createInfrastructureAnalyticsReader(input: InfrastructureAnalyticsInput): {
  read(windows: { active: UtcWindow; idle: UtcWindow }): Promise<InfrastructureAnalyticsCollection>;
} {
  const { account, accountBindingSha256, token, transport = fetch } = input;
  assert.ok(
    Object.keys(input).every((k) =>
      [
        "account",
        "accountBindingSha256",
        "token",
        "deployment",
        "namespaces",
        "transport",
      ].includes(k),
    ),
    "Unexpected analytics input",
  );
  assert.ok(
    /^[a-f0-9]{32}$/.test(account) && sha256(account) === accountBindingSha256,
    "Analytics account binding mismatch",
  );
  assert.ok(
    typeof token === "string" && token.length > 0 && token.length <= 8192 && !/[\r\n]/.test(token),
    "Analytics credential unavailable",
  );
  const deployment = structuredClone(input.deployment);
  try {
    assertDeployment(deployment);
  } catch {
    throw new Error("Analytics deployment unavailable");
  }
  assert.ok(
    deployment.backend === "free" && deployment.accountBindingSha256 === accountBindingSha256,
    "Selected Free deployment/account required",
  );
  const identity = structuredClone(input.namespaces);
  assert.ok(
    Object.keys(identity).sort().join(",") === "metadataSha256,namespaces" &&
      /^[a-f0-9]{64}$/.test(identity.metadataSha256) &&
      Array.isArray(identity.namespaces) &&
      identity.namespaces.length === 3,
    "Namespace metadata required",
  );
  const namespaces = required.map(([binding, className]) => {
    const rows = identity.namespaces.filter(
      (n) => n.binding === binding && n.className === className,
    );
    assert.ok(
      rows.length === 1 &&
        /^[a-f0-9]{32}$/.test(present(rows[0]).namespaceId) &&
        Object.keys(present(rows[0])).every((k) =>
          ["binding", "className", "namespaceId"].includes(k),
        ),
      "Exact namespace scope required",
    );
    return present(rows[0]);
  });
  assert.ok(
    new Set(namespaces.map((n) => n.namespaceId)).size === 3,
    "Distinct namespaces required",
  );
  const worker = { name: deployment.workerName, versionId: deployment.workerVersionId };
  const protect = (value: unknown) => {
    const json = JSON.stringify(value);
    for (const secret of [account, token])
      if (
        [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)].some((s) =>
          json.includes(s),
        )
      )
        fail("unsafe");
  };
  let busy = false;
  return Object.freeze({
    read: async (requested): Promise<InfrastructureAnalyticsCollection> => {
      assert.ok(!busy, "Analytics collection already active");
      const windows = structuredClone(requested),
        now = Date.now();
      assert.ok(
        Object.keys(windows).sort().join(",") === "active,idle",
        "Only active/idle windows accepted",
      );
      for (const w of Object.values(windows)) {
        assert.ok(Object.keys(w).sort().join(",") === "end,start", "Closed UTC window required");
        for (const t of [w.start, w.end])
          assert.ok(
            typeof t === "string" &&
              /^\d{4}-\d\d-\d\dT\d\d:\d\d:00(?:\.000)?Z$/.test(t) &&
              Number.isFinite(Date.parse(t)) &&
              Date.parse(t) % 60000 === 0,
            "Complete UTC minutes required",
          );
        assert.ok(
          Date.parse(w.start) < Date.parse(w.end) &&
            Date.parse(w.end) <= Math.floor(now / 60000) * 60000 &&
            Date.parse(w.end) - Date.parse(w.start) <= 86400000,
          "Bounded past window required",
        );
      }
      assert.ok(
        Date.parse(windows.active.end) <= Date.parse(windows.idle.start),
        "Disjoint ordered windows required",
      );
      busy = true;
      const total = AbortSignal.timeout(90000);
      const responseSlots: (InfrastructureAnalyticsCollection["responses"][number] | undefined)[] =
        [];
      let requests = 0,
        bytesRead = 0;
      const post = async (label: string, query: string, variables: Record<string, unknown>) => {
        const requestIndex = requests++;
        if (requests > 24 || total.aborted) fail("limit");
        const body = JSON.stringify({ query, variables });
        if (Buffer.byteLength(body) > 16000) fail("limit");
        const signal = AbortSignal.any([total, AbortSignal.timeout(10000)]);
        let response: Response;
        try {
          response = await bounded(
            transport(endpoint, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
                Accept: "application/json",
              },
              body,
              redirect: "error",
              signal,
            }),
            signal,
          );
        } catch {
          return fail("transport");
        }
        if (response.status !== 200) {
          void response.body?.cancel().catch(() => {});
          fail("http");
        }
        if (!response.headers.get("content-type")?.includes("application/json") || !response.body) {
          void response.body?.cancel().catch(() => {});
          fail("response");
        }
        const reader = response.body.getReader(),
          chunks: Uint8Array[] = [];
        let length = 0;
        try {
          for (;;) {
            const part = await bounded(reader.read(), signal);
            if (part.done) break;
            length += part.value.byteLength;
            bytesRead += part.value.byteLength;
            if (length > 2000000 || bytesRead > 16000000) fail("limit");
            chunks.push(part.value);
          }
        } catch (error) {
          void reader.cancel().catch(() => {});
          throw error;
        } finally {
          reader.releaseLock();
        }
        const bytes = Buffer.concat(chunks);
        responseSlots[requestIndex] = { request: label, sha256: sha256(bytes) };
        let envelope: Record<string, unknown>;
        try {
          envelope = object(JSON.parse(bytes.toString("utf8")));
        } catch {
          return fail("response");
        }
        if (
          envelope.errors !== undefined &&
          envelope.errors !== null &&
          (!Array.isArray(envelope.errors) || envelope.errors.length > 0)
        )
          fail("graphql");
        return object(envelope.data);
      };
      const accountData = (data: Record<string, unknown>) => {
        const rows = array(object(data.viewer).accounts, 1);
        if (rows.length !== 1) fail("response");
        const row = object(rows[0]);
        if (row.accountTag !== account) fail("response");
        return row;
      };
      let schema: Record<string, unknown> | null = null,
        settings: Record<string, unknown> | null = null;
      let schemaUnavailable: Reason | null = null,
        settingsUnavailable: Reason | null = null;
      try {
        try {
          const data = await post("schema", schemaQuery, {});
          schema = Object.fromEntries(typeNames.map((name, i) => [name, data[`t${i}`] ?? null]));
          protect(schema);
        } catch (error) {
          schema = null;
          schemaUnavailable = reason(error);
        }
        if (schema) {
          try {
            settings = object(
              accountData(await post("settings", settingsQuery, { account })).settings,
            );
            protect(settings);
          } catch (error) {
            settings = null;
            settingsUnavailable = reason(error);
          }
        } else settingsUnavailable = "schema";
        const datasets: InfrastructureDataset[] = [];
        const pending: (() => Promise<void>)[] = [];
        for (let i = 0; i < specs.length; i++) {
          const s = present(specs[i]);
          for (const namespace of s.kind === "worker" ? [null] : namespaces) {
            const bad = (r: Reason) => ({ aggregate: unavailable(r), series: unavailable(r) });
            const dataset: InfrastructureDataset = {
              kind: s.kind,
              dataset: s.node,
              namespace,
              quality: s.quality,
              units: { ...s.units },
              active: bad("schema"),
              idle: bad("schema"),
            };
            datasets.push(dataset);
            let limit: number;
            try {
              if (!schema || !settings)
                fail(schemaUnavailable ?? settingsUnavailable ?? "settings");
              limit = supported(s, schema, settings, [windows.active, windows.idle], now);
            } catch (error) {
              dataset.active = bad(reason(error));
              dataset.idle = bad(reason(error));
              continue;
            }
            for (const phase of ["active", "idle"] as const) {
              const window = windows[phase];
              pending.push(async () => {
                try {
                  const data = accountData(
                    await post(
                      `${s.kind}:${namespace?.binding ?? "worker"}:${phase}`,
                      present(queries[i]),
                      {
                        account,
                        ...(namespace
                          ? { namespace: namespace.namespaceId }
                          : { worker: worker.name, version: worker.versionId }),
                        start: window.start,
                        end: window.end,
                        limit,
                      },
                    ),
                  );
                  protect({ aggregate: data.aggregate, series: data.series });
                  dataset[phase] = {
                    aggregate: observation(
                      data.aggregate,
                      s,
                      namespace,
                      worker,
                      window,
                      limit,
                      false,
                    ),
                    series: observation(data.series, s, namespace, worker, window, limit, true),
                  };
                } catch (error) {
                  dataset[phase] = bad(reason(error));
                }
              });
            }
          }
        }
        let next = 0;
        await Promise.all(
          Array.from({ length: Math.min(3, pending.length) }, async () => {
            while (next < pending.length) {
              const task = pending[next++];
              if (task) await task();
            }
          }),
        );
        const responses = responseSlots.filter(
          (r): r is InfrastructureAnalyticsCollection["responses"][number] => r !== undefined,
        );
        const result: InfrastructureAnalyticsCollection = {
          accountBindingSha256,
          worker,
          namespaceMetadataSha256: identity.metadataSha256,
          requestedWindows: windows,
          schema,
          settings,
          schemaUnavailable,
          settingsUnavailable,
          schemaSha256: schema ? sha256(canonicalJson(schema)) : null,
          settingsSha256: settings ? sha256(canonicalJson(settings)) : null,
          responses,
          rawResponseSha256: sha256(canonicalJson(responses)),
          datasets,
          collectedAt: new Date().toISOString(),
        };
        protect(result);
        return result;
      } finally {
        busy = false;
      }
    },
  });
}
