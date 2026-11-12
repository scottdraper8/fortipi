import type * as D from "../../src/boundary/dto.js";
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
  private closeSamples: { code: number | undefined; attachment: unknown }[] = [];

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
  async streamSnapshot(cid: string): Promise<D.ConversationProjection> {
    return this.store.snapshot(cid);
  }
  async streamReplayJson(cid: string, after: number, through: number): Promise<string> {
    return JSON.stringify(await this.store.replay(cid, { after, through, limit: 100 }));
  }
}
