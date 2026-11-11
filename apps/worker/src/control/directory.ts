import Ajv from "ajv/dist/2020.js";
import { freeInfrastructurePolicy, schemaRegistry } from "fortipi-contract";
import type * as D from "../boundary/dto.js";
import type { Env } from "../boundary/env.js";
import { audit } from "./audit.js";
import { contains, emptyScope, permits, requireGrant, roleAllows } from "./authorization.js";
import type { Identities } from "./identity.js";
import { queueRepairResume } from "./repair.js";
import { check, fail, hash, id, json, next, ref, type Store, same } from "./store.js";
import type { ExecutorState } from "./tickets.js";

// Only fixed trusted schemas are compiled at module activation, never in request handlers.
const ajv = new Ajv({ strict: true, allErrors: false, validateFormats: false });
for (const schema of Object.values(schemaRegistry)) ajv.addSchema(schema);
const validators = new Map(
  [
    ["agents", "AgentCreate"],
    ["agents", "AgentPatch"],
    ["configuration", "ConfigurationPatch"],
    ["administration", "TicketInput"],
    ["administration", "TicketQuery"],
    ["administration", "ExecutorTransferLimits"],
    ["administration", "CredentialMint"],
    ["executor-messages", "ExecutorFrame"],
    ["executor-messages", "Assignment"],
    ["executor-messages", "ExecutorJobQuery"],
    ["executor-messages", "ExecutorJobChunkQuery"],
    ["workspaces", "LocalWorkspaceRequest"],
    ["workspaces", "LocalWorkspaceResponse"],
    ["workspaces", "WorkspaceBindingCreate"],
    ["workspaces", "WorkspaceBindingPatch"],
    ["workspaces", "WorkspaceLeaseAcquire"],
    ["workspaces", "WorkspaceLeaseRenew"],
    ["workspaces", "WorkspaceLeaseRelease"],
    ["workspaces", "Lease"],
    ["workspaces", "ManifestResponse"],
    ["workspaces", "UploadBegin"],
    ["workspaces", "UploadStatus"],
    ["workspaces", "UploadValidation"],
    ["common", "ProtocolError"],
    ["common", "Id"],
    ["conversations", "ReplayPage"],
    ["transfers", "TransferDescriptor"],
  ].map(([schema, name]) => {
    const key = `${schema}/${name}`;
    const fn = ajv.getSchema(
      `https://fortipi.dev/schemas/1.0.0/${schema}.schema.json#/$defs/${name}`,
    );
    if (!fn) throw new Error("Missing fixed control schema");
    return [key, fn] as const;
  }),
);
export function valid(schema: string, name: string, value: unknown): boolean {
  return validators.get(`${schema}/${name}`)?.(value) === true;
}
const modelActions = new Set([
  "conversations.create",
  "conversations.fork",
  "messages.submit",
  "conversations.steer",
  "tasks.resume",
]);
export class Directory {
  readonly store: Store;
  readonly identities: Identities;
  readonly env: Env;
  constructor(store: Store, identities: Identities, env: Env) {
    this.store = store;
    this.identities = identities;
    this.env = env;
  }
  config(): Env["FORTIPI_CONFIG"] {
    return this.store.get<D.Configuration>("config", "active") ?? this.env.FORTIPI_CONFIG;
  }
  policy(): D.InfrastructurePolicy {
    return this.config().infrastructure ?? freeInfrastructurePolicy;
  }
  registeredAuthority(ctx: D.AuthContext) {
    this.identities.current(ctx);
    const registration = this.store.get<D.AuthorityRegistration>(
      "recipient",
      ctx.registrationId ?? "",
    );
    if (!registration || !same(registration.credential, ref(ctx))) return undefined;
    if (registration.executor) {
      const executor = this.store.get<ExecutorState>("executor", registration.executor.executorId);
      if (
        !executor ||
        executor.status === "revoked" ||
        executor.generation !== registration.executor.generation
      )
        return undefined;
    }
    return registration;
  }
  registeredOperation(ctx: D.AuthContext) {
    const registration = this.registeredAuthority(ctx);
    if (registration?.recipient.kind !== "agent") return undefined;
    const resources = registration.resources;
    const agentId = registration.recipient.id;
    const action = resources.actions[0];
    if (
      resources.agentIds.length !== 1 ||
      resources.agentIds[0] !== agentId ||
      !valid("common", "Id", agentId) ||
      !this.store.get("agent", agentId) ||
      resources.actions.length !== 1 ||
      !action ||
      !roleAllows(ctx, action)
    )
      return undefined;
    // These are the actual Agent operations that use models/storage. The registration
    // is service-constructed; opaque operation IDs do not establish authority.
    const creation = action === "conversations.create";
    if (!modelActions.has(action) && action !== "jobs.dispatch") return undefined;
    if (
      creation
        ? resources.conversationIds.length !== 0
        : resources.conversationIds.length !== 1 ||
          !valid("common", "Id", resources.conversationIds[0])
    )
      return undefined;
    if (
      action === "jobs.dispatch" &&
      (resources.workspaceIds.length !== 1 ||
        !valid("common", "Id", resources.workspaceIds[0]) ||
        resources.tools.length !== 1 ||
        resources.tools[0] === "*" ||
        !resources.tools[0] ||
        !(
          (resources.executorIds.length === 1 &&
            valid("common", "Id", resources.executorIds[0]) &&
            resources.backendIds.length === 0) ||
          (resources.backendIds.length === 1 &&
            valid("common", "Id", resources.backendIds[0]) &&
            resources.executorIds.length === 0)
        ))
    )
      return undefined;
    const grant = ctx.grants.find(
      (g) =>
        (g.expiresAt === undefined || Date.now() < g.expiresAt) && contains(g.resources, resources),
    );
    if (!grant) return undefined;
    return { registration, action, grant };
  }
  registeredModel(ctx: D.AuthContext, agentId: string) {
    const authority = this.registeredOperation(ctx);
    check(
      authority &&
        modelActions.has(authority.action) &&
        authority.registration.recipient.id === agentId,
      "unauthorized",
      "Model resolution requires its current registered Agent operation",
    );
    const row = this.store.get<{ agent: D.Agent; model: D.ModelConfig }>("agent", agentId);
    check(row, "not_found", "Agent unavailable");
    return row;
  }
  async once<T>(
    ctx: D.AuthContext,
    namespace: string,
    requestId: string,
    body: unknown,
    fn: () => T,
  ): Promise<T> {
    const digest = await hash(json(body));
    const key = `${ctx.principalId}:${namespace}:${requestId}`;
    return this.store.tx(() => {
      this.identities.current(ctx);
      const old = this.store.get<{ digest: string; value: T }>("request", key);
      if (old) {
        check(old.digest === digest, "conflict", "Request identity changed");
        return old.value;
      }
      const value = fn();
      this.store.put("request", key, { digest, value });
      return value;
    });
  }
  async create(ctx: D.AuthContext, body: D.AgentCreate): Promise<D.Agent> {
    this.identities.current(ctx);
    requireGrant(ctx, "agents.create");
    check(valid("agents", "AgentCreate", body), "invalid_request", "Invalid agent configuration");
    return this.once(ctx, "agent.create", body.requestId, body, () => {
      const agent: D.Agent = {
        agentId: id(),
        name: body.name,
        configVersion: 1,
        model: { providerId: body.model.providerId, modelId: body.model.modelId },
        status: "idle",
      };
      this.store.put("agent", agent.agentId, { agent, model: body.model });
      audit(this.store, ctx, "agents.create", agent.agentId, "allowed");
      return agent;
    });
  }
  describe(ctx: D.AuthContext, agentId: string): D.Agent {
    this.identities.current(ctx);
    requireGrant(ctx, "agents.read", { ...emptyScope(), agentIds: [agentId] });
    const row = this.store.get<{ agent: D.Agent }>("agent", agentId);
    check(row, "not_found", "Agent unavailable");
    return row.agent;
  }
  list(ctx: D.AuthContext, query: D.PageQuery): D.AgentPage {
    this.identities.current(ctx);
    check(ctx.role !== "executor", "unauthorized", "Executor cannot access application directory");
    const after = this.cursor(ctx, "agents", query.pageToken);
    const limit = Math.min(100, query.limit ?? 100);
    check(limit > 0, "invalid_request", "Invalid page size");
    const rows = this.store.page<{ agent: D.Agent }>("agent", after, limit);
    const items = rows
      .filter((r) => permits(ctx.grants, { ...emptyScope(), agentIds: [r.key] }, "agents.read"))
      .map((r) => r.value.agent);
    return {
      items,
      ...(rows.length === limit
        ? { nextPageToken: this.token(ctx, "agents", rows.at(-1)?.seq ?? after) }
        : {}),
    };
  }
  async configure(ctx: D.AuthContext, agentId: string, body: D.AgentPatch): Promise<D.Agent> {
    this.identities.current(ctx);
    requireGrant(ctx, "agents.configure", { ...emptyScope(), agentIds: [agentId] });
    check(valid("agents", "AgentPatch", body), "invalid_request", "Invalid agent patch");
    return this.once(ctx, `agent.patch:${agentId}`, body.requestId, body, () => {
      const row = this.store.get<{ agent: D.Agent; model: D.ModelConfig }>("agent", agentId);
      check(row, "not_found", "Agent unavailable");
      check(row.agent.configVersion === body.expectedVersion, "conflict", "Agent version changed");
      const model = body.model ?? row.model;
      const agent: D.Agent = {
        ...row.agent,
        name: body.name ?? row.agent.name,
        configVersion: next(row.agent.configVersion),
        model: { providerId: model.providerId, modelId: model.modelId },
      };
      this.store.put("agent", agentId, { agent, model });
      return agent;
    });
  }
  async configureInstallation(
    ctx: D.AuthContext,
    body: D.ConfigurationPatch,
  ): Promise<D.Configuration> {
    this.identities.current(ctx);
    requireGrant(ctx, "configuration.write");
    check(
      valid("configuration", "ConfigurationPatch", body),
      "invalid_request",
      "Invalid configuration",
    );
    const policy = body.configuration.infrastructure;
    check(
      policy.bounds.requestsPerInstallMinute <= 1000,
      "invalid_request",
      "Control request rate exceeds bounded admission memory",
    );
    check(
      policy.bounds.headroomFraction >= 0.25 &&
        policy.bounds.sqlPageRows <= 100 &&
        policy.bounds.transferConcurrency <= 4,
      "invalid_request",
      "Unsafe infrastructure bounds",
    );
    if (policy.profile === "free" || policy.accountPlan !== "paid")
      for (const [key, value] of Object.entries(freeInfrastructurePolicy.bounds))
        if (key !== "headroomFraction")
          check(
            policy.bounds[key as keyof typeof policy.bounds] <= value,
            "invalid_request",
            "Free policy cannot raise bounds",
          );
    const deploymentPolicy = this.env.FORTIPI_CONFIG.infrastructure;
    for (const [key, value] of Object.entries(deploymentPolicy.bounds))
      if (key !== "headroomFraction")
        check(
          policy.bounds[key as keyof typeof policy.bounds] <= value,
          "unsupported",
          "Higher bounds require validated deployment policy",
        );
    for (const capability of policy.capabilities)
      check(
        deploymentPolicy.capabilities.some((c) => json(c) === json(capability)),
        "unsupported",
        "Capability evidence must come from deployment validation",
      );
    for (const model of body.configuration.models)
      if (model.providerId !== "cloudflare") {
        check("auth" in model, "invalid_request", "Model auth is required");
        check(
          ["openai", "anthropic", "openai-codex"].includes(model.providerId),
          "unsupported",
          "Provider adapter is not installed",
        );
        if (model.auth.kind === "oauth")
          check(
            model.auth.providerId === model.providerId && model.endpoint === undefined,
            "invalid_request",
            "OAuth uses fixed provider endpoints",
          );
        else
          check(
            model.providerId !== "openai-codex" &&
              model.auth.secretRef ===
                (model.providerId === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"),
            "invalid_request",
            "Invalid provider secretRef",
          );
        if (model.endpoint !== undefined)
          check(
            model.endpoint ===
              (model.providerId === "openai"
                ? "https://api.openai.com/v1"
                : "https://api.anthropic.com"),
            "invalid_request",
            "Endpoint is not allowlisted",
          );
      }
    const execution = body.configuration.execution;
    if (execution.kind !== "native") {
      const capability = execution.kind === "cloud-js" ? "loader" : "containers";
      check(
        policy.accountPlan === "paid" &&
          policy.capabilities.some(
            (c) =>
              c.capability === capability &&
              c.state === "available" &&
              c.deploymentId === this.identities.deploymentId,
          ) &&
          (capability === "loader" ? this.env.LOADER : this.env.LINUX_CONTAINERS),
        "unsupported",
        "Selected backend requires available deployment capability",
      );
    }
    await this.store.arm();
    return this.once(ctx, "config", body.requestId, body, () => {
      check(
        this.config().version === body.expectedVersion,
        "conflict",
        "Configuration version changed",
      );
      check(
        body.configuration.version === next(body.expectedVersion),
        "invalid_request",
        "Configuration must advance one version",
      );
      this.store.put("config", "active", body.configuration);
      queueRepairResume(this.store, "configuration");
      audit(this.store, ctx, "configuration.write", "installation", "allowed");
      return body.configuration;
    });
  }
  token(ctx: D.AuthContext, view: string, seq: number): string {
    return btoa(json({ principal: ctx.principalId, generation: ctx.generation, view, seq }));
  }
  cursor(ctx: D.AuthContext, view: string, token?: string): number {
    if (!token) return 0;
    try {
      check(token.length <= 1024, "cursor.invalid", "Invalid cursor");
      const data = JSON.parse(atob(token)) as {
        principal: string;
        generation: number;
        view: string;
        seq: number;
      };
      check(
        data.principal === ctx.principalId &&
          data.generation === ctx.generation &&
          data.view === view &&
          Number.isSafeInteger(data.seq) &&
          data.seq >= 0,
        "cursor.invalid",
        "Cursor scope changed",
      );
      return data.seq;
    } catch {
      fail("cursor.invalid", "Invalid cursor");
    }
  }
}
