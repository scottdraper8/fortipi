import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { freeInfrastructurePolicy } from "fortipi-contract";
import type * as D from "../../src/boundary/dto.js";
import type { Env } from "../../src/boundary/env.js";
import type { Directory } from "../../src/control/directory.js";
import type { Executors } from "../../src/control/executors.js";
import type { Tickets } from "../../src/control/tickets.js";
import { backendSupportsTool } from "../../src/execution/tool-arguments.ts";

await mkdir(".agent-docs/tmp", { recursive: true });
const directoryPath = await mkdtemp(resolve(".agent-docs/tmp/routing-policy-"));
after(() => rm(directoryPath, { recursive: true, force: true }));
await build({
  entryPoints: ["apps/worker/src/control/tool-context.ts", "apps/worker/src/execution/routing.ts"],
  outdir: directoryPath,
  outbase: "apps/worker/src",
  bundle: true,
  platform: "node",
  format: "esm",
  external: ["ajv", "ajv/*"],
  logLevel: "silent",
});
const { toolTopology, currentToolContext } = (await import(
  pathToFileURL(join(directoryPath, "control/tool-context.js")).href
)) as typeof import("../../src/control/tool-context.ts");
const { configuredRouting } = (await import(
  pathToFileURL(join(directoryPath, "execution/routing.js")).href
)) as typeof import("../../src/execution/routing.ts");

test("routing preserves explicit choice, prefers eligible local/cloud and refuses unreachable or incompatible alternatives", () => {
  const a: D.BackendRef = { kind: "executor", executorId: "a", generation: 1 },
    b: D.BackendRef = { kind: "backend", backendId: "b", generation: 1 };
  const eligible: D.RoutingInput["eligible"] = [a, b].map((target) => ({
    target,
    capabilities: ["shell"],
    grants: [],
    reachable: true,
    revisionCompatible: true,
    confinement: target.kind === "executor" ? "host" : "isolated",
  }));
  const select = (
    kind: D.Configuration["routing"]["kind"],
    overrides: Partial<D.RoutingInput> = {},
  ) =>
    configuredRouting.select({
      operation: { tool: "shell", capabilities: ["shell"] },
      eligible,
      preference: { kind, targetIds: ["b", "a"] },
      ...overrides,
    });
  assert.deepEqual(select("prefer-local"), { kind: "selected", target: a });
  assert.deepEqual(select("cloud"), { kind: "selected", target: b });
  assert.deepEqual(select("explicit"), { kind: "selected", target: b });
  assert.deepEqual(select("explicit", { eligible: [...eligible].reverse() }), {
    kind: "selected",
    target: b,
  });
  const tie = [
    { ...eligible[0]!, target: { kind: "executor" as const, executorId: "a", generation: 1 } },
    { ...eligible[0]!, target: { kind: "executor" as const, executorId: "B", generation: 1 } },
  ];
  assert.deepEqual(
    select("prefer-local", { preference: { kind: "prefer-local", targetIds: [] }, eligible: tie }),
    { kind: "selected", target: tie[1]!.target },
    "Tie order follows codepoints",
  );
  assert.deepEqual(select("cloud", { explicitTarget: a }), { kind: "selected", target: a });
  for (const fault of [{ reachable: false }, { revisionCompatible: false }, { capabilities: [] }]) {
    assert.equal(
      select("cloud", { eligible: eligible.map((c) => ({ ...c, ...fault })) }).kind,
      "deny",
    );
    assert.equal(
      select("prefer-local", {
        explicitTarget: a,
        eligible: eligible.map((c) => ({ ...c, ...fault })),
      }).kind,
      "deny",
    );
  }
  assert.equal(
    select("explicit", { preference: { kind: "explicit", targetIds: [] } }).kind,
    "deny",
  );
});

