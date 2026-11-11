import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { freeInfrastructurePolicy } from "fortipi-contract";
import type {
  ErrorBody,
  ExecutorFrame,
  LocalPrepare,
  TicketIdentity,
} from "fortipi-contract/executor";
import type { Profile } from "../../dist/config.js";
import { hash } from "../../dist/policy.js";
import { validate } from "../../dist/transport.js";
import type { Manifest } from "../../dist/workspace/manifest.js";

/** Actual Node WebSocket peer; synthetic HTTP authority, no Worker/CP substitute. */
export async function sessionFixture(
  profile: Profile,
  options: { register: boolean; fault?: "protocol" | "binary"; afterRegister?: ExecutorFrame[] },
) {
  const peers = new Set<Duplex>(),
    tickets = new Set<string>();
  const received: ExecutorFrame[] = [],
    closes: { code: number; reason: string }[] = [];
  let epoch = 0,
    serial = 0;
  function send(socket: Duplex, bytes: Buffer, opcode = 1) {
    if (bytes.length > 65535) throw new Error("fixture frame bound");
    const header = Buffer.alloc(bytes.length < 126 ? 2 : 4);
    header[0] = 128 | opcode;
    if (bytes.length < 126) header[1] = bytes.length;
    else {
      header[1] = 126;
      header.writeUInt16BE(bytes.length, 2);
    }
    socket.write(Buffer.concat([header, bytes]));
  }
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/protocol") {
      res.end(
        JSON.stringify({
          protocolVersion: "1.0",
          schemaVersion: "1.0.0",
          deploymentId: profile.deploymentId,
          infrastructure: freeInfrastructurePolicy,
          limits: { jsonBytes: 1048576, chunkBytes: 262144, outputFrameBytes: 16384 },
        }),
      );
    } else if (req.method === "POST" && req.url === "/v1/connections/tickets") {
      req.resume();
      const ticket = `synthetic_ticket_${++serial}`;
      tickets.add(ticket);
      res.writeHead(201);
      res.end(
        JSON.stringify({
          ticket,
          audience: "executor-session",
          expiresAt: Date.now() + 30000,
          identity: {
            deploymentId: profile.deploymentId,
            principalId: "synthetic_executor",
            role: "executor",
            credential: profile.credential,
            credentialExpiresAt: null,
          },
        }),
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://fixture");
    if (
      url.pathname !== "/v1/executor/session" ||
      !tickets.delete(url.searchParams.get("ticket") ?? "")
    ) {
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const accept = createHash("sha1")
      .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    peers.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => peers.delete(socket));
    let buffer = Buffer.from(head);
    socket.on("data", (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      if (buffer.length > 1048576) {
        socket.destroy();
        return;
      }
      while (buffer.length >= 2) {
        const first = buffer[0] ?? 0,
          second = buffer[1] ?? 0;
        let length = second & 127,
          offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        }
        if (length === 127 || !(first & 128) || !(second & 128)) {
          socket.destroy();
          return;
        }
        if (buffer.length < offset + 4 + length) return;
        const mask = buffer.subarray(offset, offset + 4);
        offset += 4;
        const bytes = Buffer.from(buffer.subarray(offset, offset + length));
        for (let i = 0; i < bytes.length; i++) bytes[i] = (bytes[i] ?? 0) ^ (mask[i % 4] ?? 0);
        buffer = buffer.subarray(offset + length);
        if ((first & 15) === 8) {
          closes.push({
            code: bytes.length >= 2 ? bytes.readUInt16BE(0) : 1005,
            reason: bytes.subarray(2).toString(),
          });
          send(socket, bytes, 8);
          socket.end();
          return;
        }
        if ((first & 15) !== 1) {
          socket.destroy();
          return;
        }
        const value = validate<ExecutorFrame>(
          "executor-messages.schema.json",
          "ExecutorFrame",
          JSON.parse(bytes.toString()),
        );
        received.push(value);
        if (value.type === "executor.register" && options.register) {
          send(
            socket,
            Buffer.from(
              JSON.stringify({
                type: "executor.registered",
                requestId: value.requestId,
                payload: {
                  executorId: profile.executorId,
                  generation: profile.executorGeneration,
                  connectionEpoch: ++epoch,
                  heartbeatMs: 15000,
                },
              }),
            ),
          );
          if (options.fault === "protocol")
            send(socket, Buffer.from('{"type":"invalid-protocol"}'));
          if (options.fault === "binary") send(socket, Buffer.from([1]), 2);
          for (const pending of options.afterRegister ?? [])
            send(socket, Buffer.from(JSON.stringify(pending)));
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    options,
    received,
    closes,
    async close() {
      for (const socket of peers) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

/** Real HTTP byte transport, synthetic authority. This does not stand in for CP/workerd durability. */
export async function relayFixture(data: Buffer) {
  const requests: { path: string; authorization: string | undefined; bytes: Buffer }[] = [];
  let corrupt = false,
    pressure: boolean | ErrorBody = false,
    redirect = false;
  let ticketIdentity: TicketIdentity | undefined;
  let grid = Math.max(1, data.length),
    delayMs = 0,
    pressureStatus = 503,
    retryAfter = "60";
  const server = createServer(async (req, res) => {
    const pieces: Buffer[] = [];
    for await (const piece of req) pieces.push(Buffer.from(piece as Buffer));
    const bytes = Buffer.concat(pieces);
    requests.push({ path: req.url ?? "", authorization: req.headers.authorization, bytes });
    if (req.url === "/v1/connections/tickets" && ticketIdentity) {
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ticket: "T".repeat(64),
          audience: "executor-session",
          expiresAt: Date.now() + 30000,
          identity: ticketIdentity,
        }),
      );
      return;
    }
    if (redirect) {
      res.writeHead(302, { Location: "http://127.0.0.1:1/exfiltrate" });
      res.end();
      return;
    }
    if (pressure) {
      res.writeHead(pressureStatus, { "Retry-After": retryAfter });
      res.end(typeof pressure === "object" ? JSON.stringify(pressure) : undefined);
      return;
    }
    if (req.method === "GET") {
      const index = Number(
          new URL(req.url ?? "/", "http://fixture").pathname.split("/chunks/")[1] ?? 0,
        ),
        expected = data.subarray(index * grid, (index + 1) * grid),
        value = corrupt ? Buffer.from("bad") : expected;
      if (delayMs) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      res.writeHead(200, {
        "Content-Length": String(value.length),
        "X-Content-SHA256": hash(expected),
      });
      res.end(value);
    } else {
      res.writeHead(204);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    requests,
    setGrid(value: number) {
      grid = value;
    },
    setDelay(value: number) {
      delayMs = value;
    },
    setCorrupt(value: boolean) {
      corrupt = value;
    },
    setTicketIdentity(value: TicketIdentity) {
      ticketIdentity = value;
    },
    setPressure(value: boolean | ErrorBody, status = 503, retry = "60") {
      pressure = value;
      pressureStatus = status;
      retryAfter = retry;
    },
    setRedirect(value: boolean) {
      redirect = value;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    },
  };
}

/** Immutable base bytes and an idempotent staging HTTP peer; no Worker/canonical commit implementation. */
export async function snapshotFixture(
  manifest: Manifest,
  manifestHash: string,
  files: Map<string, Buffer>,
) {
  const begins: unknown[] = [],
    chunks = new Map<string, Buffer>(),
    requests: string[] = [];
  let drop = true;
  let opened:
    | {
        requestId: string;
        manifestHash: string;
        baseRevision: string;
        mutations: Extract<LocalPrepare["mode"], { kind: "staged-change" }>["mutations"];
      }
    | undefined;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://fixture");
      requests.push(`${req.method} ${url.pathname}`);
      const pieces: Buffer[] = [];
      let size = 0;
      for await (const part of req) {
        size += (part as Buffer).length;
        if (size > 1048576) throw new Error("fixture request bound");
        pieces.push(Buffer.from(part as Buffer));
      }
      const body = Buffer.concat(pieces);
      if (req.method === "GET" && url.pathname.endsWith("/manifest")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ workspaceId: "workspace", revision: "r0", manifest, manifestHash }),
        );
        return;
      }
      if (req.method === "GET" && url.pathname.includes("/blobs/")) {
        const sha = url.pathname.split("/").at(-1) ?? "",
          bytes = files.get(sha);
        if (!bytes) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Length": String(bytes.length), "X-Content-SHA256": sha });
        res.end(bytes);
        return;
      }
      if (req.method === "POST" && url.pathname.endsWith("/uploads")) {
        const value = JSON.parse(body.toString("utf8")) as unknown;
        validate("workspaces.schema.json", "UploadBegin", value);
        begins.push(value);
        if (opened && JSON.stringify(value) !== JSON.stringify(begins[0]))
          throw new Error("changed upload intent");
        opened = value as NonNullable<typeof opened>;
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            uploadId: "server_upload",
            state: "open",
            baseRevision: opened.baseRevision,
            manifestHash: opened.manifestHash,
            receivedChunks: [],
            expiresAt: Date.now() + 60000,
          }),
        );
        return;
      }
      if (req.method === "PUT" && url.pathname.includes("/uploads/server_upload/blobs/")) {
        if (
          Number(url.searchParams.get("length")) !== body.length ||
          url.searchParams.get("sha256") !== hash(body)
        )
          throw new Error("chunk hash/length mismatch");
        const key = url.pathname.split("/blobs/")[1] ?? "";
        const old = chunks.get(key);
        if (old && !old.equals(body)) throw new Error("conflicting duplicate chunk");
        chunks.set(key, body);
        if (drop) {
          drop = false;
          req.socket.destroy();
          return;
        }
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === "POST" && url.pathname.endsWith("/server_upload/validate") && opened) {
        for (const m of opened.mutations)
          if (m.kind === "put") {
            const matching = [...chunks]
              .filter(([k]) => k.startsWith(`${m.sha256}/chunks/`))
              .sort((a, b) => Number(a[0].split("/").at(-1)) - Number(b[0].split("/").at(-1)));
            const bytes = Buffer.concat(matching.map(([, v]) => v));
            if (bytes.length !== m.size || hash(bytes) !== m.sha256)
              throw new Error("incomplete staged file");
          }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            uploadId: "server_upload",
            manifestHash: opened.manifestHash,
            stageId: "public_stage",
            validated: true,
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    } catch {
      if (!res.headersSent) res.writeHead(409);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    begins,
    chunks,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
