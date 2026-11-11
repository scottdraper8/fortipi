import { createHash } from "node:crypto";
import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import { FortiPiClient } from "fortipi-client/node";
import type {
  AdmissionReceipt,
  Approval,
  ClientCommand,
  ConversationProjection,
  DurableEvent,
  Job,
  MessageSubmit,
  ReplayPage,
  Task,
  TicketIdentity,
} from "fortipi-contract";
import { identity, protocol } from "../../../fortipi-client/test/fixtures/wire.ts";

/** In-memory HTTP/WebSocket fixture. Exercises native clients, not Worker authorization/durability/model execution. */
export class FixtureService {
  identity: TicketIdentity = structuredClone(identity);
  readonly events: DurableEvent[] = [];
  readonly snapshot: ConversationProjection = {
    conversation: {
      conversationId: "conv_1",
      agentId: "agent_1",
      title: "Fixture",
      revision: "r_0",
      createdAt: 1,
      taskState: { state: "idle" },
    },
    messages: [],
    projectionRevision: "r_0",
    lastEventSeq: 0,
    retainedFloor: 0,
  };
  readonly tasks = new Map<string, Task>();
  readonly jobs = new Map<string, Job>();
  readonly reconciliations: Record<string, unknown>[] = [];
  readonly approvals = new Map<string, Approval>();
  readonly admissions = new Map<string, { body: string; receipt: AdmissionReceipt }>();
  readonly decisions: unknown[] = [];
  readonly tickets = new Set<string>();
  readonly redeemed: string[] = [];
  readonly peers = new Set<Duplex>();
  readonly subscribers = new Set<Duplex>();
  readonly requests: string[] = [];
  origin = "";
  busy = false;
  delayApproval: Promise<void> | undefined;
  mapEvent: (event: DurableEvent) => DurableEvent = (event) => event;
  private serial = 0;
  private readonly server = createServer((req, res) => {
    void this.handle(req, res).catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  constructor() {
    this.server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", this.origin);
      const ticket = url.searchParams.get("ticket") ?? "";
      if (!this.tickets.delete(ticket) || url.pathname !== "/v1/stream" || request.headers.origin) {
        socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      this.redeemed.push(ticket);
      const accept = createHash("sha1")
        .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      this.peers.add(socket);
      let buffer = Buffer.from(head);
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
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
          if (length === 127 || !(second & 128) || !(first & 128)) {
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
            this.send(socket, new Uint8Array(), 8);
            socket.end();
            return;
          }
          if ((first & 15) === 9) {
            this.send(socket, bytes, 10);
            continue;
          }
          if ((first & 15) !== 1) {
            socket.destroy();
            return;
          }
          const command = JSON.parse(bytes.toString("utf8")) as ClientCommand;
          if (command.type === "conversation.subscribe") {
            this.sendJson(socket, {
              type: "ack",
              requestId: command.requestId,
              operationId: "replayEvents",
              receipt: this.replay(command.input.query.after),
            });
            this.subscribers.add(socket);
          }
        }
      });
      socket.on("error", () => {});
      socket.on("close", () => {
        this.peers.delete(socket);
        this.subscribers.delete(socket);
      });
    });
  }
  async start(): Promise<void> {
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("listen");
    this.origin = `http://127.0.0.1:${address.port}`;
  }
  client(): FortiPiClient {
    return new FortiPiClient({
      endpoint: this.origin,
      allowLoopbackHttp: true,
      credentials: async () => "fixture-application",
      timeoutMs: 3000,
      random: () => 0,
    });
  }
  async close(): Promise<void> {
    for (const peer of this.peers) peer.destroy();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
  private send(socket: Duplex, payload: Uint8Array, opcode = 1): void {
    const header = Buffer.alloc(payload.length < 126 ? 2 : 4);
    header[0] = 128 | opcode;
    if (payload.length < 126) header[1] = payload.length;
    else {
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    }
    socket.write(Buffer.concat([header, payload]));
  }
  private sendJson(socket: Duplex, value: unknown): void {
    this.send(socket, new TextEncoder().encode(JSON.stringify(value)));
  }
  private replay(after: number, through = this.events.length, limit = 100): ReplayPage {
    const events = this.events
      .filter((e) => e.eventSeq > after && e.eventSeq <= through)
      .slice(0, limit);
    const nextAfter = events.at(-1)?.eventSeq ?? after;
    return {
      events,
      after,
      through,
      lastEventSeq: this.events.length,
      nextAfter,
      retainedFloor: 0,
      hasMore: nextAfter < through,
    };
  }
  private append(type: string, payload: unknown, taskId: string): void {
    const sequence = this.events.length + 1;
    const event = this.mapEvent({
      protocolVersion: "1.0",
      schemaVersion: "1.0.0",
      deploymentId: protocol.deploymentId,
      conversationId: "conv_1",
      eventId: `event_${sequence}`,
      timestamp: sequence,
      durability: "durable",
      eventSeq: sequence,
      type,
      payload,
      taskId,
    } as DurableEvent);
    this.events.push(event);
    this.snapshot.lastEventSeq = sequence;
    for (const peer of this.subscribers) this.sendJson(peer, event);
  }
  private answer(res: ServerResponse, value: unknown, status = 200): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  }
  private error(res: ServerResponse, code: string, status: number, reason?: string): void {
    this.answer(
      res,
      {
        error: {
          code,
          message: "fixture",
          requestId: "fixture_request",
          retryable: false,
          ...(reason ? { details: { reason } } : {}),
        },
      },
      status,
    );
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.origin);
    this.requests.push(`${req.method} ${url.pathname}`);
    if (url.pathname === "/v1/protocol") {
      this.answer(res, protocol);
      return;
    }
    if (req.headers.authorization !== "Bearer fixture-application") {
      this.error(res, "unauthenticated", 401);
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    if (url.pathname.endsWith("/tickets")) {
      const ticket = `fixture_ticket_${++this.serial}`;
      this.tickets.add(ticket);
      this.answer(
        res,
        {
          ticket,
          audience: "client-stream",
          expiresAt: Date.now() + 30000,
          identity: this.identity,
        },
        201,
      );
      return;
    }
    if (url.pathname === "/v1/agents") {
      this.answer(res, {
        items: [
          {
            agentId: "agent_1",
            name: "Fixture agent",
            configVersion: 1,
            model: { providerId: "fixture", modelId: "fixture" },
            status: "idle",
          },
        ],
      });
      return;
    }
    if (url.pathname === "/v1/agents/agent_1/conversations") {
      this.answer(
        res,
        req.method === "POST"
          ? this.snapshot.conversation
          : { items: [this.snapshot.conversation] },
        req.method === "POST" ? 201 : 200,
      );
      return;
    }
    if (url.pathname === "/v1/conversations/conv_1") {
      this.answer(res, this.snapshot);
      return;
    }
    if (url.pathname.endsWith("/events")) {
      this.answer(
        res,
        this.replay(
          Number(url.searchParams.get("after")),
          url.searchParams.has("through")
            ? Number(url.searchParams.get("through"))
            : this.events.length,
          url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 100,
        ),
      );
      return;
    }
    if (url.pathname.endsWith("/messages") || url.pathname.endsWith("/steer")) {
      const input = body as unknown as MessageSubmit;
      const prior = this.admissions.get(input.clientRequestId);
      if (prior) {
        if (prior.body !== raw) this.error(res, "conflict", 409, "digest_mismatch");
        else this.answer(res, prior.receipt, 202);
        return;
      }
      if (this.busy) {
        this.error(res, "conflict", 409, "busy");
        return;
      }
      const n = this.admissions.size + 1;
      const taskId = `task_${n}`,
        messageId = `user_${n}`,
        revision = `r_${n}`;
      const user = {
        messageId,
        role: "user" as const,
        content: input.content,
        timestamp: this.events.length + 1,
      };
      this.snapshot.messages.push(user);
      this.append("message.committed", user, taskId);
      const running: Task = {
        taskId,
        conversationId: "conv_1",
        version: 1,
        status: { state: "running" },
      };
      this.append("task.running", running, taskId);
      const assistant = {
        messageId: `assistant_${n}`,
        role: "assistant" as const,
        content: "fixture answer",
        timestamp: this.events.length + 1,
      };
      this.snapshot.messages.push(assistant);
      this.append("message.completed", assistant, taskId);
      const complete: Task = { ...running, version: 2, status: { state: "completed" } };
      this.tasks.set(taskId, complete);
      this.snapshot.conversation.taskState = complete.status;
      this.snapshot.conversation.revision = revision;
      this.snapshot.projectionRevision = revision;
      this.append("task.completed", complete, taskId);
      const receipt = {
        operationId: `op_${n}`,
        messageId,
        taskId,
        revision,
        eventSeq: this.events.length - 3,
      };
      this.admissions.set(input.clientRequestId, { body: raw, receipt });
      this.answer(res, receipt, 202);
      return;
    }
    if (url.pathname.startsWith("/v1/tasks/")) {
      const id = url.pathname.split("/")[3] ?? "";
      if (url.pathname.endsWith("/cancel"))
        this.answer(
          res,
          {
            operationId: "cancel_1",
            durableIntent: true,
            disposition: { state: "already-terminal", possibleExternalEffects: false },
          },
          202,
        );
      else this.answer(res, this.tasks.get(id));
      return;
    }
    if (url.pathname.startsWith("/v1/jobs/")) {
      const id = url.pathname.split("/")[3] ?? "";
      const job = this.jobs.get(id);
      if (!job) {
        this.error(res, "not_found", 404);
        return;
      }
      if (req.method === "POST") {
        this.reconciliations.push(body);
        const action = body.action as { kind: string; newJobId?: string };
        this.answer(
          res,
          {
            operationId: "reconcile_1",
            durableIntent: true,
            disposition:
              action.kind === "new-job"
                ? "new-job-requested"
                : action.kind === "acknowledge-unknown"
                  ? "unknown-acknowledged"
                  : "failed-acknowledged",
            ...(action.newJobId ? { newJobId: action.newJobId } : {}),
          },
          202,
        );
      } else this.answer(res, job);
      return;
    }
    if (url.pathname.startsWith("/v1/approvals/")) {
      if (this.delayApproval) await this.delayApproval;
      const id = url.pathname.split("/")[3] ?? "";
      const approval = this.approvals.get(id);
      if (!approval) {
        this.error(res, "not_found", 404);
        return;
      }
      if (req.method === "POST") {
        this.decisions.push(body);
        const result: Approval = {
          ...approval,
          state: body.decision === "approve" ? "approved" : "rejected",
          decidedBy: "principal_fixture",
          decidedAt: Date.now(),
        };
        this.approvals.set(id, result);
        this.answer(res, result);
      } else this.answer(res, approval);
      return;
    }
    this.error(res, "not_found", 404);
  }
}
