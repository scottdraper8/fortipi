import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { cloudflareRequest } from "../../deploy-smoke.ts";
import { readInfrastructureNamespaces } from "../../live-infrastructure-identity.ts";
import type { DeploymentIdentity } from "../../verify-release-gates.ts";
import { httpFixture } from "./fixtures.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const account = "a".repeat(32);
const deployment: DeploymentIdentity = {
  schemaVersion: 1,
  candidateSha256: digest("candidate"),
  sourceCommit: "a".repeat(40),
  accountBindingSha256: digest(account),
  slot: "production",
  workerName: "infrastructure-fixture",
  origin: "https://infrastructure-fixture.example.workers.dev",
  workerVersionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  deploymentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  versions: [{ versionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", percentage: 100 }],
  configSha256: digest("config"),
  runtimeConfigSha256: digest("runtime"),
  assetManifestSha256: digest("assets"),
  publicConfigurationVersion: 1,
  capabilities: { plan: "free", loaders: false, containers: false },
  backend: "free",
  imageDigest: null,
  checkedAt: new Date().toISOString(),
};
const expected = [
  { binding: "CONTROL_PLANE", className: "ControlPlane", namespaceId: "1".repeat(32) },
  { binding: "AGENT_SESSIONS", className: "AgentSession", namespaceId: "2".repeat(32) },
  { binding: "WORKSPACES", className: "WorkspaceObject", namespaceId: "3".repeat(32) },
];
function first<T>(values: T[]): T {
  const value = values[0];
  assert.ok(value !== undefined);
  return value;
}
function fixture() {
  return {
    version: {
      id: deployment.workerVersionId,
      resources: {
        script_runtime: {
          exports: Object.fromEntries(
            expected.map((row) => [row.className, { type: "durable-object", storage: "sqlite" }]),
          ),
        },
        bindings: expected.map((row) => ({
          name: row.binding,
          type: "durable_object_namespace",
          class_name: row.className,
          namespace_id: row.namespaceId,
        })),
      },
    },
    inventory: expected.map((row) => ({
      id: row.namespaceId,
      script: deployment.workerName,
      class: row.className,
      use_sqlite: true,
    })),
  };
}

test("namespace attribution uses the actual version and account-bound GETs, including control-plane storage", async () => {
  const data = fixture();
  const seen: string[] = [];
  const versionPath = `/workers/scripts/${deployment.workerName}/versions/${deployment.workerVersionId}`;
  const inventoryPath = "/workers/durable_objects/namespaces?page=1&per_page=1000";
  const server = await httpFixture((request, response) => {
    assert.equal(request.method, "GET");
    assert.equal(request.headers.authorization, "Bearer synthetic-namespace-read-only");
    seen.push(request.url ?? "");
    response.setHeader("content-type", "application/json");
    assert.ok(
      [versionPath, inventoryPath].some(
        (path) => request.url === `/client/v4/accounts/${account}${path}`,
      ),
    );
    response.end(
      JSON.stringify({
        success: true,
        result: request.url?.endsWith(versionPath) ? data.version : data.inventory,
      }),
    );
  });
  try {
    const read = cloudflareRequest(
      account,
      digest(account),
      "synthetic-namespace-read-only",
      server.transport,
    );
    const result = await readInfrastructureNamespaces(deployment, read);
    assert.deepEqual(result.namespaces, expected);
    assert.deepEqual(Object.keys(result).sort(), ["metadataSha256", "namespaces"]);
    assert.match(result.metadataSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(
      seen,
      [versionPath, inventoryPath].map((path) => `/client/v4/accounts/${account}${path}`),
    );
    // A supplied binding ID disambiguates an older namespace of the same class.
    data.inventory.push({ ...first(data.inventory), id: "4".repeat(32) });
    const changed = await readInfrastructureNamespaces(deployment, read);
    assert.deepEqual(changed.namespaces, expected);
    assert.notEqual(changed.metadataSha256, result.metadataSha256);
    data.inventory.pop(); // The full first page has only one apparent match per class.
    for (const binding of data.version.resources.bindings)
      Reflect.deleteProperty(binding, "namespace_id");
    while (data.inventory.length < 1000)
      data.inventory.push({
        id: data.inventory.length.toString(16).padStart(32, "0"),
        script: "unrelated-worker",
        class: "Other",
        use_sqlite: true,
      });
    await assert.rejects(
      readInfrastructureNamespaces(deployment, read),
      /inventory/,
      "A full result-only page cannot establish a unique namespace join",
    );
    data.inventory.pop();
    assert.deepEqual((await readInfrastructureNamespaces(deployment, read)).namespaces, expected);
  } finally {
    await server.close();
  }
});

test("missing, foreign, ambiguous or non-SQLite provider identities cannot become namespace or object attribution", async () => {
  type Data = ReturnType<typeof fixture>;
  const faults: ((data: Data) => void)[] = [
    (data) => {
      data.version.id = deployment.deploymentId;
    },
    (data) => {
      data.version.resources.bindings.pop();
    },
    (data) => {
      data.version.resources.bindings.push({ ...first(data.version.resources.bindings) });
    },
    (data) => {
      first(data.version.resources.bindings).class_name = "WorkspaceObject";
    },
    (data) => {
      first(data.version.resources.bindings).namespace_id = "4".repeat(32);
    },
    (data) => {
      first(data.inventory).script = "foreign-worker";
    },
    (data) => {
      first(data.inventory).class = "WorkspaceObject";
    },
    (data) => {
      first(data.inventory).use_sqlite = false;
    },
    (data) => {
      data.inventory.pop();
    },
    (data) => {
      const definition = data.version.resources.script_runtime.exports.ControlPlane;
      assert.ok(definition);
      definition.storage = "kv";
    },
  ];
  for (const fault of faults) {
    const data = fixture();
    fault(data);
    await assert.rejects(
      readInfrastructureNamespaces(deployment, async (path) =>
        path.includes("/versions/") ? data.version : data.inventory,
      ),
    );
  }
  const data = fixture();
  for (const binding of data.version.resources.bindings)
    Reflect.deleteProperty(binding, "namespace_id");
  const read = async (path: string) =>
    path.includes("/versions/") ? data.version : data.inventory;
  assert.deepEqual((await readInfrastructureNamespaces(deployment, read)).namespaces, expected);
  data.inventory.push({ ...first(data.inventory), id: "4".repeat(32) });
  await assert.rejects(readInfrastructureNamespaces(deployment, read), /ambiguous/);
  let reads = 0;
  await assert.rejects(
    readInfrastructureNamespaces({ ...deployment, sourceCommit: "invalid" }, async () => {
      reads++;
    }),
  );
  assert.equal(reads, 0, "Invalid deployment data must fail before any metadata request");
});
