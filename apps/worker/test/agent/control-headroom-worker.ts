import type { Env } from "../../src/boundary/env.js";
import base, { TestAgentSession as BaseAgent } from "./resume-settlement-worker.js";

export {
  ControlPlane,
  LinuxContainerHost,
  StorageGuardProbe,
  WorkspaceObject,
  WorkspaceProxy,
} from "./resume-settlement-worker.js";

export class TestAgentSession extends BaseAgent {
  override async onRequest(request: Request) {
    if (new URL(request.url).pathname === "/__control-headroom/fill") {
      await this.lifecycle.start();
      const start = this.store.physicalBytes();
      const payload = "physical-control-headroom".padEnd(1048576, "x");
      for (let i = 0; i < 60 && this.store.physicalBytes() < 50 * 1048576; i++)
        await this.store.put("fixture-control-fill", String(i), { payload });
      return Response.json({ start, end: this.store.physicalBytes() });
    }
    return super.onRequest(request);
  }
}
export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname === "/__control-headroom/fill")
      return env.AGENT_SESSIONS.getByName(url.searchParams.get("agent") ?? "").fetch(request);
    return base.fetch(request, env);
  },
};
