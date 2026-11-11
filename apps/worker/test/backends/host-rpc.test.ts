import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { createTestHarness } from "wrangler";
import { root } from "../workspace/harness.ts";

test("production host HTTP transport preserves ownership, cancellation, streams and WebSocket upgrade", {
  timeout: 30_000,
}, async () => {
  const common = {
    main:
      process.env.FORTIPI_HOST_TEST_ENTRY ??
      resolve(root, "apps/worker/test/backends/host-rpc-worker.ts"),
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
      privateHeader: false,
    });
    for (const path of ["missing-runtime", "stale-runtime", "changed-image", "unselected"]) {
      assert.deepEqual(
        await (await server.fetch(`/${path}`)).json(),
        {
          rejected: true,
          staleMutationRejected: true,
          starts: path === "stale-runtime" ? 2 : 1,
          timeouts: 1,
        },
        `Container ownership check failed: ${path}`,
      );
    }
    assert.deepEqual(await (await server.fetch("/query-unknown")).json(), {
      rejected: true,
      starts: 0,
    });
    assert.deepEqual(
      await (await server.fetch("/queue-replacement")).json(),
      { rejected: true, startsDuringRequest: 1, starts: 2 },
      "Container replacement crossed an active native HTTP acquisition",
    );
    const baselineStream = await (await server.fetch("/baseline-stream")).json();
    assert.deepEqual(
      baselineStream,
      { first: "first", second: "second", done: true },
      "Native stream fixture did not produce distinct chunks",
    );
    assert.deepEqual(
      await (await server.fetch("/run-stream")).json(),
      baselineStream,
      "Native HTTP body was buffered",
    );
    const upgrade = await server.fetch("/run-upgrade", { headers: { Upgrade: "websocket" } });
    assert.equal(upgrade.status, 101);
    assert.ok(upgrade.webSocket);
    const socket = upgrade.webSocket;
    socket.accept();
    const echoed = new Promise((resolve) =>
      socket.addEventListener("message", (event) => resolve(event.data), { once: true }),
    );
    socket.send("upgrade-canary");
    assert.equal(await echoed, "upgrade-canary");
    socket.close(1000, "complete");
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
        stage: stage === "port-capability" ? "native-fetch" : stage,
        causedStage: stage === "port-capability" ? "native-fetch" : stage,
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
