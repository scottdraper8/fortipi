import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { createTestHarness } from "wrangler";

test("real PiHarness cancellation during a queued read preserves rejection without an unhandled handoff", {
  timeout: 15000,
}, async () => {
  const server = createTestHarness({
    root: process.cwd(),
    workers: [
      {
        config: {
          name: "fortipi-pi-waiter-qualification",
          main: resolve("apps/worker/test/agent/pi-waiter-worker.ts"),
          compatibility_date: "2026-11-10",
          compatibility_flags: ["nodejs_compat"],
          durable_objects: { bindings: [{ name: "PROBES", class_name: "PiWaiterProbe" }] },
          migrations: [{ tag: "v1", new_sqlite_classes: ["PiWaiterProbe"] }],
        },
      },
    ],
  });
  try {
    await server.listen();
    const response = await server.fetch("/");
    assert.equal(response.status, 200);
    const result = (await response.json()) as {
      committed: boolean;
      wait: { cancelled: boolean; message: string };
      events: string[];
    };
    assert.equal(result.committed, true);
    assert.equal(result.wait.cancelled, true);
    assert.equal(result.wait.message, "Error: qualification-already-cancelled-wait");
    assert.deepEqual(result.events, ["Error: qualification-unhandled-positive-control"]);
  } finally {
    await server.close();
  }
});
