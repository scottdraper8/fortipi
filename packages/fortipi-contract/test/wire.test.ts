import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { build } from "esbuild";
import { errorStatuses, routeCatalog, schemaRefs, schemaRegistry } from "../dist/index.js";
import { validators } from "./fixtures/wire.ts";

const expected = [
  "GET /health",
  "GET /v1/protocol",
  "GET /v1/openapi.json",
  "GET /v1/schemas/{name}",
  "GET /v1/agents",
  "POST /v1/agents",
  "GET /v1/agents/{agentId}",
  "PATCH /v1/agents/{agentId}",
  "GET /v1/agents/{agentId}/conversations",
  "POST /v1/agents/{agentId}/conversations",
  "GET /v1/conversations/{id}",
  "POST /v1/conversations/{id}/messages",
  "POST /v1/conversations/{id}/steer",
  "POST /v1/conversations/{id}/fork",
  "GET /v1/conversations/{id}/events",
  "GET /v1/tasks/{id}",
  "POST /v1/tasks/{id}/cancel",
  "POST /v1/tasks/{id}/resume",
  "GET /v1/approvals/{id}",
  "POST /v1/approvals/{id}/decisions",
  "GET /v1/jobs/{id}",
  "POST /v1/jobs/{id}/reconcile",
  "GET /v1/executors",
  "GET /v1/workspaces",
  "POST /v1/workspaces",
  "GET /v1/workspaces/{workspaceId}",
  "PATCH /v1/workspaces/{workspaceId}",
  ...["manifest", "list", "stat", "read", "diff"].map(
    (p) => `GET /v1/workspaces/{workspaceId}/${p}`,
  ),
  "POST /v1/workspaces/{workspaceId}/snapshots",
  "GET /v1/workspaces/{workspaceId}/blobs/{sha256}",
  "GET /v1/workspaces/{workspaceId}/artifacts/{artifactId}",
  "POST /v1/workspaces/{workspaceId}/uploads",
  "GET /v1/workspaces/{workspaceId}/uploads/{uploadId}",
  "DELETE /v1/workspaces/{workspaceId}/uploads/{uploadId}",
  "PUT /v1/workspaces/{workspaceId}/uploads/{uploadId}/blobs/{sha256}/chunks/{chunkIndex}",
  "POST /v1/workspaces/{workspaceId}/uploads/{uploadId}/validate",
  "POST /v1/workspaces/{workspaceId}/uploads/{uploadId}/commit",
  "GET /v1/workspaces/{workspaceId}/commits/{commitId}",
  "POST /v1/workspaces/{workspaceId}/transactions",
  "POST /v1/connections/tickets",
  "GET /v1/stream",
  "GET /v1/executor/session",
  "GET /v1/executor/transfers/{transferId}/input/chunks/{chunkIndex}",
  "PUT /v1/executor/transfers/{transferId}/output/chunks/{chunkIndex}",
  "GET /v1/executor/transfers/{transferId}",
  "POST /v1/admin/credentials",
  "POST /v1/admin/credentials/{id}/revoke",
  "POST /v1/admin/credentials/{id}/rotate",
  "POST /v1/admin/executors/{id}/revoke",
  ...["configuration", "models", "health", "usage", "audit"].map((p) => `GET /v1/admin/${p}`),
  "PATCH /v1/admin/configuration",
  "POST /v1/admin/exports",
  "POST /v1/admin/backups",
  "GET /v1/admin/operations/{id}",
  "GET /v1/admin/artifacts/{id}",
  ...["GET", "PUT", "DELETE"].map((m) => `${m} /v1/admin/models/{providerId}/auth`),
];
test("full independently enumerated route surface and resolvable schema/OpenAPI refs", () => {
  assert.deepEqual(routeCatalog.map((r) => `${r.method} ${r.path}`).sort(), expected.sort());
  assert.equal(new Set(routeCatalog.map((r) => r.operationId)).size, expected.length);
  const spec = JSON.parse(readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8"));
  assert.equal(spec.openapi, "3.1.0");
  const { get, ajv } = validators();
  for (const route of routeCatalog) {
    const op = spec.paths[route.path][route.method.toLowerCase()];
    assert.equal(op.operationId, route.operationId);
    get(route.query);
    if (route.body) get(route.body);
    if (route.response) get(route.response);
    const schemas = "successSchemas" in route ? route.successSchemas : undefined;
    for (const status of route.success) {
      const name = schemas?.[status as 200 | 202] ?? route.response;
      if (name)
        assert.equal(
          op.responses[status].content["application/json"].schema.$ref,
          schemaRefs[name as keyof typeof schemaRefs],
        );
    }
    assert.deepEqual(
      Object.keys(op.responses).map(Number).sort(),
      [...new Set([...route.success, ...route.errors.map((e) => errorStatuses[e])])].sort(),
    );
    if (route.audience !== "public") assert.ok(op.security.length);
    if (
      route.path.includes("/auth") ||
      route.path.includes("/credentials") ||
      route.path.includes("/transfers/")
    )
      for (const response of Object.values(op.responses) as {
        headers: Record<string, { schema: { const?: string } }>;
      }[])
        assert.equal(response.headers["Cache-Control"]?.schema.const, "no-store");
  }
  const refs = new Set(Object.values(schemaRefs));
  function walk(v: unknown) {
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (v && typeof v === "object") {
      for (const [k, item] of Object.entries(v)) {
        if (k === "$ref")
          assert.ok(refs.has(item as (typeof schemaRefs)[keyof typeof schemaRefs]), String(item));
        else walk(item);
      }
    }
  }
  walk(spec);
  walk(schemaRegistry);
  const errorSchema =
    spec.paths["/v1/agents"].get.responses["401"].content["application/json"].schema;
  const error = ajv.compile(errorSchema);
  assert.equal(
    error({
      error: {
        code: "unauthenticated",
        message: "sign in",
        requestId: "request_1",
        retryable: false,
      },
    }),
    true,
  );
  assert.equal(
    error({
      error: { code: "not_found", message: "not found", requestId: "request_1", retryable: false },
    }),
    false,
  );
  assert.equal(Object.keys(schemaRegistry).length, 15);
  // Follow only definitions actually used by HTTP and executor messages, not unused private schema definitions.
  const forbidden = new Set(["childId", "authorityId", "allocationId"]);
  const visited = new Set<string>();
  function publicShape(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(publicShape);
      return;
    }
    if (!value || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    if (typeof object.$ref === "string") {
      if (visited.has(object.$ref)) return;
      visited.add(object.$ref);
      const [id, name] = object.$ref.split("#/$defs/");
      const schema = Object.values(schemaRegistry).find((s) => s.$id === id);
      assert.ok(schema && name);
      publicShape((schema.$defs as Record<string, unknown>)[name]);
    }
    if (object.properties)
      for (const key of Object.keys(object.properties))
        assert.equal(forbidden.has(key), false, `Public schema exposes internal ${key}`);
    Object.values(object).forEach(publicShape);
  }
  for (const route of routeCatalog)
    for (const name of [route.body, route.response])
      if (name) publicShape({ $ref: schemaRefs[name as keyof typeof schemaRefs] });
  publicShape({ $ref: schemaRefs.ExecutorFrame });
});
test("semantic status matrix keeps cursor/range/quota errors at their actual routes", () => {
  const get = (id: string) => {
    const r = routeCatalog.find((r) => r.operationId === id);
    assert.ok(r);
    return r;
  };
  assert.ok(get("replayEvents").errors.some((e) => e === "cursor.expired"));
  assert.equal(errorStatuses["cursor.expired"], 410);
  assert.equal(
    get("listAgents").errors.some((e) => e === "cursor.expired"),
    false,
  );
  assert.equal(errorStatuses["workspace.conflict"], 409);
  assert.equal(errorStatuses.quota_exceeded, 429);
  assert.equal(errorStatuses.quota_paused, 503);
  assert.ok(get("resumeTask").errors.some((e) => e === "unsupported"));
  for (const id of ["getClientStream", "getExecutorSession"])
    assert.deepEqual(get(id).success, [101]);
  for (const id of ["readWorkspaceFile", "getWorkspaceBlob", "getWorkspaceArtifact"]) {
    assert.deepEqual(get(id).success, [200, 206]);
    assert.ok(get(id).errors.some((e) => e === "range_not_satisfiable"));
    assert.equal(get(id).response, null);
  }
  for (const id of [
    "getExecutorTransferInputChunk",
    "putExecutorTransferOutputChunk",
    "getExecutorTransfer",
  ])
    assert.equal(get(id).audience, "executor");
  assert.equal(get("putProviderAuth").body, "ProviderAuthPut");
  assert.equal(get("getProviderAuthStatus").response, "ProviderAuthStatus");
  const spec = JSON.parse(readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8"));
  for (const id of ["putUploadChunk", "putExecutorTransferOutputChunk"]) {
    const r = get(id);
    assert.ok(spec.paths[r.path].put.requestBody.content["application/octet-stream"]);
  }
  for (const id of [
    "readWorkspaceFile",
    "getWorkspaceBlob",
    "getWorkspaceArtifact",
    "getAdminArtifact",
    "getExecutorTransferInputChunk",
  ]) {
    const r = get(id),
      op = spec.paths[r.path].get;
    assert.ok(op.responses[200].headers["Content-Length"]);
    assert.ok(op.responses[200].headers["X-Content-SHA256"]);
    if (op.responses[206]) assert.ok(op.responses[206].headers["Content-Range"]);
  }
  const relay = get("getExecutorTransferInputChunk");
  assert.equal(
    spec.paths[relay.path].get.parameters.some((p: { name: string }) => p.name === "Range"),
    false,
  );
  const read = get("readWorkspaceFile");
  assert.equal(
    spec.paths[read.path].get.parameters.find((p: { name: string }) => p.name === "range").style,
    "deepObject",
  );
});
test("browser bundles are portable and executor exports have no client commands", async () => {
  for (const name of ["index", "client", "executor"]) {
    const result = await build({
      stdin: {
        contents: `export * from "fortipi-contract${name === "index" ? "" : `/${name}`}";`,
        resolveDir: new URL("..", import.meta.url).pathname,
      },
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
      metafile: true,
    });
    const inputs = Object.keys(result.metafile?.inputs ?? {});
    assert.equal(
      inputs.some((p) => p.includes("node_modules") || p.includes("apps/worker")),
      false,
    );
    const module = await import(`../dist/${name}.js`);
    assert.equal("Ajv2020" in module, false);
    if (name === "executor") {
      assert.equal(
        result.outputFiles.some((file) => file.text.includes("message.submit")),
        false,
      );
      assert.equal("clientCommandsSchema" in module, false);
      assert.equal("routeCatalog" in module, false);
      assert.equal("client-commands.schema.json" in module.executorSchemaRegistry, false);
      const { Ajv2020 } = await import("ajv/dist/2020.js");
      const ajv = new Ajv2020({ strict: true, validateFormats: false });
      for (const schema of Object.values(module.executorSchemaRegistry))
        ajv.addSchema(schema as import("ajv").AnySchema);
      assert.ok(ajv.getSchema("https://fortipi.dev/schemas/1.0.0/executor-messages.schema.json"));
    }
  }
  for (const file of readdirSync(new URL("../src/", import.meta.url)).filter((f) =>
    f.endsWith(".ts"),
  )) {
    const s = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    assert.equal(/from\s+["'](?:node:|@cloudflare|@earendil|ajv|.*worker)/.test(s), false);
  }
});
