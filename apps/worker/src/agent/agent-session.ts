import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import { type CommitObservation, type ConversationId, Harness } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import {
  type Connection,
  Lifecycle,
  type LifecycleJobContext,
  type LifecycleJobOutcome,
} from "agents/lifecycle";
import { isCapnWebTransportUpgrade, WebSockets } from "agents/websockets";
import { routeCatalog, wireLimits } from "fortipi-contract";
import {
  check,
  errorResponse,
  failure,
  id,
  Lanes,
  outcome,
  permits,
  pressure,
  resourceAgent,
  same,
  scope,
  unwrap,
} from "../api/common.js";
import { matchRoute } from "../api/router.js";
import { boundedJson, valid, validate } from "../api/validation.js";
import type { AgentSessionRpc } from "../boundary/agent-session.js";
import type * as D from "../boundary/dto.js";
import type { Env } from "../boundary/env.js";
import { Dispatch } from "../execution/dispatch.js";
import { type JobState, Jobs } from "../execution/jobs.js";
import { FreshJobs } from "../execution/new-job.js";
import { Reconciliation } from "../execution/reconciliation.js";
import { buildRegistry, type DispatchTask } from "../execution/registry.js";
import { ModelStorageBounds } from "../models/bounded.js";
import { bootstrapModels, buildModels } from "../models/factory.js";
import { retainedModelConfigurations } from "../models/retained.js";
import { configuredModel } from "../models/selection.js";
import { Authority } from "./authority.js";
import { Controls } from "./controls.js";
import { type Admission, Conversations, CreationDoc } from "./conversations.js";
import { AgentExports } from "./exports.js";
import { piStorageWatermark } from "./pi-storage.js";
import { Projection } from "./projection.js";
import { Recovery } from "./recovery.js";
import { type ConversationRow, Store } from "./store.js";

