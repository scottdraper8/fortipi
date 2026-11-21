import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ServiceError } from "../../src/api/common.js";
import type { Env } from "../../src/boundary/env.js";
import base, { TestAgentSession as BaseAgent } from "../agent/runtime-worker.js";

export {
  ControlPlane,
  LinuxContainerHost,
  StorageGuardProbe,
  WorkspaceObject,
  WorkspaceProxy,
} from "../agent/runtime-worker.js";

export class TestAgentSession extends BaseAgent {
  #mode = "unknown";
  #calls = 0;
  #failedAt = 0;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.dispatch.tick = async () => {
      this.#calls++;
      this.#failedAt = Date.now();
      if (this.#mode === "unknown") throw new Error("Synthetic transport uncertainty");
      throw new ServiceError(
        "unavailable",
        "Synthetic retryable receiver response",
        this.#mode === "declared" ? { retryAfterMs: 120000 } : undefined,
        true,
      );
    };
  }
  override async onRequest(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/__dispatch-backoff/mode") {
      this.#mode = url.searchParams.get("mode") ?? "unknown";
      return Response.json(true);
    }
    if (url.pathname === "/__dispatch-backoff/trace") {
      await this.lifecycle.start();
      const harness = await this.pi.pi();
      const tasks = await harness.commit((tx) => tx.scanTasks({}, 100), BACKGROUND_CONTEXT);
      return Response.json({
        calls: this.#calls,
        failedAt: this.#failedAt,
        tasks: tasks.items
          .filter((task) => task.kind === "fortipi.dispatch")
          .map((task) => ({
            id: task.id,
            status: task.state.status,
            until: task.state.status === "sleeping" ? task.state.until : null,
          })),
      });
    }
    return super.onRequest(request);
  }
}
export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__dispatch-backoff/"))
      return env.AGENT_SESSIONS.getByName(url.searchParams.get("agent") ?? "").fetch(request);
    return base.fetch(request, env);
  },
} satisfies ExportedHandler<Env>;
