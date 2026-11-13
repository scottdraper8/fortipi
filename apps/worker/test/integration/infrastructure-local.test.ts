import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { FortiPiClient, FortiPiError } from "../../../../packages/fortipi-client/dist/node.js";
import { freeInfrastructurePolicy } from "../../../../packages/fortipi-contract/dist/index.js";
import { object } from "../../../../scripts/verify-release-gates.ts";
import {
  observeComputerDeclaration,
  seedInfrastructureWorkspace,
} from "../../../../tests/clients/live-infrastructure-controls.ts";
import { RoleContext } from "../../../../tests/clients/roles.ts";
import type * as D from "../../src/boundary/dto.js";
import { runLocalInfrastructureDetails } from "./infrastructure-local.ts";
import { start } from "./runtime.ts";

test("LOCAL public Computer staging/history and CP retained cleanup preserve bounds, identities and possible effects", {
  timeout: 90000,
}, async () => {
  const observed = await runLocalInfrastructureDetails();
  // Numeric/hashes/public IDs only; never profile/token/request headers.
  console.log(JSON.stringify(observed));
});

test("actual default Computer declarations distinguish the pool, preserve same-workspace bytes and reject unrelated refusal or uncertain cleanup", {
  timeout: 90000,
}, async (t) => {
  const rows = [];
  // Independent LOCAL installations isolate descriptor oracles without claiming
  // extra workspace estimates fit one deployed Free installation.
  for (const resource of ["file", "snapshot", "entries"] as const) {
    const runtime = await start(),
      roles = new RoleContext(runtime.endpoint, runtime.admin);
    const request = <T>(operation: () => Promise<T>) => operation();
    let changedQuota = 0,
      changedTerminal = 0,
      corruptReason = false,
      hideTerminal = false,
      deletedPath: string | undefined;
    const transport: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      const response = await fetch(input, init);
      if (
        corruptReason &&
        method === "POST" &&
        url.pathname.endsWith("/uploads") &&
        response.status === 429
      ) {
        const body = object(await response.clone().json());
        const pressure = object(object(object(body.error).details).pressure);
        assert.equal(
          pressure.reason,
          "Workspace physical copies and unspent growth exhaust the shared pool",
        );
        pressure.reason = "Unrelated storage refusal";
        changedQuota++;
        return Response.json(body, { status: response.status });
      }
      if (hideTerminal && method === "DELETE" && /\/uploads\/[^/]+$/.test(url.pathname))
        deletedPath = url.pathname;
      if (hideTerminal && method === "GET" && url.pathname === deletedPath && response.ok) {
        const body = object(await response.clone().json());
        assert.equal(body.state, "aborted");
        body.state = "open";
        hideTerminal = false;
        changedTerminal++;
        return Response.json(body, { status: response.status });
      }
      return response;
    };
    try {
      const protocol = await runtime.api<D.Protocol>("/v1/protocol");
      const expected = structuredClone(freeInfrastructurePolicy);
      expected.bounds.requestsPerPrincipalMinute = 10000;
      expected.bounds.requestsPerInstallMinute = 10000;
      assert.deepEqual(
        protocol.body.infrastructure,
        expected,
        "LOCAL fixture changes only cadence; allocation/headroom defaults remain exact",
      );
      async function probe(delta: -1 | 0 | 1) {
        const binding = await roles.call({
          operationId: "createWorkspace",
          path: {},
          query: {},
          body: { requestId: randomUUID(), config: { kind: "computer" } },
        });
        const role = await roles.issue({
          requestId: randomUUID(),
          role: "client",
          grants: [
            {
              grantId: randomUUID(),
              version: 1,
              resources: {
                agentIds: [],
                conversationIds: [],
                workspaceIds: [binding.workspaceId],
                executorIds: [],
                backendIds: [],
                tools: [],
                actions: ["workspace.read", "workspace.write", "workspaces.read"],
              },
            },
          ],
        });
        const client = new FortiPiClient({
          endpoint: runtime.endpoint,
          credentials: async () => role.token,
          allowLoopbackHttp: true,
          fetch: transport,
        });
        const context = { client, errorType: FortiPiError, request };
        const canary = await seedInfrastructureWorkspace(context, binding);
        return { ...context, canary, resource, delta };
      }
      let snapshotProbe: Parameters<typeof observeComputerDeclaration>[0] | undefined;
      for (const delta of [-1, 0, 1] as const) {
        const input = await probe(delta);
        rows.push(await observeComputerDeclaration(input));
        if (resource === "snapshot" && delta === 0) snapshotProbe = input;
      }
      if (resource === "snapshot") {
        assert.ok(snapshotProbe);
        corruptReason = true;
        try {
          await assert.rejects(
            observeComputerDeclaration(snapshotProbe),
            /Unrelated storage refusal/,
          );
        } finally {
          corruptReason = false;
        }
        assert.equal(changedQuota, 1, "Intended actual HTTP refusal response changed");
        hideTerminal = true;
        await assert.rejects(
          observeComputerDeclaration(snapshotProbe),
          /Unknown or nonterminal upload cleanup/,
        );
        assert.equal(changedTerminal, 1, "Actual terminal-state GET changed after actual DELETE");
      }
    } finally {
      try {
        const cleanup = await roles.cleanup();
        assert.ok(cleanup.every((row) => row.state === "complete"));
      } finally {
        await runtime.dispose();
      }
    }
  }
  t.diagnostic(
    JSON.stringify({
      scope:
        "LOCAL actual SDK/workerd/Computer/SQLite on separate installations per resource; default allocation bounds,10000 fixture cadence. No single-installation scheduling, installed/live/Free-account proof",
      rows,
    }),
  );
});
