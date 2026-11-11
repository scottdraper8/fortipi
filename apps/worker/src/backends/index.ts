import { requireCapability } from "fortipi-contract";
import type * as D from "../boundary/dto.js";
import type { ExecutionBackendFactory, FactoryDependencies } from "../boundary/env.js";
import type { ExecutionBackend } from "../boundary/execution-backend.js";
import { outcome, requireThat } from "../workspace/errors.js";

export class CloudExecutionBackend implements ExecutionBackend {
  readonly contractVersion = "1.0" as const;
  readonly config: Exclude<D.BackendConfig, { kind: "native" }>;
  readonly deps: FactoryDependencies;
  constructor(config: Exclude<D.BackendConfig, { kind: "native" }>, deps: FactoryDependencies) {
    this.config = config;
    this.deps = deps;
  }
  describe(ctx: D.AuthContext, input: D.DescribeBackend): Promise<D.Outcome<D.BackendDescription>> {
    return outcome(() => {
      requireThat(
        input.target.kind === "backend" &&
          input.target.backendId === this.config.backendId &&
          ctx.grants.some(
            (grant) =>
              grant.resources.backendIds.includes(this.config.backendId) &&
              grant.resources.workspaceIds.includes(input.workspace.workspaceId) &&
              (!grant.expiresAt || grant.expiresAt > Date.now()),
          ),
        "unauthorized",
        "Backend grant required",
      );
      const available = requireCapability(
        this.deps.env.FORTIPI_CONFIG.infrastructure,
        this.config.kind === "cloud-js" ? "loader" : "containers",
        ctx.deploymentId,
      );
      return {
        target: input.target,
        kind: this.config.kind,
        capabilities:
          this.config.kind === "cloud-js"
            ? ["javascript", "workspace.read", "workspace.write"]
            : ["shell", "workspace.read", "workspace.write"],
        workspaceKinds: ["computer"],
        confinement: "isolated",
        available,
        ...(!available
          ? { reason: "Select and verify the required paid capability and binding" }
          : {}),
      };
    });
  }
  prepare(ctx: D.AuthContext, input: D.ExecutionRequest) {
    return this.deps.authority.prepareExecution(ctx, input);
  }
  startOnce(ctx: D.AuthContext, input: D.PreparedExecution) {
    return this.deps.authority.startOnce(ctx, input);
  }
  queryExisting(ctx: D.AuthContext, input: D.ExecutionIdentity) {
    return this.deps.authority.queryExecution(ctx, input);
  }
  cancel(ctx: D.AuthContext, input: D.CancelRequest) {
    return this.deps.authority.cancelExecution(ctx, input);
  }
  collectResult(ctx: D.AuthContext, input: D.ExecutionIdentity) {
    return this.deps.authority.collectResult(ctx, input);
  }
  classifyUncertainty(
    _ctx: D.AuthContext,
    input: D.ExecutionObservation,
  ): Promise<D.Outcome<D.UncertaintyDisposition>> {
    return Promise.resolve({
      ok: true,
      value:
        input.state === "not_started"
          ? { action: "eligible-first-start", proof: input, canStart: true }
          : {
              action:
                input.state === "terminal" && input.result?.commitId
                  ? "recover-receipt"
                  : input.state === "unknown" || input.state === "lost"
                    ? "reconcile"
                    : "query-existing",
              canStart: false,
              reason:
                "An attempted execution can only be observed, reconciled or recovered by receipt",
            },
    });
  }
}
export const createExecutionBackend: ExecutionBackendFactory = async (config, deps) =>
  outcome(() => {
    requireThat(
      config.kind !== "native",
      "unsupported",
      "Native backend is owned by the authorized executor transport",
    );
    return new CloudExecutionBackend(config, deps);
  });
