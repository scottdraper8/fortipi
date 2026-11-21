import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { mock } from "node:test";
import {
  createInfrastructureAnalyticsReader,
  type InfrastructureAnalyticsInput,
  type UtcWindow,
} from "../../live-infrastructure-provider.ts";
import { canonicalJson } from "../../verify-release-gates.ts";
import { httpFixture } from "./fixtures.ts";

const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const account = "a".repeat(32),
  token = 'synthetic-analytics-"credential\\only';
const versionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
function inputs(): InfrastructureAnalyticsInput {
  return {
    account,
    accountBindingSha256: hash(account),
    token,
    deployment: {
      schemaVersion: 1,
      candidateSha256: hash("candidate"),
      sourceCommit: "c".repeat(40),
      accountBindingSha256: hash(account),
      slot: "production",
      workerName: "analytics-fixture",
      origin: "https://analytics-fixture.example.workers.dev",
      workerVersionId: versionId,
      deploymentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      versions: [{ versionId, percentage: 100 }],
      configSha256: hash("config"),
      runtimeConfigSha256: hash("runtime"),
      assetManifestSha256: hash("assets"),
      publicConfigurationVersion: 1,
      capabilities: { plan: "free", loaders: false, containers: false },
      backend: "free",
      imageDigest: null,
      checkedAt: new Date().toISOString(),
    },
    namespaces: {
      metadataSha256: hash("authenticated namespace metadata"),
      namespaces: [
        { binding: "CONTROL_PLANE", className: "ControlPlane", namespaceId: "1".repeat(32) },
        { binding: "AGENT_SESSIONS", className: "AgentSession", namespaceId: "2".repeat(32) },
        { binding: "WORKSPACES", className: "WorkspaceObject", namespaceId: "3".repeat(32) },
      ],
    },
  };
}
function windows() {
  const base = Math.floor(Date.now() / 60000) * 60000 - 3600000;
  const window = (offset: number): UtcWindow => ({
    start: new Date(base + offset).toISOString(),
    end: new Date(base + offset + 120000).toISOString(),
  });
  return { active: window(0), idle: window(180000) };
}
type Json = Record<string, unknown>;
type Ref = { kind: string; name: string | null; ofType?: Ref };
function present<T>(value: T | undefined): T {
  assert.ok(value !== undefined);
  return value;
}
const ref = (name: string, kind = "SCALAR"): Ref => ({ kind, name });
const list = (name: string, kind = "OBJECT"): Ref => ({
  kind: "LIST",
  name: null,
  ofType: ref(name, kind),
});
const field = (name: string, type: Ref, args: Json[] = []) => ({
  name,
  type,
  args,
  description: "Synthetic current-schema protocol fixture; no provider acceptance",
  isDeprecated: false,
});
// Primary schema contract, independently expressed from the public snapshot's
// Account* fields; memory is added from current DO documentation, not old omission.
function discovery() {
  const schema: Record<string, Json> = {};
  const type = (name: string, fields: ReturnType<typeof field>[], input = false) => {
    schema[name] = {
      name,
      kind: input ? "INPUT_OBJECT" : "OBJECT",
      fields: input ? null : fields,
      inputFields: input ? fields : null,
    };
  };
  const worker = "AccountWorkersInvocationsAdaptive";
  const invoke = "AccountDurableObjectsInvocationsAdaptiveGroups";
  const periodic = "AccountDurableObjectsPeriodicGroups";
  const definitions = [
    [
      worker,
      {
        Sum: { requests: "uint64", errors: "uint64", cpuTimeUs: "uint64" },
        Avg: { sampleInterval: "float64" },
        Quantiles: { cpuTimeP99: "float64" },
        Dimensions: {
          scriptName: "string",
          scriptVersion: "string",
          status: "string",
          datetimeMinute: "Time",
        },
      },
    ],
    [
      invoke,
      {
        Sum: { requests: "uint64", errors: "uint64" },
        Avg: { sampleInterval: "float64" },
        Dimensions: { namespaceId: "string", status: "string", datetimeMinute: "Time" },
      },
    ],
    [
      periodic,
      {
        Sum: {
          rowsRead: "uint64",
          rowsWritten: "uint64",
          cpuTime: "uint64",
          exceededCpuErrors: "uint64",
          exceededMemoryErrors: "uint64",
          fatalInternalErrors: "uint64",
        },
        Quantiles: { memoryUsageBytesP99: "uint64" },
        Dimensions: { namespaceId: "string", datetimeMinute: "Time" },
      },
    ],
  ] as const;
  for (const [name, groups] of definitions) {
    type(
      name,
      Object.keys(groups).map((g) =>
        field(g.charAt(0).toLowerCase() + g.slice(1), ref(name + g, "OBJECT")),
      ),
    );
    for (const [group, fields] of Object.entries(groups))
      type(
        name + group,
        Object.entries(fields).map(([f, scalar]) => {
          assert.equal(typeof scalar, "string");
          return field(f, ref(String(scalar)));
        }),
      );
    const date = name === periodic ? "datetimeMinute" : "datetime";
    type(
      `${name}Filter_InputObject`,
      [
        ...["_geq", "_lt"].map((s) => field(date + s, ref("Time"))),
        ...(name === worker ? ["scriptName", "scriptVersion"] : ["namespaceId"]).map((f) =>
          field(f, ref("string")),
        ),
      ],
      true,
    );
  }
  const nodes = [
    "workersInvocationsAdaptive",
    "durableObjectsInvocationsAdaptiveGroups",
    "durableObjectsPeriodicGroups",
  ];
  type("account", [
    field("accountTag", ref("string")),
    ...nodes.map((n, i) =>
      field(n, list(present(definitions[i])[0]), [
        { name: "limit", type: ref("uint64") },
        {
          name: "filter",
          type: ref(`${present(definitions[i])[0]}Filter_InputObject`, "INPUT_OBJECT"),
        },
      ]),
    ),
  ]);
  type(
    "AccountSettings",
    nodes.map((n) => field(n, ref("Settings", "OBJECT"))),
  );
  type("Settings", [
    field("enabled", ref("bool")),
    field("availableFields", list("string", "SCALAR")),
    ...["maxPageSize", "maxDuration", "notOlderThan", "maxNumberOfFields"].map((n) =>
      field(n, ref("int64")),
    ),
  ]);
  const available = (name: string) =>
    Object.entries(present(definitions.find(([n]) => n === name))[1]).flatMap(([g, fs]) =>
      Object.keys(fs).map((f) => `${g.charAt(0).toLowerCase()}${g.slice(1)}_${f}`),
    );
  const settings = Object.fromEntries(
    nodes.map((n, i) => [
      n,
      {
        enabled: true,
        availableFields: available(present(definitions[i])[0]),
        maxPageSize: 20,
        maxDuration: 3600,
        notOlderThan: 86400,
        maxNumberOfFields: 40,
      },
    ]),
  );
  return { schema, settings };
}
type Discovery = ReturnType<typeof discovery>;
type RequestData = { query: string; variables: Json };
async function protocol(
  change?: (d: Discovery) => void,
  responseChange?: (r: Json, q: RequestData) => Json,
) {
  const data = discovery();
  change?.(data);
  const seen: RequestData[] = [],
    responseHashes: string[] = [];
  const expected = inputs();
  const expectedWorkerName = expected.deployment.workerName;
  const clock = windows();
  const server = await httpFixture(async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/client/v4/graphql");
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    const chunks: Buffer[] = [];
    for await (const b of request) chunks.push(b);
    const q = JSON.parse(Buffer.concat(chunks).toString()) as RequestData;
    seen.push(q);
    assert.match(q.query, /^query FortiPiInfrastructure/);
    assert.ok(!q.query.includes(token) && !q.query.includes(account));
    let result: Json;
    if (q.query.startsWith("query FortiPiInfrastructureSchema")) {
      const selected = [...q.query.matchAll(/(t\d+): __type\(name: "([A-Za-z0-9_]+)"\)/g)];
      assert.ok(selected.length > 0 && selected.length < 32);
      result = {
        data: Object.fromEntries(
          selected.map(([, alias, name]) => [present(alias), data.schema[present(name)] ?? null]),
        ),
      };
    } else {
      assert.equal(q.variables.account, account);
      assert.match(q.query, /\$account: string!/);
      let values: Json;
      if (q.query.startsWith("query FortiPiInfrastructureSettings"))
        values = { settings: data.settings };
      else {
        assert.match(q.query, /\$limit: uint64!/);
        assert.match(q.query, /\$start: Time!/);
        assert.ok(Number(q.variables.limit) >= 2 && Number(q.variables.limit) <= 20);
        const operation = q.query.match(/^query FortiPiInfrastructure(\w+)/)?.[1];
        const idle = q.variables.start === clock.idle.start;
        assert.equal(q.variables.start, idle ? clock.idle.start : clock.active.start);
        assert.equal(q.variables.end, idle ? clock.idle.end : clock.active.end);
        const dimensions: Json = { datetimeMinute: q.variables.start };
        let metrics: Json;
        if (operation === "worker") {
          assert.equal(q.variables.worker, expectedWorkerName);
          assert.equal(q.variables.version, versionId);
          assert.match(q.query, /scriptVersion: \$version/);
          metrics = {
            sum: {
              requests: idle ? 0 : 2,
              errors: 0,
              ...(q.query.includes("cpuTimeUs") ? { cpuTimeUs: 1234 } : {}),
            },
            avg: { sampleInterval: 2.5 },
            ...(q.query.includes("cpuTimeP99") ? { quantiles: { cpuTimeP99: 800.5 } } : {}),
          };
          Object.assign(dimensions, {
            scriptName: expectedWorkerName,
            scriptVersion: versionId,
            status: "newProviderOutcome",
          });
        } else {
          assert.ok(
            expected.namespaces.namespaces.some((n) => n.namespaceId === q.variables.namespace),
          );
          assert.match(q.query, /namespaceId: \$namespace/);
          dimensions.namespaceId = q.variables.namespace;
          if (operation === "invocations") {
            metrics = { sum: { requests: idle ? 0 : 2, errors: 0 }, avg: { sampleInterval: 1.5 } };
            dimensions.status = "ok";
          } else if (operation === "periodic")
            metrics = {
              sum: {
                rowsRead: 7,
                rowsWritten: idle ? 0 : Number(String(q.variables.namespace)[0]),
                ...(/\bcpuTime\b/.test(q.query) ? { cpuTime: 9001 } : {}),
                exceededCpuErrors: 0,
                exceededMemoryErrors: 0,
                fatalInternalErrors: 0,
              },
            };
          else {
            assert.equal(operation, "memory");
            metrics = { quantiles: { memoryUsageBytesP99: 123456 } };
          }
        }
        assert.match(
          q.query,
          operation === "periodic" || operation === "memory"
            ? /datetimeMinute_geq: \$start/
            : /datetime_geq: \$start/,
        );
        assert.ok(!q.query.includes("objectId"));
        // Explicit zero aggregate survives; an absent idle series is not zero.
        values = { aggregate: [metrics], series: idle ? [] : [{ ...metrics, dimensions }] };
      }
      result = {
        data: { viewer: { accounts: [{ accountTag: account, ...values }] } },
        errors: null,
      };
    }
    result = responseChange ? responseChange(result, q) : result;
    const body = JSON.stringify(result);
    responseHashes.push(hash(body));
    response.setHeader("content-type", "application/json");
    response.end(body);
  });
  const transport: typeof fetch = (url, options) => {
    assert.equal(String(url), "https://api.cloudflare.com/client/v4/graphql");
    assert.equal(options?.redirect, "error");
    assert.ok(options.signal);
    return server.transport(url, options);
  };
  return {
    data,
    seen,
    responseHashes,
    clock,
    input: { ...expected, transport },
    close: server.close,
  };
}

