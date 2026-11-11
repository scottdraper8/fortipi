import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { adminClient, adminConfig, type WireInit } from "./admin-harness.ts";

/** Actual pinned Wrangler dev process tree and persistent SQLite; no harness reset/import. */
export async function adminProcess() {
  const directory = await mkdtemp(join(tmpdir(), "fortipi-admin-reopen-")),
    configPath = join(directory, "wrangler.json"),
    bootstrap = randomBytes(32).toString("hex");
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  const base = `http://127.0.0.1:${address.port}`;
  await mkdir(join(directory, "home"));
  await writeFile(configPath, JSON.stringify(adminConfig(bootstrap)), { mode: 0o600 });
  let child: ChildProcess | undefined,
    logs = "";
  async function stop(signal: "SIGKILL" | "SIGTERM") {
    const current = child;
    if (!current) return;
    child = undefined;
    if (current.exitCode !== null || current.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => current.once("exit", () => resolve()));
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/PID", String(current.pid), "/T", "/F"], {
        stdio: "ignore",
      });
      await new Promise<void>((resolve) => killer.once("exit", () => resolve()));
    } else if (current.pid) process.kill(-current.pid, signal);
    await exited;
  }
  async function start() {
    assert.equal(child, undefined);
    logs = "";
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
          HOME: join(directory, "home"),
          TMPDIR: directory,
          XDG_CONFIG_HOME: join(directory, "config"),
          WRANGLER_SEND_METRICS: "false",
          CI: "true",
        },
      },
    );
    child = runtime;
    const capture = (data: Buffer) => {
      logs = (logs + data.toString().replaceAll(bootstrap, "[synthetic redacted]")).slice(-4096);
    };
    runtime.stdout?.on("data", capture);
    runtime.stderr?.on("data", capture);
    for (let i = 0; i < 200; i++) {
      try {
        const ready = await fetch(`${base}/ready`, { signal: AbortSignal.timeout(250) });
        if (ready.status === 200) return;
      } catch {}
      if (runtime.exitCode !== null)
        throw new Error(
          `Isolated Wrangler exited: ${logs.replace(/fp_(?:admin|client|executor)_[A-Za-z0-9_-]+/g, "[redacted]")}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Isolated Wrangler startup bound exceeded");
  }
  async function raw(path: string, token = bootstrap, init: WireInit = {}) {
    return fetch(`${base}${path}`, {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${token}`,
        "X-Fortipi-Context": "forged-public-context",
      },
    });
  }
  try {
    await start();
  } catch (error) {
    await stop("SIGKILL");
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    ...adminClient(raw, bootstrap),
    async reopen() {
      await stop("SIGKILL");
      await start();
    },
    async close() {
      await stop("SIGTERM");
      await rm(directory, { recursive: true, force: true });
    },
  };
}
