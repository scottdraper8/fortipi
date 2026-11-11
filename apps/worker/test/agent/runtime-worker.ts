import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxProviderHandle,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { commitDigest } from "fortipi-contract";
import { AgentSession } from "../../src/agent/agent-session.js";
import { Authority, type ControlPort } from "../../src/agent/authority.js";
import type { ConversationRow } from "../../src/agent/store.js";
import { scope, unwrap } from "../../src/api/common.js";
import { routeRequest } from "../../src/api/router.js";
import type * as D from "../../src/boundary/dto.js";
import type { Env } from "../../src/boundary/env.js";
import { ControlPlane as RealControlPlane } from "../../src/control/control-plane.js";
import { Dispatch } from "../../src/execution/dispatch.js";
import { isTerminal, Jobs } from "../../src/execution/jobs.js";
import { nativeContext, nativeProof } from "../../src/execution/native-proof.js";
import { FreshJobDoc } from "../../src/execution/new-job.js";
import { defaultModel } from "../../src/models/factory.js";
import { configuredModel } from "../../src/models/selection.js";
import { samplingOracle } from "./sampling-oracle.js";

export { WorkspaceProxy } from "@cloudflare/computer";
export { LinuxContainerHost } from "../../src/container/linux-container-host.js";
export { StorageGuardProbe } from "./storage-guard-worker.js";
export class ControlPlane extends RealControlPlane {
  private readonly calls: Record<string, number> = {};
  private count(name: string) {
    this.calls[name] = (this.calls[name] ?? 0) + 1;
  }
  override async authenticate(input: D.CredentialProof) {
    this.count("authenticate");
    const result = await super.authenticate(input);
    this.count(result.ok ? `authenticate.${result.value.role}` : "authenticate.denied");
    return result;
  }
  override authorize(input: D.AuthorizationRequest) {
    this.count("authorize");
    return super.authorize(input);
  }
  override registerAuthorityRecipient(ctx: D.AuthContext, input: D.AuthorityRecipientRequest) {
    this.count("registerAuthorityRecipient");
    return super.registerAuthorityRecipient(ctx, input);
  }
  override handleApi<K extends D.ControlOperationId>(
    ctx: D.AuthContext,
    input: D.OperationRequest<K>,
  ) {
    this.count("handleApi");
    this.count(`handleApi.${ctx.role}`);
    return super.handleApi(ctx, input);
  }
  override createAgent(ctx: D.AuthContext, input: D.OperationRequest<"createAgent">) {
    this.count("createAgent");
    return super.createAgent(ctx, input);
  }
  override reserveCapacity(
    ctx: D.AuthContext,
    input: {
      operationId: string;
      ownerId: string;
      policyVersion: number;
      bytes: number;
      admissionSlots: number;
    },
  ) {
    this.count("reserveCapacity");
    return super.reserveCapacity(ctx, input);
  }
  override settleCapacity(
    ctx: D.AuthContext,
    input: { reservationId: string; disposition: "consumed" | "unused"; observedBytes?: number },
  ) {
    this.count("settleCapacity");
    return super.settleCapacity(ctx, input);
  }
  override fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (path.match(/^\/internal\/agents\/[^/]+\/model$/)) this.count("configuredModel.fetch");
    if (path.startsWith("/v1/executor/jobs/")) {
      this.count("executorJob.fetch");
      if (path.endsWith("/manifest")) this.count("executorJob.manifest");
      if (/\/blobs\/[a-f0-9]{64}$/.test(path)) this.count("executorJob.blob");
    }
    return super.fetch(request);
  }
  ingressCounts() {
    return { ...this.calls };
  }
  queryLeaseTrace(identity: D.ExecutionIdentity) {
    const record = this.store.get<{
      intent: D.DispatchIntent;
      observation?: D.ExecutionObservation;
    }>("dispatch", identity.executionId);
    const known = this.store.get<{ lease: D.Lease }>("lease", identity.lease.leaseId);
    return {
      originalVersion: record?.intent.assignment.identity.lease.leaseVersion,
      knownVersion: known?.lease.leaseVersion,
      observedVersion: record?.observation?.identity.lease.leaseVersion,
      observedState: record?.observation?.state,
    };
  }
  reservationState(reservationId: string) {
    return (
      this.store.get<{ reservation: D.CapacityReservation }>("capacity_reservation", reservationId)
        ?.reservation.state ?? "missing"
    );
  }
  physicalAllocation(kind: "agent" | "workspace", objectId: string) {
    return {
      controlBytes: this.store.storage.sql.databaseSize,
      allocation: this.store.get<{
        estimate: number;
        pending: number;
        measured: number;
        sequence: number;
      }>("storage_allocation", `${kind}:${objectId}`),
    };
  }
  registrationDebug(auth: D.AuthContext, identity: D.ExecutionIdentity) {
    const registration = this.store.get<D.AuthorityRegistration>(
        "recipient",
        auth.registrationId ?? "",
      ),
      record = this.store.get<{ intent: D.DispatchIntent }>("dispatch", identity.executionId);
    if (!record) return JSON.stringify({ recordPresent: false });
    const reservation = record.intent.reservation,
      required: D.ResourceScope = {
        agentIds: [reservation.agentId],
        conversationIds: [reservation.conversationId],
        workspaceIds: [reservation.workspaceId],
        executorIds: identity.target.kind === "executor" ? [identity.target.executorId] : [],
        backendIds: identity.target.kind === "backend" ? [identity.target.backendId] : [],
        tools: [record.intent.assignment.tool],
        actions: [...new Set([...reservation.actions, "jobs.dispatch"])],
      };
    const includes = (parent: D.ResourceScope, child: D.ResourceScope) =>
      Object.keys(child).every((key) =>
        child[key as keyof D.ResourceScope].every(
          (value) =>
            parent[key as keyof D.ResourceScope].includes(value) ||
            parent[key as keyof D.ResourceScope].includes("*"),
        ),
      );
    return JSON.stringify({
      recordPresent: true,
      registrationPresent: !!registration,
      isReservationAgent: auth.registrationId === reservation.registrationIds.agent,
      recipient: registration?.recipient,
      expectedAgent: reservation.agentId,
      credentialMatches:
        registration?.credential.credentialId === auth.credentialId &&
        registration.credential.generation === auth.generation &&
        registration.credential.grantVersion === auth.grantVersion,
      registrationScope: registration?.resources,
      required,
      scopeCovers:
        !!registration &&
        includes(registration.resources, { ...required, actions: ["jobs.dispatch"] }),
      oneGrant:
        !!registration &&
        auth.grants.some(
          (grant) =>
            includes(grant.resources, required) &&
            includes(grant.resources, registration.resources),
        ),
      grantActions: auth.grants.map((grant) => grant.resources.actions),
    });
  }
}
export { WorkspaceObject } from "../../src/workspace/workspace-object.js";

