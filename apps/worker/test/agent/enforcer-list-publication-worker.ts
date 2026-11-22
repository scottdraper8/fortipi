import type { Env } from "../../src/boundary/env.js";
import { TestAgentSession as RuntimeAgent } from "./runtime-worker.js";

export {
  ControlPlane,
  default,
  LinuxContainerHost,
  StorageGuardProbe,
  WorkspaceObject,
  WorkspaceProxy,
} from "./runtime-worker.js";

interface ListGate {
  credentialId: string;
  requestId?: string;
  principalId?: string;
  authorizedAt?: number;
  pageWrittenAt?: number;
  enteredAt?: number;
  delegatedAt?: number;
  finalPassed: boolean;
  release: ReturnType<typeof Promise.withResolvers<void>>;
}

export class TestAgentSession extends RuntimeAgent {
  #listGate: ListGate | undefined;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const authorize = this.authority.authorize.bind(this.authority);
    this.authority.authorize = async (...args) => {
      await authorize(...args);
      const gate = this.#listGate;
      if (
        gate?.credentialId === args[0].credentialId &&
        args[1] === "conversations.list" &&
        gate.enteredAt === undefined
      ) {
        gate.requestId = args[0].requestId;
        gate.principalId = args[0].principalId;
        gate.authorizedAt = Date.now();
      }
    };
    const put = this.store.put.bind(this.store);
    this.store.put = async (...args) => {
      await put(...args);
      const gate = this.#listGate,
        value = args[2];
      if (
        gate?.authorizedAt !== undefined &&
        gate.enteredAt === undefined &&
        args[0] === "page" &&
        args[3] === undefined &&
        value !== null &&
        typeof value === "object" &&
        "principalId" in value &&
        value.principalId === gate.principalId
      )
        // Only the outer put has left its actual queued transaction. Production
        // has already selected item payloads before this page-token write.
        gate.pageWrittenAt = Date.now();
    };
    const current = this.authority.current.bind(this.authority);
    this.authority.current = async (...args) => {
      const gate = this.#listGate;
      const final =
        gate?.requestId === args[0].requestId &&
        gate.pageWrittenAt !== undefined &&
        args[1].actions.includes("conversations.list") &&
        args[1].conversationIds.length === 0 &&
        args[2] === undefined;
      if (gate && final && gate.enteredAt === undefined) {
        gate.enteredAt = Date.now();
        await gate.release.promise;
        gate.delegatedAt = Date.now();
      }
      // Never fabricate authorization or pause after the real final check.
      await current(...args);
      if (gate && final) gate.finalPassed = true;
    };
  }
  armList(credentialId: string) {
    this.#listGate = { credentialId, finalPassed: false, release: Promise.withResolvers<void>() };
  }
  listGate() {
    const gate = this.#listGate;
    return {
      authorizedAt: gate?.authorizedAt ?? null,
      pageWrittenAt: gate?.pageWrittenAt ?? null,
      enteredAt: gate?.enteredAt ?? null,
      delegatedAt: gate?.delegatedAt ?? null,
      finalPassed: gate?.finalPassed ?? false,
    };
  }
  async queuedConversations() {
    return (await this.store.page("conversation", 2)).map((row) => row.id);
  }
  releaseList() {
    this.#listGate?.release.resolve();
  }
}
