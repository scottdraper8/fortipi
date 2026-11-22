import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { createTestHarness } from "wrangler";
import type * as D from "../../src/boundary/dto.js";
import { root, workspaceConfig } from "./harness.ts";

test("private operational metadata requires the current scoped dispatch writer and exact current base", async () => {
  for (const local of [false, true]) {
    const server = createTestHarness({
      root,
      workers: [
        {
          config: {
            ...workspaceConfig(),
            main: local
              ? (process.env.FORTIPI_LOCAL_TEST_ENTRY ??
                resolve(root, "apps/worker/test/workspace/local-upload-worker.ts"))
              : workspaceConfig().main,
          },
        },
      ],
    });
    const write = { "x-test-dispatch-write": "1" };
    const rpc = async <T>(
      input: unknown,
      headers: Record<string, string> = write,
    ): Promise<D.Outcome<T>> =>
      (
        await server.fetch("/rpc", { method: "POST", headers, body: JSON.stringify(input) })
      ).json() as Promise<D.Outcome<T>>;
    try {
      await server.listen();
      const config: D.WorkspaceConfig = local
        ? { kind: "local", executorId: "executor", rootBindingId: "opaque-root" }
        : { kind: "computer" };
      const seeded = local
        ? await rpc<D.WorkspaceBinding>(
            {
              kind: "binding",
              input: {
                requestId: "metadata-local-binding",
                binding: { workspaceId: "workspace", bindingVersion: 1, config },
                expectedVersion: null,
                executor: { executorId: "executor", generation: 1 },
                import: {
                  revision: "local-base",
                  manifest: { version: 1, entries: [] },
                  acknowledgeExternalEffects: true,
                },
              },
            },
            { "x-test-bootstrap": "1" },
          )
        : await ((await server.fetch("/seed")).json() as Promise<D.Outcome<D.WorkspaceBinding>>);
      assert.ok(seeded.ok);
      const binding = seeded.value;
      const query = new URLSearchParams({
        revision: binding.revision,
        agentId: "agent",
        conversationId: "conversation",
      });
      const discoveryQuery = new URLSearchParams({
        agentId: "agent",
        conversationId: "conversation",
      }).toString();
      const read = (
        headers: Record<string, string> = write,
        suffix = query.toString(),
        method = "GET",
      ) => server.fetch(`/operational-metadata?${suffix}`, { headers, method });
      const storage = await server
        .getWorker()
        .getDurableObjectStorage("WORKSPACES", { name: "workspace" });
      const before = await storage.exec("SELECT key,value FROM fp_ws_record ORDER BY key");
      const response = await read();
      assert.equal(
        response.status,
        200,
        "Dispatch writer could not obtain actual operational metadata",
      );
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      const metadata = (await response.json()) as D.WorkspaceBinding;
      assert.deepEqual(metadata, binding);
      assert.deepEqual(Object.keys(metadata).sort(), [
        "availability",
        "bindingVersion",
        "config",
        "manifestHash",
        "revision",
        "workspaceId",
      ]);
      assert.deepEqual(metadata.config, config);
      const discovery = await read(write, discoveryQuery);
      assert.equal(discovery.status, 200, "Scoped discovery may omit the expected revision");
      assert.equal(discovery.headers.get("Cache-Control"), "no-store");
      assert.deepEqual(await discovery.json(), binding);
      assert.deepEqual(
        await storage.exec("SELECT key,value FROM fp_ws_record ORDER BY key"),
        before,
        "Operational metadata changed workspace state",
      );
      for (const suffix of [query.toString(), discoveryQuery]) {
        assert.equal(
          (await read({ "x-test-write-only": "1" }, suffix)).status,
          403,
          "Workspace write alone exposed operational metadata",
        );
        for (const headers of [
          { "x-test-dispatch-only": "1" },
          { "x-test-read-only": "1" },
          { ...write, "x-test-split-actions": "1" },
          { ...write, "x-test-split-scope": "1" },
          { ...write, "x-test-other-agent": "1" },
          { ...write, "x-test-other-conversation": "1" },
          { ...write, "x-test-unregistered": "1" },
          { ...write, "x-test-no-context": "1" },
        ])
          assert.equal(
            (await read(headers, suffix)).status,
            403,
            "Operational metadata escaped its current authority scope",
          );
        assert.equal((await read({ ...write, "x-test-expired": "1" }, suffix)).status, 401);
      }
      assert.equal((await read(write, query.toString(), "POST")).status, 400);
      for (const suffix of [
        `${query}&revision=other-base`,
        `${query}&extra=1`,
        "conversationId=conversation",
        "agentId=agent",
        `${discoveryQuery}&revision=`,
        `${query}&agentId=other`,
        new URLSearchParams({
          revision: binding.revision,
          agentId: "bad/agent",
          conversationId: "conversation",
        }).toString(),
      ]) {
        const result = await read(write, suffix);
        assert.ok(
          result.status === 400 || result.status === 409,
          "Operational metadata promoted an incorrect base or malformed query",
        );
        await result.body?.cancel();
      }
      const wrongBase = await read(
        write,
        new URLSearchParams({
          revision: "other-base",
          agentId: "agent",
          conversationId: "conversation",
        }).toString(),
      );
      assert.equal(
        wrongBase.status,
        409,
        "Operational metadata accepted a different expected base",
      );
      for (const input of [
        {
          kind: "describe",
          input: {
            operationId: "describeWorkspace",
            path: { workspaceId: "workspace" },
            query: {},
          },
        },
        {
          kind: "manifest",
          input: {
            operationId: "getWorkspaceManifest",
            path: { workspaceId: "workspace" },
            query: { revision: binding.revision },
          },
        },
      ])
        assert.equal(
          (await rpc(input)).ok,
          false,
          "Operational metadata grant widened a public read",
        );
      const invalidated = await rpc({
        kind: "invalidate",
        input: {
          revocationId: "metadata-credential-floor",
          subject: { kind: "credential", credentialId: "credential", minimumGeneration: 2 },
        },
      });
      assert.ok(invalidated.ok);
      assert.equal((await read()).status, 403, "Revoked actor received operational metadata");
      assert.equal((await read(write, discoveryQuery)).status, 403);
      const recovery = await read({ ...write, "x-test-recovery": "1" });
      assert.equal(recovery.status, 200);
      assert.deepEqual(await recovery.json(), binding);
      const rebound = await rpc<D.WorkspaceBinding>(
        {
          kind: "binding",
          input: {
            requestId: "metadata-rebind",
            binding: { workspaceId: "workspace", bindingVersion: 2, config },
            expectedVersion: 1,
            ...(local ? { executor: { executorId: "executor", generation: 1 } } : {}),
            import: {
              revision: "new-base",
              manifest: { version: 1, entries: [] },
              acknowledgeExternalEffects: true,
            },
          },
        },
        { "x-test-bootstrap": "1", "x-test-recovery": "1" },
      );
      assert.ok(rebound.ok);
      assert.equal(
        (await read({ ...write, "x-test-recovery": "1" })).status,
        409,
        "Historical base became current operational metadata",
      );
      const currentQuery = new URLSearchParams({
        revision: rebound.value.revision,
        agentId: "agent",
        conversationId: "conversation",
      }).toString();
      const current = await read({ ...write, "x-test-recovery": "1" }, currentQuery);
      assert.equal(current.status, 200);
      assert.deepEqual(await current.json(), rebound.value);
      const discoveredCurrent = await read({ ...write, "x-test-recovery": "1" }, discoveryQuery);
      assert.equal(discoveredCurrent.status, 200);
      assert.deepEqual(
        await discoveredCurrent.json(),
        rebound.value,
        "Discovery returned a historical binding",
      );
      const queued = await read(
        { ...write, "x-test-recovery": "1", "x-test-metadata-queued": "1" },
        currentQuery,
      );
      assert.equal(queued.status, 403, "Queued stale context exposed operational metadata");
    } finally {
      await server.close();
    }
  }
});
