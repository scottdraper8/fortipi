import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { LocalPrepare, TicketIdentity } from "fortipi-contract/executor";
import { hash } from "../../dist/policy.js";
import { validate } from "../../dist/transport.js";
import type { Manifest } from "../../dist/workspace/manifest.js";

/** Real HTTP byte transport, synthetic authority. This does not stand in for CP/workerd durability. */
export async function relayFixture(data: Buffer) {
  const requests: { path: string; authorization: string | undefined; bytes: Buffer }[] = [];
  let corrupt = false,
    pressure = false,
    redirect = false;
  let ticketIdentity: TicketIdentity | undefined;
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
      res.writeHead(503, { "Retry-After": "60" });
      res.end();
      return;
    }
    if (req.method === "GET") {
      const value = corrupt ? Buffer.from("bad") : data;
      res.writeHead(200, {
        "Content-Length": String(value.length),
        "X-Content-SHA256": hash(data),
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
    setCorrupt(value: boolean) {
      corrupt = value;
    },
    setTicketIdentity(value: TicketIdentity) {
      ticketIdentity = value;
    },
    setPressure(value: boolean) {
      pressure = value;
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
