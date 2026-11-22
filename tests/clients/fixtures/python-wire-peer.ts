// Handwritten RFC6455/contract peer. This is not the FortiPi service or a second client.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readdir, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { resolve } from "node:path";
import type {
  ClientEvent,
  Conversation,
  Protocol,
  Task,
} from "../../../packages/fortipi-contract/dist/index.js";
import { freeInfrastructurePolicy } from "../../../packages/fortipi-contract/dist/index.js";

export type Fault = "none" | "accept" | "control" | "message" | "truncated" | "known" | "utf8";
const root = resolve(import.meta.dirname, "../../..");
const primary = "synthetic-client-primary";
export const secondary = "synthetic-client-secondary";
export { primary };

const agent = {
  agentId: "agent-A",
  name: "Peer agent",
  configVersion: 0,
  model: { providerId: "cloudflare", modelId: "peer-model" },
  status: "idle",
};
const conversation: Conversation = {
  conversationId: "conversation-A",
  agentId: "agent-A",
  title: "Peer only",
  revision: "revision-A",
  createdAt: 1,
  taskState: { state: "idle" },
};
const scope = {
  agentIds: ["agent-A"],
  conversationIds: ["conversation-A"],
  workspaceIds: [],
  actions: ["events.read"],
  tools: [],
  executorIds: [],
  backendIds: [],
};
function event(type: string, seq: number, payload: unknown, taskId?: string): ClientEvent {
  return {
    protocolVersion: "1.0",
    schemaVersion: "1.0.0",
    deploymentId: "deployment-A",
    conversationId: "conversation-A",
    eventId: `event-${seq}`,
    timestamp: 1,
    durability: "durable",
    eventSeq: seq,
    type,
    payload,
    ...(taskId ? { taskId } : {}),
  } as ClientEvent;
}
function volatile(): ClientEvent {
  return {
    protocolVersion: "1.0",
    schemaVersion: "1.0.0",
    deploymentId: "deployment-A",
    conversationId: "conversation-A",
    eventId: "volatile-A",
    timestamp: 1,
    durability: "volatile",
    type: "future.transient",
    payload: { transient: true },
  };
}
const message = (id: string, role: "user" | "assistant" = "user") => ({
  messageId: id,
  role,
  content: "synthetic-content",
  timestamp: 1,
});
const completed = (id: string): Task => ({
  taskId: id,
  conversationId: "conversation-A",
  version: 1,
  status: { state: "completed" },
});
function frame(opcode: number, bytes: Uint8Array, final = true): Buffer {
  const data = Buffer.from(bytes);
  assert.ok(data.length < 65536);
  const header =
    data.length < 126
      ? Buffer.from([(final ? 128 : 0) | opcode, data.length])
      : Buffer.from([(final ? 128 : 0) | opcode, 126, data.length >> 8, data.length & 255]);
  return Buffer.concat([header, data]);
}
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value));

