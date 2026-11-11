import { requireCapability } from "fortipi-contract";
import type * as D from "../boundary/dto.js";
import type { ExecutionBackendFactory, FactoryDependencies } from "../boundary/env.js";
import type { ExecutionBackend } from "../boundary/execution-backend.js";
import { permitsResource } from "../workspace/authority.js";
import { outcome, requireThat, unwrap } from "../workspace/errors.js";
import { internalHeader } from "../workspace/workspace-object.js";

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
              permitsResource(grant.resources.backendIds, this.config.backendId) &&
              permitsResource(grant.resources.workspaceIds, input.workspace.workspaceId) &&
              (grant.expiresAt === undefined || grant.expiresAt > Date.now()),
          ),
        "unauthorized",
        "Backend grant required",
      );
      const available = Boolean(
        (this.config.kind === "cloud-js" ? this.deps.env.LOADER : this.deps.env.LINUX_CONTAINERS) &&
          requireCapability(
            this.deps.env.FORTIPI_CONFIG.infrastructure,
            this.config.kind === "cloud-js" ? "loader" : "containers",
            ctx.deploymentId,
          ),
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
  private async call<T>(
    ctx: D.AuthContext,
    action: string,
    input: D.ExecutionRequest | D.PreparedExecution | D.ExecutionIdentity,
  ): Promise<D.Outcome<T>> {
    return outcome(async () => {
      const response = await this.deps.authority.fetch(
        new Request(`https://workspace.internal/__fortipi/authority/${action}`, {
          method: "POST",
          headers: { [internalHeader]: JSON.stringify({ auth: ctx }) },
          body: JSON.stringify(input),
        }),
      );
      requireThat(
        response.ok,
        "interrupted",
        "Authority transport interrupted; observe the existing execution",
      );
      return unwrap(await response.json<D.Outcome<T>>());
    }, ctx.requestId);
  }
  prepare(ctx: D.AuthContext, input: D.ExecutionRequest) {
    return this.call<D.PreparedExecution>(ctx, "prepare", input);
  }
  startOnce(ctx: D.AuthContext, input: D.PreparedExecution) {
    return this.call<D.ExecutionObservation>(ctx, "start", input);
  }
  queryExisting(ctx: D.AuthContext, input: D.ExecutionIdentity) {
    return this.call<D.ExecutionObservation>(ctx, "query", input);
  }
  cancel(ctx: D.AuthContext, input: D.CancelRequest) {
    return this.deps.authority.cancelExecution(ctx, input);
  }
  collectResult(ctx: D.AuthContext, input: D.ExecutionIdentity) {
    return this.call<D.PreparedResult>(ctx, "collect", input);
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
