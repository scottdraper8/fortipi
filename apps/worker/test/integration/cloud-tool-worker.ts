import type { Env } from "../../src/boundary/env.js";
import { defaultModel } from "../../src/models/factory.js";
import common, {
  ControlPlane as RealControlPlane,
  TestAgentSession as RealTestAgentSession,
  WorkspaceObject as RealWorkspaceObject,
} from "./fixture-worker.ts";

export { WorkspaceProxy } from "./fixture-worker.ts";

const sourceBackendId = "seed1010-source-loader";
/** Explicit source capability fixture, never installed/live configuration.
 * Local Loader is real; the declared paid account is a disclosed substitute.
 * Without the actual local binding the Free fixture remains unavailable. */
function sourceEnvironment(env: Env): Env {
  const observedAt = (env as Env & { FORTIPI_EVIDENCE_SOURCE_TIME: number })
    .FORTIPI_EVIDENCE_SOURCE_TIME;
  if (!Number.isSafeInteger(observedAt))
    throw new Error("Explicit source-fixture observation time required");
  const policy = structuredClone(env.FORTIPI_CONFIG.infrastructure);
  policy.accountPlan = env.LOADER ? "paid" : "free";
  policy.profile = env.LOADER ? "verified" : "free";
  policy.capabilities = [
    {
      capability: "loader",
      state: env.LOADER ? "available" : "unavailable",
      accountPlan: policy.accountPlan,
      deploymentId: env.CONTROL_PLANE.idFromName("control").toString(),
      observedAt,
      ...(!env.LOADER ? { reason: "Local source fixture has no Loader binding" } : {}),
    },
  ];
  return {
    ...env,
    FORTIPI_CONFIG: {
      version: 1,
      workspace: { kind: "computer" },
      execution: {
        kind: "cloud-js",
        backendId: sourceBackendId,
        modules: [],
        egress: [],
        onInterrupt: "fail",
      },
      routing: { kind: "explicit", targetIds: [sourceBackendId] },
      models: [defaultModel],
      infrastructure: policy,
    },
  };
}
export class ControlPlane extends RealControlPlane {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, sourceEnvironment(env));
  }
}
export class TestAgentSession extends RealTestAgentSession {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, sourceEnvironment(env));
  }
}
export class WorkspaceObject extends RealWorkspaceObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, sourceEnvironment(env));
  }
}
export default {
  fetch(request, env) {
    return common.fetch(request, sourceEnvironment(env));
  },
} satisfies ExportedHandler<Env>;