test("controlled topology fixture requires both current and deployed Paid capability; Free, missing binding, grants and local storage refuse cloud", () => {
  // Only gate predicates are exercised here. No Loader/container/provider is invoked.
  const policy = structuredClone(freeInfrastructurePolicy),
    scope: D.ResourceScope = {
      agentIds: ["agent"],
      conversationIds: ["conversation"],
      workspaceIds: ["workspace"],
      tools: ["javascript"],
      executorIds: [],
      backendIds: ["cloud"],
      actions: ["jobs.dispatch", "workspace.write"],
    };
  const auth = {
    role: "client",
    deploymentId: "deployment",
    grants: [{ grantId: "grant", version: 1, resources: scope }],
  } as D.AuthContext;
  const binding = {
    workspaceId: "workspace",
    bindingVersion: 1,
    config: { kind: "computer" },
  } as D.WorkspaceBinding;
  const config: D.Configuration = {
    version: 1,
    workspace: { kind: "computer" },
    routing: { kind: "cloud", targetIds: ["cloud"] },
    models: [],
    execution: {
      kind: "cloud-js",
      backendId: "cloud",
      modules: [],
      egress: [],
      onInterrupt: "fail",
    },
    infrastructure: policy,
  };
  const directory = {
    config: () => config,
    policy: () => policy,
    registeredAuthority: () => ({ recipient: { kind: "agent", id: "agent" }, resources: scope }),
    cursor: (_ctx: D.AuthContext, _view: string, token?: string) => Number(token ?? 0),
    token: (_ctx: D.AuthContext, _view: string, seq: number) => String(seq),
    store: {
      get: () => binding,
      page: (kind: string) => (kind === "binding" ? [{ value: binding }] : []),
    },
  } as unknown as Directory;
  const env = { FORTIPI_CONFIG: config, LOADER: {} } as Env;
  const count = () =>
    toolTopology(directory, {} as Executors, env, auth, {
      agentId: "agent",
      conversationId: "conversation",
      tool: "javascript",
      capabilities: ["javascript"],
    }).workspaces.length;
  assert.equal(count(), 0, "A binding alone cannot enable cloud on Free");
  policy.accountPlan = "paid";
  policy.profile = "verified";
  policy.capabilities = [
    {
      capability: "loader",
      state: "available",
      accountPlan: "paid",
      deploymentId: "deployment",
      observedAt: Date.now(),
    },
  ];
  assert.equal(count(), 1, "Positive gate control only; not actual Paid execution");
  scope.tools = ["workspace.write"];
  assert.equal(
    toolTopology(directory, {} as Executors, env, auth, {
      agentId: "agent",
      conversationId: "conversation",
      tool: "workspace.write",
      capabilities: ["workspace.write"],
    }).workspaces.length,
    0,
    "A workspace capability is not permission for JavaScript execution",
  );
  scope.tools = ["javascript"];
  assert.equal(backendSupportsTool("cloud-js", "javascript"), true);
  assert.equal(backendSupportsTool("linux", "shell"), true);
  for (const name of ["workspace.read", "workspace.write", "snapshots"]) {
    assert.equal(backendSupportsTool("cloud-js", name), false);
    assert.equal(backendSupportsTool("linux", name), false);
  }
  assert.equal(backendSupportsTool("cloud-js", "shell"), false);
  assert.equal(backendSupportsTool("linux", "javascript"), false);
  env.FORTIPI_CONFIG = { ...config, infrastructure: freeInfrastructurePolicy };
  assert.equal(count(), 0, "Saved preference cannot grant a deployment capability");
  env.FORTIPI_CONFIG = config;
  delete env.LOADER;
  assert.equal(count(), 0);
  env.LOADER = {} as WorkerLoader;
  scope.backendIds = [];
  assert.equal(count(), 0);
  scope.backendIds = ["cloud"];
  binding.config = { kind: "local", executorId: "a", rootBindingId: "root" };
  assert.equal(count(), 0);
});