export class TestAgentSession extends AgentSession {
  #resultDelivery: { accepted: boolean; code?: D.ErrorCode } | undefined;
  override async receiveExecutorResult(ctx: D.AuthContext, input: D.ResultDelivery) {
    const result = await super.receiveExecutorResult(ctx, input);
    this.#resultDelivery = result.ok ? { accepted: true } : { accepted: false, code: result.code };
    return result;
  }
  #nativeCommitRelease: (() => void) | undefined;
  async holdNativeCommit() {
    const commit = this.dispatch.commitResult.bind(this.dispatch);
    const held = new Promise<void>((resolve) => {
      this.#nativeCommitRelease = resolve;
    });
    this.dispatch.commitResult = async (state) => {
      await held;
      const current = await this.jobs.state(state.job.jobId);
      if (!isTerminal(current.job)) await commit(current);
    };
  }
  async releaseNativeCommit() {
    this.#nativeCommitRelease?.();
  }
  private faux: FauxProviderHandle | undefined;
  private diagnostic = "";
  private readonly completion: ReturnType<typeof Promise.withResolvers<void>>;
  private readonly oldRepair = Promise.withResolvers<void>();
  private readonly newRepair = Promise.withResolvers<void>();
  private repairCalls = 0;
  #replayHold:
    | { cid: string; entered: boolean; gate: ReturnType<typeof Promise.withResolvers<void>> }
    | undefined;
  constructor(ctx: DurableObjectState, env: Env) {
    const completion = Promise.withResolvers<void>();
    const faux = fauxProvider({
      provider: "cloudflare",
      models: [{ id: defaultModel.modelId }, { id: "fixture-alternate" }],
      tokensPerSecond: 100000,
    });
    faux.setResponses(
      Array.from({ length: 100 }, () => async (context) => {
        const last = context.messages.filter((message) => message.role === "user").at(-1);
        const content = last && typeof last.content === "string" ? last.content : "input";
        if (content === "hold-completion") await completion.promise;
        return fauxAssistantMessage(
          content === "large-answer" ? "x".repeat(102400) : `answer:${content}`,
        );
      }),
    );
    super(ctx, env, async () => {
      const models = createModels();
      models.setProvider(faux.provider);
      return { ok: true, value: models };
    });
    this.completion = completion;
    this.faux = faux;
    const replay = this.store.replay.bind(this.store);
    this.store.replay = async (cid, query) => {
      const page = await replay(cid, query),
        hold = this.#replayHold;
      if (hold?.cid === cid && !hold.entered) {
        hold.entered = true;
        await hold.gate.promise;
      }
      return page;
    };
    // Test-only barriers wrap the supported API, after its actual durable commit.
    // The supervisor kills workerd; no product fault lane or private Pi SQL exists.
    const session = this.pi.session.bind(this.pi);
    this.pi.session = (...args) => {
      const current = session(...args);
      const submit = current.submit.bind(current);
      current.submit = async (...input) => {
        await this.barrier("before-submit");
        const receipt = await submit(...input);
        await this.barrier("after-submit");
        return receipt;
      };
      return current;
    };
    const allocate = this.pi.sessions.create.bind(this.pi.sessions);
    this.pi.sessions.create = async (...args) => {
      const created = await allocate(...args);
      await this.barrier("after-create");
      return created;
    };
    const create = this.conversations.create.bind(this.conversations);
    this.conversations.create = async (...args) => {
      try {
        return await create(...args);
      } catch (error) {
        this.diagnostic = error instanceof Error ? (error.stack ?? error.message) : "unknown";
        throw error;
      }
    };
  }
  diagnose() {
    return this.diagnostic;
  }
  holdReplay(cid: string) {
    this.#replayHold = { cid, entered: false, gate: Promise.withResolvers<void>() };
  }
  replayHeld() {
    return this.#replayHold?.entered ?? false;
  }
  releaseReplay() {
    this.#replayHold?.gate.resolve();
    this.#replayHold = undefined;
  }
  async seedExcludedExportRecords() {
    await this.lifecycle.start();
    for (const kind of ["credential", "model-auth", "socket-authority", "admission"])
      await this.store.put(kind, `excluded_${kind}`, {
        accessToken: "synthetic-excluded-access-sentinel",
        refreshToken: "synthetic-excluded-refresh-sentinel",
        providerKey: "synthetic-excluded-provider-sentinel",
      });
  }
  async exportDataJson(auth: D.AuthContext, input: D.ExportRequest) {
    return JSON.stringify(await this.exportData(auth, input));
  }
  async physicalCeilingReachability() {
    await this.lifecycle.start();
    const sql = this.ctx.storage.sql;
    let pragma = "allowed",
      nested = "committed";
    try {
      sql.exec("PRAGMA max_page_count=32768").toArray();
    } catch (error) {
      pragma = error instanceof Error ? error.message : "rejected";
    }
    try {
      await this.ctx.storage.transaction(async () => {
        await this.store.transaction(async (tx) => {
          await this.store.put("ceiling-probe", "rollback", { bytes: "x".repeat(102400) }, tx);
        });
        throw new Error("outer rollback canary");
      });
    } catch (error) {
      nested = error instanceof Error ? error.message : "rejected";
    }
    return JSON.stringify({
      pragma,
      nested,
      rolledBack: (await this.store.get("ceiling-probe", "rollback")) === undefined,
      totalSqlBytes: sql.databaseSize,
    });
  }
  private async barrier(point: string) {
    if ((await this.store.get<string>("fixture", "fault")) !== point) return;
    await this.store.transaction(async (tx) => {
      await this.store.remove("fixture", "fault", tx);
      await this.store.put("fixture", "barrier", point, tx);
    });
    await new Promise<void>((accept) => setTimeout(accept, 300000));
  }
  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__test/")) {
      if (request.headers.get("Authorization") !== `Bearer ${this.env.FORTIPI_ADMIN_TOKEN}`)
        return new Response(null, { status: 403 });
      const action = url.pathname.slice("/__test/".length);
      if (action === "canary") {
        if (request.method === "PUT")
          await this.store.put("fixture", "canary", await request.json());
        return Response.json((await this.store.get("fixture", "canary")) ?? null);
      }
      if (action === "fault") {
        await this.store.remove("fixture", "barrier");
        await this.store.put("fixture", "fault", await request.json());
        return Response.json({ armed: true });
      }
      if (action === "state") {
        const admissions = await this.store.page<
          import("../../src/agent/conversations.js").Admission
        >("admission", 100);
        const creations = await this.store.page<
          import("../../src/agent/conversations.js").CreationIntent
        >("creation", 100);
        const admissionIntents = await this.store.page<
          import("../../src/agent/conversations.js").AdmissionIntent
        >("admission-intent", 100);
        const harness = await this.pi.pi();
        const conversations = await harness.commit(
          (tx) => tx.scanConversations({ order: "ascending" }, 100),
          BACKGROUND_CONTEXT,
        );
        return Response.json({
          barrier: (await this.store.get("fixture", "barrier")) ?? null,
          admissions: admissions.map((row) => ({
            operationId: row.value.operationId,
            messageId: row.value.messageId,
            taskId: row.value.taskId,
            receipt: row.value.receipt ?? null,
          })),
          admissionIntents: admissionIntents.map(({ value }) => ({
            operationId: value.operationId,
            messageId: value.messageId,
            taskId: value.taskId,
            hasModel: !!value.model,
          })),
          creations: creations.map((row) => ({ conversationId: row.value.conversationId })),
          piIds: conversations.items.filter((c) => !c.owner).map((c) => String(c.id)),
        });
      }
      if (action === "inspect")
        return Response.json(await this.inspectConversation(url.searchParams.get("cid") ?? ""));
      if (action === "tool") {
        await this.queueTool(await request.text());
        return Response.json({ queued: true });
      }
      if (action === "tool-state")
        return Response.json(await this.toolState(url.searchParams.get("cid") ?? ""));
      return new Response(null, { status: 404 });
    }
    return super.onRequest(request);
  }
  async inspectConversation(cid: string) {
    await this.lifecycle.start();
    const row = await this.store.get<ConversationRow>("conversation", cid);
    if (!row) throw new Error("Unknown test conversation");
    const page = await this.pi
      .session(row.piId)
      .entries({ order: "ascending" }, 100, BACKGROUND_CONTEXT);
    const harness = await this.pi.pi();
    const inspection = await harness.inspect(BACKGROUND_CONTEXT);
    return {
      piId: row.piId,
      entries: page.items.map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        models: (entry.model ?? []).flatMap((message) =>
          message.role === "assistant" ? [message.model] : [],
        ),
        text: (entry.model ?? [])
          .flatMap((message) =>
            typeof message.content === "string"
              ? [message.content]
              : message.content.filter((part) => part.type === "text").map((part) => part.text),
          )
          .join("\n"),
      })),
      modelCalls: this.faux?.state.callCount ?? 0,
      inputSubmissions:
        page.items.filter((entry) => entry.kind === "pi.user").length +
        inspection.submissions.filter(
          (submission) =>
            String(submission.conversationId) === row.piId &&
            submission.type === "input" &&
            submission.status === "queued",
        ).length,
      jobs: this.lifecycle.jobs.list().map((job) => ({ id: job.id, fn: job.fn, time: job.time })),
    };
  }
  async disposePi() {
    await this.pi.dispose();
  }
  async queueTool(argumentsJson: string) {
    await this.lifecycle.start();
    await this.pi.pi();
    if (!this.faux) throw new Error("Faux provider unavailable");
    this.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("fortipi_dispatch", JSON.parse(argumentsJson) as D.JsonObject),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("tool-settled"),
    ]);
  }
  async failNextModel() {
    await this.lifecycle.start();
    await this.pi.pi();
    if (!this.faux) throw new Error("Faux provider unavailable");
    this.faux.setResponses([
      () => {
        throw new Error("synthetic-kept-input");
      },
      fauxAssistantMessage("resumed-without-input"),
    ]);
  }
  async toolState(cid: string) {
    const mapped = await this.store.get<ConversationRow>("conversation", cid);
    if (!mapped) throw new Error("Unknown conversation");
    const pi = await this.pi.pi();
    const tasks = await pi.commit(
      (tx) =>
        tx.scanTasks(
          {
            conversationId: Number(
              mapped.piId,
            ) as import("@earendil-works/pi-durable").ConversationId,
          },
          100,
        ),
      BACKGROUND_CONTEXT,
    );
    const jobs = await this.store.page<import("../../src/execution/jobs.js").JobState>("job", 100);
    return {
      tasks: tasks.items.map((task) => ({
        id: task.id,
        kind: task.kind,
        owner: task.owner ?? null,
        status: task.state.status,
      })),
      jobs: jobs
        .filter((row) => row.value.job.conversationId === cid)
        .map((row) => ({
          jobId: row.value.job.jobId,
          state: row.value.job.state,
          approvalId: row.value.approvalId ?? null,
          hasExecution: !!row.value.job.execution,
        })),
    };
  }
  async toolStateJson(cid: string) {
    return JSON.stringify(await this.toolState(cid));
  }
  async freshReferenceCount(cid: string): Promise<number> {
    const row = await this.store.get<ConversationRow>("conversation", cid);
    if (!row) throw new Error("Unknown test conversation");
    const harness = await this.pi.pi(),
      document = await harness.snapshot(
        FreshJobDoc,
        Number(row.piId) as import("@earendil-works/pi-durable").ConversationId,
        BACKGROUND_CONTEXT,
      );
    return Object.keys(document?.children ?? {}).length;
  }
  async activeJobPorts(jobId: string) {
    const state = await this.jobs.state(jobId);
    if (!state.assignment || !state.reservation)
      throw new Error("Actual admitted assignment required");
    const auth = this.dispatch.auth(state),
      workspace = this.env.WORKSPACES.getByName(state.job.workspaceId),
      wsAuth = { ...auth, registrationId: state.reservation.registrationIds.workspace };
    const query = await this.authority.control.queryExecution(
      auth,
      await this.jobs.observationIdentity(state),
    );
    const lease =
      (await this.store.get<D.Lease>("lease-observation", jobId)) ??
      state.assignment.identity.lease;
    const renewal = await workspace.renewLease(wsAuth, {
      requestId: `pressure_${jobId}_${lease.leaseVersion}`,
      lease,
      expectedLeaseVersion: lease.leaseVersion,
      expiresAt: Math.min(state.deadline, Date.now() + 30000),
    });
    let delivery = "not_renewed";
    if (renewal.ok && state.assignment.identity.target.kind === "executor") {
      await this.jobs.retainLease(auth, jobId, renewal.value);
      const target = state.assignment.identity.target;
      const delivered = await this.authority.control.deliverExecutorFrame(auth, {
        executorId: target.executorId,
        generation: target.generation,
        frame: {
          type: "job.lease_update",
          requestId: `pressure_delivery_${jobId}_${renewal.value.leaseVersion}`,
          payload: {
            identity: state.assignment.identity,
            leaseVersion: renewal.value.leaseVersion,
            expiresAt: renewal.value.expiresAt,
          },
        },
      });
      delivery = delivered.ok ? "delivered" : delivered.code;
    }
    const facts = await workspace.fetch(
      new Request("https://workspace.internal/__fortipi/facts", {
        method: "POST",
        headers: { "x-fortipi-workspace-context": JSON.stringify({ auth: wsAuth }) },
        body: JSON.stringify({ recipient: { kind: "agent", id: this.agentId }, limit: 100 }),
      }),
    );
    const factBody = await facts.json<D.Outcome<D.FactPage>>();
    return JSON.stringify({
      jobId,
      identity: state.assignment.identity,
      leaseExpiresAt: lease.expiresAt,
      query: query.ok ? query.value.state : query.code,
      renewal: renewal.ok ? "renewed" : renewal.code,
      delivery,
      facts: factBody.ok ? "read" : factBody.code,
    });
  }
  async leaseProjectionFacts(jobId: string) {
    const state = await this.jobs.state(jobId),
      original = state.assignment!.identity,
      effective = await this.jobs.observationIdentity(state),
      history = await this.store.get<D.Lease>(
        "lease-history",
        `${jobId}:${original.lease.leaseVersion + 1}`,
      );
    if (!history) throw new Error("Real historical Workspace renewal required");
    for (const identity of [original, effective, { ...original, lease: history }])
      await this.jobs.requireObservationIdentity(state, identity);
    const candidates: Record<string, D.ExecutionIdentity> = {
      unknownVersion: {
        ...effective,
        lease: { ...effective.lease, leaseVersion: effective.lease.leaseVersion + 10 },
      },
      changedExpiry: {
        ...effective,
        lease: { ...effective.lease, expiresAt: effective.lease.expiresAt + 1 },
      },
      changedFence: {
        ...effective,
        lease: { ...effective.lease, fence: `${effective.lease.fence}1` },
      },
      changedGeneration: {
        ...effective,
        lease: { ...effective.lease, executorGeneration: effective.lease.executorGeneration + 1 },
      },
      changedDigest: { ...effective, assignmentDigest: "0".repeat(64) },
      changedTarget: {
        ...effective,
        target: { ...effective.target, generation: effective.target.generation + 1 },
      },
    };
    const rejected: string[] = [];
    for (const [label, candidate] of Object.entries(candidates)) {
      try {
        await this.jobs.requireObservationIdentity(state, candidate);
      } catch {
        rejected.push(label);
      }
    }
    return {
      originalVersion: original.lease.leaseVersion,
      effectiveVersion: effective.lease.leaseVersion,
      historicalVersion: history.leaseVersion,
      rejected,
    };
  }
  async jobDiagnosticsJson(jobId: string) {
    const state = await this.jobs.state(jobId);
    return JSON.stringify({
      phase: state.job.state,
      resultDelivery: this.#resultDelivery ?? null,
      hasReservation: !!state.reservation,
      hasLease: !!state.assignment,
      hasLocalPreparation: !!state.localPreparation,
      hasLocalIntent: !!state.localIntent,
      receiptRetained: !!(await this.store.get("receipt", jobId)),
      nativeReceiptAck:
        (await this.store.get<{ acknowledged: boolean }>("native-receipt-ack", jobId))
          ?.acknowledged ?? null,
      completeManifestRetained: !!(
        await this.store.get<Extract<D.LocalObservation, { state: "applied" }>>(
          "local-observation",
          jobId,
        )
      )?.postManifest,
      pressure: (await this.store.get("job-pressure", jobId)) ?? null,
    });
  }
  async nativeObservationRequest(jobId: string) {
    const state = await this.jobs.state(jobId);
    if (state.localRequest?.kind !== "prepare" || !state.localPreparation)
      throw new Error("Actual preparation required");
    const { kind: _kind, mode: _mode, expectedManifestHash: _hash, ...scope } = state.localRequest;
    return JSON.stringify({
      ...scope,
      kind: "observe",
      preparationId: state.localPreparation.preparationId,
    });
  }
  async registrationDebugInput(jobId: string) {
    const state = await this.jobs.state(jobId);
    return JSON.stringify({ auth: state.auth, identity: state.assignment?.identity });
  }
  async nativeProofMatrix(jobId: string) {
    const state = await this.jobs.state(jobId),
      observation = await this.store.get<Extract<D.LocalObservation, { state: "applied" }>>(
        "local-observation",
        jobId,
      );
    if (!observation?.postManifest) throw new Error("Actual forwarded complete manifest required");
    await nativeProof(state, observation, this.store.policy);
    const { postManifest: _manifest, ...hashOnly } = observation;
    const cases: Record<string, D.LocalObservation> = {
      hashOnly,
      wrongExecution: { ...observation, executionId: "wrong_execution" },
      wrongHash: { ...observation, postManifestHash: "0".repeat(64) },
      wrongPreparation: { ...observation, preparationId: "wrong_preparation" },
      wrongDigest: { ...observation, operationDigest: "0".repeat(64) },
      wrongManifest: { ...observation, postManifest: { version: 1, entries: [] } },
    };
    const rejected: string[] = [];
    for (const [name, value] of Object.entries(cases)) {
      try {
        await nativeProof(state, value, this.store.policy);
      } catch {
        rejected.push(name);
      }
    }
    return JSON.stringify({
      positive: true,
      rejected,
      realManifestEntries: observation.postManifest.entries.length,
    });
  }
  async terminalProofMatrix(jobId: string) {
    const state = await this.jobs.state(jobId);
    if (state.job.state !== "completed" || !state.terminalSeq || !state.job.execution)
      throw new Error("Actual completed job/event required");
    const auth = this.dispatch.auth(state),
      proof: D.JobCommitted = {
        identity: state.job.execution,
        evidence: state.job.evidence,
        terminalVersion: state.job.version,
        eventSeq: state.terminalSeq,
      };
    await this.jobs.terminalProof(auth, jobId, proof);
    const rejected: string[] = [];
    const cases: Record<string, { auth: D.AuthContext; proof: D.JobCommitted }> = {
      missingTool: {
        auth: {
          ...auth,
          grants: auth.grants.map((grant) => ({
            ...grant,
            resources: { ...grant.resources, tools: [] },
          })),
        },
        proof,
      },
      expiredContext: { auth: { ...auth, deadline: Date.now() - 1 }, proof },
      differentEvent: { auth, proof: { ...proof, eventSeq: proof.eventSeq + 1 } },
    };
    for (const [label, input] of Object.entries(cases)) {
      try {
        await this.jobs.terminalProof(input.auth, jobId, input.proof);
      } catch {
        rejected.push(label);
      }
    }
    const exact = this.store.exactEvent.bind(this.store);
    this.store.exactEvent = async (...args) => {
      const event = await exact(...args);
      await this.store.put("credential-floor", auth.credentialId, auth.generation + 1);
      return event;
    };
    try {
      await this.jobs.terminalProof(auth, jobId, proof);
    } catch {
      rejected.push("floorAfterEventAwait");
    } finally {
      this.store.exactEvent = exact;
    }
    try {
      await this.jobs.terminalProof(auth, jobId, proof);
    } catch {
      rejected.push("currentFloor");
    }
    return { positive: true, rejected };
  }
  async completionGuardMatrix(jobId: string) {
    const state = await this.jobs.state(jobId),
      result = state.job.preparedResult,
      receipt = await this.store.get<D.CommitReceipt>("receipt", jobId);
    if (!result || state.job.state !== "completed")
      throw new Error("Real completed result required");
    if (!receipt) throw new Error("Actual retained commit receipt required");
    const auth = this.dispatch.auth(state),
      input: D.ResultDelivery = {
        identity: result.identity,
        result,
        sequence: result.sequence,
        deliveryId: `guard_${jobId}`,
      };
    const duplicate = await this.jobs.savePreparedResult(auth, input);
    const rejected: string[] = [];
    const checks: Record<string, D.AuthContext> = {
      wrongRegistration: { ...auth, registrationId: "another_registration" },
      missingTool: {
        ...auth,
        grants: auth.grants.map((g) => ({ ...g, resources: { ...g.resources, tools: [] } })),
      },
      splitActions: {
        ...auth,
        grants: auth.grants.flatMap((g) => [
          { ...g, resources: { ...g.resources, actions: ["jobs.dispatch"] } },
          {
            ...g,
            grantId: `${g.grantId}_write`,
            resources: { ...g.resources, actions: ["workspace.write"] },
          },
        ]),
      },
    };
    for (const [label, context] of Object.entries(checks))
      if (!(await this.jobs.savePreparedResult(context, input)).ok) rejected.push(label);
    const finalize: D.FinalizeJob = {
      jobId,
      expectedVersion: state.job.version,
      expectedState: "completed",
      state: "completed",
      evidence: { kind: "committed", receipt },
      event: this.jobs.event(state),
    };
    const finalDuplicate = await this.jobs.finalize(auth, finalize);
    for (const operation of ["result", "finalize"] as const) {
      const expiresAt = Date.now() + 100,
        expiring = { ...auth, grants: auth.grants.map((g) => ({ ...g, expiresAt })) },
        transaction = this.store.transaction.bind(this.store);
      let entered = false;
      this.store.transaction = async (fn) => {
        this.store.transaction = transaction;
        entered = true;
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.max(0, expiresAt - Date.now() + 1)),
        );
        return transaction(fn);
      };
      try {
        const outcome =
          operation === "result"
            ? await this.jobs.savePreparedResult(expiring, input)
            : await this.jobs.finalize(expiring, finalize);
        if (entered && !outcome.ok && outcome.code === "unauthorized")
          rejected.push(`${operation}GrantExpiredAfterAwait`);
      } finally {
        this.store.transaction = transaction;
      }
    }
    // An actual owned SQL floor lands after the initial check, ahead of the
    // queued mutation. Restore this deliberate test fault after observing it.
    const floor = await this.store.get<number>("credential-floor", auth.credentialId),
      transaction = this.store.transaction.bind(this.store);
    this.store.transaction = async (fn) => {
      this.store.transaction = transaction;
      await this.store.put("credential-floor", auth.credentialId, auth.generation + 1);
      return transaction(fn);
    };
    try {
      const guarded = await this.jobs.savePreparedResult(auth, input);
      if (!guarded.ok && guarded.code === "unauthorized") rejected.push("floorAfterAwait");
    } finally {
      this.store.transaction = transaction;
      if (floor === undefined) await this.store.remove("credential-floor", auth.credentialId);
      else await this.store.put("credential-floor", auth.credentialId, floor);
    }
    return {
      duplicate: duplicate.ok,
      finalDuplicate: finalDuplicate.ok,
      rejected,
      versionUnchanged: (await this.jobs.state(jobId)).job.version === state.job.version,
    };
  }
  async commitNativeAndLoseReply(jobId: string, observationJson: string) {
    try {
      const state = await this.jobs.state(jobId),
        known = await nativeContext(state),
        verified = await nativeProof(state, JSON.parse(observationJson), this.store.policy);
      if (!verified.manifest || !state.reservation)
        throw new Error("Actual complete changed manifest required");
      const digest = await commitDigest({
        commitId: known.intent.commitId,
        operationId: state.operation.operationId,
        jobId,
        workspaceId: state.job.workspaceId,
        baseRevision: state.job.baseRevision,
        manifestHash: verified.observation.postManifestHash,
        leaseIdentity: known.identity.lease,
        storage: {
          kind: "local",
          preparationId: known.prepared.preparationId,
          observationSeq: verified.observation.observationSeq,
          preManifestHash: known.intent.preManifestHash,
          postManifestHash: verified.observation.postManifestHash,
        },
      });
      await this.store.put("native-commit-intent", jobId, {
        workspaceId: state.job.workspaceId,
        commitId: known.intent.commitId,
        commitDigest: digest,
      });
      const receipt = unwrap(
        await this.env.WORKSPACES.getByName(state.job.workspaceId).commitLocal(
          {
            ...this.dispatch.auth(state),
            registrationId: state.reservation.registrationIds.workspace,
          },
          { intent: known.intent, observation: verified.observation, manifest: verified.manifest },
        ),
      );
      if (await this.store.get("receipt", jobId))
        throw new Error("Lost-reply setup must not cache an Agent receipt");
      if (receipt.providerKind !== "local") throw new Error("Actual local receipt required");
      return JSON.stringify({
        commitId: receipt.commitId,
        commitDigest: receipt.commitDigest,
        manifestHash: receipt.manifestHash,
        observationSeq: receipt.observationSeq,
      });
    } catch (error) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : "Native receipt setup failed",
      });
    }
  }
  async finishKnownReceiptWithoutObservation(jobId: string) {
    let observeCalls = 0;
    try {
      const original = this.authority.control;
      const control: ControlPort = {
        fetch: (request) => original.fetch(request),
        authorize: (input) => original.authorize(input),
        reserveCapacity: (ctx, input) => original.reserveCapacity(ctx, input),
        settleCapacity: (ctx, input) => original.settleCapacity(ctx, input),
        reserveTarget: (ctx, input) => original.reserveTarget(ctx, input),
        registerAuthorityRecipient: (ctx, input) => original.registerAuthorityRecipient(ctx, input),
        recordDispatchIntent: (ctx, input) => original.recordDispatchIntent(ctx, input),
        assignOnce: (ctx, input) => original.assignOnce(ctx, input),
        queryExecution: (ctx, input) => original.queryExecution(ctx, input),
        cancelExecution: (ctx, input) => original.cancelExecution(ctx, input),
        deliverExecutorFrame: (ctx, input) => original.deliverExecutorFrame(ctx, input),
        resolveExecutorGeneration: (ctx, input) => original.resolveExecutorGeneration(ctx, input),
        requestLocalWorkspace: async (ctx, input) => {
          if (input.kind === "observe") {
            observeCalls++;
            throw new Error("Fresh observation deliberately unavailable");
          }
          return original.requestLocalWorkspace(ctx, input);
        },
      };
      const jobs = new Jobs(this.store, new Authority(this.store, control, this.agentId));
      const dispatch = new Dispatch(jobs, this.env);
      await dispatch.commitResult(await jobs.state(jobId));
      const state = await jobs.state(jobId);
      return JSON.stringify({
        observeCalls,
        state: state.job.state,
        eventSeq: state.terminalSeq ?? null,
        receiptRetained: !!(await this.store.get("receipt", jobId)),
        notificationPending: !!(await this.store.get("terminal-notification", jobId)),
      });
    } catch (error) {
      const state = await this.jobs.state(jobId);
      return JSON.stringify({
        observeCalls,
        error: error instanceof Error ? error.message : "Known receipt closure failed",
        state: state.job.state,
        eventSeq: state.terminalSeq ?? null,
        receiptRetained: !!(await this.store.get("receipt", jobId)),
        notificationPending: !!(await this.store.get("terminal-notification", jobId)),
      });
    }
  }
  async interruptForReconciliation(jobId: string) {
    await this.jobs.interrupt(jobId, "Actual result committed after the Pi caller lost certainty");
    return this.jobs.public((await this.jobs.state(jobId)).job);
  }
  async reconciliationFacts(operationId: string) {
    const row = await this.store.get<{
      originalDisposition: string;
      piOutcomePreserved: boolean;
      verified?: unknown;
    }>("reconciled", operationId);
    return {
      applied: !!row,
      originalDisposition: row?.originalDisposition,
      piOutcomePreserved: row?.piOutcomePreserved,
      evidenceRetained: !!row?.verified,
    };
  }
  async inspectionJson(cid: string) {
    return JSON.stringify(await this.inspectConversation(cid));
  }
  releaseCompletion() {
    this.completion.resolve();
  }
  async runRepair() {
    return this.projection.drain({ maxItems: 16, deadline: Date.now() + 10000 });
  }
  async storageReport() {
    await this.lifecycle.start();
    return JSON.stringify({
      bytes: this.store.physicalBytes(),
      objectBytes: this.store.policy.bounds.objectBytes,
      headroomFraction: this.store.policy.bounds.headroomFraction,
    });
  }
  async sampleOracle(auth: D.AuthContext, completedReservationId: string) {
    await this.lifecycle.start();
    return JSON.stringify(
      await samplingOracle(
        this.store,
        this.authority,
        await this.pi.pi(),
        auth,
        completedReservationId,
      ),
    );
  }
  async physicalSample(auth: D.AuthContext, conversationId?: string) {
    await this.lifecycle.start();
    await this.authority.physical.beforeGrowth(
      auth,
      scope({
        agentIds: [this.agentId],
        conversationIds: conversationId ? [conversationId] : [],
        actions: [conversationId ? "messages.submit" : "conversations.create"],
      }),
    );
    return JSON.stringify(await this.store.get("meta", "storage-report"));
  }
  async lastPhysicalSample() {
    return JSON.stringify(await this.store.get("meta", "storage-report"));
  }
  socketReport() {
    return JSON.stringify(
      this.ctx.getWebSockets().map((socket) => {
        const attachment: unknown = socket.deserializeAttachment();
        const encoded = JSON.stringify(attachment);
        return {
          bytes: new TextEncoder().encode(encoded).length,
          containsGrants: encoded.includes('"grants"'),
          containsTicket: encoded.includes("ticket="),
          attachment,
        };
      }),
    );
  }
  async fillStorageHeadroom() {
    await this.lifecycle.start();
    const threshold = Math.floor(
      this.store.policy.bounds.objectBytes * (1 - this.store.policy.bounds.headroomFraction),
    );
    const padding = "x".repeat(1048576);
    let writes = 0;
    while (this.store.physicalBytes() < threshold && writes < 8) {
      await this.store.put("fixture-fill", crypto.randomUUID(), { padding });
      writes++;
    }
    return this.storageReport();
  }
  async admissionStatus() {
    const rows = await this.store.page<import("../../src/agent/conversations.js").Admission>(
      "admission",
      10,
    );
    return rows.map((row) => ({
      state: row.value.state,
      reservationId: row.value.capacity.reservationId,
      receipt: row.value.receipt ?? null,
    }));
  }
  async beginRepairProbe() {
    await this.lifecycle.start();
    this.projection.drain = async () => {
      this.repairCalls++;
      await (this.repairCalls === 1 ? this.oldRepair : this.newRepair).promise;
      return { processed: 1, remaining: true, nextWakeAt: Date.now() + 30000 };
    };
    await this.recovery.arm();
  }
  async driveRepairProbe() {
    await this.lifecycle.alarm();
  }
  async supersedeRepairProbe() {
    await this.recovery.arm();
  }
  releaseRepairProbe(which: "old" | "new") {
    (which === "old" ? this.oldRepair : this.newRepair).resolve();
  }
  async repairProbeJson() {
    return JSON.stringify({
      calls: this.repairCalls,
      state: await this.store.get("meta", "repair"),
      jobs: this.lifecycle.jobs
        .list()
        .filter((job) => job.fn === "fortipi.repair")
        .map((job) => ({ id: job.id, time: job.time })),
    });
  }
  async modelSelectionProbeJson(payload: string) {
    const input = JSON.parse(payload) as { auth: D.AuthContext; body: string; status: number };
    let calls = 0,
      canonical = false;
    const model = await configuredModel(
      {
        fetch: async (request) => {
          calls++;
          canonical =
            request.url === "https://control.internal/internal/agents/agent/model" &&
            request.method === "GET" &&
            request.headers.get("X-Fortipi-Context") === JSON.stringify(input.auth) &&
            !request.headers.has("Authorization");
          return new Response(input.body, {
            status: input.status,
            headers: { "Cache-Control": "no-store" },
          });
        },
      },
      "agent",
      input.auth,
    );
    return JSON.stringify({ model, calls, canonical });
  }
}
export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/__test/ping") return new Response("ready");
    const match =
      /^\/__test\/agents\/([A-Za-z0-9_-]+)\/(canary|fault|state|inspect|tool|tool-state)$/.exec(
        url.pathname,
      );
    if (match) {
      url.pathname = `/__test/${match[2]}`;
      return env.AGENT_SESSIONS.getByName(match[1]!).fetch(new Request(url, request));
    }
    return routeRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