test("private loopback collector binds fixed queries/account/version/all3 namespaces and preserves raw statistics/zero-vs-absence", async () => {
  const p = await protocol();
  try {
    const reader = createInfrastructureAnalyticsReader(p.input);
    p.input.deployment.workerName = "changed-after-construction";
    const result = await reader.read(p.clock);
    assert.equal(p.seen.length, 22);
    assert.match(present(p.seen[0]).query, /InfrastructureSchema/);
    assert.match(present(p.seen[1]).query, /InfrastructureSettings/);
    assert.equal(result.datasets.length, 10);
    assert.ok(
      result.datasets.every(
        (d) => d.active.aggregate.unavailable === null && d.active.series.unavailable === null,
      ),
    );
    const worker = present(result.datasets.find((d) => d.kind === "worker"));
    assert.equal(worker.active.aggregate.records?.[0]?.sum?.cpuTimeUs, 1234);
    assert.equal(worker.active.aggregate.records?.[0]?.quantiles?.cpuTimeP99, 800.5);
    assert.equal(worker.active.aggregate.recordedWindow, null);
    assert.equal(worker.idle.aggregate.records?.[0]?.sum?.requests, 0);
    assert.equal(worker.idle.series.records, null);
    assert.equal(worker.idle.series.unavailable, "empty");
    assert.equal(worker.active.series.records?.[0]?.dimensions?.status, "newProviderOutcome");
    for (const [i, row] of result.datasets.filter((d) => d.kind === "periodic").entries())
      assert.equal(row.active.aggregate.records?.[0]?.sum?.rowsWritten, i + 1);
    for (const row of result.datasets.filter((d) => d.kind === "memory")) {
      assert.equal(row.active.aggregate.records?.[0]?.quantiles?.memoryUsageBytesP99, 123456);
      assert.equal(row.quality, "periodic-quantile");
    }
    assert.equal(result.responses.length, 22);
    for (const r of result.responses) assert.ok(p.responseHashes.includes(r.sha256));
    assert.equal(result.rawResponseSha256, hash(canonicalJson(result.responses)));
    assert.equal(result.schemaSha256, hash(canonicalJson(result.schema)));
    assert.equal(result.settingsSha256, hash(canonicalJson(result.settings)));
    const publicBytes = JSON.stringify(result);
    for (const value of [account, token, JSON.stringify(token).slice(1, -1)])
      assert.ok(!publicBytes.includes(value));
    assert.ok(!Object.hasOwn(result, "verified") && !Object.hasOwn(result, "authorized"));
    // Returned DATA must not alias the authority retained for a later read.
    const boundWorker = { ...result.worker };
    const boundNamespaces = p.input.namespaces.namespaces.map((n) => n.namespaceId);
    result.worker.name = "foreign-worker-from-prior-output";
    result.worker.versionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const returnedNamespace = present(result.datasets.find((d) => d.namespace)?.namespace);
    assert.ok(returnedNamespace);
    returnedNamespace.namespaceId = "e".repeat(32);
    const start = p.seen.length;
    const second = await reader.read(p.clock);
    const wrongTargets = p.seen
      .slice(start)
      .filter(({ variables }) =>
        variables.worker !== undefined
          ? variables.worker !== boundWorker.name || variables.version !== boundWorker.versionId
          : variables.namespace !== undefined &&
            !boundNamespaces.includes(String(variables.namespace)),
      );
    assert.equal(wrongTargets.length, 0);
    assert.equal(p.seen.length - start, 22);
    assert.deepEqual(second.worker, boundWorker);
    assert.notEqual(second.worker, result.worker);
    assert.ok(second.datasets.every((d) => d.active.aggregate.unavailable === null));
  } finally {
    await p.close();
  }
});

