import assert from "node:assert/strict";
import type { CloudflareRead } from "./deploy-smoke.ts";
import {
  assertDeployment,
  canonicalJson,
  type DeploymentIdentity,
  object,
  sha256,
} from "./verify-release-gates.ts";

const bindings = [
  ["CONTROL_PLANE", "ControlPlane"],
  ["AGENT_SESSIONS", "AgentSession"],
  ["WORKSPACES", "WorkspaceObject"],
] as const;

export interface InfrastructureNamespace {
  binding: (typeof bindings)[number][0];
  className: (typeof bindings)[number][1];
  namespaceId: string;
}

/** Provider metadata only. The caller authenticates the deployment and supplies
 * its account-bound, read-only client. Logical agent/workspace names are never
 * treated as physical object IDs. No per-object attribution is inferred here. */
export async function readInfrastructureNamespaces(
  deployment: DeploymentIdentity,
  read: CloudflareRead,
): Promise<{ namespaces: InfrastructureNamespace[]; metadataSha256: string }> {
  assertDeployment(deployment);
  assert.equal(deployment.backend, "free", "Selected Free-mode target required");
  const version = object(
    await read(
      `/workers/scripts/${encodeURIComponent(deployment.workerName)}/versions/${encodeURIComponent(deployment.workerVersionId)}`,
    ),
  );
  assert.ok(version.id === deployment.workerVersionId, "Provider version mismatch");
  const resources = object(version.resources),
    runtime = object(resources.script_runtime),
    exports = object(runtime.exports);
  assert.ok(Array.isArray(resources.bindings), "Provider bindings unavailable");
  assert.ok(resources.bindings.length <= 1000, "Provider binding bound exceeded");
  const actual = resources.bindings.map(object);
  const selectedBindings = bindings.map(([binding, className]) => {
    const declared = object(exports[className]);
    assert.ok(
      declared.type === "durable-object" &&
        declared.storage === "sqlite" &&
        (declared.state === undefined || declared.state === "created"),
      "SQLite export identity unavailable",
    );
    const matches = actual.filter((row) => row.name === binding);
    assert.ok(matches.length === 1, "Required binding unavailable or duplicated");
    const selected = matches[0];
    assert.ok(selected);
    assert.ok(
      selected.type === "durable_object_namespace" &&
        selected.class_name === className &&
        (selected.script_name === undefined || selected.script_name === deployment.workerName),
      "Binding owner/class mismatch",
    );
    if (selected.namespace_id !== undefined)
      assert.ok(
        typeof selected.namespace_id === "string" && /^[a-f0-9]{32}$/.test(selected.namespace_id),
        "Provider namespace identity unavailable",
      );
    return { binding, className, selected };
  });
  const listed = await read("/workers/durable_objects/namespaces?page=1&per_page=1000");
  assert.ok(Array.isArray(listed) && listed.length <= 1000, "Namespace inventory unavailable");
  const inventory = listed.map(object);
  const namespaces = selectedBindings.map(
    ({ binding, className, selected }): InfrastructureNamespace => {
      const candidates = inventory.filter((row) =>
        selected.namespace_id === undefined
          ? row.script === deployment.workerName && row.class === className
          : row.id === selected.namespace_id,
      );
      // An omitted binding ID is usable only with one unambiguous provider join.
      // Missing/truncated/ambiguous inventories never produce a guessed ID.
      assert.ok(candidates.length === 1, "Namespace attribution unavailable or ambiguous");
      const namespace = candidates[0];
      assert.ok(namespace);
      assert.ok(
        typeof namespace.id === "string" &&
          /^[a-f0-9]{32}$/.test(namespace.id) &&
          namespace.script === deployment.workerName &&
          namespace.class === className &&
          namespace.use_sqlite === true,
        "Namespace owner/class/backend mismatch",
      );
      return { binding, className, namespaceId: namespace.id };
    },
  );
  assert.equal(new Set(namespaces.map((row) => row.namespaceId)).size, bindings.length);
  return { namespaces, metadataSha256: sha256(canonicalJson({ version, inventory: listed })) };
}
