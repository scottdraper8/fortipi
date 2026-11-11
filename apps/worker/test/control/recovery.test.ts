import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import { bootstrap, config } from "./harness.ts";

async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
async function kill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    await new Promise<void>((resolve) => killer.once("exit", () => resolve()));
  } else if (child.pid) process.kill(-child.pid, "SIGKILL");
  await exited;
}
test("abrupt Wrangler/workerd kill preserves authority, OAuth and structured quota holds", {
  timeout: 30000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "fortipi-control-reopen-"));
  const configPath = join(directory, "wrangler.json");
  const selectedPort = await port();
  const base = `http://127.0.0.1:${selectedPort}`;
  let child: ChildProcess | undefined;
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        name: "control-reopen",
        main: resolve("apps/worker/test/control/fixtures/worker.ts"),
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
    const start = async (): Promise<ChildProcess> => {
      const runtime = spawn(
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
          String(selectedPort),
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
      runtime.stdout?.resume();
      runtime.stderr?.resume();
      child = runtime;
      for (let n = 0; n < 150; n++) {
        try {
          const response = await fetch(`${base}/deployment`);
          if (response.ok) return runtime;
        } catch {}
        if (runtime.exitCode !== null) assert.fail("Wrangler exited before startup");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.fail("Wrangler startup deadline exceeded");
    };
    await start();
    const get = async (path: string): Promise<unknown> => {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 200);
      return response.json();
    };
    assert.equal(await get("/canary?value=committed_before_kill"), "committed_before_kill");
    const reserved = await get("/reserve");
    assert.ok(reserved && typeof reserved === "object" && "ok" in reserved && reserved.ok === true);
    const reservation = await get("/reserved");
    const settled = await get("/settle-conservative");
    assert.ok(
      settled &&
        typeof settled === "object" &&
        "ok" in settled &&
        settled.ok === true &&
        "value" in settled &&
        settled.value &&
        typeof settled.value === "object" &&
        "reservationId" in settled.value &&
        typeof settled.value.reservationId === "string",
    );
    const settledId = settled.value.reservationId;
    assert.deepEqual(await get("/capacity-usage"), { reserved: 12288, consumed: 0, slots: 1 });
    assert.deepEqual(await get(`/capacity-settlement?id=${settledId}`), {
      disposition: "consumed",
    });
    await get("/seed-provider");
    const providerBefore = await get("/resolve-provider");
    assert.ok(
      providerBefore &&
        typeof providerBefore === "object" &&
        "ok" in providerBefore &&
        providerBefore.ok === true,
    );
    const repairAdmin = (await get("/seed-paused-repair")) as { token: string };
    const pausedBefore = (await get("/repair-state")) as {
      holds: { reason: string; notBefore?: number; pressure: { resetAt?: number } }[];
    };
    assert.equal(pausedBefore.holds[0]?.reason, "storage");
    assert.equal(pausedBefore.holds[0]?.notBefore, undefined);
    assert.equal(pausedBefore.holds[0]?.pressure.resetAt, undefined);
    await get("/revoke-bootstrap");
    assert.deepEqual(await get("/auth"), { authenticated: false });
    assert.ok(child);
    await kill(child);
    child = undefined;
    await start();
    assert.equal(
      await get("/canary"),
      "committed_before_kill",
      "actual persisted canary survives runtime-tree SIGKILL",
    );
    assert.deepEqual(
      await get("/reserved"),
      reservation,
      "reservation is not regenerated after process death",
    );
    assert.deepEqual(
      await get("/capacity-usage"),
      { reserved: 12288, consumed: 0, slots: 1 },
      "unmeasured full conservative charge survives actual runtime-tree SIGKILL",
    );
    assert.deepEqual(
      await get(`/capacity-settlement?id=${settledId}`),
      { disposition: "consumed" },
      "actual reopen must preserve absent measurement without fabricating observed bytes",
    );
    const pausedAfter = (await get("/repair-state")) as {
      holds: unknown[];
      due: { kind: string; due: number | null }[];
    };
    assert.deepEqual(
      pausedAfter.holds,
      pausedBefore.holds,
      "durable quota hold survives actual runtime-tree death without an invented reset",
    );
    assert.equal(
      pausedAfter.due.some((row) => row.kind === "fanout" && row.due === null),
      true,
    );
    const resumedResponse = await fetch(`${base}/resume-paused-repair`, {
      headers: { Authorization: `Bearer ${repairAdmin.token}` },
    });
    assert.equal(resumedResponse.status, 200);
    const resumed = (await resumedResponse.json()) as { holds: unknown[] };
    assert.equal(
      resumed.holds.length,
      0,
      "actual configuration and matching receiver acknowledgment resume paused repair",
    );
    const providerAfter = (await get("/resolve-provider")) as {
      ok: boolean;
      value: { isFresh: boolean; version: number; calls: number };
    };
    assert.equal(providerAfter.ok, true);
    assert.equal(providerAfter.value.isFresh, true);
    assert.equal(providerAfter.value.version, 2);
    assert.equal(
      providerAfter.value.calls,
      0,
      "complete credential decrypts after actual process reopen without a second refresh",
    );
    assert.deepEqual(
      await get("/auth"),
      { authenticated: false },
      "same-secret bootstrap stays revoked after process reopen",
    );
  } finally {
    if (child) await kill(child);
    await rm(directory, { recursive: true, force: true });
  }
});
