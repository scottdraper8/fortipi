import { messageParts } from "../../src/agent/message-projection.js";
import type { Sql } from "../../src/agent/store.js";
import { validate } from "../../src/api/validation.js";
import type * as D from "../../src/boundary/dto.js";
import type { Env } from "../../src/boundary/env.js";
import { TestAgentSession as RuntimeAgent } from "../agent/runtime-worker.js";

export {
  ControlPlane,
  default,
  LinuxContainerHost,
  StorageGuardProbe,
  WorkspaceObject,
  WorkspaceProxy,
} from "../agent/runtime-worker.js";

export class TestAgentSession extends RuntimeAgent {
  async messagePartsJson(message: D.Message) {
    return JSON.stringify(await messageParts(message));
  }
  private closeSamples: { code: number | undefined; attachment: unknown }[] = [];
  #deliveryHold: { entered: boolean; gate: PromiseWithResolvers<void> } | undefined;
  readonly #deliveryWrites = new WeakSet<Sql>();
  #replayCaptures = 0;
  #commandGate:
    | {
        conversationId: string;
        requestId: string;
        entered: boolean;
        finished: boolean;
        release: PromiseWithResolvers<void>;
      }
    | undefined;
  #submissionCalls = 0;
  #submissionOutcome: number | string | null = null;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const authorize = this.authority.authorize.bind(this.authority);
    this.authority.authorize = async (...args) => {
      await authorize(...args);
      const gate = this.#commandGate;
      if (
        gate &&
        !gate.entered &&
        args[1] === "messages.submit" &&
        args[2] === gate.conversationId
      ) {
        gate.entered = true;
        // Hold only after the real authority check, outside every storage queue.
        await gate.release.promise;
      }
    };
    const handleApi = this.handleApi.bind(this);
    this.handleApi = async (...args) => {
      if (args[1].operationId === "submitMessage") this.#submissionCalls++;
      const result = await handleApi(...args);
      if (args[1].operationId === "submitMessage")
        this.#submissionOutcome = result.ok ? result.value.status : result.code;
      return result;
    };
    const host = this as unknown as {
      webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void>;
    };
    const message = host.webSocketMessage.bind(host);
    // Observe completion of the actual platform-delivered callback. Lifecycle
    // installs this public DO handler configurable but non-writable.
    Object.defineProperty(this, "webSocketMessage", {
      configurable: true,
      value: async (socket: WebSocket, data: string | ArrayBuffer) => {
        let requestId: unknown;
        if (typeof data === "string") {
          try {
            const value: unknown = JSON.parse(data);
            if (value && typeof value === "object" && "requestId" in value)
              requestId = value.requestId;
          } catch {
            // The real handler retains validation/error behavior.
          }
        }
        const gate = this.#commandGate;
        const capture = gate?.requestId === requestId ? gate : undefined;
        try {
          await message(socket, data);
        } finally {
          if (capture) capture.finished = true;
        }
      },
    });
    const replay = this.store.replay.bind(this.store);
    this.store.replay = async (...args) => {
      const value = await replay(...args);
      this.#replayCaptures++;
      return value;
    };
    const transaction = this.store.transaction.bind(this.store);
    this.store.transaction = async <T>(fn: (tx: Sql) => Promise<T>): Promise<T> => {
      let charged = false;
      const value = await transaction(async (tx) => {
        const result = await fn(tx);
        charged = this.#deliveryWrites.delete(tx);
        return result;
      });
      // Pause only after the real queued transaction has committed. Holding an
      // actual storage transaction would block the observer/release RPC inputs.
      const hold = this.#deliveryHold;
      if (charged && hold && !hold.entered) {
        hold.entered = true;
        await hold.gate.promise;
      }
      return value;
    };
    const put = this.store.put.bind(this.store);
    this.store.put = async (...args) => {
      await put(...args);
      const [kind, , value, tx] = args;
      if (
        tx &&
        kind === "socket-delivery" &&
        typeof value === "object" &&
        value !== null &&
        "frames" in value &&
        typeof value.frames === "number" &&
        value.frames > 0
      ) {
        this.#deliveryWrites.add(tx);
      }
    };
  }
  holdDelivery() {
    this.#deliveryHold = { entered: false, gate: Promise.withResolvers<void>() };
  }
  deliveryHeld() {
    return this.#deliveryHold?.entered ?? false;
  }
  releaseDelivery() {
    this.#deliveryHold?.gate.resolve();
    this.#deliveryHold = undefined;
  }
  replayCaptures() {
    return this.#replayCaptures;
  }
  holdSocketCommand(conversationId: string, requestId: string) {
    this.#commandGate = {
      conversationId,
      requestId,
      entered: false,
      finished: false,
      release: Promise.withResolvers<void>(),
    };
  }
  releaseSocketCommand() {
    this.#commandGate?.release.resolve();
  }
  socketCommandReport() {
    return {
      held: this.#commandGate?.entered ?? false,
      finished: this.#commandGate?.finished ?? false,
      submissionCalls: this.#submissionCalls,
      submissionOutcome: this.#submissionOutcome,
    };
  }

  // Read-only observation around the real public socket.close; no forged
  // bufferedAmount, SDK handlers, attachment writes, or simulated restart.
  observeSocketClose() {
    for (const socket of this.ctx.getWebSockets()) {
      const close = socket.close.bind(socket);
      socket.close = (code, reason) => {
        this.closeSamples.push({ code, attachment: socket.deserializeAttachment() });
        close(code, reason);
      };
    }
    return this.ctx.getWebSockets().map((socket) => ({
      bufferedAmountPresent: "bufferedAmount" in socket,
    }));
  }
  closeSamplesJson() {
    return JSON.stringify(this.closeSamples);
  }

  // Substitute only the event producer: real application append transactions,
  // IDs, SQLite replay, retention and native WebSocket delivery remain intact.
  // Deliberately omit notification hints to create a deterministic durable gap.
  async appendStreamEvents(cid: string, count: number) {
    if (!Number.isInteger(count) || count < 1 || count > 101) throw new Error("Bounded seed");
    const first = await this.store.exactEvent(cid, 1);
    if (first?.type !== "conversation.created") throw new Error("Creation required");
    const acks: D.FactAck[] = [];
    for (let index = 0; index < count; index++) {
      acks.push(
        await this.store.transaction((tx) =>
          this.store.append(tx, crypto.randomUUID(), {
            protocolVersion: "1.0",
            schemaVersion: "1.0.0",
            deploymentId: first.deploymentId,
            conversationId: cid,
            durability: "durable",
            type: "conversation.updated",
            payload: first.payload,
          }),
        ),
      );
    }
    return acks;
  }
  async retainStreamEvents(cid: string): Promise<D.ConversationProjection> {
    // A single supported bounded retention pass suffices for the small fixture.
    await this.store.retain(cid);
    return this.store.snapshot(cid);
  }
  async appendStreamMessages(cid: string, count: number, bytes: number) {
    if (
      !Number.isInteger(count) ||
      count < 1 ||
      count > 20 ||
      !Number.isInteger(bytes) ||
      bytes < 1 ||
      bytes > 65536
    )
      throw new Error("Bounded valid message producer");
    const first = await this.store.exactEvent(cid, 1);
    if (first?.type !== "conversation.created") throw new Error("Creation required");
    const acks: D.FactAck[] = [];
    for (let index = 0; index < count; index++) {
      const payload: D.Message = {
        messageId: crypto.randomUUID(),
        role: "assistant",
        content: "x".repeat(bytes),
        timestamp: Date.now(),
      };
      validate<D.Message>("Message", payload);
      acks.push(
        await this.store.transaction((tx) =>
          this.store.append(tx, crypto.randomUUID(), {
            protocolVersion: "1.0",
            schemaVersion: "1.0.0",
            deploymentId: first.deploymentId,
            conversationId: cid,
            durability: "durable",
            type: "message.completed",
            payload,
          }),
        ),
      );
    }
    return acks;
  }
  async streamSnapshot(cid: string): Promise<D.ConversationProjection> {
    return this.store.snapshot(cid);
  }
  notifyStream(cid: string) {
    return this.conversations.host.notify(cid);
  }
  async socketBudgetJson() {
    return JSON.stringify(await this.store.page("socket-delivery"));
  }
  async streamReplayJson(cid: string, after: number, through: number): Promise<string> {
    return JSON.stringify(await this.store.replay(cid, { after, through, limit: 100 }));
  }
}
