import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ConnectionStatus, CursorScope, Subscription } from "fortipi-client/node";
import { cursorScopeKey, type FortiPiClient, FortiPiError } from "fortipi-client/node";
import type {
  AdmissionReceipt,
  Agent,
  Approval,
  Conversation,
  InfrastructurePressure,
  Job,
  MessageSubmit,
  ReconcileInput,
  TaskResume,
  TicketIdentity,
  WorkspaceTransaction,
} from "fortipi-contract";
import { canonicalJson } from "fortipi-contract";
import { Projection } from "./projection.js";

export type View =
  | "conversation"
  | "agents"
  | "conversations"
  | "task"
  | "approvals"
  | "reconcile"
  | "workspace"
  | "ids"
  | "help"
  | "profiles";
export interface Choice {
  id: string;
  title: string;
}
export class Controller {
  client: FortiPiClient;
  projection = new Projection();
  connection: ConnectionStatus = "offline";
  view: View = "conversation";
  choices: Choice[] = [];
  agentId: string | undefined;
  conversationId: string | undefined;
  composer = "";
  detail = "";
  notice = "";
  searchProgress = "";
  private searchQuery = "";
  nextPageToken: string | undefined;
  pressure: InfrastructurePressure | undefined;
  ticketIdentity: TicketIdentity | undefined;
  private cursorScope: CursorScope | undefined;
  selectedApproval: Approval | undefined;
  selectedJob: Job | undefined;
  private selection = new AbortController();
  private live = new AbortController();
  private connectionEpoch = 0;
  private browsing = new AbortController();
  private generation = 0;
  private subscription: Subscription | undefined;
  private pending:
    | { conversationId: string; kind: "send" | "steer"; body: MessageSubmit }
    | undefined;
  private readonly listeners = new Set<() => void>();
  constructor(client: FortiPiClient) {
    this.client = client;
  }
  listen(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  changed(): void {
    for (const listener of this.listeners) listener();
  }
  report(error: unknown): void {
    const issue = error instanceof FortiPiError ? error : new FortiPiError("action_failed");
    this.notice = `${issue.code}${issue.requestId ? ` request ${issue.requestId}` : ""}${issue.details?.reason ? ` (${issue.details.reason})` : ""}`;
    if (
      issue.code === "unauthenticated" ||
      issue.code === "invalid_application_credential" ||
      issue.code === "invalid_credential_file"
    )
      this.notice +=
        "; select a profile or replace its protected application credential through operator tooling";
    if (issue.code === "unauthorized")
      this.notice += "; this application credential lacks the requested grant";
    if (issue.details?.setup) this.notice += `; operator setup: ${issue.details.setup}`;
    this.pressure = issue.details?.pressure;
    this.changed();
  }
  private resetSelection(): number {
    this.live.abort();
    this.connectionEpoch++;
    this.subscription?.close();
    this.subscription = undefined;
    this.selection.abort();
    this.selection = new AbortController();
    this.browsing.abort();
    this.browsing = new AbortController();
    this.generation++;
    return this.generation;
  }
  changeClient(client: FortiPiClient): void {
    this.resetSelection();
    this.client = client;
    this.projection = new Projection();
    this.pending = undefined;
    this.agentId = undefined;
    this.conversationId = undefined;
    this.ticketIdentity = undefined;
    this.cursorScope = undefined;
    this.composer = "";
    this.connection = "offline";
    this.choices = [];
    this.detail = "";
    this.selectedApproval = undefined;
    this.selectedJob = undefined;
    this.changed();
  }
  async browse(kind: "agents" | "conversations", query = "", continuation = false): Promise<void> {
    if (continuation) query = this.searchQuery;
    else this.searchQuery = query;
    this.browsing.abort();
    this.browsing = new AbortController();
    const signal = AbortSignal.any([this.selection.signal, this.browsing.signal]);
    const generation = this.generation;
    const agentId = this.agentId;
    if (kind === "conversations" && !agentId) throw new FortiPiError("select_agent");
    const client = this.client;
    this.view = kind;
    if (!continuation) {
      this.choices = [];
      this.nextPageToken = undefined;
    }
    let token = continuation ? this.nextPageToken : undefined;
    const seen = new Set<string>();
    let pages = 0;
    do {
      this.searchProgress = `Searching page ${++pages}${token ? " (continued)" : ""}`;
      this.changed();
      const page =
        kind === "agents"
          ? await client.agents.list(
              { limit: 100, ...(token ? { pageToken: token } : {}) },
              { signal },
            )
          : await client.conversations.list(
              agentId as string,
              { limit: 100, ...(token ? { pageToken: token } : {}) },
              { signal },
            );
      if (generation !== this.generation || signal.aborted) return;
      for (const item of page.items) {
        const id =
          "conversationId" in item
            ? (item as Conversation).conversationId
            : (item as Agent).agentId;
        const title = "title" in item ? item.title : item.name;
        if (!query || `${id} ${title}`.toLowerCase().includes(query.toLowerCase()))
          this.choices.push({ id, title });
      }
      token = page.nextPageToken;
      this.nextPageToken = token;
      if (token && seen.has(token)) throw new FortiPiError("invalid_pagination");
      if (token) seen.add(token);
      this.changed();
      // Yield visible continuation after bounded work; search remains cancellable.
    } while (query && token && pages < 10 && this.choices.length < 1000);
    this.searchProgress = `${this.choices.length} matches${token ? " — /more continues" : " — complete"}`;
    this.changed();
  }
  stopSearch(): void {
    this.browsing.abort();
    this.searchProgress = "Search stopped; /more continues";
    this.changed();
  }
  async choose(id: string): Promise<void> {
    if (this.view === "agents") {
      this.agentId = id;
      await this.browse("conversations");
    } else if (this.view === "conversations") await this.open(id);
    else if (this.view === "approvals") await this.approval(id);
  }
  async create(title = "New conversation"): Promise<void> {
    if (!this.agentId) throw new FortiPiError("select_agent");
    const generation = this.generation;
    const value = await this.client.conversations.create(
      this.agentId,
      { requestId: globalThis.crypto.randomUUID(), title },
      { signal: this.selection.signal },
    );
    if (generation === this.generation) await this.open(value.conversationId);
  }
  async open(conversationId: string): Promise<void> {
    this.resetSelection();
    this.choices = [];
    this.conversationId = conversationId;
    this.projection = new Projection(
      this.client.http.protocol?.infrastructure.bounds.inlineTailBytes ?? 32768,
    );
    this.composer = "";
    this.pending = undefined;
    this.detail = "";
    this.notice = "";
    this.selectedApproval = undefined;
    this.selectedJob = undefined;
    this.view = "conversation";
    this.changed();
    await this.connect(false);
  }
  private async connect(retain: boolean): Promise<void> {
    const id = this.conversationId;
    if (!id) throw new FortiPiError("select_conversation");
    const generation = this.generation;
    const epoch = ++this.connectionEpoch;
    if (retain) this.cursorScope = this.subscription?.scope ?? this.cursorScope;
    else this.cursorScope = undefined;
    this.subscription?.close();
    this.live.abort();
    this.live = new AbortController();
    const liveSignal = AbortSignal.any([this.live.signal, this.selection.signal]);
    const current = () =>
      generation === this.generation && epoch === this.connectionEpoch && !liveSignal.aborted;
    const priorScope = this.cursorScope;
    const subscription = this.client.conversations.subscribe(id, {
      signal: liveSignal,
      ...(retain && priorScope ? { after: this.projection.cursor, scope: priorScope } : {}),
      onSnapshot: async (value) => {
        if (!current()) return;
        const restored = new Projection(
          this.client.http.protocol?.infrastructure.bounds.inlineTailBytes ?? 32768,
        );
        restored.replace(value);
        const client = this.client;
        const signal = liveSignal;
        let after = value.retainedFloor;
        while (after < value.lastEventSeq) {
          const page = await client.conversations.events(
            id,
            {
              after,
              through: value.lastEventSeq,
              limit: Math.min(100, client.http.protocol?.limits.replayPage ?? 100),
            },
            { signal },
          );
          if (!current()) return;
          if (page.after !== after || page.through !== value.lastEventSeq || !page.events.length)
            throw new FortiPiError("invalid_replay");
          for (const event of page.events) {
            if (
              event.eventSeq !== after + 1 ||
              event.conversationId !== id ||
              event.deploymentId !== client.http.protocol?.deploymentId
            )
              throw new FortiPiError("invalid_replay");
            restored.restoreContext(event);
            after = event.eventSeq;
          }
          if (page.nextAfter !== after || (!page.hasMore && after !== value.lastEventSeq))
            throw new FortiPiError("invalid_replay");
        }
        if (!current()) return;
        // Historical metadata cannot replace the authoritative snapshot's current task state.
        if (restored.snapshot) restored.snapshot.conversation = structuredClone(value.conversation);
        this.projection = restored;
        this.agentId = value.conversation.agentId;
        this.changed();
      },
      onEvent: (event) => {
        if (!current()) return;
        this.projection.apply(event);
        this.changed();
      },
      onIdentity: (identity) => {
        if (!current()) return;
        if (identity.role !== "client") {
          this.projection = new Projection();
          this.ticketIdentity = undefined;
          this.cursorScope = undefined;
          this.composer = "";
          this.pending = undefined;
          this.detail = "";
          this.selectedApproval = undefined;
          this.selectedJob = undefined;
          this.choices = [];
          throw new FortiPiError("application_credential_required");
        }
        if (
          this.ticketIdentity &&
          cursorScopeKey({
            origin: this.client.http.origin,
            conversationId: id,
            identity: this.ticketIdentity,
          }) !== cursorScopeKey({ origin: this.client.http.origin, conversationId: id, identity })
        ) {
          this.projection = new Projection();
          this.composer = "";
          this.pending = undefined;
          this.detail = "";
          this.selectedApproval = undefined;
          this.selectedJob = undefined;
          this.choices = [];
        }
        this.ticketIdentity = identity;
        this.changed();
      },
      onStatus: (status, error) => {
        if (!current()) return;
        this.connection = status;
        if (status === "online") {
          this.pressure = undefined;
          this.notice = "Connected";
        }
        if (error) this.report(error);
        this.changed();
      },
    });
    this.subscription = subscription;
    void subscription.done.catch((error) => {
      if (current()) this.report(error);
    });
    await subscription.ready;
    if (current()) this.cursorScope = subscription.scope;
  }
  async disconnect(): Promise<void> {
    const epoch = ++this.connectionEpoch;
    this.live.abort();
    const subscription = this.subscription;
    this.cursorScope = subscription?.scope ?? this.cursorScope;
    this.subscription = undefined;
    subscription?.close();
    await subscription?.done.catch(() => {});
    if (epoch !== this.connectionEpoch) return;
    this.connection = "offline";
    this.notice = "Disconnected; committed projection retained";
    this.changed();
  }
  async reconnect(): Promise<void> {
    await this.connect(true);
  }
  async resnapshot(): Promise<void> {
    await this.connect(false);
  }
  async send(kind: "send" | "steer" = "send"): Promise<AdmissionReceipt> {
    const id = this.conversationId;
    if (!id || !this.composer.trim()) throw new FortiPiError("empty_message");
    if (
      this.pending &&
      (this.pending.kind !== kind ||
        this.pending.body.content !== this.composer ||
        this.pending.conversationId !== id)
    )
      throw new FortiPiError("unresolved_message_intent");
    this.pending ??= {
      conversationId: id,
      kind,
      body: Object.freeze({
        clientRequestId: globalThis.crypto.randomUUID(),
        content: this.composer,
        busyBehavior: "reject",
      }),
    };
    const pending = this.pending;
    const generation = this.generation;
    this.composer = "";
    this.changed();
    try {
      const receipt =
        kind === "send"
          ? await this.client.conversations.send(id, pending.body, {
              signal: this.selection.signal,
            })
          : await this.client.conversations.steer(
              id,
              { clientRequestId: pending.body.clientRequestId, content: pending.body.content },
              { signal: this.selection.signal },
            );
      if (generation === this.generation && this.pending === pending) {
        this.pending = undefined;
        if (this.composer === pending.body.content) this.composer = "";
        this.notice = `Accepted ${receipt.taskId}; awaiting committed completion`;
        this.changed();
      }
      return receipt;
    } catch (error) {
      if (generation === this.generation && !this.composer) this.composer = pending.body.content;
      if (
        error instanceof FortiPiError &&
        ["conflict", "invalid_request", "unauthorized", "unauthenticated"].includes(error.code) &&
        generation === this.generation
      )
        this.pending = undefined;
      if (generation === this.generation) this.changed();
      throw error;
    }
  }
  discardIntent(): void {
    this.pending = undefined;
    this.notice = "Local intent released; accepted work may still have effects";
    this.changed();
  }
  async task(id?: string): Promise<void> {
    id ??= [...this.projection.tasks.keys()].at(-1);
    if (!id) throw new FortiPiError("task_id_required");
    const generation = this.generation;
    const task = await this.client.tasks.get(id, { signal: this.selection.signal });
    if (generation !== this.generation) return;
    this.projection.tasks.set(id, task);
    this.view = "task";
    this.detail = JSON.stringify(task, null, 2);
    this.changed();
  }
  async cancel(id?: string) {
    id ??= [...this.projection.tasks.keys()].at(-1);
    if (!id) throw new FortiPiError("task_id_required");
    const generation = this.generation;
    const receipt = await this.client.tasks.cancel(
      id,
      { requestId: globalThis.crypto.randomUUID(), reason: "User requested cancellation" },
      { signal: this.selection.signal },
    );
    if (generation === this.generation) {
      this.notice = `Cancel intent persisted: ${receipt.disposition.state}; possible external effects: ${receipt.disposition.possibleExternalEffects}`;
      this.changed();
    }
    return receipt;
  }
  async resume(id: string, continuation: TaskResume["continuation"]): Promise<void> {
    const generation = this.generation;
    const receipt = await this.client.tasks.resume(
      id,
      { requestId: globalThis.crypto.randomUUID(), continuation },
      { signal: this.selection.signal },
    );
    if (generation !== this.generation) return;
    this.notice = `Resume intent ${receipt.operationId}: ${receipt.disposition.state}`;
    this.changed();
  }
  listApprovals(): void {
    this.view = "approvals";
    this.choices = [...this.projection.approvals.values()].map((a) => ({
      id: a.approvalId,
      title: `${a.state} ${a.operation.tool} (${a.operation.trust})`,
    }));
    this.detail = "Select an approval; /approvals ID can retrieve any authorized approval.";
    this.changed();
  }
  tool(id: string): void {
    const tool = this.projection.tools.get(id);
    if (!tool) throw new FortiPiError("tool_id_required");
    this.view = "task";
    this.detail = JSON.stringify(tool, null, 2);
    this.changed();
  }
  async transact(workspaceId: string, input: WorkspaceTransaction): Promise<void> {
    const generation = this.generation;
    const receipt = await this.client.workspaces.transact(workspaceId, input, {
      signal: this.selection.signal,
    });
    if (generation !== this.generation) return;
    this.projection.workspaceState.set(workspaceId, `committed ${receipt.revision}`);
    this.view = "workspace";
    this.detail = JSON.stringify(receipt, null, 2);
    this.changed();
  }
  retryIntent(): Promise<AdmissionReceipt> {
    if (!this.pending) throw new FortiPiError("no_pending_intent");
    this.composer = this.pending.body.content;
    return this.send(this.pending.kind);
  }
  async approval(id: string): Promise<void> {
    const generation = this.generation;
    const approval = await this.client.approvals.get(id, { signal: this.selection.signal });
    if (generation !== this.generation) return;
    this.selectedApproval = approval;
    this.projection.approvals.set(id, approval);
    this.view = "approvals";
    this.detail = JSON.stringify(approval, null, 2);
    this.changed();
  }
  async decide(decision: "approve" | "reject"): Promise<void> {
    const shown = this.selectedApproval;
    if (!shown) throw new FortiPiError("select_approval");
    const generation = this.generation;
    const current = await this.client.approvals.get(shown.approvalId, {
      signal: this.selection.signal,
    });
    if (generation !== this.generation) return;
    if (this.selectedApproval !== shown) throw new FortiPiError("stale_approval_context");
    this.selectedApproval = current;
    if (
      current.state !== "pending" ||
      current.version !== shown.version ||
      canonicalJson(current.operation) !== canonicalJson(shown.operation) ||
      current.operation.expiresAt <= Date.now()
    ) {
      this.detail = JSON.stringify(current, null, 2);
      this.changed();
      throw new FortiPiError("stale_approval_context");
    }
    const result = await this.client.approvals.decide(
      current.approvalId,
      {
        requestId: globalThis.crypto.randomUUID(),
        expectedVersion: current.version,
        operationDigest: current.operation.operationDigest,
        decision,
      },
      { signal: this.selection.signal },
    );
    if (generation !== this.generation || this.selectedApproval !== current) return;
    this.selectedApproval = result;
    this.projection.approvals.set(result.approvalId, result);
    this.detail = JSON.stringify(result, null, 2);
    this.notice = `${decision} recorded; local executor policy remains independent`;
    this.changed();
  }
  async job(id?: string): Promise<void> {
    id ??= [...this.projection.jobs.keys()].at(-1);
    if (!id) throw new FortiPiError("job_id_required");
    const generation = this.generation;
    const value = await this.client.jobs.get(id, { signal: this.selection.signal });
    if (generation !== this.generation) return;
    this.selectedJob = value;
    this.view = "reconcile";
    this.detail = JSON.stringify(value, null, 2);
    this.changed();
  }
  async reconcile(action: ReconcileInput["action"], reason: string): Promise<void> {
    const shown = this.selectedJob;
    if (!shown || !reason.trim()) throw new FortiPiError("reconciliation_context_required");
    const generation = this.generation;
    const current = await this.client.jobs.get(shown.jobId, { signal: this.selection.signal });
    if (generation !== this.generation) return;
    if (this.selectedJob !== shown) throw new FortiPiError("stale_job_context");
    if (current.version !== shown.version) {
      this.selectedJob = current;
      this.detail = JSON.stringify(current, null, 2);
      this.changed();
      throw new FortiPiError("stale_job_context");
    }
    const receipt = await this.client.jobs.reconcile(
      current.jobId,
      {
        requestId: globalThis.crypto.randomUUID(),
        expectedVersion: current.version,
        reason,
        action,
      },
      { signal: this.selection.signal },
    );
    if (generation !== this.generation || this.selectedJob !== shown) return;
    this.notice = `Reconciliation ${receipt.disposition}${receipt.newJobId ? ` new job ${receipt.newJobId}` : ""}; external effects are not rolled back`;
    this.detail = JSON.stringify(receipt, null, 2);
    this.changed();
  }
  async workspace(id: string): Promise<void> {
    const generation = this.generation;
    const value = await this.client.workspaces.get(id, { signal: this.selection.signal });
    if (generation !== this.generation) return;
    this.projection.workspace = value;
    this.view = "workspace";
    this.detail = JSON.stringify(value, null, 2);
    this.changed();
  }
  async diff(id: string, from: string, to: string): Promise<void> {
    const generation = this.generation;
    const value = await this.client.workspaces.diff(
      id,
      { revision: from, otherRevision: to },
      { signal: this.selection.signal },
    );
    if (generation === this.generation) {
      this.view = "workspace";
      this.detail = JSON.stringify(value, null, 2);
      this.changed();
    }
  }
  async read(id: string, revision: string, path: string): Promise<void> {
    const generation = this.generation;
    const bytes = await this.client.workspaces.read(
      id,
      { revision, path, range: { start: 0, end: 32767 } },
      { signal: this.selection.signal },
    );
    if (generation === this.generation) {
      this.view = "workspace";
      this.detail = `${path} @ ${revision}\n${new TextDecoder().decode(bytes)}`;
      this.changed();
    }
  }
  async artifact(id: string, destination?: string): Promise<void> {
    const reference = this.projection.artifacts.get(id);
    if (!reference) throw new FortiPiError("artifact_id_required");
    const generation = this.generation;
    const bytes = await this.client.artifacts.read(reference, { signal: this.selection.signal });
    if (generation !== this.generation) return;
    if (destination) {
      await writeFile(resolve(destination), bytes, { flag: "wx", mode: 0o600 });
      if (generation !== this.generation) return;
      this.notice = "Artifact saved (new file)";
    } else {
      this.view = "workspace";
      this.detail = `${reference.size} bytes; bounded preview:\n${new TextDecoder().decode(bytes.slice(0, 32768))}`;
    }
    this.changed();
  }
  ids(): string {
    return [
      `origin ${this.client.http.origin}`,
      `deployment ${this.client.http.protocol?.deploymentId ?? "unknown"}`,
      `principal ${this.ticketIdentity?.principalId ?? "unknown"}`,
      ...(this.ticketIdentity
        ? [
            `credential ${this.ticketIdentity.credential.credentialId} generation ${this.ticketIdentity.credential.generation} grantVersion ${this.ticketIdentity.credential.grantVersion}`,
            `credential expiry ${this.ticketIdentity.credentialExpiresAt ?? "none advertised"}`,
          ]
        : []),
      `agent ${this.agentId ?? "none"}`,
      `conversation ${this.conversationId ?? "none"}`,
      `cursor ${this.projection.cursor}`,
      ...[...this.projection.tasks.keys()].map((id) => `task ${id}`),
      ...[...this.projection.jobs.keys()].map((id) => `job ${id}`),
      ...[...this.projection.approvals.keys()].map((id) => `approval ${id}`),
      ...[...this.projection.artifacts.keys()].map((id) => `artifact ${id}`),
    ].join("\n");
  }
  close(): void {
    this.resetSelection();
    this.connection = "closed";
    this.changed();
  }
}
