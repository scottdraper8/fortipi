import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("an RPC callback can reenter its pending initialization more than once", {
  timeout: 30000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "fortipi-reentry-"));
  const configPath = join(directory, "wrangler.json");
  await writeFile(
    configPath,
    JSON.stringify({
      name: "fortipi-reentry",
      main: resolve("apps/worker/test/agent/reentry-worker.ts"),
      compatibility_date: "2026-11-10",
      compatibility_flags: ["nodejs_compat"],
      durable_objects: {
        bindings: [
          { name: "PROBES", class_name: "ReentryProbe" },
          { name: "CALLERS", class_name: "ReentryCaller" },
        ],
      },
      migrations: [{ tag: "v1", new_sqlite_classes: ["ReentryProbe", "ReentryCaller"] }],
    }),
  );
  process.env.WRANGLER_SEND_METRICS = "false";
  process.env.XDG_CONFIG_HOME = join(directory, "xdg");
  process.env.XDG_CACHE_HOME = join(directory, "cache");
  const { createTestHarness } = await import("wrangler");
  const server = createTestHarness({ root: directory, workers: [{ configPath }] });
  try {
    await server.listen();
    for (const [name, expected] of [
      ["once", [1]],
      ["twice", [1, 2]],
    ] as const) {
      const response = await server.fetch(`http://fortipi.local/${name}`, {
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), expected);
    }
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
