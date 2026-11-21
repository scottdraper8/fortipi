import type { AdmissionIntent } from "../../src/agent/conversations.js";
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

export class TestAgentSession extends RuntimeAgent {
  #refuse = false;
  #next = false;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const put = this.store.put.bind(this.store);
    this.store.put = async (...args) => {
      if (this.#refuse) throw new Error("Injected owned application write refusal");
      await put(...args);
    };
    const select = this.conversations.host.selectModel;
    this.conversations.host.selectModel = async (...args) => {
      const selected = await select(...args);
      if (this.#next) {
        this.#next = false;
        this.#refuse = true;
      }
      return selected;
    };
  }
  refuseAfterNextSelection() {
    this.#next = true;
  }
  restoreWrites() {
    this.#refuse = false;
  }
  async refusalState() {
    return JSON.stringify({
      refusing: this.#refuse,
      intents: (await this.store.page<AdmissionIntent>("admission-intent")).map(({ value }) => ({
        operationId: value.operationId,
        messageId: value.messageId,
        taskId: value.taskId,
      })),
      growth: await this.growthReport(),
    });
  }
}
