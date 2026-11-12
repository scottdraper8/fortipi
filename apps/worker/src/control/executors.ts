import { validateExecutorTransferLimits } from "fortipi-contract";
import type * as D from "../boundary/dto.js";
import { emptyScope, requireGrant } from "./authorization.js";
import { valid } from "./directory.js";
import type { Identities } from "./identity.js";
import { ControlError, check, id, json, next, type Store } from "./store.js";
import type { ExecutorState } from "./tickets.js";

interface Attachment {
  identity: D.SocketIdentity;
  epoch: number;
  registered: boolean;
  lastBeat: number;
}
interface Waiter {
  resolve: (frame: D.ExecutorFrame) => void;
  reject: () => void;
  timer: ReturnType<typeof setTimeout>;
  promise: Promise<D.ExecutorFrame>;
  fingerprint: string;
  executorId: string;
  generation: number;
  epoch: number;
  transfers: string[];
}
export class Executors {
  readonly state: DurableObjectState;
  readonly store: Store;
  readonly identities: Identities;
  readonly receive: (ctx: D.AuthContext, frame: D.ExecutorDelivery) => Promise<D.DeliveryAck>;
  readonly recoverTerminal: (
    ctx: D.AuthContext,
    executorId: string,
    generation: number,
    epoch: number,
    registration: boolean,
  ) => Promise<void>;
  private beats = new Map<string, number>();
  private waiters = new Map<string, Waiter>();
  constructor(
    state: DurableObjectState,
    store: Store,
    identities: Identities,
    receive: (ctx: D.AuthContext, frame: D.ExecutorDelivery) => Promise<D.DeliveryAck>,
    recoverTerminal: Executors["recoverTerminal"] = async () => {},
  ) {
    this.state = state;
    this.store = store;
    this.identities = identities;
    this.receive = receive;
    this.recoverTerminal = recoverTerminal;
  }
  attachment(socket: WebSocket): Attachment | undefined {
    try {
      return socket.deserializeAttachment() as Attachment;
    } catch {
      return undefined;
    }
  }
  private key(executorId: string, epoch: number): string {
    return `${executorId}:${epoch}`;
  }
  private transition(executorId: string, state: ExecutorState): void {
    this.store.tx(() => {
      const old = this.store.get<ExecutorState>("executor", executorId);
      this.store.put("executor", executorId, state, state.status === "online" ? "connected" : "");
      if (state.description && (old?.status !== state.status || old.epoch !== state.epoch)) {
        const transitionId = id();
        this.store.put(
          "presence_transition",
          transitionId,
          { executorId, description: state.description, cursor: 0, cutoff: this.store.maxSeq() },
          "",
          "",
          Date.now(),
        );
      }
    });
  }
  context(identity: D.SocketIdentity): D.AuthContext {
    const c = this.store.get<import("./identity.js").CredentialRecord>(
      "credential",
      identity.credentialId,
    );
    check(c, "unauthenticated", "Credential unavailable");
    const ctx: D.AuthContext = {
      ...identity,
      grants: c.grants,
      requestId: id(),
      authenticatedAt: Date.now(),
      credentialExpiresAt: c.expiresAt,
      deadline: Date.now() + 30000,
    };
    this.identities.current(ctx);
    check(identity.expiresAt > Date.now(), "unauthenticated", "Socket authority expired");
    return ctx;
  }
  async upgrade(identity: D.SocketIdentity): Promise<Response> {
    this.context(identity);
    check(
      identity.role === "executor" && identity.executor,
      "unauthorized",
      "Executor ticket required",
    );
    const executor = identity.executor;
    await this.store.arm(Date.now() + 45000);
    const epoch = this.store.tx(() => {
      this.context(identity);
      const e = this.store.get<ExecutorState>("executor", executor.executorId);
      check(
        e && e.status !== "revoked" && e.generation === executor.generation,
        "unauthenticated",
        "Executor revoked",
      );
      const epoch = next(e.epoch);
      this.store.put(
        "executor",
        executor.executorId,
        {
          ...e,
          epoch,
          credentialId: identity.credentialId,
          status: "offline",
        },
        "connected",
      );
      if (!this.store.get("presence_check", "control"))
        this.store.put(
          "presence_check",
          "control",
          { cursor: 0, anyLive: false },
          "",
          "",
          Date.now() + 45000,
        );
      return epoch;
    });
    for (const old of this.state.getWebSockets(executor.executorId)) {
      old.close(1008, "Superseded connection");
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({
      identity,
      epoch,
      registered: false,
      lastBeat: Date.now(),
    } satisfies Attachment);
    this.state.acceptWebSocket(server, [executor.executorId]);
    this.beats.set(this.key(executor.executorId, epoch), Date.now());
    return new Response(null, { status: 101, webSocket: client });
  }
  channel(executorId: string, generation: number): WebSocket {
    const e = this.store.get<ExecutorState>("executor", executorId);
    check(
      e && e.generation === generation && e.status !== "revoked",
      "unavailable_executor",
      "Executor unavailable",
    );
    const socket = this.state.getWebSockets(executorId).find((s) => {
      const a = this.attachment(s);
      return a?.registered && a.epoch === e.epoch;
    });
    check(socket, "unavailable_executor", "Executor offline");
    const a = this.attachment(socket);
    check(a, "unavailable_executor", "Missing executor identity");
    this.context(a.identity);
    const beat = this.beats.get(this.key(executorId, e.epoch)) ?? a.lastBeat;
    check(Date.now() - beat < 45000, "unavailable_executor", "Executor presence stale");
    return socket;
  }
  transferLimits(executorId: string, generation: number): D.ExecutorTransferLimits {
    const row = this.store.get<ExecutorState>("executor", executorId);
    check(
      row &&
        row.status !== "revoked" &&
        row.generation === generation &&
        row.description?.generation === generation &&
        row.description.transferLimits,
      "unavailable_executor",
      "Executor has no current validated transfer limits",
    );
    return row.description.transferLimits;
  }
  send(executorId: string, generation: number, frame: D.ExecutorFrame): void {
    check(
      valid("executor-messages", "ExecutorFrame", frame),
      "invalid_request",
      "Invalid executor frame",
    );
    const encoded = json(frame);
    check(
      new TextEncoder().encode(encoded).length <= 1048576,
      "payload_too_large",
      "Executor frame exceeds transport bound",
    );
    this.channel(executorId, generation).send(encoded);
  }
  exchange(
    executorId: string,
    generation: number,
    frame: D.ExecutorFrame,
    deadline: number,
  ): Promise<D.ExecutorFrame> {
    const fingerprint = json(frame);
    const existing = this.waiters.get(frame.requestId);
    if (existing) {
      check(
        existing.executorId === executorId &&
          existing.generation === generation &&
          existing.fingerprint === fingerprint,
        "conflict",
        "Executor request correlation changed",
      );
      return existing.promise;
    }
    check(this.waiters.size < 16, "unavailable", "Executor request window exhausted");
    let resolve: (frame: D.ExecutorFrame) => void = () => undefined;
    let reject: (error: unknown) => void = () => undefined;
    const promise = new Promise<D.ExecutorFrame>((accept, deny) => {
      resolve = accept;
      reject = deny;
    });
    const finish = (): void => {
      const pending = this.waiters.get(frame.requestId);
      if (pending) clearTimeout(pending.timer);
      this.waiters.delete(frame.requestId);
      reject(
        new ControlError(
          "unavailable_executor",
          "Executor response unavailable; observe existing operation",
        ),
      );
    };
    const timer = setTimeout(
      finish,
      Math.max(
        1,
        Math.min(frame.type === "workspace.request" ? 30000 : 10000, deadline - Date.now()),
      ),
    );
    this.waiters.set(frame.requestId, {
      resolve,
      reject: finish,
      timer,
      promise,
      fingerprint,
      executorId,
      generation,
      epoch: this.store.get<ExecutorState>("executor", executorId)?.epoch ?? -1,
      transfers:
        frame.type === "workspace.request" && "transfers" in frame.payload.request
          ? (frame.payload.request.transfers ?? []).map(
              (transfer) => `${transfer.transferId}:${transfer.attemptId}`,
            )
          : [],
    });
    try {
      this.send(executorId, generation, frame);
    } catch (e) {
      clearTimeout(timer);
      this.waiters.delete(frame.requestId);
      reject(e);
    }
    return promise;
  }
  interruptTransfer(transferId: string, attemptId: string): void {
    for (const waiter of this.waiters.values())
      if (waiter.transfers.includes(`${transferId}:${attemptId}`)) waiter.reject();
  }
  async message(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const a = this.attachment(socket);
    check(a?.identity.executor, "unauthenticated", "Missing executor attachment");
    const executor = a.identity.executor;
    const e = this.store.get<ExecutorState>("executor", executor.executorId);
    check(
      e && e.epoch === a.epoch && e.generation === executor.generation && e.status !== "revoked",
      "unauthenticated",
      "Stale connection epoch",
    );
    const ctx = this.context(a.identity);
    check(
      (typeof message === "string"
        ? new TextEncoder().encode(message).length
        : message.byteLength) <= 1048576,
      "payload_too_large",
      "Invalid frame size",
    );
    check(typeof message === "string", "invalid_request", "Executor frames must be JSON text");
    const frame = JSON.parse(message) as D.ExecutorFrame;
    check(
      valid("executor-messages", "ExecutorFrame", frame),
      "invalid_request",
      "Invalid executor frame",
    );
    if (frame.type === "executor.register") {
      validateExecutorTransferLimits(frame.payload.transferLimits);
      check(
        !a.registered &&
          frame.payload.executorId === executor.executorId &&
          frame.payload.generation === executor.generation,
        "unauthorized",
        "Registration identity mismatch",
      );
      requireGrant(ctx, "executors.register", {
        ...emptyScope(),
        executorIds: [executor.executorId],
      });
      await this.store.arm();
      const description: D.ExecutorDescription = {
        ...frame.payload,
        connectionEpoch: a.epoch,
        state: "online",
      };
      // Drop negotiation fields from public metadata.
      const {
        protocolVersion: _protocol,
        schemaVersion: _schema,
        ...publicDescription
      } = description as D.ExecutorDescription & { protocolVersion: string; schemaVersion: string };
      this.store.tx(() => {
        this.context(a.identity);
        const current = this.store.get<ExecutorState>("executor", executor.executorId);
        check(
          current &&
            current.status !== "revoked" &&
            current.generation === executor.generation &&
            current.epoch === a.epoch,
          "unauthenticated",
          "Executor authority changed before registration",
        );
        this.transition(executor.executorId, {
          ...current,
          status: "online",
          description: publicDescription,
        });
      });
      a.registered = true;
      a.lastBeat = Date.now();
      socket.serializeAttachment(a);
      this.beats.set(this.key(executor.executorId, a.epoch), Date.now());
      socket.send(
        json({
          type: "executor.registered",
          requestId: frame.requestId,
          payload: {
            executorId: executor.executorId,
            generation: executor.generation,
            connectionEpoch: a.epoch,
            heartbeatMs: 15000,
          },
        } satisfies D.ExecutorFrame),
      );
      await this.recoverTerminal(
        { ...ctx, deadline: Math.min(ctx.deadline, a.identity.expiresAt) },
        executor.executorId,
        executor.generation,
        a.epoch,
        true,
      ).catch(() => {});
      return;
    }
    check(a.registered, "unauthorized", "Executor must register first");
    if (frame.type === "executor.heartbeat") {
      check(
        frame.payload.executorId === executor.executorId &&
          frame.payload.generation === executor.generation &&
          frame.payload.connectionEpoch === a.epoch,
        "unauthenticated",
        "Heartbeat epoch mismatch",
      );
      a.lastBeat = Date.now();
      socket.serializeAttachment(a);
      this.beats.set(this.key(executor.executorId, a.epoch), a.lastBeat);
      socket.send(json({ ...frame, payload: { ...frame.payload, timestamp: Date.now() } }));
      await this.recoverTerminal(
        { ...ctx, deadline: Math.min(ctx.deadline, a.identity.expiresAt) },
        executor.executorId,
        executor.generation,
        a.epoch,
        false,
      ).catch(() => {});
      return;
    }
    check(
      [
        "job.start_ack",
        "job.query_result",
        "job.cancel_ack",
        "job.output",
        "job.prepared_result",
        "job.committed_ack",
        "local_policy.pending",
        "local_policy.decision",
        "workspace.response",
        "transfer.status",
      ].includes(frame.type),
      "unauthorized",
      "Executor cannot send command frames",
    );
    if (
      (frame.type === "job.query_result" || frame.type === "job.cancel_ack") &&
      !this.waiters.has(frame.requestId)
    )
      return;
    const ack = await this.receive(
      frame.type === "job.committed_ack"
        ? { ...ctx, deadline: Math.min(ctx.deadline, a.identity.expiresAt) }
        : ctx,
      {
        executorId: executor.executorId,
        generation: executor.generation,
        connectionEpoch: a.epoch,
        frame,
      },
    );
    if (frame.type === "job.committed_ack") return;
    const waiter = this.waiters.get(frame.requestId);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.waiters.delete(frame.requestId);
      waiter.resolve(frame);
    }
    if (frame.type === "job.output" || frame.type === "job.prepared_result")
      socket.send(
        json({
          type: frame.type === "job.output" ? "job.output_ack" : "job.result_ack",
          requestId: frame.requestId,
          // The executor outbox is keyed by its outgoing request, while the
          // control-plane inbox keeps its own durable downstream receipt ID.
          payload: { ...ack, deliveryId: frame.requestId },
        }),
      );
  }
  close(subject: D.Invalidation["subject"]): void {
    for (const socket of this.state.getWebSockets()) {
      const a = this.attachment(socket);
      if (
        a &&
        (subject.kind === "credential"
          ? a.identity.credentialId === subject.credentialId
          : a.identity.executor?.executorId === subject.executorId)
      ) {
        socket.close(1008, "Authority revoked");
        this.closed(socket);
      }
    }
  }
  closed(socket: WebSocket): void {
    const a = this.attachment(socket);
    if (!a?.identity.executor) return;
    const key = a.identity.executor.executorId;
    this.beats.delete(this.key(key, a.epoch));
    const e = this.store.get<ExecutorState>("executor", key);
    for (const waiter of this.waiters.values())
      if (waiter.executorId === key && waiter.epoch === a.epoch) waiter.reject();
    if (e?.epoch === a.epoch && e.status !== "revoked")
      this.transition(key, {
        ...e,
        status: "offline",
        ...(e.description ? { description: { ...e.description, state: "offline" } } : {}),
      });
  }
  expire(): void {
    const sweep = this.store.get<{ cursor: number; anyLive: boolean }>(
      "presence_check",
      "control",
    ) ?? { cursor: 0, anyLive: false };
    const rows = this.store.page<ExecutorState>("executor", sweep.cursor, 16, {
      subject: "connected",
    });
    for (const row of rows) {
      const e = row.value;
      let fresh = false;
      for (const socket of this.state.getWebSockets(row.key)) {
        const attachment = this.attachment(socket);
        if (!attachment || attachment.epoch !== e.epoch) continue;
        try {
          this.context(attachment.identity);
          check(
            Date.now() - (this.beats.get(this.key(row.key, e.epoch)) ?? attachment.lastBeat) <
              45000,
            "unavailable_executor",
            "Presence expired",
          );
          fresh = true;
        } catch {
          socket.close(1008, "Presence expired");
          this.closed(socket);
        }
      }
      if (!fresh && e.status !== "revoked")
        this.transition(row.key, {
          ...e,
          status: "offline",
          ...(e.description ? { description: { ...e.description, state: "offline" } } : {}),
        });
      sweep.anyLive ||= fresh;
      sweep.cursor = row.seq;
    }
    if (rows.length === 16)
      this.store.put("presence_check", "control", sweep, "", "", Date.now() + 250);
    else if (sweep.anyLive)
      this.store.put(
        "presence_check",
        "control",
        { cursor: 0, anyLive: false },
        "",
        "",
        Date.now() + 45000,
      );
    else this.store.remove("presence_check", "control");
  }
}
