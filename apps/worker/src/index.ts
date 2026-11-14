import { routeRequest } from "./api/router.js";
import type { Env } from "./boundary/env.js";

export { WorkspaceProxy } from "@cloudflare/computer";
export { AgentSession } from "./agent/agent-session.js";
export { LinuxContainerHost } from "./container/linux-container-host.js";
export { ControlPlane } from "./control/index.js";
export { WorkspaceObject } from "./workspace/workspace-object.js";

export default { fetch: routeRequest } satisfies ExportedHandler<Env>;