test("optional CPU cannot crowd out or invalidate required counters in either window", async () => {
  const cpu = new Set(["cpuTimeUs", "cpuTimeP99", "cpuTime"]);
  for (const mode of ["schema-absent", "not-listed", "wrong-type", "field-budget"] as const) {
    let unsupportedQueries = 0;
    const p = await protocol(
      (d) => {
        if (mode === "schema-absent" || mode === "wrong-type") {
          for (const definition of Object.values(d.schema)) {
            if (!Array.isArray(definition.fields)) continue;
            if (mode === "schema-absent")
              definition.fields = definition.fields.filter((f) => !cpu.has(f.name));
            else for (const f of definition.fields) if (cpu.has(f.name)) f.type = ref("string");
          }
          if (mode === "schema-absent") {
            const worker = present(d.schema.AccountWorkersInvocationsAdaptive);
            worker.fields = (worker.fields as ReturnType<typeof field>[]).filter(
              (f) => f.name !== "quantiles",
            );
            delete d.schema.AccountWorkersInvocationsAdaptiveQuantiles;
          }
        }
        for (const config of Object.values(d.settings)) {
          if (mode === "schema-absent" || mode === "not-listed")
            config.availableFields = config.availableFields.filter(
              (f) => !["sum_cpuTimeUs", "quantiles_cpuTimeP99", "sum_cpuTime"].includes(f),
            );
          config.availableFields.push("sum_notAReviewedMetric");
        }
        if (mode === "field-budget") {
          present(d.settings.workersInvocationsAdaptive).maxNumberOfFields = 7;
          present(d.settings.durableObjectsPeriodicGroups).maxNumberOfFields = 7;
        }
      },
      (response, q) => {
        assert.ok(!q.query.includes("notAReviewedMetric"));
        if (
          /^query FortiPiInfrastructure(?:worker|periodic)\(/.test(q.query) &&
          /\b(?:cpuTimeUs|cpuTimeP99|cpuTime)\b/.test(q.query)
        ) {
          unsupportedQueries++;
          return { data: null, errors: [{ message: "Unavailable optional CPU selection" }] };
        }
        return response;
      },
    );
    try {
      const result = await createInfrastructureAnalyticsReader(p.input).read(p.clock);
      assert.equal(unsupportedQueries, 0, mode);
      assert.equal(p.seen.length, 22, mode);
      assert.ok(result.datasets.every((d) => d.active.aggregate.unavailable === null));
      for (const phase of ["active", "idle"] as const) {
        const worker = present(result.datasets.find((d) => d.kind === "worker"));
        const record = present(worker[phase].aggregate.records?.[0]);
        assert.equal(record.sum?.requests, phase === "idle" ? 0 : 2);
        assert.equal(record.sum?.errors, 0);
        assert.equal(record.avg?.sampleInterval, 2.5);
        assert.equal(record.sum?.cpuTimeUs, undefined);
        assert.equal(record.quantiles, undefined);
        for (const [i, row] of result.datasets.filter((d) => d.kind === "periodic").entries()) {
          const sum = present(row[phase].aggregate.records?.[0]?.sum);
          assert.equal(sum.rowsRead, 7);
          assert.equal(sum.rowsWritten, phase === "idle" ? 0 : i + 1);
          assert.equal(sum.exceededCpuErrors, 0);
          assert.equal(sum.exceededMemoryErrors, 0);
          assert.equal(sum.fatalInternalErrors, 0);
          assert.equal(sum.cpuTime, undefined);
        }
      }
    } finally {
      await p.close();
    }
  }
});

test("current schema, entitlement and settings bounds refuse affected queries before collection", async () => {
  const scenarios: { change: (d: Discovery) => void; kind: string; reason: string }[] = [
    {
      change: (d) => {
        const config = present(d.settings.workersInvocationsAdaptive);
        config.availableFields = config.availableFields.filter((f) => f !== "avg_sampleInterval");
      },
      kind: "worker",
      reason: "field",
    },
    {
      change: (d) => {
        const config = present(d.settings.durableObjectsPeriodicGroups);
        config.availableFields = config.availableFields.filter((f) => f !== "sum_rowsWritten");
      },
      kind: "periodic",
      reason: "field",
    },
    {
      change: (d) => {
        const fields = present(d.schema.AccountDurableObjectsPeriodicGroupsSum)
          .fields as ReturnType<typeof field>[];
        present(fields.find((f) => f.name === "exceededCpuErrors")).type = ref("string");
      },
      kind: "periodic",
      reason: "schema",
    },
    {
      change: (d) => {
        present(d.settings.workersInvocationsAdaptive).enabled = false;
      },
      kind: "worker",
      reason: "disabled",
    },
    {
      change: (d) => {
        present(d.settings.workersInvocationsAdaptive).maxDuration = 60;
      },
      kind: "worker",
      reason: "window",
    },
    {
      change: (d) => {
        present(d.settings.workersInvocationsAdaptive).notOlderThan = 30;
      },
      kind: "worker",
      reason: "window",
    },
    {
      change: (d) => {
        present(d.settings.workersInvocationsAdaptive).maxNumberOfFields = 1;
      },
      kind: "worker",
      reason: "limit",
    },
    {
      change: (d) => {
        present(d.settings.workersInvocationsAdaptive).maxPageSize = 1;
      },
      kind: "worker",
      reason: "limit",
    },
    {
      change: (d) => {
        present(d.settings.durableObjectsPeriodicGroups).availableFields = present(
          d.settings.durableObjectsPeriodicGroups,
        ).availableFields.filter((f) => f !== "quantiles_memoryUsageBytesP99");
      },
      kind: "memory",
      reason: "field",
    },
    {
      change: (d) => {
        const f = present(d.schema.AccountWorkersInvocationsAdaptiveSum).fields as ReturnType<
          typeof field
        >[];
        present(f.find((f) => f.name === "requests")).type = ref("string");
      },
      kind: "worker",
      reason: "schema",
    },
  ];
  for (const s of scenarios) {
    const p = await protocol(s.change);
    try {
      const result = await createInfrastructureAnalyticsReader(p.input).read(p.clock);
      assert.ok(
        result.datasets
          .filter((d) => d.kind === s.kind)
          .every(
            (d) =>
              d.active.aggregate.unavailable === s.reason && d.idle.series.unavailable === s.reason,
          ),
      );
      assert.ok(!p.seen.some((q) => q.query.startsWith(`query FortiPiInfrastructure${s.kind}(`)));
      if (s.kind === "memory")
        assert.ok(
          result.datasets
            .filter((d) => d.kind === "periodic")
            .every((d) => d.active.aggregate.unavailable === null),
        );
    } finally {
      await p.close();
    }
  }
  let calls = 0;
  const invalid = inputs();
  invalid.transport = async () => {
    calls++;
    throw new Error(token);
  };
  assert.throws(
    () =>
      createInfrastructureAnalyticsReader({ ...invalid, accountBindingSha256: hash("foreign") }),
    /binding/,
  );
  invalid.namespaces.namespaces = invalid.namespaces.namespaces.slice(1);
  assert.throws(() => createInfrastructureAnalyticsReader(invalid), /metadata/);
  assert.equal(calls, 0);
});

test("full, absent, foreign and errored responses remain unavailable without fallback, secret output or extra reads", async () => {
  for (const mode of ["full", "null", "foreign", "graphql", "unsafe"] as const) {
    const p = await protocol(undefined, (result, q) => {
      if (!q.query.startsWith("query FortiPiInfrastructureworker(")) return result;
      if (mode === "graphql")
        return { errors: [{ message: `Bearer ${token}` }], data: result.data };
      const a = present(((result.data as Json).viewer as { accounts: Json[] }).accounts[0]);
      if (mode === "full")
        a.series = Array.from(
          { length: Number(q.variables.limit) },
          () => (a.series as unknown[])[0],
        );
      if (mode === "null") a.aggregate = null;
      if (mode === "foreign" && q.variables.start === p.clock.active.start)
        present(present((a.series as RawRows)[0]).dimensions).scriptVersion =
          "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
      if (mode === "unsafe" && q.variables.start === p.clock.active.start)
        present(present((a.series as RawRows)[0]).dimensions).status = token;
      return result;
    });
    try {
      const result = await createInfrastructureAnalyticsReader(p.input).read(p.clock);
      const worker = present(result.datasets.find((d) => d.kind === "worker"));
      if (mode === "full") {
        assert.equal(worker.active.series.unavailable, "full-page");
        assert.equal(worker.active.aggregate.unavailable, null);
      }
      if (mode === "null") assert.equal(worker.active.aggregate.unavailable, "response");
      if (mode === "foreign") assert.equal(worker.active.series.unavailable, "response");
      if (mode === "graphql") assert.equal(worker.active.aggregate.unavailable, "graphql");
      if (mode === "unsafe") assert.equal(worker.active.aggregate.unavailable, "unsafe");
      assert.equal(p.seen.length, 22, "No fallback/retry/poll after refusal");
      assert.ok(!JSON.stringify(result).includes(token));
      assert.ok(!JSON.stringify(result).includes(JSON.stringify(token).slice(1, -1)));
    } finally {
      await p.close();
    }
  }
  const rawError = await createInfrastructureAnalyticsReader({
    ...inputs(),
    transport: async () => {
      throw new Error(token);
    },
  }).read(windows());
  assert.equal(rawError.schemaUnavailable, "transport");
  assert.ok(!JSON.stringify(rawError).includes(token));
  let cancelled = 0,
    largeCalls = 0;
  const oversized = await createInfrastructureAnalyticsReader({
    ...inputs(),
    transport: async () => {
      largeCalls++;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(2000001));
          },
          cancel() {
            cancelled++;
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  }).read(windows());
  assert.equal(oversized.schemaUnavailable, "limit");
  assert.equal(largeCalls, 1);
  assert.equal(cancelled, 1);
  // Controlled deadline signal, not a real 90-second hosted timeout claim.
  const deadlines = mock.method(AbortSignal, "timeout", () => {
    const controller = new AbortController();
    queueMicrotask(() => controller.abort());
    return controller.signal;
  });
  try {
    const timed = await createInfrastructureAnalyticsReader({
      ...inputs(),
      transport: () => new Promise<Response>(() => {}),
    }).read(windows());
    assert.equal(timed.schemaUnavailable, "transport");
  } finally {
    deadlines.mock.restore();
  }
  const p = await protocol();
  try {
    const reader = createInfrastructureAnalyticsReader(p.input);
    const bad = windows();
    bad.idle.start = bad.active.start;
    await assert.rejects(reader.read(bad), /Disjoint/);
    assert.equal(p.seen.length, 0);
  } finally {
    await p.close();
  }
});
type RawRows = { dimensions?: Record<string, unknown> }[];