interface SocketAuthority {
  auth: D.AuthContext;
  identity: D.SocketIdentity;
}
interface SocketState {
  authorityId: string;
  credentialId: string;
  generation: number;
  grantVersion: number;
  subscriptions: Record<string, number>;
}
export class AgentSession extends DurableObject<Env> implements AgentSessionRpc {
  declare fetch: (request: Request) => Promise<Response>;
  get contractVersion(): "1.0" {
    return "1.0";
  }
  readonly lifecycle: Lifecycle<Env>;
  readonly store: Store;
  readonly authority: Authority;
  readonly agentId: string;
  readonly pi: PiHarness;
  readonly conversations: Conversations;
  readonly projection: Projection;
  readonly recovery: Recovery;
  readonly jobs: Jobs;
  readonly dispatch: Dispatch;
  readonly controls: Controls;
  readonly reconciliation: Reconciliation;
  readonly freshJobs: FreshJobs;
  #dispatchTask: DispatchTask | undefined;
  readonly exports: AgentExports;
  readonly #sockets: WebSockets;
  readonly #socketLanes = new Lanes();
  readonly #modelLanes = new Lanes();
  readonly #hintIds = new Set<number>();
  #hintScheduled = false;
  #observation: CommitObservation | undefined;
  #modelRegistry: MutableModels | undefined;
  #installedModelConfiguration: D.ModelConfig | undefined;
  readonly #modelBuilder: typeof buildModels;
  readonly #modelBounds: ModelStorageBounds;
  readonly #testModelBuilder: boolean;
  constructor(ctx: DurableObjectState, env: Env, modelBuilder?: typeof buildModels) {
    super(ctx, env);
    this.#modelBuilder = modelBuilder ?? buildModels;
    this.#testModelBuilder = modelBuilder !== undefined;
    this.lifecycle = Lifecycle.install(this);
    this.agentId = this.lifecycle.name;
    this.store = new Store(ctx.storage, env.FORTIPI_CONFIG.infrastructure);
    this.#modelBounds = new ModelStorageBounds(this.store.policy.bounds.activeMutatingJobs);
    this.authority = new Authority(
      this.store,
      env.CONTROL_PLANE.getByName("control"),
      this.agentId,
    );
    this.jobs = new Jobs(this.store, this.authority);
    this.dispatch = new Dispatch(this.jobs, env);
    this.pi = new PiHarness({
      harness: async ({ storage, context, onWake }) => {
        await this.store.open();
        const models = unwrap(await this.#models());
        this.#modelRegistry = models;
        const registry = buildRegistry({
          jobs: this.jobs,
          dispatch: this.dispatch,
          projection: this.projection,
          conversations: this.conversations,
          env: this.env,
          dispatchReady: (task) => {
            this.#dispatchTask = task;
          },
        });
        const harness = await Harness.open(
          piStorageWatermark(storage, this.store),
          {
            models: () => {
              check(this.#modelRegistry, "interrupted", "Model registry unavailable");
              return this.#modelRegistry;
            },
            registry,
            onWake,
            settings: { afterFailedRun: "keep", progress: { persistWithinMs: 1000 } },
            conversationCreated: async (tx, conversation) => {
              if (!conversation.owner && this.conversations.allocating) {
                const doc = await tx.doc(CreationDoc, conversation.id);
                doc.intent = this.conversations.allocating;
              }
            },
            onReport: (report) => {
              if (report.kind === "storage_failed")
                this.ctx.waitUntil(
                  this.pi
                    .dispose()
                    .then(() => this.#arm())
                    .catch(() => {}),
                );
            },
          },
          context,
        );
        this.#observation?.detach();
        this.#observation = harness.observeCommits({
          advance: (publication) => {
            for (const change of publication.changes) {
              const cid =
                change.type === "document" || change.type === "document.copy"
                  ? change.conversationId
                  : change.type === "conversation"
                    ? change.value.id
                    : change.value.conversationId;
              if (cid !== undefined && this.#hintIds.size < 100) this.#hintIds.add(cid);
            }
            if (!this.#hintScheduled) {
              this.#hintScheduled = true;
              this.ctx.waitUntil(
                Promise.resolve()
                  .then(() => this.#flushHints())
                  .catch(() => {}),
              );
            }
          },
          end: () => {},
        });
        return harness;
      },
    });
    this.conversations = new Conversations({
      store: this.store,
      authority: this.authority,
      pi: this.pi,
      agentId: this.agentId,
      arm: () => this.#arm(),
      notify: (cid) => this.#notify(cid),
      selectModel: (...args) => this.#selectModel(...args),
    });
    this.controls = new Controls(this.conversations, this.jobs);
    this.freshJobs = new FreshJobs(this.jobs, this.dispatch, this.conversations, env, () => {
      check(this.#dispatchTask, "interrupted", "Registered dispatch task unavailable");
      return this.#dispatchTask;
    });
    this.reconciliation = new Reconciliation(
      this.jobs,
      env,
      () => this.#arm(),
      (cid) => this.#notify(cid),
    );
    this.exports = new AgentExports(this.conversations, this.jobs);
    this.projection = new Projection(this.conversations);
    this.recovery = new Recovery(this.store, this.lifecycle, (budget) => this.#drain(budget));
    this.#sockets = new WebSockets({
      protocol: false,
      handlers: {
        onConnect: (connection, context) => this.#attachSocket(connection, context.request),
        onMessage: (connection, message) => this.#message(connection, message),
      },
    });
    this.lifecycle
      .use({
        claims: "selective",
        onWebSocketUpgrade: ({ request }) => this.#guardUpgrade(request),
      })
      .use(this.pi)
      .use(this.#sockets);
  }
  async #models() {
    // Local selection may lag a CP change while idle. Startup restores pending
    // work only; a new caller supplies authority to resolve the current model.
    const { configurations, selected } = await retainedModelConfigurations(
      this.store,
      undefined,
      false,
    );
    const result =
      configurations.length === 0 && !this.#testModelBuilder
        ? { ok: true as const, value: bootstrapModels() }
        : await this.#modelBuilder(configurations, this.env, {
            agentId: this.agentId,
            deploymentId: this.env.CONTROL_PLANE.idFromName("control").toString(),
          });
    if (result.ok) {
      this.#modelBounds.install(result.value);
      this.#installedModelConfiguration = selected;
    }
    return result;
  }
  #selectedModel(auth: D.AuthContext): Promise<D.ModelConfig> {
    return configuredModel(this.env.CONTROL_PLANE.getByName("control"), this.agentId, auth);
  }
  async #installSelectedModel(selected: D.ModelConfig, auth: D.AuthContext) {
    const retained = await retainedModelConfigurations(this.store, selected);
    const replacement = unwrap(
      await this.#modelBuilder(retained.configurations, this.env, {
        agentId: this.agentId,
        deploymentId: auth.deploymentId,
      }),
    );
    const provider = replacement.getProvider(selected.providerId);
    check(
      replacement.getModel(selected.providerId, selected.modelId),
      "invalid_request",
      "Selected model unavailable",
    );
    check(provider && this.#modelRegistry, "unsupported", "Selected model provider unavailable");
    this.#modelBounds.install(replacement);
    return { models: replacement, catalog: retained.catalog };
  }
  async #selectModel(
    auth: D.AuthContext,
    action: string,
    conversationId?: string,
  ): Promise<D.ModelConfig> {
    return this.#modelLanes.run("selection", () =>
      this.#selectModelSerial(auth, action, conversationId),
    );
  }
  async #selectModelSerial(
    auth: D.AuthContext,
    action: string,
    conversationId?: string,
  ): Promise<D.ModelConfig> {
    const resources = scope({
      agentIds: [this.agentId],
      conversationIds: conversationId ? [conversationId] : [],
      actions: [action],
    });
    await this.authority.current(auth, resources);
    const selected = await this.#selectedModel(auth);
    await this.authority.current(auth, resources);
    const old = await this.store.get<D.ModelConfig>("meta", "selected-model");
    if (
      !same(old ?? null, selected) ||
      !same(this.#installedModelConfiguration ?? null, selected) ||
      !this.#modelRegistry?.getModel(selected.providerId, selected.modelId)
    ) {
      const installed = await this.#installSelectedModel(selected, auth);
      await this.store.transaction(async (tx) => {
        await this.authority.current(auth, resources, tx);
        await this.store.put("meta", "selected-model", selected, tx);
        await this.store.put("meta", "model-catalog", installed.catalog, tx);
        await this.authority.current(auth, resources, tx);
      });
      await this.authority.current(auth, resources);
      this.#modelRegistry = installed.models;
      this.#installedModelConfiguration = selected;
    }
    return selected;
  }
  async onStart(): Promise<void> {
    await this.store.open();
    await this.recovery.start();
  }
  async onJob(context: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    return this.recovery.job(context);
  }
  async #arm(): Promise<void> {
    await this.recovery.arm();
  }
  async #drain(budget: D.DrainBudget): Promise<D.DrainProgress> {
    const control = await this.controls.drain(budget);
    const reconciliation = await this.reconciliation.drain({
      ...budget,
      maxItems: Math.max(0, budget.maxItems - control.processed),
    });
    const fresh = await this.freshJobs.drain({
      ...budget,
      maxItems: Math.max(0, budget.maxItems - control.processed - reconciliation.processed),
    });
    const jobs = await this.dispatch.repair({
      ...budget,
      maxItems: Math.max(
        0,
        budget.maxItems - control.processed - reconciliation.processed - fresh.processed,
      ),
    });
    const projection = await this.projection.drain({
      ...budget,
      maxItems: Math.max(
        0,
        budget.maxItems -
          control.processed -
          reconciliation.processed -
          fresh.processed -
          jobs.processed,
      ),
    });
    const wakes = [
      control.nextWakeAt,
      reconciliation.nextWakeAt,
      fresh.nextWakeAt,
      jobs.nextWakeAt,
      projection.nextWakeAt,
    ].filter((value): value is number => value !== undefined);
    return {
      processed:
        control.processed +
        reconciliation.processed +
        fresh.processed +
        jobs.processed +
        projection.processed,
      remaining:
        control.remaining ||
        reconciliation.remaining ||
        fresh.remaining ||
        jobs.remaining ||
        projection.remaining,
      ...(wakes.length ? { nextWakeAt: Math.min(...wakes) } : {}),
    };
  }
  async #flushHints(): Promise<void> {
    this.#hintScheduled = false;
    const ids = Array.from(this.#hintIds);
    this.#hintIds.clear();
    for (const piId of ids) {
      const mapped = await this.store.get<{ conversationId: string }>("pi-map", String(piId));
      if (mapped)
        await this.store.put(
          "dirty",
          mapped.conversationId,
          { piId: String(piId) },
          undefined,
          Date.now(),
        );
    }
    if (ids.length) await this.#arm();
  }
  async #resource(
    input: D.OperationRequest<D.AgentOperationId>,
  ): Promise<{ conversationId?: string }> {
    if ("agentId" in input.path) {
      check(input.path.agentId === this.agentId, "unauthorized", "Wrong agent");
      return {};
    }
    const key = input.path.id;
    check(resourceAgent(key) === this.agentId, "unauthorized", "Wrong agent");
    if (["describeTask", "cancelTask", "resumeTask"].includes(input.operationId)) {
      const task = await this.store.get<D.Task>("task", key);
      check(task, "not_found", "Task unavailable");
      return { conversationId: task.conversationId };
    }
    if (["describeApproval", "decideApproval"].includes(input.operationId)) {
      const approval = await this.store.get<D.Approval>("approval", key);
      check(approval, "not_found", "Approval unavailable");
      return { conversationId: approval.conversationId };
    }
    if (["describeJob", "reconcileJob"].includes(input.operationId)) {
      const state = await this.jobs.state(key);
      return { conversationId: state.job.conversationId };
    }
    return { conversationId: key };
  }
  async handleApi<K extends D.AgentOperationId>(
    ctx: D.AuthContext,
    input: D.OperationRequest<K>,
  ): Promise<D.Outcome<D.OperationResponse<K>>> {
    const request = input as D.OperationRequest<D.AgentOperationId>;
    const result = await outcome(ctx.requestId, async () => {
      await this.lifecycle.start();
      const route = routeCatalog.find((r) => r.operationId === request.operationId);
      check(route?.owner === "agent", "invalid_request", "Unknown agent operation");
      const resource = await this.#resource(request);
      // These owners perform the same current CP authorization, including on
      // idempotent retries. Keep one physical check at that owning operation.
      if (
        [
          "createConversation",
          "forkConversation",
          "submitMessage",
          "steerConversation",
          "decideApproval",
        ].includes(request.operationId)
      )
        await this.authority.current(
          ctx,
          scope({
            agentIds: [this.agentId],
            conversationIds: resource.conversationId ? [resource.conversationId] : [],
            actions: [route.action],
          }),
        );
      else await this.authority.authorize(ctx, route.action, resource.conversationId);
      if (
        resource.conversationId &&
        [
          "describeTask",
          "cancelTask",
          "resumeTask",
          "describeApproval",
          "decideApproval",
          "describeJob",
          "reconcileJob",
        ].includes(request.operationId)
      ) {
        const registration = unwrap(
          await this.authority.control.registerAuthorityRecipient(ctx, {
            credential: {
              credentialId: ctx.credentialId,
              generation: ctx.generation,
              grantVersion: ctx.grantVersion,
            },
            recipient: { kind: "agent", id: this.agentId },
            resources: scope({
              agentIds: [this.agentId],
              conversationIds: [resource.conversationId],
              actions: [route.action],
            }),
          }),
        );
        ctx = { ...ctx, registrationId: registration.registrationId };
        await this.authority.current(
          ctx,
          scope({
            agentIds: [this.agentId],
            conversationIds: [resource.conversationId],
            actions: [route.action],
          }),
        );
      }
      if (request.operationId === "createConversation")
        return { status: 201, body: await this.conversations.create(ctx, request.body) };
      if (request.operationId === "listConversations") {
        const token = request.query.pageToken
          ? await this.store.get<{ principalId: string; after: string }>(
              "page",
              request.query.pageToken,
            )
          : undefined;
        check(
          !request.query.pageToken || token?.principalId === ctx.principalId,
          "invalid_request",
          "Page token scope changed",
        );
        const rows = await this.store.page<ConversationRow>(
          "conversation",
          request.query.limit ?? 100,
          token?.after,
        );
        const items = rows
          .filter(
            (row) =>
              row.value.published &&
              permits(
                ctx.grants,
                scope({
                  agentIds: [this.agentId],
                  conversationIds: [row.id],
                  actions: [route.action],
                }),
              ),
          )
          .map((row) => row.value.conversation);
        let nextPageToken: string | undefined;
        if (rows.length === (request.query.limit ?? 100)) {
          nextPageToken = id();
          await this.store.put("page", nextPageToken, {
            principalId: ctx.principalId,
            after: rows.at(-1)!.id,
          });
        }
        return { status: 200, body: { items, ...(nextPageToken ? { nextPageToken } : {}) } };
      }
      if (request.operationId === "submitMessage")
        return {
          status: 202,
          body: await this.conversations.submit(ctx, request.path.id, request.body),
        };
      if (request.operationId === "steerConversation")
        return {
          status: 202,
          body: await this.conversations.submit(ctx, request.path.id, request.body, true),
        };
      if (request.operationId === "forkConversation") {
        const parent = await this.store.get<ConversationRow>("conversation", request.path.id);
        check(parent?.published, "not_found", "Conversation unavailable");
        return {
          status: 201,
          body: await this.conversations.create(
            ctx,
            {
              requestId: request.body.requestId,
              ...(request.body.title ? { title: request.body.title } : {}),
            },
            parent,
            request.body,
          ),
        };
      }
      if (request.operationId === "getConversation") {
        await this.projection.drain({ maxItems: 8, deadline: Date.now() + 5000 });
        return { status: 200, body: await this.store.snapshot(request.path.id) };
      }
      if (request.operationId === "replayEvents") {
        await this.projection.drain({ maxItems: 8, deadline: Date.now() + 5000 });
        return { status: 200, body: await this.store.replay(request.path.id, request.query) };
      }
      if (request.operationId === "describeJob")
        return {
          status: 200,
          body: this.jobs.public((await this.jobs.state(request.path.id)).job),
        };
      if (request.operationId === "describeTask")
        return { status: 200, body: await this.store.get<D.Task>("task", request.path.id) };
      if (request.operationId === "describeApproval")
        return { status: 200, body: await this.store.get<D.Approval>("approval", request.path.id) };
      if (request.operationId === "decideApproval")
        return {
          status: 200,
          body: unwrap(
            await this.jobs.decideApproval(ctx, {
              approvalId: request.path.id,
              decision: request.body,
              event: {
                protocolVersion: "1.0",
                schemaVersion: "1.0.0",
                deploymentId: ctx.deploymentId,
                conversationId: resource.conversationId!,
                durability: "durable",
                type: "approval.resolved",
                payload: (await this.store.get<D.Approval>("approval", request.path.id))!,
              },
            }),
          ),
        };
      if (request.operationId === "cancelTask" || request.operationId === "resumeTask")
        return { status: 202, body: await this.controls.request(ctx, request) };
      check(request.operationId === "reconcileJob", "invalid_request", "Unknown operation");
      if (request.body.action.kind === "new-job")
        return {
          status: 202,
          body: await this.freshJobs.request(ctx, request.path.id, request.body),
        };
      return {
        status: 202,
        body: await this.reconciliation.request(ctx, request.path.id, request.body),
      };
    });
    return result as D.Outcome<D.OperationResponse<K>>;
  }
  describeJob(ctx: D.AuthContext, input: D.OperationRequest<"describeJob">) {
    return this.handleApi(ctx, input);
  }
  describeTask(ctx: D.AuthContext, input: D.OperationRequest<"describeTask">) {
    return this.handleApi(ctx, input);
  }
  describeApproval(ctx: D.AuthContext, input: D.OperationRequest<"describeApproval">) {
    return this.handleApi(ctx, input);
  }
  async receiveExecutorOutput(
    ctx: D.AuthContext,
    input: D.OutputDelivery,
  ): Promise<D.Outcome<D.DeliveryAck>> {
    return outcome(ctx.requestId, async () => {
      await this.lifecycle.start();
      const state = await this.jobs.state(input.identity.jobId);
      await this.authority.authorize(ctx, "jobs.dispatch", state.job.conversationId);
      check(same(state.job.execution, input.identity), "conflict", "Output identity mismatch");
      check(
        new TextEncoder().encode(input.text).length <= wireLimits.outputFrameBytes,
        "payload_too_large",
        "Output frame too large",
      );
      await this.store.once(
        "output",
        `${input.identity.executionId}:${input.sequence}`,
        input,
        async () => ({ deliveryId: input.deliveryId, sequence: input.sequence, persisted: true }),
      );
      return { deliveryId: input.deliveryId, sequence: input.sequence, persisted: true };
    });
  }
  async receiveExecutorResult(
    ctx: D.AuthContext,
    input: D.ResultDelivery,
  ): Promise<D.Outcome<D.DeliveryAck>> {
    return outcome(ctx.requestId, async () => {
      await this.lifecycle.start();
      unwrap(await this.jobs.savePreparedResult(ctx, input));
      await this.#arm();
      return { deliveryId: input.deliveryId, sequence: input.sequence, persisted: true };
    });
  }
  async invalidateGeneration(
    ctx: D.RecoveryContext,
    input: D.Invalidation,
  ): Promise<D.Outcome<D.InvalidationAck>> {
    return outcome(input.revocationId, async () => {
      await this.lifecycle.start();
      const ack = await this.authority.invalidate(ctx, input);
      for (const connection of this.#sockets.getConnections<SocketState>()) {
        const state = connection.state;
        if (
          state &&
          input.subject.kind === "credential" &&
          state.credentialId === input.subject.credentialId &&
          state.generation < input.subject.minimumGeneration
        )
          connection.close(1008, "Authority revoked");
      }
      return ack;
    });
  }
  async ingestFacts(
    ctx: D.FactDeliveryContext,
    input: D.FactBatch,
  ): Promise<D.Outcome<D.FactBatchAck>> {
    return outcome(id(), async () => {
      await this.lifecycle.start();
      check(
        input.facts.length <= 100 && same(ctx.recipient, input.recipient),
        "invalid_request",
        "Invalid fact batch",
      );
      const acks: D.FactAck[] = [];
      for (const fact of input.facts) {
        acks.push(unwrap(await this.jobs.ingestFact(ctx, fact)));
        await this.#notify(fact.conversationId);
      }
      return { acks };
    });
  }
  async drainRecovery(
    ctx: D.AuthContext,
    input: D.DrainBudget,
  ): Promise<D.Outcome<D.DrainProgress>> {
    return outcome(ctx.requestId, async () => {
      await this.lifecycle.start();
      await this.authority.authorize(ctx, "conversations.read");
      return this.projection.drain(input);
    });
  }
  async exportData(
    ctx: D.AuthContext,
    input: D.ExportRequest,
  ): Promise<D.Outcome<D.ExportDescriptor>> {
    return outcome(ctx.requestId, async () => {
      await this.lifecycle.start();
      return this.exports.prepare(ctx, input);
    });
  }
  async onRequest(request: Request): Promise<Response> {
    const requestId = id();
    try {
      const raw = request.headers.get("X-Fortipi-Context");
      check(raw && raw.length <= 65536, "unauthenticated", "Trusted authority required");
      const auth = JSON.parse(raw) as D.AuthContext;
      const url = new URL(request.url);
      const terminal = /^\/__fortipi\/terminal-proof\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
      if (terminal) {
        check(
          request.method === "POST" && url.search === "",
          "invalid_request",
          "Invalid terminal proof request",
        );
        return Response.json(
          await this.jobs.terminalProof(auth, terminal[1]!, await boundedJson(request, 65536)),
          { headers: { "Cache-Control": "no-store" } },
        );
      }
      const matched = matchRoute(request.method, url.pathname);
      if (matched?.route.operationId === "getAdminArtifact")
        return this.exports.read(auth, String(matched.path.id), request);
      check(matched?.route.owner === "agent", "not_found", "Agent route unavailable");
      const query = Object.fromEntries(
        Array.from(url.searchParams, ([k, v]) => [
          k,
          ["after", "through", "limit"].includes(k) ? Number(v) : v,
        ]),
      );
      validate(matched.route.query, query);
      const body = matched.route.body ? await boundedJson(request) : undefined;
      if (matched.route.body) validate(matched.route.body, body);
      const input = {
        operationId: matched.route.operationId,
        path: matched.path,
        query,
        body,
      } as D.OperationRequest<D.AgentOperationId>;
      const response = unwrap(await this.handleApi(auth, input));
      return Response.json(response.body, {
        status: response.status,
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      return errorResponse(error, requestId);
    }
  }
  async #guardUpgrade(request: Request): Promise<Response | undefined> {
    try {
      const url = new URL(request.url);
      check(
        request.method === "GET" &&
          url.pathname === "/v1/stream" &&
          url.search === "" &&
          !isCapnWebTransportUpgrade(request) &&
          !request.headers.has("Sec-WebSocket-Protocol"),
        "invalid_request",
        "Only the public JSON stream is supported",
      );
      await this.#socketAuthority(request);
      return undefined;
    } catch (error) {
      return errorResponse(error, id());
    }
  }
  async #socketAuthority(request: Request): Promise<SocketAuthority> {
    const identityRaw = request.headers.get("X-Fortipi-Socket"),
      authRaw = request.headers.get("X-Fortipi-Context");
    check(
      identityRaw && authRaw && identityRaw.length <= 65536 && authRaw.length <= 65536,
      "unauthenticated",
      "Trusted socket authority required",
    );
    const identity = JSON.parse(identityRaw) as D.SocketIdentity;
    const auth = JSON.parse(authRaw) as D.AuthContext;
    validate<D.ResourceScope>("ResourceScope", identity.resources);
    check(
      identity.role !== "executor" &&
        identity.resources.agentIds.length === 1 &&
        identity.resources.agentIds[0] === this.agentId &&
        identity.deploymentId === auth.deploymentId &&
        identity.principalId === auth.principalId &&
        identity.role === auth.role &&
        identity.credentialId === auth.credentialId &&
        identity.generation === auth.generation &&
        identity.grantVersion === auth.grantVersion &&
        identity.registrationId === auth.registrationId &&
        identity.expiresAt > Date.now(),
      "unauthorized",
      "Socket identity mismatch",
    );
    const origin = request.headers.get("Origin");
    check(
      identity.originMode.kind === "browser"
        ? origin === identity.originMode.value
        : origin === null,
      "unauthorized",
      "Socket Origin mismatch",
    );
    await this.authority.authorize(
      auth,
      "events.read",
      identity.resources.conversationIds[0],
      scope({ ...identity.resources, actions: ["events.read"] }),
    );
    return { auth, identity };
  }
  async #attachSocket(connection: Connection, request: Request): Promise<void> {
    const authority = await this.#socketAuthority(request);
    const authorityId = id();
    await this.store.put(
      "socket-authority",
      authorityId,
      authority,
      undefined,
      authority.identity.expiresAt,
    );
    connection.setState({
      authorityId,
      credentialId: authority.identity.credentialId,
      generation: authority.identity.generation,
      grantVersion: authority.identity.grantVersion,
      subscriptions: {},
    } satisfies SocketState);
  }
  async #socketContext(
    connection: Connection<SocketState>,
    resources: D.ResourceScope,
  ): Promise<D.AuthContext> {
    const state = connection.state;
    check(state, "unauthenticated", "Socket attachment missing");
    const authority = await this.store.get<SocketAuthority>("socket-authority", state.authorityId);
    check(
      authority && authority.identity.expiresAt > Date.now(),
      "unauthenticated",
      "Socket authority expired",
    );
    check(
      permits(
        [
          {
            grantId: "ticket-scope",
            version: authority.identity.grantVersion,
            resources: authority.identity.resources,
            expiresAt: authority.identity.expiresAt,
          },
        ],
        resources,
      ),
      "unauthorized",
      "Command exceeds ticket scope",
    );
    const auth = {
      ...authority.auth,
      requestId: id(),
      deadline: Math.min(Date.now() + 30000, authority.identity.expiresAt),
    };
    for (const action of resources.actions)
      await this.authority.authorize(auth, action, resources.conversationIds[0], resources);
    return auth;
  }
  #send(connection: Connection, value: unknown): void {
    const data = JSON.stringify(value);
    const buffered =
      "bufferedAmount" in connection && typeof connection.bufferedAmount === "number"
        ? connection.bufferedAmount
        : 0;
    check(
      buffered + new TextEncoder().encode(data).byteLength <= wireLimits.socketBytes,
      "quota_exceeded",
      "Socket backlog exceeded",
      pressure("concurrency", wireLimits.socketBytes, "Socket backlog exceeded"),
    );
    connection.send(data);
  }
  async #message(raw: Connection, message: string | ArrayBuffer | ArrayBufferView): Promise<void> {
    const connection = raw as Connection<SocketState>;
    let requestId = id();
    try {
      check(
        typeof message === "string" &&
          new TextEncoder().encode(message).length <= wireLimits.jsonBytes,
        "invalid_request",
        "Invalid client frame",
      );
      const command: unknown = JSON.parse(message);
      validate<D.ClientCommand>("ClientCommand", command);
      requestId = command.requestId;
      if (command.type === "ping") {
        await this.#socketContext(
          connection,
          scope({ agentIds: [this.agentId], actions: ["events.read"] }),
        );
        this.#send(connection, { type: "ack", requestId, operationId: "ping" });
        return;
      }
      if (command.type === "conversation.unsubscribe") {
        await this.#socketContext(
          connection,
          scope({
            agentIds: [this.agentId],
            conversationIds: [command.conversationId],
            actions: ["events.read"],
          }),
        );
        const state = connection.state;
        check(state, "unauthenticated", "Missing attachment");
        const subscriptions = { ...state.subscriptions };
        delete subscriptions[command.conversationId];
        connection.setState({ ...state, subscriptions });
        this.#send(connection, { type: "ack", requestId, operationId: command.type });
        return;
      }
      const input =
        command.type === "conversation.subscribe"
          ? { ...command.input, body: undefined }
          : command.input;
      const resource = await this.#resource(input);
      const route = routeCatalog.find((r) => r.operationId === input.operationId)!;
      const auth = await this.#socketContext(
        connection,
        scope({
          agentIds: [this.agentId],
          conversationIds: resource.conversationId ? [resource.conversationId] : [],
          actions: [route.action],
        }),
      );
      if (command.type === "conversation.subscribe") {
        await this.#socketLanes.run(command.input.path.id, async () => {
          const page = await this.store.replay(command.input.path.id, command.input.query);
          const state = connection.state;
          check(state, "unauthenticated", "Missing attachment");
          check(
            Object.keys(state.subscriptions).length < 4 ||
              command.input.path.id in state.subscriptions,
            "quota_exceeded",
            "Too many subscriptions",
            pressure("concurrency", 4, "Too many subscriptions"),
          );
          this.#send(connection, {
            type: "ack",
            requestId,
            operationId: "replayEvents",
            receipt: page,
          });
          const attachment = {
            ...state,
            subscriptions: { ...state.subscriptions, [command.input.path.id]: page.through },
          };
          check(
            new TextEncoder().encode(JSON.stringify(attachment)).length <= 2048,
            "payload_too_large",
            "Attachment limit exceeded",
          );
          connection.setState(attachment);
          await this.#deliver(connection, command.input.path.id);
        });
        return;
      }
      const response = unwrap(await this.handleApi(auth, input));
      this.#send(connection, {
        type: "ack",
        requestId,
        operationId: input.operationId,
        receipt: response.body,
      });
    } catch (error) {
      const failed = failure(error, requestId);
      const { ok: _ok, ...body } = failed;
      try {
        this.#send(connection, { type: "error", requestId, error: body });
      } catch {
        connection.close(1013, "Stream overflow");
        return;
      }
      if (failed.code === "unauthorized" || failed.code === "unauthenticated")
        connection.close(1008, "Authority expired");
      else if (failed.code === "quota_exceeded") connection.close(1013, "Stream overflow");
    }
  }
  async #deliver(connection: Connection<SocketState>, cid: string): Promise<void> {
    const state = connection.state;
    const after = state?.subscriptions[cid];
    if (after === undefined) return;
    await this.#socketContext(
      connection,
      scope({ agentIds: [this.agentId], conversationIds: [cid], actions: ["events.read"] }),
    );
    const page = await this.store.replay(cid, { after, limit: 100 });
    for (const event of page.events) this.#send(connection, event);
    const current = connection.state;
    check(current, "unauthenticated", "Missing attachment");
    connection.setState({
      ...current,
      subscriptions: { ...current.subscriptions, [cid]: page.nextAfter },
    });
    if (page.hasMore) {
      this.#send(connection, {
        type: "resync_required",
        requestId: id(),
        reason: "overflow",
        retainedFloor: page.retainedFloor,
      });
      connection.close(1013, "Replay backlog exceeded");
    }
  }
  async #notify(cid: string): Promise<void> {
    await this.#socketLanes.run(cid, async () => {
      for (const connection of this.#sockets.getConnections<SocketState>())
        if (connection.state?.subscriptions[cid] !== undefined)
          try {
            await this.#deliver(connection, cid);
          } catch {
            connection.close(1008, "Stream requires authorization or resync");
          }
    });
  }
}
