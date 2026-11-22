import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import type { FetchErrorProbe } from "./lifecycle-fetch-error-worker.js";

const marker = "synthetic-private-lifecycle-initialization-detail-7891";
const token = "synthetic-lifecycle-fetch-test-token";

test("actual Lifecycle hides pre-onRequest errors on HTTP and WebSocket", {
  timeout: 30000,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "fortipi-lifecycle-fetch-"));
  const configPath = join(directory, "wrangler.json");
  await writeFile(
    configPath,
    JSON.stringify({
      name: "fortipi-lifecycle-fetch",
      main: resolve("apps/worker/test/agent/lifecycle-fetch-error-worker.ts"),
      compatibility_date: "2026-11-10",
      compatibility_flags: ["nodejs_compat", "enable_request_signal", "request_signal_passthrough"],
      vars: { FAILURE_MARKER: marker, TEST_TOKEN: token },
      durable_objects: { bindings: [{ name: "PROBE", class_name: "FetchErrorProbe" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["FetchErrorProbe"] }],
    }),
  );
  process.env.WRANGLER_SEND_METRICS = "false";
  process.env.XDG_CONFIG_HOME = join(directory, "xdg");
  process.env.XDG_CACHE_HOME = join(directory, "cache");
  const { createTestHarness } = await import("wrangler");
  const server = createTestHarness({ root: directory, workers: [{ configPath }] });
  try {
    await server.listen();
    const env = await server
      .getWorker<{ PROBE: DurableObjectNamespace<FetchErrorProbe> }>()
      .getEnv();
    const observe = async (name: string) => JSON.parse(await env.PROBE.getByName(name).observe());
    for (const transport of ["http", "ws"] as const) {
      const name = `host-start/${transport}`;
      const denied = await server.fetch(`http://fixture.local/${name}`, {
        headers: {
          Authorization: "Bearer invalid",
          ...(transport === "ws" ? { Upgrade: "websocket" } : {}),
        },
        signal: t.signal,
      });
      assert.equal(denied.status, 403);
      assert.equal(await denied.text(), "");
      assert.deepEqual(
        await observe(name),
        {
          hostStarts: 0,
          capabilityStarts: 0,
          capabilityRequests: 0,
          capabilityUpgrades: 0,
          hostRequests: 0,
        },
        "Rejected requests must not initialize the object",
      );
    }
    const healthy = await server.fetch("http://fixture.local/healthy/http", {
      headers: { Authorization: `Bearer ${token}` },
      signal: t.signal,
    });
    assert.equal(healthy.status, 200);
    assert.equal(await healthy.text(), "host reached");
    assert.equal((await observe("healthy/http")).hostRequests, 1);

    for (const phase of ["host-start", "capability-start", "capability"] as const) {
      for (const transport of ["http", "ws"] as const) {
        await t.test(`${phase} failure / ${transport}`, async () => {
          const response = await server.fetch(`http://fixture.local/${phase}/${transport}`, {
            headers: {
              Authorization: `Bearer ${token}`,
              ...(transport === "ws" ? { Upgrade: "websocket" } : {}),
            },
            signal: t.signal,
          });
          let body: string;
          const frames: string[] = [];
          if (transport === "http") {
            assert.equal(response.status, 500);
            body = await response.text();
          } else {
            assert.equal(response.status, 101);
            assert.ok(response.webSocket);
            const socket = response.webSocket;
            socket.addEventListener("message", (event) => frames.push(String(event.data)));
            const closed = new Promise<{ code: number; reason: string }>((accept, reject) => {
              const timer = setTimeout(
                () => reject(new Error("Lifecycle failure socket did not close")),
                3000,
              );
              socket.addEventListener(
                "close",
                (event) => {
                  clearTimeout(timer);
                  accept({ code: event.code, reason: event.reason });
                },
                { once: true },
              );
            });
            socket.accept();
            const end = await closed;
            assert.deepEqual(end, {
              code: 1011,
              reason: "Uncaught exception during session setup",
            });
            body = frames.join("\n") + end.reason;
          }
          const observed = await observe(`${phase}/${transport}`);
          assert.deepEqual(
            observed,
            {
              hostStarts: phase === "capability-start" ? 0 : 1,
              capabilityStarts: 1,
              capabilityRequests: phase === "capability" && transport === "http" ? 1 : 0,
              capabilityUpgrades: phase === "capability" && transport === "ws" ? 1 : 0,
              hostRequests: 0,
            },
            "The real failure must precede the host's onRequest",
          );
          assert.equal(
            body.includes(marker),
            false,
            "Synthetic initialization detail must not reach callers",
          );
          if (transport === "http") assert.equal(body, "Internal Server Error");
          else assert.deepEqual(frames, [], "Lifecycle must close without an error frame");
        });
      }
    }
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});
