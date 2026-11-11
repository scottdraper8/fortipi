import { DurableObject } from "cloudflare:workers";
import { errorStatuses, routeCatalog, validateBrowserOrigin } from "fortipi-contract";
import type { ControlPlaneRpc } from "../boundary/control-plane.js";
import type * as D from "../boundary/dto.js";
import type { Env } from "../boundary/env.js";
import { Artifacts } from "./artifacts.js";
import { emptyScope, permits, requireGrant, roleAllows } from "./authorization.js";
import { Bindings } from "./bindings.js";
import { Capacity } from "./capacity.js";
import { Delivery } from "./delivery.js";
import { Directory, valid } from "./directory.js";
import { Dispatch } from "./dispatch.js";
import { Executors } from "./executors.js";
import { Identities } from "./identity.js";
import { LocalWorkspace } from "./local-workspace.js";
import { ProviderAuth } from "./provider-auth.js";
import { Relay } from "./relay.js";
import { drainRepairResume, postponeRepair, repairEligible } from "./repair.js";
import { Revocations } from "./revocation.js";
import { ControlError, check, fail, id, json, outcome, Store, same } from "./store.js";
import { type ExecutorState, Tickets } from "./tickets.js";
import { WorkspaceLeases } from "./workspace-leases.js";

export class ControlPlane extends DurableObject<Env> implements ControlPlaneRpc {
  get contractVersion(): "1.0" {
    return "1.0";
  }
  readonly store: Store;
  readonly identities: Identities;
  readonly directory: Directory;
  readonly capacity: Capacity;
  readonly tickets: Tickets;
  readonly executors: Executors;
  readonly dispatch: Dispatch;
  readonly delivery: Delivery;
  readonly revocations: Revocations;
  readonly providerAuth: ProviderAuth;
  readonly local: LocalWorkspace;
  readonly relay: Relay;
  readonly artifacts: Artifacts;
  readonly bindings: Bindings;
  readonly leases: WorkspaceLeases;
  private readonly initialized: Promise<void>;
  private readonly origins = new Map<string, { value: string; deadline: number }>();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new Store(
      ctx.storage,
      env.FORTIPI_CONFIG.infrastructure.bounds.objectBytes *
        (1 - env.FORTIPI_CONFIG.infrastructure.bounds.headroomFraction),
    );
    // A deployment uses one stable named singleton. Its ID is public nonsecret scope, not an authority.
    this.identities = new Identities(this.store, ctx.id.toString());
    this.directory = new Directory(this.store, this.identities, env);
    this.capacity = new Capacity(this.store, this.identities, this.directory);
    this.tickets = new Tickets(this.store, this.identities);
    this.bindings = new Bindings(this.store, this.identities, this.tickets, this.directory, env);
    this.delivery = new Delivery(this.store, this.identities, this.directory, env, this.tickets);
    this.executors = new Executors(ctx, this.store, this.identities, (auth, frame) =>
      frame.frame.type === "transfer.status"
        ? this.relay.receiveStatus(auth, frame)
        : this.delivery.receive(auth, frame),
    );
    this.dispatch = new Dispatch(
      this.store,
      this.identities,
      this.tickets,
      this.executors,
      this.directory,
    );
    this.local = new LocalWorkspace(this.store, this.identities, this.executors, env);
    this.leases = new WorkspaceLeases(
      this.store,
      this.identities,
      this.bindings,
      this.dispatch,
      env,
      this.local,
    );
    this.relay = new Relay(this.store, this.identities, this.directory, this.executors, env);
    this.artifacts = new Artifacts(this.store, this.identities, this.relay, this.tickets);
    this.revocations = new Revocations(this.store, this.identities, env, (subject) => {
      this.executors.close(subject);
      this.relay.revoke(subject);
    });
    this.providerAuth = new ProviderAuth(
      this.store,
      this.identities,
      env,
      () => this.directory.config(),
      this.providerTransport(),
    );
    this.initialized = ctx.blockConcurrencyWhile(async () => {
      await this.identities.bootstrap(env.FORTIPI_ADMIN_TOKEN);
      await this.store.rearm();
    });
  }
  protected providerTransport(): typeof fetch {
    return fetch;
  }
  private async call<T>(ctx: D.AuthContext, fn: () => Promise<T> | T): Promise<D.Outcome<T>> {
    return outcome(ctx.requestId, async () => {
      await this.initialized;
      this.identities.current(ctx);
      this.capacity.admitRequest(ctx.principalId);
      return fn();
    });
  }
  async authenticate(input: D.CredentialProof): Promise<D.Outcome<D.AuthContext>> {
    return outcome(input.requestId, async () => {
      await this.initialized;
      const auth = await this.identities.authenticate(input);
      this.capacity.admitRequest(auth.principalId);
      if (input.origin) {
        validateBrowserOrigin(input.origin);
        for (const [key, origin] of this.origins)
          if (origin.deadline <= Date.now()) this.origins.delete(key);
        if (this.origins.size >= 256) {
          const first = this.origins.keys().next().value;
          if (first) this.origins.delete(first);
        }
        this.origins.set(auth.requestId, { value: input.origin, deadline: auth.deadline });
      }
      return auth;
    });
  }
  async authorize(input: D.AuthorizationRequest): Promise<D.Outcome<D.GrantDecision>> {
    return this.call(input.principal, () =>
      roleAllows(input.principal, input.action) &&
      permits(input.principal.grants, input.resources, input.action)
        ? {
            allowed: true,
            grants: input.principal.grants,
            grantVersion: input.principal.grantVersion,
          }
        : { allowed: false, reason: "scope" },
    );
  }
  async registerAuthorityRecipient(
    ctx: D.AuthContext,
    input: D.AuthorityRecipientRequest,
  ): Promise<D.Outcome<D.AuthorityRegistration>> {
    return this.call(ctx, () => this.tickets.register(ctx, input));
  }
  async resolveExecutorGeneration(
    ctx: D.AuthContext,
    input: { workspaceId: string; bindingVersion: number; executorId: string },
  ): Promise<
    D.Outcome<{
      executorId: string;
      executorGeneration: number;
      transferLimits: D.ExecutorTransferLimits | null;
    }>
  > {
    return this.call(ctx, () => this.bindings.resolve(ctx, input));
  }
  async reserveCapacity(
    ctx: D.AuthContext,
    input: Parameters<ControlPlaneRpc["reserveCapacity"]>[1],
  ): Promise<D.Outcome<D.CapacityReservation>> {
    return this.call(ctx, () => this.capacity.reserve(ctx, input));
  }
  async settleCapacity(
    ctx: D.AuthContext,
    input: Parameters<ControlPlaneRpc["settleCapacity"]>[1],
  ): Promise<D.Outcome<D.CapacityReservation>> {
    return outcome(ctx.requestId, async () => {
      await this.initialized;
      this.identities.current(ctx);
      this.capacity.admitSettlement(ctx, input);
      await this.store.arm();
      return this.capacity.settle(ctx, input);
    });
  }
  async reserveTarget(
    ctx: D.AuthContext,
    input: D.TargetRequest,
  ): Promise<D.Outcome<D.TargetReservation>> {
    return this.call(ctx, () => this.dispatch.reserve(ctx, input));
  }
  async recordDispatchIntent(
    ctx: D.AuthContext,
    input: D.DispatchIntent,
  ): Promise<D.Outcome<D.DispatchReceipt>> {
    return this.call(ctx, () => this.dispatch.intent(ctx, input));
  }
  async assignOnce(ctx: D.AuthContext, input: D.Assignment): Promise<D.Outcome<D.DispatchAck>> {
    return this.call(ctx, () => this.dispatch.assign(ctx, input));
  }
  async queryExecution(
    ctx: D.AuthContext,
    input: D.ExecutionIdentity,
  ): Promise<D.Outcome<D.ExecutionObservation>> {
    return this.call(ctx, () => this.dispatch.query(ctx, input));
  }
  async cancelExecution(
    ctx: D.AuthContext,
    input: D.CancelRequest,
  ): Promise<D.Outcome<D.CancelDisposition>> {
    return this.call(ctx, () => this.dispatch.cancel(ctx, input));
  }
  async deliverExecutorFrame(
    ctx: D.AuthContext,
    input: D.ExecutorDelivery,
  ): Promise<D.Outcome<D.DeliveryAck>> {
    return this.call(ctx, () => {
      check(
        new TextEncoder().encode(json(input.frame)).length <= 1048576,
        "payload_too_large",
        "Executor frame exceeds the transport body bound",
      );
      check(
        valid("executor-messages", "ExecutorFrame", input.frame),
        "invalid_request",
        "Invalid executor delivery frame",
      );
      return ctx.role === "executor"
        ? input.frame.type === "transfer.status"
          ? this.relay.receiveStatus(ctx, input)
          : this.delivery.receive(ctx, input)
        : this.delivery.forward(ctx, input, this.executors);
    });
  }
  async requestLocalWorkspace(
    ctx: D.AuthContext,
    input: D.LocalWorkspaceRequest,
  ): Promise<D.Outcome<D.LocalWorkspaceResponse>> {
    return this.call(ctx, () => {
      check(
        new TextEncoder().encode(json(input)).length <= 1048576,
        "payload_too_large",
        "Local request exceeds the transport body bound",
      );
      this.bindings.validateLocalRead(ctx, input);
      if (!("lease" in input)) this.relay.validateRead(ctx, input);
      return this.local.request(ctx, input);
    });
  }
  async openTransfer(
    ctx: D.AuthContext,
    input: Parameters<ControlPlaneRpc["openTransfer"]>[1],
  ): Promise<D.Outcome<D.TransferDescriptor>> {
    return this.call(ctx, () => {
      check(
        new TextEncoder().encode(json(input)).length <= 1048576,
        "payload_too_large",
        "Transfer metadata exceeds the transport body bound",
      );
      check(
        valid("transfers", "TransferDescriptor", {
          ...input,
          transferId: "validation",
          attemptId: "validation",
        }),
        "invalid_request",
        "Invalid transfer descriptor",
      );
      const registration = this.tickets.register(ctx, {
        credential: input.credential,
        recipient: { kind: "workspace", id: input.workspaceId },
        resources: input.consumer,
        executor: { executorId: input.executorId, generation: input.executorGeneration },
      });
      return this.relay.open({ ...ctx, registrationId: registration.registrationId }, input);
    });
  }
  async observeTransfer(
    ctx: D.AuthContext,
    input: { transferId: string; attemptId: string },
  ): Promise<D.Outcome<D.TransferStatus>> {
    return this.call(ctx, () => this.relay.observe(ctx, input));
  }
  async consumeTicket(input: D.TicketRedemption): Promise<D.Outcome<D.SocketIdentity>> {
    return outcome(id(), async () => {
      await this.initialized;
      return this.tickets.consume(input);
    });
  }
  async pageFacts(ctx: D.AuthContext, input: D.FactPageRequest): Promise<D.Outcome<D.FactPage>> {
    return this.call(ctx, () => this.delivery.page(ctx, input));
  }
  async ackFacts(ctx: D.AuthContext, input: D.FactAckRequest): Promise<D.Outcome<D.FactAck>> {
    return this.call(ctx, () => this.delivery.ack(ctx, input));
  }
  async resolveProviderAuth(
    ctx: D.ModelResolutionContext,
    input: Parameters<ControlPlaneRpc["resolveProviderAuth"]>[1],
  ): Promise<D.Outcome<D.ResolvedProviderAuth>> {
    return outcome(id(), async () => {
      await this.initialized;
      return this.providerAuth.resolve(ctx, input);
    });
  }
  async listAgents(
    ctx: D.AuthContext,
    input: D.OperationRequest<"listAgents">,
  ): Promise<D.Outcome<D.OperationResponse<"listAgents">>> {
    return this.call(ctx, () => this.listAgentsValue(ctx, input));
  }
  private listAgentsValue(
    ctx: D.AuthContext,
    input: D.OperationRequest<"listAgents">,
  ): D.OperationResponse<"listAgents"> {
    return { status: 200, body: this.directory.list(ctx, input.query) };
  }
  async createAgent(
    ctx: D.AuthContext,
    input: D.OperationRequest<"createAgent">,
  ): Promise<D.Outcome<D.OperationResponse<"createAgent">>> {
    return this.call(ctx, () => this.createAgentValue(ctx, input));
  }
  private async createAgentValue(
    ctx: D.AuthContext,
    input: D.OperationRequest<"createAgent">,
  ): Promise<D.OperationResponse<"createAgent">> {
    return {
      status: 201,
      body: await this.directory.create(ctx, input.body),
    };
  }
  async describeAgent(
    ctx: D.AuthContext,
    input: D.OperationRequest<"describeAgent">,
  ): Promise<D.Outcome<D.OperationResponse<"describeAgent">>> {
    return this.call(ctx, () => this.describeAgentValue(ctx, input));
  }
  private describeAgentValue(
    ctx: D.AuthContext,
    input: D.OperationRequest<"describeAgent">,
  ): D.OperationResponse<"describeAgent"> {
    return {
      status: 200,
      body: this.directory.describe(ctx, input.path.agentId),
    };
  }
  async configureAgent(
    ctx: D.AuthContext,
    input: D.OperationRequest<"configureAgent">,
  ): Promise<D.Outcome<D.OperationResponse<"configureAgent">>> {
    return this.call(ctx, () => this.configureAgentValue(ctx, input));
  }
  private async configureAgentValue(
    ctx: D.AuthContext,
    input: D.OperationRequest<"configureAgent">,
  ): Promise<D.OperationResponse<"configureAgent">> {
    return {
      status: 200,
      body: await this.directory.configure(ctx, input.path.agentId, input.body),
    };
  }
  async mintCredential(
    ctx: D.AuthContext,
    input: D.OperationRequest<"mintCredential">,
  ): Promise<D.Outcome<D.OperationResponse<"mintCredential">>> {
    return this.call(ctx, () => this.mintCredentialValue(ctx, input));
  }
  private async mintCredentialValue(
    ctx: D.AuthContext,
    input: D.OperationRequest<"mintCredential">,
  ): Promise<D.OperationResponse<"mintCredential">> {
    check(
      valid("administration", "CredentialMint", input.body),
      "invalid_request",
      "Invalid credential request",
    );
    return { status: 201, body: await this.identities.mint(ctx, input.body) };
  }
  async acquireWorkspaceLease(
    ctx: D.AuthContext,
    input: D.OperationRequest<"acquireWorkspaceLease">,
  ): Promise<D.Outcome<D.OperationResponse<"acquireWorkspaceLease">>> {
    return this.call(ctx, () => this.acquireWorkspaceLeaseValue(ctx, input));
  }
  private async acquireWorkspaceLeaseValue(
    ctx: D.AuthContext,
    input: D.OperationRequest<"acquireWorkspaceLease">,
  ): Promise<D.OperationResponse<"acquireWorkspaceLease">> {
    return {
      status: 201,
      body: await this.leases.acquire(ctx, input),
    };
  }
  async renewWorkspaceLease(
    ctx: D.AuthContext,
    input: D.OperationRequest<"renewWorkspaceLease">,
  ): Promise<D.Outcome<D.OperationResponse<"renewWorkspaceLease">>> {
    return this.call(ctx, () => this.renewWorkspaceLeaseValue(ctx, input));
  }
  private async renewWorkspaceLeaseValue(
    ctx: D.AuthContext,
    input: D.OperationRequest<"renewWorkspaceLease">,
  ): Promise<D.OperationResponse<"renewWorkspaceLease">> {
    return { status: 200, body: await this.leases.renew(ctx, input) };
  }
  async releaseWorkspaceLease(
    ctx: D.AuthContext,
    input: D.OperationRequest<"releaseWorkspaceLease">,
  ): Promise<D.Outcome<D.OperationResponse<"releaseWorkspaceLease">>> {
    return this.call(ctx, () => this.releaseWorkspaceLeaseValue(ctx, input));
  }
  private async releaseWorkspaceLeaseValue(
    ctx: D.AuthContext,
    input: D.OperationRequest<"releaseWorkspaceLease">,
  ): Promise<D.OperationResponse<"releaseWorkspaceLease">> {
    return {
      status: 200,
      body: await this.leases.release(ctx, input),
    };
  }
  async revokeCredential(
    ctx: D.AuthContext,
    input: D.OperationRequest<"revokeCredential">,
  ): Promise<D.Outcome<D.OperationResponse<"revokeCredential">>> {
    return this.call(ctx, () => this.revokeCredentialValue(ctx, input));
  }
  private async revokeCredentialValue(
    ctx: D.AuthContext,
    input: D.OperationRequest<"revokeCredential">,
  ): Promise<D.OperationResponse<"revokeCredential">> {
    const receipt = await this.revocations.revoke(ctx, "credential", input.path.id, input.body);
    return receipt.state === "complete"
      ? { status: 200, body: receipt }
      : { status: 202, body: receipt };
  }
  async revokeExecutor(
    ctx: D.AuthContext,
    input: D.OperationRequest<"revokeExecutor">,
  ): Promise<D.Outcome<D.OperationResponse<"revokeExecutor">>> {
    return this.call(ctx, () => this.revokeExecutorValue(ctx, input));
  }
  private async revokeExecutorValue(
    ctx: D.AuthContext,
    input: D.OperationRequest<"revokeExecutor">,
  ): Promise<D.OperationResponse<"revokeExecutor">> {
    const receipt = await this.revocations.revoke(ctx, "executor", input.path.id, input.body);
    return receipt.state === "complete"
      ? { status: 200, body: receipt }
      : { status: 202, body: receipt };
  }
  async rotateCredential(
    ctx: D.AuthContext,
    input: D.OperationRequest<"rotateCredential">,
  ): Promise<D.Outcome<D.OperationResponse<"rotateCredential">>> {
    return this.call(ctx, () => this.rotateCredentialValue(ctx, input));
  }
  private async rotateCredentialValue(
    ctx: D.AuthContext,
    input: D.OperationRequest<"rotateCredential">,
  ): Promise<D.OperationResponse<"rotateCredential">> {
    requireGrant(ctx, "credentials.rotate");
    const old = this.store.get<import("./identity.js").CredentialRecord>(
      "credential",
      input.path.id,
    );
    check(old, "not_found", "Credential unavailable");
    requireGrant(ctx, "credentials.revoke");
    await this.store.arm();
    const common = {
      requestId: input.body.requestId,
      grants: old.grants,
      ...(old.expiresAt === null ? {} : { expiresAt: old.expiresAt }),
    };
    const body: D.CredentialMint =
      old.role === "executor"
        ? { ...common, role: "executor", executorId: old.executorId ?? "" }
        : { ...common, role: old.role };
    let rev: ReturnType<Revocations["begin"]> | undefined;
    const rotationKey = `${ctx.principalId}:${input.path.id}:${input.body.requestId}`;
    const previous = this.store.get<{ input: D.RevocationInput; revocationId: string }>(
      "rotation",
      rotationKey,
    );
    if (previous) check(same(previous.input, input.body), "conflict", "Rotation request changed");
    const replacement = await this.identities.mint(
      ctx,
      body,
      () => {
        rev = this.revocations.begin(ctx, "credential", input.path.id, input.body);
        this.store.put("rotation", rotationKey, {
          input: input.body,
          revocationId: rev.revocationId,
        });
      },
      `rotate:${input.path.id}`,
    );
    const revocation = rev
      ? await this.revocations.publish(rev)
      : this.revocations.receipt(previous?.revocationId ?? "");
    return { status: 201, body: { replacement, revocation } };
  }
  async mintTicket(
    ctx: D.AuthContext,
    input: D.OperationRequest<"mintConnectionTicket">,
  ): Promise<D.Outcome<D.OperationResponse<"mintConnectionTicket">>> {
    return this.call(ctx, () => this.mintTicketValue(ctx, input));
  }
  private async mintTicketValue(
    ctx: D.AuthContext,
    input: D.OperationRequest<"mintConnectionTicket">,
  ): Promise<D.OperationResponse<"mintConnectionTicket">> {
    check(
      valid("administration", "TicketInput", input.body),
      "invalid_request",
      "Invalid ticket request",
    );
    const origin = this.origins.get(ctx.requestId);
    this.origins.delete(ctx.requestId);
    return { status: 201, body: await this.tickets.mint(ctx, input.body, origin?.value) };
  }
  async getProviderAuthStatus(
    ctx: D.AuthContext,
    input: D.OperationRequest<"getProviderAuthStatus">,
  ): Promise<D.Outcome<D.OperationResponse<"getProviderAuthStatus">>> {
    return this.call(ctx, () => this.getProviderAuthStatusValue(ctx, input));
  }
  private getProviderAuthStatusValue(
    ctx: D.AuthContext,
    input: D.OperationRequest<"getProviderAuthStatus">,
  ): D.OperationResponse<"getProviderAuthStatus"> {
    return {
      status: 200,
      body: this.providerAuth.status(ctx, input.path.providerId),
    };
  }
  async putProviderAuth(
    ctx: D.AuthContext,
    input: D.OperationRequest<"putProviderAuth">,
  ): Promise<D.Outcome<D.OperationResponse<"putProviderAuth">>> {
    return this.call(ctx, () => this.putProviderAuthValue(ctx, input));
  }
  private async putProviderAuthValue(
    ctx: D.AuthContext,
    input: D.OperationRequest<"putProviderAuth">,
  ): Promise<D.OperationResponse<"putProviderAuth">> {
    return {
      status: 200,
      body: await this.providerAuth.put(ctx, input.path.providerId, input.body),
    };
  }
  async deleteProviderAuth(
    ctx: D.AuthContext,
    input: D.OperationRequest<"deleteProviderAuth">,
  ): Promise<D.Outcome<D.OperationResponse<"deleteProviderAuth">>> {
    return this.call(ctx, () => this.deleteProviderAuthValue(ctx, input));
  }
  private async deleteProviderAuthValue(
    ctx: D.AuthContext,
    input: D.OperationRequest<"deleteProviderAuth">,
  ): Promise<D.OperationResponse<"deleteProviderAuth">> {
    return {
      status: 200,
      body: await this.providerAuth.remove(ctx, input.path.providerId, input.body),
    };
  }
  async handleApi<K extends D.ControlOperationId>(
    ctx: D.AuthContext,
    input: D.OperationRequest<K>,
  ): Promise<D.Outcome<D.OperationResponse<K>>> {
    const request = input as D.OperationRequest<D.ControlOperationId>;
    const value = await this.call(ctx, async () => {
      const route = routeCatalog.find((r) => r.operationId === request.operationId);
      check(route, "invalid_request", "Unknown control operation");
      check(
        roleAllows(ctx, route.action),
        "unauthorized",
        "Credential role cannot access this audience",
      );
      // Individual methods perform resource checks; management reads are installation scoped.
      switch (request.operationId) {
        case "listAgents":
          return this.listAgentsValue(ctx, request);
        case "createAgent":
          return this.createAgentValue(ctx, request);
        case "describeAgent":
          return this.describeAgentValue(ctx, request);
        case "configureAgent":
          return this.configureAgentValue(ctx, request);
        case "acquireWorkspaceLease":
          return this.acquireWorkspaceLeaseValue(ctx, request);
        case "renewWorkspaceLease":
          return this.renewWorkspaceLeaseValue(ctx, request);
        case "releaseWorkspaceLease":
          return this.releaseWorkspaceLeaseValue(ctx, request);
        case "mintCredential":
          return this.mintCredentialValue(ctx, request);
        case "revokeCredential":
          return this.revokeCredentialValue(ctx, request);
        case "rotateCredential":
          return this.rotateCredentialValue(ctx, request);
        case "revokeExecutor":
          return this.revokeExecutorValue(ctx, request);
        case "mintConnectionTicket":
          return this.mintTicketValue(ctx, request);
        case "getProviderAuthStatus":
          return this.getProviderAuthStatusValue(ctx, request);
        case "putProviderAuth":
          return this.putProviderAuthValue(ctx, request);
        case "deleteProviderAuth":
          return this.deleteProviderAuthValue(ctx, request);
        case "getConfiguration": {
          requireGrant(ctx, route.action);
          const config = this.directory.config();
          check("models" in config, "unavailable", "Installation configuration is incomplete");
          return { status: 200, body: config };
        }
        case "patchConfiguration":
          return {
            status: 200,
            body: await this.directory.configureInstallation(ctx, request.body),
          };
        case "listWorkspaces":
          return { status: 200, body: this.bindings.list(ctx, request.query) };
        case "createWorkspace":
          return { status: 201, body: await this.bindings.create(ctx, request.body) };
        case "rebindWorkspace":
          return {
            status: 200,
            body: await this.bindings.rebind(ctx, request.path.workspaceId, request.body),
          };
        case "listExecutors": {
          const rows = this.store.page<ExecutorState>(
            "executor",
            this.directory.cursor(ctx, "executors", request.query.pageToken),
            request.query.limit ?? 100,
          );
          const items = rows
            .filter(
              (r) =>
                r.value.description &&
                permits(ctx.grants, { ...emptyScope(), executorIds: [r.key] }, route.action),
            )
            .map((r) => {
              const description = r.value.description;
              check(description, "internal", "Missing executor description");
              try {
                this.executors.channel(r.key, r.value.generation);
                return description;
              } catch {
                return { ...description, state: "offline" as const };
              }
            });
          return { status: 200, body: { items } };
        }
        case "listModels": {
          requireGrant(ctx, route.action);
          const config = this.directory.config();
          const view = `models:${config.version}`;
          const after = this.directory.cursor(ctx, view, request.query.pageToken);
          const limit = request.query.limit ?? 100;
          check(
            Number.isSafeInteger(limit) && limit > 0 && limit <= 100,
            "invalid_request",
            "Invalid page size",
          );
          const configured = "models" in config ? config.models : [];
          const selected = configured.slice(after, after + limit);
          return {
            status: 200,
            body: {
              items: selected.map((m) => {
                const model = this.providerAuth.models.getModel(m.providerId, m.modelId);
                return {
                  providerId: m.providerId,
                  modelId: m.modelId,
                  capabilities: model
                    ? [...model.input, ...(model.reasoning ? ["reasoning"] : [])]
                    : [],
                  available:
                    m.providerId === "cloudflare"
                      ? !!this.env.AI
                      : !!model &&
                        ("auth" in m && m.auth.kind === "secretRef"
                          ? !!(m.auth.secretRef === "OPENAI_API_KEY"
                              ? this.env.OPENAI_API_KEY
                              : m.auth.secretRef === "ANTHROPIC_API_KEY"
                                ? this.env.ANTHROPIC_API_KEY
                                : undefined)
                          : this.providerAuth.keyConfigured &&
                            this.providerAuth.credentials.status(m.providerId).state ===
                              "configured"),
                };
              }),
              ...(after + selected.length < configured.length
                ? { nextPageToken: this.directory.token(ctx, view, after + selected.length) }
                : {}),
            },
          };
        }
        case "getUsage": {
          requireGrant(ctx, route.action);
          const usage = this.capacity.usage();
          return {
            status: 200,
            body: {
              policy: this.directory.policy(),
              pressure: this.capacity.pressure(),
              reservedBytes: usage.reserved,
              observedBytes: usage.consumed,
            },
          };
        }
        case "getAdminHealth": {
          requireGrant(ctx, route.action);
          const pressure = this.capacity.pressure();
          return {
            status: 200,
            body: { state: pressure.length ? "degraded" : "healthy", pressure },
          };
        }
        case "listAudit": {
          requireGrant(ctx, route.action);
          const rows = this.store.page<D.AuditEntry>(
            "audit",
            this.directory.cursor(ctx, "audit", request.query.pageToken),
            request.query.limit ?? 100,
          );
          return {
            status: 200,
            body: {
              items: rows.map((r) => r.value),
              ...(rows.length
                ? { nextPageToken: this.directory.token(ctx, "audit", rows.at(-1)?.seq ?? 0) }
                : {}),
            },
          };
        }
        case "getAdminOperation": {
          requireGrant(ctx, route.action);
          const rev = this.store.get<{ revocationId: string }>("admin_operation", request.path.id);
          check(rev, "not_found", "Operation unavailable");
          const receipt = this.revocations.receipt(rev.revocationId);
          return {
            status: 200,
            body: {
              operationId: receipt.operationId,
              kind: "revocation",
              state: receipt.state === "complete" ? "completed" : "pending",
              artifacts: [],
            },
          };
        }
        default:
          requireGrant(ctx, route.action);
          fail("unavailable", "This aggregate operation requires the service coordinator");
      }
    });
    // Generic operation correlation is checked by the individual ports; this cast erases only K.
    return value as D.Outcome<D.OperationResponse<K>>;
  }
  async alarm(): Promise<void> {
    await this.initialized;
    const pause = this.store.get<{ until: number }>("repair_pause", "control");
    if (pause && pause.until > Date.now()) {
      await this.store.finishAlarm();
      return;
    }
    if (pause) this.store.remove("repair_pause", "control");
    const due = this.store.due(Date.now(), 16);
    if (due.length === 0) {
      await this.store.finishAlarm();
      return;
    }
    const alarmVersion = await this.store.arm(Date.now() + 10000);
    const stopAt = Date.now() + 10000;
    for (const task of due) {
      if (Date.now() >= stopAt) break;
      if (!repairEligible(this.store, task.kind, task.key)) continue;
      try {
        this.capacity.admitRepair();
      } catch (error) {
        if (!(error instanceof ControlError) || error.code !== "rate_limited") throw error;
        this.store.put("repair_pause", "control", {
          until: (Math.floor(Date.now() / 60000) + 1) * 60000,
        });
        break;
      }
      try {
        if (task.kind === "revocation" || task.kind === "fanout")
          await this.revocations.drain(task.kind, task.key);
        else if (task.kind === "inbox") await this.delivery.drain(task.key);
        else if (task.kind === "binding_request") await this.bindings.drain(task.key);
        else if (task.kind === "command")
          await this.delivery.drainCommand(task.key, this.executors);
        else if (task.kind === "presence_transition") this.delivery.presence(task.key);
        else if (task.kind === "fact") await this.delivery.drainFact(task.key);
        else if (task.kind === "ticket") this.store.remove("ticket", task.key);
        else if (task.kind === "presence_check") this.executors.expire();
        else if (task.kind === "transfer") this.relay.expire(task.key);
        else if (task.kind === "repair_resume") drainRepairResume(this.store);
      } catch (error) {
        postponeRepair(this.store, task.kind, task.key, error, Date.now() + 60000);
        break;
      }
    }
    await this.store.finishAlarm(alarmVersion);
  }
  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      await this.initialized;
      await this.executors.message(socket, message);
    } catch (error) {
      const code = error instanceof ControlError ? error.code : "invalid_request";
      const closeCode =
        code === "payload_too_large"
          ? 1009
          : code === "invalid_request"
            ? 1007
            : code === "unavailable" || code === "rate_limited" || code === "quota_exceeded"
              ? 1013
              : 1008;
      socket.close(closeCode, "Executor frame rejected");
    }
  }
  async webSocketClose(socket: WebSocket): Promise<void> {
    socket.close(1000, "Executor disconnected");
    await this.store.arm();
    const attachment = this.executors.attachment(socket);
    const executor = attachment?.identity.executor;
    if (
      executor &&
      this.store.get<ExecutorState>("executor", executor.executorId)?.epoch === attachment.epoch
    )
      this.relay.revoke({
        kind: "executor",
        executorId: executor.executorId,
        minimumGeneration: executor.generation,
      });
    this.executors.closed(socket);
  }
  async webSocketError(socket: WebSocket): Promise<void> {
    socket.close(1011, "Executor transport error");
    await this.store.arm();
    this.executors.closed(socket);
  }
  async fetch(request: Request): Promise<Response> {
    await this.initialized;
    const requestId = id();
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const headers = new Headers({ "Cache-Control": "no-store", Vary: "Origin" });
    const origins = this.env.FORTIPI_ALLOWED_ORIGINS ?? [];
    check(
      origins.length <= 16 &&
        origins.every((value) => {
          try {
            const parsed = new URL(value);
            return parsed.protocol === "https:" && parsed.origin === value;
          } catch {
            return false;
          }
        }),
      "invalid_request",
      "Invalid deployment Origin allowlist",
    );
    const cors = origin === null || origin === url.origin || origins.includes(origin);
    if (origin && cors) headers.set("Access-Control-Allow-Origin", origin);
    const result = await outcome(requestId, async () => {
      check(url.protocol === "https:", "unauthorized", "HTTPS required");
      check(cors && origin !== "null", "unauthorized", "Origin not allowed");
      if (request.method === "OPTIONS") {
        check(
          ["GET", "PUT", "POST", "DELETE", "PATCH"].includes(
            request.headers.get("Access-Control-Request-Method") ?? "",
          ),
          "invalid_request",
          "Unsupported preflight method",
        );
        check(
          (request.headers.get("Access-Control-Request-Headers") ?? "")
            .split(",")
            .filter(Boolean)
            .every((header) =>
              ["authorization", "content-type"].includes(header.trim().toLowerCase()),
            ),
          "unauthorized",
          "Unsupported preflight header",
        );
        headers.set("Access-Control-Allow-Methods", "GET,PUT,POST,DELETE,PATCH,OPTIONS");
        headers.set("Access-Control-Allow-Headers", "Authorization,Content-Type");
        return new Response(null, { status: 204, headers });
      }
      if (url.pathname === "/v1/stream") {
        check(
          [...url.searchParams].length === 1 &&
            valid("administration", "TicketQuery", Object.fromEntries(url.searchParams)),
          "invalid_request",
          "Invalid stream query",
        );
        const [identity, auth] = await this.tickets.consumeStream(
          url.searchParams.get("ticket") ?? "",
          origin ? { kind: "browser", value: origin } : { kind: "native" },
        );
        this.identities.current(auth);
        check(
          request.method === "GET" &&
            request.headers.get("Upgrade")?.toLowerCase() === "websocket" &&
            !request.headers.has("Sec-WebSocket-Protocol"),
          "invalid_request",
          "Native WebSocket upgrade required",
        );
        const forwarded = new Headers();
        for (const name of [
          "Upgrade",
          "Connection",
          "Sec-WebSocket-Key",
          "Sec-WebSocket-Version",
          "Sec-WebSocket-Extensions",
          "Origin",
        ]) {
          const value = request.headers.get(name);
          if (value !== null) forwarded.set(name, value);
        }
        const socketEnvelope = json(identity);
        const authEnvelope = json(auth);
        check(
          new TextEncoder().encode(socketEnvelope).length +
            new TextEncoder().encode(authEnvelope).length <=
            65536,
          "invalid_request",
          "Stream authority headers exceed bound",
        );
        forwarded.set("X-Fortipi-Socket", socketEnvelope);
        forwarded.set("X-Fortipi-Context", authEnvelope);
        const agentId = identity.resources.agentIds[0];
        check(agentId, "invalid_request", "Missing stream agent");
        return this.env.AGENT_SESSIONS.getByName(agentId).fetch(
          new Request("https://agent.internal/v1/stream", {
            method: "GET",
            headers: forwarded,
            signal: request.signal,
          }),
        );
      }
      if (url.pathname === "/v1/executor/session") {
        const identity = await this.tickets.consume({
          ticket: url.searchParams.get("ticket") ?? "",
          deploymentId: this.identities.deploymentId,
          audience: "executor-session",
          origin: origin ? { kind: "browser", value: origin } : { kind: "native" },
          destination: { kind: "control" },
        });
        check(
          request.method === "GET" && request.headers.get("Upgrade")?.toLowerCase() === "websocket",
          "invalid_request",
          "WebSocket upgrade required",
        );
        return this.executors.upgrade(identity);
      }
      const match =
        /^\/(?:v1\/executor\/transfers|internal\/transfers)\/([a-zA-Z0-9_-]+)\/(?:input|output|peer)\/chunks\/(\d+)$/.exec(
          url.pathname,
        );
      const statusMatch = /^\/v1\/executor\/transfers\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
      const artifactMatch = /^\/internal\/artifacts\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)$/.exec(
        url.pathname,
      );
      const modelMatch = /^\/internal\/agents\/([a-zA-Z0-9_-]+)\/model$/.exec(url.pathname);
      check(
        match || statusMatch || artifactMatch || modelMatch,
        "not_found",
        "Control route unavailable",
      );
      let auth: D.AuthContext;
      if (url.pathname.startsWith("/internal/")) {
        const envelope = request.headers.get("X-Fortipi-Context");
        check(
          envelope && new TextEncoder().encode(envelope).length <= 65536,
          "unauthenticated",
          "Missing internal authority",
        );
        try {
          auth = JSON.parse(envelope) as D.AuthContext;
        } catch {
          fail("unauthenticated", "Malformed internal authority");
        }
        check(
          auth && typeof auth === "object" && typeof auth.credentialId === "string",
          "unauthenticated",
          "Invalid internal authority",
        );
        this.identities.current(auth);
      } else {
        const bearer = request.headers.get("Authorization") ?? "";
        check(bearer.startsWith("Bearer "), "unauthenticated", "Executor authorization required");
        auth = await this.identities.authenticate({
          bearer: bearer.slice(7),
          deploymentId: this.identities.deploymentId,
          requestId,
          deadline: Date.now() + 30000,
        });
        check(auth.role === "executor", "unauthorized", "Executor credential required");
      }
      if (modelMatch) {
        this.capacity.admitRequest(auth.principalId);
        check(
          request.method === "GET" && request.body === null && url.search === "",
          "invalid_request",
          "Model resolution requires query-free GET",
        );
        const selected = this.directory.registeredModel(auth, modelMatch[1] ?? "");
        headers.set("X-Fortipi-Agent-Config-Version", String(selected.agent.configVersion));
        return Response.json(selected.model, { headers });
      }
      if (artifactMatch)
        return this.artifacts.fetch(auth, request, artifactMatch[1] ?? "", artifactMatch[2] ?? "");
      if (statusMatch) {
        check(request.method === "GET", "invalid_request", "Transfer status requires GET");
        return Response.json(
          this.relay.observe(auth, {
            transferId: statusMatch[1] ?? "",
            attemptId: url.searchParams.get("attemptId") ?? "",
          }),
          { headers },
        );
      }
      check(match, "not_found", "Control route unavailable");
      return this.relay.chunk(
        auth,
        request,
        match[1] ?? "",
        url.searchParams.get("attemptId") ?? "",
        Number(match[2]),
      );
    });
    if (result.ok) return result.value;
    const { ok: _ok, ...error } = result;
    if (error.details?.retryAfterMs !== undefined)
      headers.set("Retry-After", String(Math.max(1, Math.ceil(error.details.retryAfterMs / 1000))));
    return Response.json({ error }, { status: errorStatuses[result.code], headers });
  }
}
