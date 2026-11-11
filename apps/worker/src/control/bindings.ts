import { incrementSafe, manifestDigest } from "fortipi-contract";
import type * as D from "../boundary/dto.js";
import type { Env } from "../boundary/env.js";
import { emptyScope, permits, requireGrant } from "./authorization.js";
import { type Directory, valid } from "./directory.js";
import type { Identities } from "./identity.js";
import { postponeRepair, repairAccepted } from "./repair.js";
import { check, fail, hash, id, json, ref, type Store, same, within } from "./store.js";
import type { ExecutorState, Tickets } from "./tickets.js";

interface BindingRequest {
  key: string;
  digest: string;
  application: D.WorkspaceBindingApplication;
  ctx: D.ResourceAuthContext;
  ack?: D.WorkspaceBinding;
  attempts: number;
}
export class Bindings {
  readonly store: Store;
  readonly identities: Identities;
  readonly tickets: Tickets;
  readonly directory: Directory;
  readonly env: Env;
  constructor(
    store: Store,
    identities: Identities,
    tickets: Tickets,
    directory: Directory,
    env: Env,
  ) {
    this.store = store;
    this.identities = identities;
    this.tickets = tickets;
    this.directory = directory;
    this.env = env;
  }
  current(workspaceId: string): D.WorkspaceBinding | undefined {
    return this.store.get<D.WorkspaceBinding>("binding", workspaceId);
  }
  list(ctx: D.AuthContext, query: D.PageQuery): D.WorkspacePage {
    this.identities.current(ctx);
    const limit = Math.min(100, query.limit ?? 100);
    check(Number.isSafeInteger(limit) && limit > 0, "invalid_request", "Invalid page size");
    const rows = this.store.page<D.WorkspaceBinding>(
      "binding",
      this.directory.cursor(ctx, "workspaces", query.pageToken),
      limit,
    );
    return {
      items: rows
        .filter((row) =>
          permits(ctx.grants, { ...emptyScope(), workspaceIds: [row.key] }, "workspaces.list"),
        )
        .map((row) => row.value),
      ...(rows.length === limit
        ? { nextPageToken: this.directory.token(ctx, "workspaces", rows.at(-1)?.seq ?? 0) }
        : {}),
    };
  }
  private executor(
    ctx: D.AuthContext,
    executorId: string,
  ): { executorId: string; generation: number } {
    const row = this.store.get<ExecutorState>("executor", executorId);
    check(
      row && row.status !== "revoked",
      "unavailable_executor",
      "Executor identity is unknown or revoked",
    );
    check(
      ctx.grants.some(
        (g) =>
          (g.expiresAt === undefined || g.expiresAt > Date.now()) &&
          (g.resources.executorIds.includes(executorId) || g.resources.executorIds.includes("*")),
      ),
      "unauthorized",
      "Executor is outside grant scope",
    );
    return { executorId, generation: row.generation };
  }
  resolve(
    ctx: D.AuthContext,
    input: { workspaceId: string; bindingVersion: number; executorId: string },
  ): {
    executorId: string;
    executorGeneration: number;
    transferLimits: D.ExecutorTransferLimits | null;
  } {
    this.identities.current(ctx);
    requireGrant(ctx, "workspace.read", {
      ...emptyScope(),
      workspaceIds: [input.workspaceId],
      executorIds: [input.executorId],
    });
    const current = this.current(input.workspaceId);
    const pending = this.store.get<BindingRequest>("binding_pending", input.workspaceId);
    const binding =
      current?.bindingVersion === input.bindingVersion
        ? current
        : pending &&
            same(ref(pending.ctx), ref(ctx)) &&
            pending.ctx.principalId === ctx.principalId &&
            pending.ctx.registrationId === ctx.registrationId &&
            pending.application.binding.bindingVersion === input.bindingVersion
          ? pending.application.binding
          : undefined;
    check(
      binding?.config.kind === "local" && binding.config.executorId === input.executorId,
      "conflict",
      "Binding generation resolution scope mismatch",
    );
    const executor = this.executor(ctx, input.executorId);
    const observed = this.store.get<ExecutorState>("executor", executor.executorId)?.description;
    return {
      executorId: executor.executorId,
      executorGeneration: executor.generation,
      transferLimits:
        observed?.generation === executor.generation ? (observed.transferLimits ?? null) : null,
    };
  }
  validateLocalRead(ctx: D.AuthContext, input: D.LocalWorkspaceRequest): void {
    const executor = this.store.get<ExecutorState>("executor", input.executorId);
    check(
      executor && executor.status !== "revoked" && executor.generation === input.executorGeneration,
      "unavailable_executor",
      "Local request executor generation is no longer current",
    );
    const current = this.current(input.workspaceId);
    if (current?.bindingVersion === input.bindingVersion) {
      check(
        current.config.kind === "local" &&
          current.config.executorId === input.executorId &&
          current.config.rootBindingId === input.rootBindingId,
        "conflict",
        "Local binding scope mismatch",
      );
      return;
    }
    const pending = this.store.get<BindingRequest>("binding_pending", input.workspaceId);
    const app = pending?.application;
    check(
      pending &&
        app?.import &&
        input.kind === "snapshot" &&
        input.operationId === app.requestId &&
        app.binding.config.kind === "local" &&
        app.binding.bindingVersion === input.bindingVersion &&
        app.binding.config.rootBindingId === input.rootBindingId &&
        app.binding.config.executorId === input.executorId &&
        app.executor?.generation === input.executorGeneration &&
        input.revision === app.import.revision &&
        same(ref(pending.ctx), ref(ctx)) &&
        pending.ctx.principalId === ctx.principalId &&
        pending.ctx.registrationId === ctx.registrationId,
      "conflict",
      "No matching pending binding snapshot authority",
    );
  }
  async create(ctx: D.AuthContext, body: D.WorkspaceBindingCreate): Promise<D.WorkspaceBinding> {
    this.identities.current(ctx);
    requireGrant(ctx, "workspaces.create");
    check(
      valid("workspaces", "WorkspaceBindingCreate", body),
      "invalid_request",
      "Invalid workspace binding",
    );
    return this.coordinate(ctx, `create:${ctx.principalId}:${body.requestId}`, body, () => ({
      requestId: body.requestId,
      binding: { workspaceId: id(), bindingVersion: 1, config: body.config },
      expectedVersion: null,
    }));
  }
  async rebind(
    ctx: D.AuthContext,
    workspaceId: string,
    body: D.WorkspaceBindingPatch,
  ): Promise<D.WorkspaceBinding> {
    this.identities.current(ctx);
    requireGrant(ctx, "workspaces.rebind", { ...emptyScope(), workspaceIds: [workspaceId] });
    check(
      valid("workspaces", "WorkspaceBindingPatch", body),
      "invalid_request",
      "Invalid binding import",
    );
    await manifestDigest(body.import.manifest);
    return this.coordinate(
      ctx,
      `rebind:${ctx.principalId}:${workspaceId}:${body.requestId}`,
      body,
      () => {
        const current = this.current(workspaceId);
        check(
          current && current.bindingVersion === body.expectedVersion,
          "conflict",
          "Binding version changed",
        );
        check(
          body.newBindingVersion === incrementSafe(current.bindingVersion),
          "conflict",
          "Binding must advance exactly one version",
        );
        return {
          requestId: body.requestId,
          binding: { workspaceId, bindingVersion: body.newBindingVersion, config: body.config },
          expectedVersion: body.expectedVersion,
          import: body.import,
        };
      },
    );
  }
  private async coordinate(
    ctx: D.AuthContext,
    key: string,
    body: unknown,
    application: () => D.WorkspaceBindingApplication,
  ): Promise<D.WorkspaceBinding> {
    const digest = await hash(json(body));
    await this.store.arm();
    const request = this.store.tx(() => {
      this.identities.current(ctx);
      const old = this.store.get<BindingRequest>("binding_request", key);
      if (old) {
        check(old.digest === digest, "conflict", "Binding request changed");
        return old;
      }
      const app = application();
      check(
        !this.store.get("binding_pending", app.binding.workspaceId),
        "conflict",
        "A binding operation is already pending",
      );
      if (app.binding.config.kind === "local")
        app.executor = this.executor(ctx, app.binding.config.executorId);
      const resources = {
        ...emptyScope(),
        workspaceIds: [app.binding.workspaceId],
        actions: [
          app.expectedVersion === null ? "workspaces.create" : "workspaces.rebind",
          "workspace.read",
        ],
        executorIds: app.executor ? [app.executor.executorId] : [],
      };
      const registration = this.tickets.register(ctx, {
        credential: ref(ctx),
        recipient: { kind: "workspace", id: app.binding.workspaceId },
        resources,
        ...(app.executor ? { executor: app.executor } : {}),
      });
      const record: BindingRequest = {
        key,
        digest,
        application: app,
        ctx: { ...ctx, registrationId: registration.registrationId },
        attempts: 0,
      };
      this.store.put("binding_request", key, record, app.binding.workspaceId, "", Date.now());
      this.store.put("binding_pending", app.binding.workspaceId, record);
      return record;
    });
    if (request.ack) return request.ack;
    return this.apply({ ...request, ctx: { ...ctx, registrationId: request.ctx.registrationId } });
  }
  private async apply(request: BindingRequest): Promise<D.WorkspaceBinding> {
    this.identities.current(request.ctx);
    const app = request.application;
    const authority = this.env.WORKSPACES.getByName(app.binding.workspaceId);
    check(
      (await authority.contractVersion) === "1.0",
      "unsupported",
      "Workspace contract mismatch",
    );
    const result = await within<D.Outcome<D.WorkspaceBinding>>(
      authority.applyBinding(request.ctx, app),
      Math.max(1, Math.min(30000, request.ctx.deadline - Date.now())),
    );
    if (!result.ok) fail(result.code, "Binding authority rejected the application", result.details);
    const ack = result.value;
    check(
      ack.workspaceId === app.binding.workspaceId &&
        ack.bindingVersion === app.binding.bindingVersion &&
        same(ack.config, app.binding.config),
      "conflict",
      "Binding acknowledgment scope mismatch",
    );
    if (app.import)
      check(
        ack.revision === app.import.revision &&
          ack.manifestHash === (await manifestDigest(app.import.manifest)),
        "conflict",
        "Binding import acknowledgment mismatch",
      );
    return this.store.tx(() => {
      this.identities.current(request.ctx);
      const saved = this.store.get<BindingRequest>("binding_request", request.key);
      if (saved?.ack) {
        check(saved.digest === request.digest, "conflict", "Binding request changed");
        return saved.ack;
      }
      const pending = this.store.get<BindingRequest>("binding_pending", app.binding.workspaceId);
      check(
        pending?.key === request.key && pending.digest === request.digest,
        "conflict",
        "Binding pending identity changed",
      );
      const current = this.current(app.binding.workspaceId);
      check(
        (current?.bindingVersion ?? null) === app.expectedVersion,
        "conflict",
        "Binding publication version changed",
      );
      this.store.put("binding", ack.workspaceId, ack);
      this.store.put("binding_request", request.key, { ...request, ack });
      repairAccepted(this.store, "binding_request", request.key);
      this.store.remove("binding_pending", ack.workspaceId);
      return ack;
    });
  }
  async drain(key: string): Promise<void> {
    const request = this.store.get<BindingRequest>("binding_request", key);
    if (!request || request.ack) return;
    try {
      await this.apply({ ...request, ctx: { ...request.ctx, deadline: Date.now() + 5000 } });
    } catch (error) {
      const saved = this.store.get<BindingRequest>("binding_request", key);
      if (!saved || saved.ack) return;
      request.attempts = incrementSafe(saved.attempts);
      this.store.put(
        "binding_request",
        key,
        request,
        request.application.binding.workspaceId,
        "",
        Date.now() + Math.min(3600000, 1000 * 2 ** Math.min(12, request.attempts)),
      );
      postponeRepair(
        this.store,
        "binding_request",
        key,
        error,
        Date.now() + Math.min(3600000, 1000 * 2 ** Math.min(12, request.attempts)),
      );
    }
  }
}
