import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readSync } from "node:fs";
import type { Profile } from "../dist/config.js";
import { disabledPolicy } from "../dist/policy.js";
import { frame, HttpTransport } from "../dist/transport.js";

// Test-only inherited JSON descriptor: no ambient credentials, server imports, deployment or credential minting.
const option = (name: string) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const endpoint = option("--endpoint"),
  descriptor = Number(option("--credential-fd"));
if (!endpoint || !Number.isInteger(descriptor) || descriptor < 3)
  throw new Error("real endpoint and inherited --credential-fd >=3 required");
let input: Omit<Profile, "origin" | "bindings" | "policy" | "limits" | "ledgerId" | "version">;
try {
  const buffer = Buffer.alloc(65537);
  let size = 0;
  for (;;) {
    const n = readSync(descriptor, buffer, size, buffer.length - size, null);
    if (!n) break;
    size += n;
    if (size >= buffer.length) throw new Error("descriptor bound");
  }
  input = JSON.parse(buffer.subarray(0, size).toString("utf8")) as typeof input;
  buffer.fill(0);
} catch {
  throw new Error(
    "external executor test credential descriptor is unavailable/invalid; no live proof ran",
  );
}
const profile: Profile = {
  ...input,
  version: 1,
  origin: endpoint,
  bindings: [],
  policy: disabledPolicy,
  limits: {},
  ledgerId: "remote_test",
};
const http = new HttpTransport(profile, fetch, endpoint.startsWith("http://127.0.0.1:"));
await http.discover();
const ticket = await http.ticket(),
  url = new URL("/v1/executor/session", profile.origin);
url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
url.searchParams.set("ticket", ticket.ticket);
const socket = new WebSocket(url),
  requestId = randomUUID();
try {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("real executor registration timeout")), 15000);
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("real executor WebSocket failed"));
      },
      { once: true },
    );
    socket.addEventListener("open", () =>
      socket.send(
        JSON.stringify(
          frame({
            type: "executor.register",
            requestId,
            payload: {
              executorId: profile.executorId,
              generation: profile.executorGeneration,
              protocolVersion: "1.0",
              schemaVersion: "1.0.0",
              capabilities: [],
              platform: process.platform,
              caseBehavior: process.platform === "linux" ? "sensitive" : "insensitive",
              rootBindingIds: [],
              confinement: "host",
            },
          }),
        ),
      ),
    );
    socket.addEventListener(
      "message",
      (event) => {
        try {
          const value = frame(JSON.parse(String(event.data)));
          assert.equal(value.type, "executor.registered");
          if (value.type !== "executor.registered") throw new Error("register expected");
          assert.equal(value.requestId, requestId);
          assert.equal(value.payload.executorId, profile.executorId);
          assert.equal(value.payload.generation, profile.executorGeneration);
          clearTimeout(timer);
          resolve();
        } catch {
          clearTimeout(timer);
          reject(new Error("real registration contract mismatch"));
        }
      },
      { once: true },
    );
  });
  const reused = new WebSocket(url);
  const accepted = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      reused.close();
      resolve(false);
    }, 3000);
    reused.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        reused.close();
        resolve(true);
      },
      { once: true },
    );
    reused.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        resolve(false);
      },
      { once: true },
    );
  });
  assert.equal(accepted, false, "one-use ticket was accepted twice");
  process.stdout.write(
    `${JSON.stringify({ observation: "real executor ticket/register succeeded; ticket reuse rejected", protocolVersion: "1.0", effectsStarted: 0 })}\n`,
  );
} finally {
  socket.close(1000, "acceptance complete");
}
