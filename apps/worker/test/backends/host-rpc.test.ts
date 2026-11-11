import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { createTestHarness } from "wrangler";
import { root } from "../workspace/harness.ts";

test("production container adapter carries Request cancellation through actual RPC and built-in Fetcher", {
  timeout: 30_000,
}, async () => {
  const common = {
    main: resolve(root, "apps/worker/test/backends/host-rpc-worker.ts"),
    compatibility_date: "2026-11-10",
    compatibility_flags: ["nodejs_compat", "enable_request_signal", "request_signal_passthrough"],
  };
  const server = createTestHarness({
    root,
    workers: [
      {
        config: {
          ...common,
          name: "fortipi-host-abi",
          services: [{ binding: "PORT", service: "fortipi-host-port" }],
          durable_objects: { bindings: [{ name: "HOST", class_name: "HostProbe" }] },
          migrations: [{ tag: "v1", new_sqlite_classes: ["HostProbe"] }],
        },
      },
      { config: { ...common, name: "fortipi-host-port" } },
    ],
  });
  try {
    await server.listen();
    assert.deepEqual(await (await server.fetch("/raw-rpc")).json(), {
      rejected: true,
      serialization: true,
    });
    const response = await server.fetch("/run");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      method: "POST",
      header: "request-header",
      body: "request-body",
    });
    for (const path of ["cancel", "timeout"]) {
      const baseline = (await (await server.fetch(`/baseline-${path}`)).json()) as {
        rejected: boolean;
        observed: boolean;
        reasonPreserved: boolean;
      };
      assert.equal(baseline.rejected, true);
      assert.equal(baseline.observed, true);
      assert.equal(typeof baseline.reasonPreserved, "boolean");
      assert.deepEqual(await (await server.fetch(`/${path}`)).json(), {
        ...baseline,
        stage: "native-fetch",
      });
    }
    for (const stage of ["before-status", "port-capability", "after-status"])
      assert.deepEqual(await (await server.fetch(`/stage-${stage}`)).json(), {
        stage,
        causedStage: stage,
      });
    for (const path of ["/exit", "/evict"])
      assert.deepEqual(await (await server.fetch(path)).json(), {
        requestRejected: true,
        startRejected: true,
        restartRejected: true,
        starts: 1,
      });
    assert.deepEqual(await (await server.fetch("/known-change")).json(), {
      rejected: true,
      starts: 1,
    });
  } finally {
    await server.close();
  }
});