export async function pythonPeer() {
  const spec = await readFile(resolve(root, "packages/fortipi-contract/openapi.yaml"));
  const schemas = new Map<string, Buffer>();
  for (const name of await readdir(resolve(root, "packages/fortipi-contract/schemas")))
    schemas.set(
      `/v1/schemas/${name}`,
      await readFile(resolve(root, "packages/fortipi-contract/schemas", name)),
    );
  const observations = {
    tickets: 0,
    upgrades: 0,
    subscribes: [] as number[],
    sends: [] as unknown[],
    pongs: 0,
    closes: 0,
    masks: new Set<string>(),
    requests: 0,
  };
  const failures: unknown[] = [];
  const connections = new Set<Socket>();
  const streams = new Set<Socket>();
  let fault: Fault = "none",
    created = false,
    phase = 0;
  const history = [event("conversation.created", 1, conversation)];
  const receipts = new Map<string, object>();
  const page = (after: number, through = history.length) => ({
    events: history.filter((e) => "eventSeq" in e && e.eventSeq > after && e.eventSeq <= through),
    after,
    through,
    lastEventSeq: history.length,
    nextAfter: through,
    hasMore: false,
    retainedFloor: 0,
  });
  const protocol: Protocol = {
    protocolVersion: "1.0",
    schemaVersion: "1.0.0",
    deploymentId: "deployment-A",
    supportedVersions: ["1.0"],
    features: [],
    schemas: [...schemas.keys()].map((url) => ({ name: url.slice(12), url })),
    models: [
      { providerId: "cloudflare", modelId: "peer-model", capabilities: [], available: true },
    ],
    infrastructure: freeInfrastructurePolicy,
    limits: {
      jsonBytes: 1048576,
      outputFrameBytes: 4096,
      chunkBytes: 1024,
      uploadTtlMs: 1000,
      ticketTtlMs: 1000,
      rpcDeadlineMs: 1000,
      replayPage: 100,
      socketBufferBytes: 4096,
      socketBufferFrames: 64,
    },
    retention: { kind: "conversation-lifetime", retainedFloor: 0 },
    backends: [{ kind: "native", available: true, confinement: "host" }],
  };
  const reply = (response: ServerResponse, value: unknown, status = 200) => {
    response.writeHead(status, { "content-type": "application/json", connection: "close" });
    response.end(value instanceof Buffer ? value : encoded(value));
  };
  const server = createServer((request, response) => {
    void (async () => {
      observations.requests++;
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (["/v1/protocol", "/v1/openapi.json", ...schemas.keys()].includes(url.pathname)) {
        assert.equal(
          request.headers.authorization,
          undefined,
          "public discovery must not receive a credential",
        );
        return reply(
          response,
          url.pathname === "/v1/protocol"
            ? protocol
            : url.pathname === "/v1/openapi.json"
              ? spec
              : schemas.get(url.pathname),
        );
      }
      assert.ok(
        [`Bearer ${primary}`, `Bearer ${secondary}`].includes(request.headers.authorization ?? ""),
      );
      assert.equal(request.headers.origin, undefined);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        assert.ok(size <= 8192);
        chunks.push(Buffer.from(chunk));
      }
      const body = size
        ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>)
        : undefined;
      if (url.pathname === "/v1/agents") return reply(response, { items: [agent] });
      if (url.pathname === "/v1/agents/agent-A/conversations") {
        if (request.method === "GET")
          return reply(response, { items: created ? [conversation] : [] });
        assert.equal(request.method, "POST");
        assert.deepEqual(body, { requestId: "create-A" });
        created = true;
        return reply(response, conversation, 201);
      }
      if (url.pathname === "/v1/conversations/conversation-A")
        return reply(response, {
          conversation,
          messages: [],
          projectionRevision: "revision-A",
          lastEventSeq: history.length,
          retainedFloor: 0,
        });
      if (url.pathname === "/v1/conversations/conversation-A/events") {
        assert.deepEqual(
          [...url.searchParams.keys()].sort(),
          url.searchParams.has("through") ? ["after", "limit", "through"] : ["after", "limit"],
        );
        assert.equal(url.searchParams.get("limit"), "100");
        return reply(
          response,
          page(
            Number(url.searchParams.get("after")),
            url.searchParams.has("through")
              ? Number(url.searchParams.get("through"))
              : history.length,
          ),
        );
      }
      if (url.pathname === "/v1/connections/tickets") {
        assert.equal(request.method, "POST");
        assert.deepEqual(Object.keys(body ?? {}).sort(), [
          "audience",
          "originMode",
          "requestId",
          "resources",
        ]);
        assert.equal(body?.audience, "client-stream");
        assert.deepEqual(body?.originMode, { kind: "native" });
        assert.deepEqual(body?.resources, scope);
        observations.tickets++;
        return reply(
          response,
          {
            ticket: `synthetic-ticket-${observations.tickets}`,
            audience: "client-stream",
            expiresAt: Date.now() + 30000,
            identity: {
              deploymentId: "deployment-A",
              principalId: "client-A",
              role: "client",
              credential: { credentialId: "credential-A", generation: 1, grantVersion: 1 },
              credentialExpiresAt: null,
            },
          },
          201,
        );
      }
      assert.equal(url.pathname, "/v1/conversations/conversation-A/messages");
      assert.equal(request.method, "POST");
      observations.sends.push(body);
      assert.deepEqual(Object.keys(body ?? {}).sort(), [
        "busyBehavior",
        "clientRequestId",
        "content",
      ]);
      assert.equal(body?.busyBehavior, "followUp");
      assert.equal(body?.content, "synthetic-content");
      const id = body?.clientRequestId as string;
      if (!receipts.has(id)) {
        const first = receipts.size === 0;
        const seq = history.length + 1,
          taskId = first ? "task-A" : "task-B";
        const receipt = {
          operationId: `operation-${id}`,
          messageId: `message-${id}`,
          taskId,
          revision: "revision-A",
          eventSeq: seq,
        };
        receipts.set(id, receipt);
        history.push(event("message.committed", seq, message(receipt.messageId), taskId));
        if (first) history.push(event("future.persisted", seq + 1, { text: "split-μ🧪" }));
        history.push(event("task.completed", history.length + 1, completed(taskId), taskId));
        if (first)
          for (const stream of streams) {
            stream.write(frame(1, encoded(history[1])));
            const future = encoded(history[2]);
            const split = future.indexOf(Buffer.from("μ")) + 1;
            stream.write(frame(1, future.subarray(0, split), false));
            stream.write(frame(9, Buffer.from("wire-check")));
            stream.write(frame(0, future.subarray(split)));
            stream.write(frame(1, encoded(history[3])));
          }
      }
      reply(response, receipts.get(id), 202);
    })().catch((error: unknown) => {
      failures.push(error);
      response.destroy();
    });
  });
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (
        fault === "none" ||
        !["EPIPE", "ECONNRESET", "ERR_STREAM_WRITE_AFTER_END"].includes(error.code ?? "")
      )
        failures.push(error);
    });
  });
  server.on("upgrade", (request: IncomingMessage, socket, head) => {
    const stream = socket as Socket;
    void (async () => {
      observations.upgrades++;
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      assert.equal(url.pathname, "/v1/stream");
      assert.equal(url.searchParams.get("ticket"), `synthetic-ticket-${observations.tickets}`);
      assert.equal(request.headers.authorization, undefined);
      assert.equal(request.headers.origin, undefined);
      assert.equal(request.headers.upgrade, "websocket");
      assert.equal(request.headers["sec-websocket-version"], "13");
      assert.match(request.headers.connection ?? "", /upgrade/i);
      const key = request.headers["sec-websocket-key"] as string;
      assert.equal(Buffer.from(key, "base64").length, 16);
      const accept = createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      stream.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${fault === "accept" ? "deliberately-wrong" : accept}\r\n\r\n`,
      );
      if (fault === "accept") return;
      let buffered = head;
      stream.on("data", (chunk: Buffer) => {
        try {
          buffered = Buffer.concat([buffered, chunk]);
          assert.ok(buffered.length <= 8192);
          while (buffered.length >= 2) {
            assert.ok(buffered[0] && buffered[0] & 128);
            assert.ok(buffered[1] && buffered[1] & 128, "client frames must be masked");
            let length = (buffered[1] ?? 0) & 127,
              offset = 2;
            if (length === 126) {
              if (buffered.length < 4) return;
              length = buffered.readUInt16BE(2);
              offset = 4;
            }
            assert.ok(length < 4096);
            if (buffered.length < offset + 4 + length) return;
            const mask = buffered.subarray(offset, offset + 4);
            assert.equal(
              observations.masks.has(mask.toString("hex")),
              false,
              "fresh mask required for every client frame",
            );
            observations.masks.add(mask.toString("hex"));
            const payload = Buffer.from(buffered.subarray(offset + 4, offset + 4 + length));
            for (let i = 0; i < payload.length; i++)
              payload[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);
            const opcode = (buffered[0] ?? 0) & 15;
            buffered = buffered.subarray(offset + 4 + length);
            if (opcode === 10) {
              assert.deepEqual(payload, Buffer.from("wire-check"));
              observations.pongs++;
              continue;
            }
            if (opcode === 8) {
              observations.closes++;
              if (!stream.writableEnded) stream.end(frame(8, payload));
              continue;
            }
            assert.equal(opcode, 1);
            const command = JSON.parse(payload.toString()) as {
              requestId: string;
              input: { query: { after: number } };
            };
            const after = command.input.query.after;
            assert.deepEqual(command, {
              type: "conversation.subscribe",
              requestId: command.requestId,
              input: {
                operationId: "replayEvents",
                path: { id: "conversation-A" },
                query: { after, limit: 100 },
              },
            });
            observations.subscribes.push(after);
            stream.write(
              frame(
                1,
                encoded({
                  type: "ack",
                  requestId: command.requestId,
                  operationId: "replayEvents",
                  receipt: page(after),
                }),
              ),
            );
            streams.add(stream);
            stream.on("close", () => streams.delete(stream));
            if (fault === "control") stream.write(Buffer.from([0x89, 126, 0, 126]));
            else if (fault === "message") stream.write(Buffer.from([0x81, 126, 0x20, 0x00]));
            else if (fault === "truncated") stream.end(Buffer.from([0x81, 10, 123]));
            else if (fault === "known")
              stream.write(frame(1, encoded(event("task.completed", after + 1, {}))));
            else if (fault === "utf8") stream.write(frame(1, Buffer.from([0xff])));
            else {
              stream.write(frame(1, encoded(volatile())));
              if (phase > 0) stream.end(); // A boundary EOF is closure, never completion.
              phase++;
            }
          }
        } catch (error) {
          failures.push(error);
          stream.destroy();
        }
      });
    })().catch((error: unknown) => {
      failures.push(error);
      stream.destroy();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let disposed = false;
  return {
    endpoint,
    observations,
    failures,
    setFault: (value: Fault) => {
      fault = value;
    },
    async close() {
      if (disposed) return;
      disposed = true;
      for (const stream of connections) stream.destroy();
      const closed = once(server, "close");
      server.close();
      await closed;
    },
  };
}