// Controlled read adapters below exercise paging/concurrency/serialization only, not CF or auth acceptance.
function discoveryFixture(count: number, scoped = false) {
  const policy = structuredClone(freeInfrastructurePolicy);
  policy.profile = "verified";
  policy.accountPlan = "paid";
  policy.bounds.transferConcurrency = 2;
  policy.capabilities = [
    {
      capability: "loader",
      state: "available",
      accountPlan: "paid",
      deploymentId: "deployment",
      observedAt: Date.now(),
    },
  ];
  const bindings: D.WorkspaceBinding[] = Array.from({ length: count }, (_, index) => ({
    workspaceId: `workspace-${index + 1}`,
    bindingVersion: 1,
    revision: "base",
    manifestHash: "a".repeat(64),
    availability: "available",
    config: { kind: "computer" },
  }));
  const resources: D.ResourceScope = {
    agentIds: ["agent"],
    conversationIds: ["conversation"],
    workspaceIds: scoped ? [bindings.at(-1)!.workspaceId] : ["*"],
    executorIds: [],
    backendIds: ["cloud"],
    tools: ["javascript"],
    actions: ["jobs.dispatch", "workspace.write"],
  };
  const auth = {
    role: "client",
    deploymentId: "deployment",
    grantVersion: 1,
    grants: [{ grantId: "grant", version: 1, resources }],
    deadline: Date.now() + 30000,
  } as D.AuthContext;
  const config: D.Configuration = {
    version: 1,
    workspace: { kind: "computer" },
    execution: {
      kind: "cloud-js",
      backendId: "cloud",
      modules: [],
      egress: [],
      onInterrupt: "fail",
    },
    routing: { kind: "cloud", targetIds: ["cloud"] },
    models: [],
    infrastructure: policy,
  };
  let scans = 0,
    active = 0,
    maximum = 0;
  const gates: (() => void)[] = [];
  const directory = {
    config: () => config,
    policy: () => policy,
    identities: { current: () => {} },
    registeredAuthority: () => ({ recipient: { kind: "agent", id: "agent" }, resources }),
    cursor: (_ctx: D.AuthContext, _view: string, token?: string) => Number(token ?? 0),
    token: (_ctx: D.AuthContext, _view: string, seq: number) => String(seq),
    store: {
      get: (kind: string, key: string) =>
        kind === "binding" ? bindings.find((b) => b.workspaceId === key) : undefined,
      page: (kind: string, after: number, limit: number) => {
        if (kind !== "binding") return [];
        scans++;
        return bindings
          .map((value, index) => ({ key: value.workspaceId, value, seq: index + 1 }))
          .filter((row) => row.seq > after)
          .slice(0, limit);
      },
    },
  } as unknown as Directory;
  const env = {
    FORTIPI_CONFIG: config,
    LOADER: {},
    WORKSPACES: {
      getByName: (workspaceId: string) => ({
        fetch: async () => {
          active++;
          maximum = Math.max(maximum, active);
          await new Promise<void>((accept) => gates.push(accept));
          active--;
          return Response.json(bindings.find((b) => b.workspaceId === workspaceId));
        },
      }),
    },
  } as unknown as Env;
  const tickets = { register: () => ({ registrationId: "registration" }) } as unknown as Tickets;
  return {
    directory,
    env,
    auth,
    tickets,
    policy,
    bindings,
    gates,
    counts: () => ({ scans, active, maximum }),
  };
}

test("scoped lookup reaches the101st binding; global pages advertise continuation instead of silently omitting it", () => {
  const request: D.ToolContextRequest = {
    agentId: "agent",
    conversationId: "conversation",
    tool: "javascript",
    capabilities: ["javascript"],
  };
  const scoped = discoveryFixture(101, true);
  assert.equal(
    toolTopology(scoped.directory, {} as Executors, scoped.env, scoped.auth, request).workspaces[0]
      ?.workspaceId,
    "workspace-101",
  );
  assert.equal(
    scoped.counts().scans,
    0,
    "Finite grants use keyed lookups, irrespective of the global prefix",
  );
  const global = discoveryFixture(101),
    ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = toolTopology(global.directory, {} as Executors, global.env, global.auth, {
      ...request,
      ...(pageToken ? { pageToken } : {}),
    });
    ids.push(...page.workspaces.map((w) => w.workspaceId));
    pageToken = page.nextPageToken;
  } while (pageToken);
  assert.equal(ids.length, 101);
  assert.equal(new Set(ids).size, 101);
  assert.equal(ids.at(-1), "workspace-101");
});

test("metadata reads overlap within policy concurrency, share target contracts and enforce encoded output bytes", async () => {
  const f = discoveryFixture(4),
    request: D.ToolContextRequest = {
      agentId: "agent",
      conversationId: "conversation",
      tool: "javascript",
      capabilities: ["javascript"],
    };
  const pending = currentToolContext(
    f.directory,
    {} as Executors,
    f.tickets,
    f.env,
    f.auth,
    request,
  );
  assert.equal(f.counts().active, 2, "Independent Workspace reads must overlap");
  for (let i = 0; i < 20; i++) {
    for (const release of f.gates.splice(0)) release();
    await new Promise((accept) => setTimeout(accept, 0));
  }
  const context = await pending;
  assert.equal(f.counts().maximum, 2);
  assert.equal(context.workspaces.length, 4);
  assert.equal(context.targets.length, 1);
  assert.equal(
    (JSON.stringify(context).match(/"capabilities"/g) ?? []).length,
    1,
    "Capability descriptions are not repeated per workspace",
  );
  assert.match(context.argumentContracts["javascript-module"]!, /"source"/);
  assert.match(context.argumentContracts["javascript-module"]!, /default exported function/);
  assert.ok(
    new TextEncoder().encode(JSON.stringify(context)).length <= f.policy.bounds.inlineTailBytes,
  );
  f.policy.bounds.inlineTailBytes = 1;
  const refused = currentToolContext(
    f.directory,
    {} as Executors,
    f.tickets,
    f.env,
    f.auth,
    request,
  );
  const observed = assert.rejects(
    refused,
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "payload_too_large",
  );
  for (let i = 0; i < 20; i++) {
    for (const release of f.gates.splice(0)) release();
    await new Promise((accept) => setTimeout(accept, 0));
  }
  await observed;
});
