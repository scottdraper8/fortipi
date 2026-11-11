import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import { bootstrap, config } from "./harness.ts";

test("real process SIGKILL retains uninitialized Agent allocation and its exact creation receipt", {
  timeout: 30000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "fortipi-budget-reopen-"));
  const listener = createServer();
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((done, reject) =>
    listener.close((error) => (error ? reject(error) : done())),
  );
  const base = `http://127.0.0.1:${port}`;
  let child: ChildProcess | undefined;
  const kill = async () => {
    if (!child || child.exitCode !== null) return;
    const stopped = new Promise<void>((done) => child?.once("exit", () => done()));
    assert.ok(child.pid);
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
      await new Promise<void>((done) => killer.once("exit", () => done()));
    } else process.kill(-child.pid, "SIGKILL");
    await stopped;
    child = undefined;
  };
  const get = async (path: string): Promise<unknown> => {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    const configPath = join(directory, "wrangler.json");
    await writeFile(
      configPath,
      JSON.stringify({
        name: "budget-reopen",
        main: resolve("apps/worker/test/control/fixtures/storage-budget.ts"),
        compatibility_date: "2026-11-10",
        compatibility_flags: ["nodejs_compat"],
        vars: {
          FORTIPI_ADMIN_TOKEN: bootstrap,
          FORTIPI_MODEL_AUTH_KEY: "a1".repeat(32),
          FORTIPI_CONFIG: config,
        },
        durable_objects: {
          bindings: [
            { name: "CONTROL_PLANE", class_name: "TestControlPlane" },
            { name: "AGENT_SESSIONS", class_name: "TestRecipient" },
            { name: "WORKSPACES", class_name: "TestRecipient" },
          ],
        },
        migrations: [{ tag: "v1", new_sqlite_classes: ["TestControlPlane", "TestRecipient"] }],
      }),
    );
    const start = async () => {
      child = spawn(
        process.execPath,
        [
          resolve("apps/worker/node_modules/wrangler/bin/wrangler.js"),
          "dev",
          "--local",
          "--config",
          configPath,
          "--persist-to",
          join(directory, "state"),
          "--port",
          String(port),
          "--ip",
          "127.0.0.1",
          "--inspector-port",
          "0",
        ],
        {
          cwd: directory,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            PATH: process.env.PATH ?? "",
            TMPDIR: directory,
            XDG_CONFIG_HOME: join(directory, "config"),
            WRANGLER_SEND_METRICS: "false",
            CI: "true",
          },
        },
      );
      child.stdout?.resume();
      child.stderr?.resume();
      for (let attempt = 0; attempt < 150; attempt++) {
        try {
          if ((await fetch(`${base}/deployment`)).ok) return;
        } catch {}
        assert.equal(child.exitCode, null, "Wrangler must remain running");
        await new Promise((done) => setTimeout(done, 50));
      }
      assert.fail("Wrangler startup timed out");
    };
    await start();
    const created = await get("/budget-create");
    assert.ok(created && typeof created === "object" && "ok" in created && created.ok === true);
    const before = await get("/budget-state");
    assert.ok(
      before &&
        typeof before === "object" &&
        "usage" in before &&
        before.usage &&
        typeof before.usage === "object" &&
        "total" in before.usage,
    );
    assert.equal(before.usage.total, 256 * 1048576);
    await get("/canary?value=budget_committed");
    await kill();
    await start();
    assert.equal(await get("/canary"), "budget_committed");
    const reopened = await get("/budget-state");
    assert.ok(
      reopened &&
        typeof reopened === "object" &&
        "allocations" in reopened &&
        "allocations" in before,
    );
    assert.deepEqual(
      reopened.allocations,
      before.allocations,
      "No actor initialization or observation may refund an orphan allocation on reopen",
    );
    assert.deepEqual(
      await get("/budget-create"),
      created,
      "One original request returns its retained ID without a second floor",
    );
  } finally {
    await kill();
    await rm(directory, { recursive: true, force: true });
  }
});
