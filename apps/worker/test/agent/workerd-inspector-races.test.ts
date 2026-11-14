import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((accept, reject) =>
    server.close((error) => (error ? reject(error) : accept())),
  );
  return address.port;
}
test("actual workerd Inspector observes delayed-publication cancellation and shutdown", {
  timeout: 25000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "fortipi-inspector-race-"));
  const listenPort = await port(),
    inspectorPort = await port();
  const configPath = join(directory, "wrangler.json");
  await writeFile(
    configPath,
    JSON.stringify({
      name: "fortipi-inspector-race",
      main: resolve("apps/worker/test/agent/race-worker.ts"),
      compatibility_date: "2026-11-10",
      compatibility_flags: ["nodejs_compat", "enable_request_signal", "request_signal_passthrough"],
      durable_objects: { bindings: [{ name: "PROBE", class_name: "RaceProbe" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["RaceProbe"] }],
    }),
  );
  const wrangler = join(
    dirname(fileURLToPath(import.meta.resolve("wrangler"))),
    "../bin/wrangler.js",
  );
  const child = spawn(
    process.execPath,
    [
      wrangler,
      "dev",
      "--local",
      "--config",
      configPath,
      "--persist-to",
      join(directory, "state"),
      "--port",
      String(listenPort),
      "--inspector-port",
      String(inspectorPort),
    ],
    {
      cwd: directory,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: {
        PATH: process.env.PATH,
        WRANGLER_SEND_METRICS: "false",
        XDG_CONFIG_HOME: join(directory, "xdg"),
        XDG_CACHE_HOME: join(directory, "cache"),
      },
    },
  );
  let output = "";
  child.stdout.on("data", (value) => {
    output += String(value);
  });
  child.stderr.on("data", (value) => {
    output += String(value);
  });
  const origin = `http://127.0.0.1:${listenPort}`;
  let socket: WebSocket | undefined;
  const relay = createHttpServer();
  const peers = new Set<import("node:stream").Duplex>();
  relay.on("upgrade", (incoming, downstream, head) => {
    peers.add(downstream);
    const upgrade = httpRequest({
      hostname: "127.0.0.1",
      port: inspectorPort,
      path: incoming.url,
      headers: { ...incoming.headers, origin: "http://localhost" },
    });
    upgrade.on("upgrade", (response, upstream, upstreamHead) => {
      peers.add(upstream);
      downstream.write(
        `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers)
          .map(([name, value]) => `${name}: ${String(value)}`)
          .join("\r\n")}\r\n\r\n`,
      );
      if (head.length) upstream.write(head);
      if (upstreamHead.length) downstream.write(upstreamHead);
      upstream.pipe(downstream).pipe(upstream);
    });
    upgrade.on("error", () => downstream.destroy());
    upgrade.end();
  });
  await new Promise<void>((accept) => relay.listen(0, "127.0.0.1", accept));
  const relayAddress = relay.address();
  assert.ok(relayAddress && typeof relayAddress !== "string");
  try {
    let targets: { webSocketDebuggerUrl: string }[] = [];
    for (let i = 0; i < 150; i++) {
      try {
        targets = (await (
          await fetch(`http://127.0.0.1:${inspectorPort}/json`)
        ).json()) as typeof targets;
        if (targets[0] && (await fetch(origin)).ok) break;
      } catch {}
      assert.equal(child.exitCode, null, output);
      await pause(50);
    }
    assert.ok(targets[0], output);
    const inspectorUrl = new URL(targets[0].webSocketDebuggerUrl);
    inspectorUrl.hostname = "127.0.0.1";
    inspectorUrl.port = String(relayAddress.port);
    socket = new WebSocket(inspectorUrl.href);
    await new Promise<void>((accept, reject) => {
      socket!.addEventListener("open", () => accept(), { once: true });
      socket!.addEventListener("error", () => reject(new Error(output)), { once: true });
    });
    const events: { method?: string; params?: unknown; id?: number }[] = [];
    socket.addEventListener("message", (event) => {
      const value = JSON.parse(String(event.data)) as (typeof events)[number];
      events.push(value);
      if (value.method === "Debugger.paused")
        socket!.send(JSON.stringify({ id: 999, method: "Debugger.resume" }));
    });
    socket.send(JSON.stringify({ id: 1, method: "Runtime.enable" }));
    for (let i = 0; i < 100 && !events.some((e) => e.id === 1); i++) await pause(5);
    socket.send(JSON.stringify({ id: 2, method: "Debugger.enable" }));
    socket.send(
      JSON.stringify({
        id: 3,
        method: "Debugger.setPauseOnExceptions",
        params: { state: "uncaught" },
      }),
    );
    await pause(50);
    await fetch(`${origin}/canary`);
    await pause(100);
    const calibration = events.filter(
      (e) => e.method === "Runtime.exceptionThrown" || e.method === "Debugger.paused",
    );
    console.log(
      JSON.stringify({
        calibration: calibration.map((e) => ({ method: e.method, params: e.params })),
        processOutput: output.slice(-500),
      }),
    );
    assert.ok(
      calibration.some((e) => JSON.stringify(e).includes("workerd-unhandled-canary")),
      "Inspector oracle must detect a deliberately unhandled Worker rejection",
    );
    const observations: unknown[] = [];
    for (const mode of [
      "aftercall",
      "shutdown",
      "guarded-shutdown",
      "task-aftercall",
      "task-shutdown",
    ]) {
      events.length = 0;
      const response = await fetch(
        mode.startsWith("task-")
          ? `${origin}/task-pi?mode=${mode.slice(5)}`
          : `${origin}/pi?mode=${mode}`,
      );
      const result: unknown = await response.json();
      assert.equal(response.status, 200);
      assert.ok(
        typeof result === "object" &&
          result &&
          "rejection" in result &&
          typeof result.rejection === "string" &&
          result.rejection.length > 0,
        "Cancellation must preserve a rejected public wait",
      );
      await pause(100);
      const exceptions = events
        .filter((e) => e.method === "Runtime.exceptionThrown" || e.method === "Debugger.paused")
        .map((e) => ({ method: e.method, params: e.params }));
      observations.push({ mode, status: response.status, result, exceptions });
    }
    console.log(JSON.stringify({ observations }));
    assert.equal(
      observations.some((row) => JSON.stringify(row).includes('"exceptions":[{')),
      false,
      "Caught public Pi waits must not report unhandled runtime exceptions",
    );
  } finally {
    socket?.close();
    for (const peer of peers) peer.destroy();
    await new Promise<void>((accept) => relay.close(() => accept()));
    try {
      process.kill(-child.pid!, "SIGTERM");
    } catch {}
    if (child.exitCode === null)
      await new Promise<void>((accept) => child.once("exit", () => accept()));
    await rm(directory, { recursive: true, force: true });
  }
});
