import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  ConversationBusy,
  type ConversationId,
  ConversationIdle,
  type Cursor,
  defineDoc,
  type EntryId,
} from "@earendil-works/pi-durable";
import type { PiHarness } from "agents/harness/pi";
import {
  check,
  digest,
  Lanes,
  resourceId,
  ServiceError,
  same,
  scope,
  unwrap,
} from "../api/common.js";
import type * as D from "../boundary/dto.js";
import type { Authority } from "./authority.js";
import { type EntryMessages, entryMessages, messageParts } from "./message-projection.js";
import { repairRetryAt } from "./repair-retry.js";
import type { ConversationRow, GrowthClaim, Store } from "./store.js";

export const CreationDoc = defineDoc({
  kind: "fortipi.creation",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ intent: "" }),
  checkpointWhen: () => true,
});
export interface CreationIntent {
  key: string;
  digest: string;
  conversationId: string;
  title: string;
  auth: D.AuthContext;
  state: "pending" | "allocated" | "complete";
  piId?: string;
  scan?: Cursor;
  parent?: string;
  through?: number;
  at?: number;
  model?: D.ModelConfig;
  operationId?: string;
  growthBytes?: number;
  policyVersion?: number;
  forkEstimate?: { highWater: number; bytes: number; complete: boolean; cursor?: Cursor };
}
export interface Admission {
  key: string;
  digest: string;
  conversationId: string;
  content: string;
  auth: D.AuthContext;
  operationId: string;
  messageId: string;
  taskId: string;
  capacity: D.CapacityReservation;
  mode: "followUp" | "reject" | "steer";
  state: "pending" | "accepted" | "settlement_pending" | "settled" | "rejection_pending";
  receipt?: D.AdmissionReceipt;
  submission?: number;
  piTask?: number;
  model: D.ModelConfig;
  growthBytes?: number;
  continuation?: { operationId: string; auth: D.AuthContext; capacity: D.CapacityReservation };
}
export type AdmissionIntent = Omit<
  Admission,
  "capacity" | "model" | "state" | "receipt" | "submission" | "piTask" | "continuation"
> & {
  state: "pending";
  policyVersion: number;
  model?: D.ModelConfig;
};
interface RejectedAdmission {
  digest: string;
  operationId: string;
  reason: "busy" | "idle";
  acknowledged: boolean;
  reclaimed: boolean;
}
export interface ConversationHost {
  store: Store;
  authority: Authority;
  pi: PiHarness;
  agentId: string;
  arm(): Promise<void>;
  notify(conversationId: string): Promise<void>;
  selectModel(auth: D.AuthContext, action: string, conversationId?: string): Promise<D.ModelConfig>;
}
export class Conversations {
  readonly lanes = new Lanes();
  allocating: string | undefined;
  readonly host: ConversationHost;
  constructor(host: ConversationHost) {
    this.host = host;
  }
  /** An infrastructure bound on one admitted run, not a provider usage allowance. */
  async configureRun(
    auth: D.AuthContext,
    piId: string,
    conversationId: string,
    action: string,
  ): Promise<void> {
    const resources = scope({
      agentIds: [this.host.agentId],
      conversationIds: [conversationId],
      actions: [action],
    });
    await this.host.authority.current(auth, resources);
    const harness = await this.host.pi.pi();
    const conversation = await harness.conversation(
      Number(piId) as ConversationId,
      BACKGROUND_CONTEXT,
    );
    check(conversation, "interrupted", "Pi conversation unavailable");
    const agent = await conversation.agent(BACKGROUND_CONTEXT);
    await this.host.authority.current(auth, resources);
    if (agent.maxTurns !== 4) await conversation.configure({ maxTurns: 4 }, BACKGROUND_CONTEXT);
    await this.host.authority.current(auth, resources);
  }
  draft(
    cid: string,
  ): Pick<
    D.EventDraft,
    "protocolVersion" | "schemaVersion" | "deploymentId" | "conversationId" | "durability"
  > {
    // Deployment is supplied from persisted admission/creation contexts at each call below.
    return {
      protocolVersion: "1.0",
      schemaVersion: "1.0.0",
      deploymentId: "",
      conversationId: cid,
      durability: "durable",
    };
  }
  async create(
    auth: D.AuthContext,
    body: D.ConversationCreate,
    parent?: ConversationRow,
    fork?: D.ForkInput,
  ): Promise<D.Conversation> {
    return this.lanes.run("creation", async () => {
      const store = this.host.store;
      await this.host.authority.authorize(
        auth,
        parent ? "conversations.fork" : "conversations.create",
        parent?.conversation.conversationId,
      );
      const key = `${auth.principalId}:${parent?.conversation.conversationId ?? "new"}:${body.requestId}`;
      const fingerprint = await digest({
        body,
        parent: parent?.conversation.conversationId ?? null,
        fork: fork ?? null,
      });
      let intent = await store.get<CreationIntent>("creation", key);
      if (intent) check(intent.digest === fingerprint, "conflict", "Creation identity changed");
      else {
        if (parent) {
          check(
            fork && fork.through > 0 && fork.through <= parent.last,
            "conflict",
            "Empty or future fork",
          );
          const prefix = `${parent.conversation.conversationId}:`;
          const found = await store.db.get<{ data: string }>(
            "SELECT data FROM fp_records_v1 WHERE kind='entry-event' AND substr(id,1,?)=? AND CAST(substr(id,?) AS INTEGER)<=? ORDER BY CAST(substr(id,?) AS INTEGER) DESC LIMIT 1",
            prefix.length,
            prefix,
            prefix.length + 1,
            fork.through,
            prefix.length + 1,
          );
          const source = found
            ? (JSON.parse(found.data) as { entry: number; end?: number })
            : undefined;
          check(source, "conflict", "Fork cursor has no committed input prefix");
          check(
            fork.through >= (source.end ?? 0),
            "conflict",
            "Fork cursor splits one committed entry; select its completed projection cursor",
            { reason: "revision_unavailable" },
          );
          intent = {
            key,
            digest: fingerprint,
            conversationId: resourceId("c", this.host.agentId),
            title: body.title ?? parent.conversation.title,
            auth,
            state: "pending",
            parent: parent.conversation.conversationId,
            through: fork.through,
            at: source.entry,
            forkEstimate: { highWater: store.physicalBytes(), bytes: 0, complete: false },
          };
        } else
          intent = {
            key,
            digest: fingerprint,
            conversationId: resourceId("c", this.host.agentId),
            title: body.title ?? "Conversation",
            auth,
            state: "pending",
          };
        const candidate = intent;
        const operationId = resourceId("m", this.host.agentId);
        candidate.operationId = operationId;
        candidate.policyVersion = store.policy.version;
        const metadataBytes = new TextEncoder().encode(JSON.stringify(candidate)).length + 8192;
        let growthBytes = (candidate.forkEstimate?.highWater ?? 0) + metadataBytes;
        candidate.growthBytes = growthBytes;
        const resources = scope({
          agentIds: [this.host.agentId],
          conversationIds: parent ? [parent.conversation.conversationId] : [],
          actions: [parent ? "conversations.fork" : "conversations.create"],
        });
        await this.host.authority.physical.makeRoom(auth, resources, candidate.growthBytes);
        await store.transaction(async (tx) => {
          await this.host.authority.current(auth, resources, tx);
          if (candidate.forkEstimate) {
            candidate.forkEstimate.highWater = Math.max(
              candidate.forkEstimate.highWater,
              store.physicalBytes(),
            );
            growthBytes = candidate.forkEstimate.highWater + metadataBytes;
            candidate.growthBytes = growthBytes;
          }
          await store.claimGrowth(operationId, growthBytes, tx);
          await store.put("creation", key, candidate, tx, Date.now());
          await store.put("meta", "deployment", auth.deploymentId, tx);
        });
      }
      await this.host.arm();
      return this.finishCreation(intent);
    });
  }
  async finishCreation(intent: CreationIntent): Promise<D.Conversation> {
    try {
      return await this.#finishCreation(intent);
    } catch (error) {
      const retryAt = repairRetryAt(error);
      const current = await this.host.store.get<CreationIntent>("creation", intent.key);
      if (current && current.state !== "complete")
        await this.host.store.put("creation", intent.key, current, undefined, retryAt);
      throw error;
    }
  }
  async #finishCreation(intent: CreationIntent): Promise<D.Conversation> {
    const { store, pi } = this.host;
    const old = await store.get<ConversationRow>("conversation", intent.conversationId);
    if (old?.published) return this.#settleCreation(intent, old.conversation);
    const auth = { ...intent.auth, deadline: Date.now() + 30000 };
    const action = intent.parent ? "conversations.fork" : "conversations.create";
    const resources = scope({
      agentIds: [this.host.agentId],
      conversationIds: intent.parent ? [intent.parent] : [],
      actions: [action],
    });
    await this.host.authority.current(auth, resources);
    if (intent.forkEstimate && !intent.forkEstimate.complete)
      await this.#estimateFork(intent, auth, resources);
    if (!intent.model) {
      const model = await this.host.selectModel(auth, action, intent.parent);
      await store.transaction(async (tx) => {
        await this.host.authority.current(auth, resources, tx);
        intent.model = model;
        await store.put("creation", intent.key, intent, tx, Date.now());
      });
    }
    const model = intent.model;
    check(model, "interrupted", "Creation model unavailable");
    if (!(await store.get("creation-capacity", intent.key))) {
      check(
        intent.operationId &&
          intent.growthBytes !== undefined &&
          intent.policyVersion !== undefined,
        "interrupted",
        "Creation reservation identity unavailable",
      );
      const operationId = intent.operationId;
      await this.host.authority.physical.beforeGrowth(auth, resources);
      const capacity = unwrap(
        await this.host.authority.control.reserveCapacity(auth, {
          operationId: intent.operationId,
          ownerId: this.host.agentId,
          policyVersion: intent.policyVersion,
          bytes: intent.growthBytes,
          admissionSlots: 0,
        }),
      );
      await store.transaction(async (tx) => {
        await this.host.authority.current(auth, resources, tx);
        await store.bindGrowth(operationId, capacity.reservationId, tx);
        await store.put("creation-capacity", intent.key, capacity, tx);
      });
    }
    await this.host.authority.current(auth, resources);
    const harness = await pi.pi();
    if (!intent.piId) {
      // Reconcile the allocation commit before creating anything. Scan at most one bounded page per invocation.
      const page = await harness.commit(
        (tx) => tx.scanConversations({ order: "ascending" }, 100, intent.scan),
        BACKGROUND_CONTEXT,
      );
      const matches: string[] = [];
      for (const candidate of page.items) {
        if (candidate.owner) continue;
        const tag = await harness.snapshot(CreationDoc, candidate.id, BACKGROUND_CONTEXT);
        if (tag?.intent === intent.key) matches.push(String(candidate.id));
      }
      check(matches.length <= 1, "conflict", "Ambiguous allocation provenance");
      if (matches[0]) intent.piId = matches[0];
      else if (page.next) {
        intent.scan = page.next;
        await store.put("creation", intent.key, intent, store.db, Date.now());
        throw new ServiceError(
          "unavailable",
          "Creation recovery continues",
          { retryAfterMs: 5000 },
          true,
        );
      } else {
        await this.host.authority.authorize(
          { ...intent.auth, deadline: Date.now() + 30000 },
          intent.parent ? "conversations.fork" : "conversations.create",
          intent.parent,
        );
        this.allocating = intent.key;
        try {
          if (intent.parent) {
            const parent = await store.get<ConversationRow>("conversation", intent.parent);
            check(parent && intent.at, "conflict", "Fork source unavailable");
            const source = await harness.conversation(
              Number(parent.piId) as ConversationId,
              BACKGROUND_CONTEXT,
            );
            check(source, "conflict", "Fork source unavailable");
            const child = await source.fork(
              intent.at as EntryId,
              { ownership: { kind: "ownerless" } },
              BACKGROUND_CONTEXT,
            );
            intent.piId = String(child.id);
          } else intent.piId = (await pi.sessions.create()).id;
        } finally {
          this.allocating = undefined;
        }
      }
      intent.state = "allocated";
      delete intent.scan;
      await store.transaction(async (tx) => {
        await this.host.authority.current(auth, resources, tx);
        await store.put("creation", intent.key, intent, tx, Date.now());
      });
    }
    check(intent.piId, "interrupted", "Allocation recovery pending");
    const piId = intent.piId;
    await this.host.authority.current(auth, resources);
    await pi.session(piId).setModel({ provider: model.providerId, id: model.modelId });
    const conversation: D.Conversation = {
      conversationId: intent.conversationId,
      agentId: this.host.agentId,
      title: intent.title,
      revision: "r0",
      createdAt: Date.now(),
      taskState: { state: "idle" },
    };
    await store.transaction(async (tx) => {
      await this.host.authority.current(auth, resources, tx);
      if (await store.get("conversation", intent.conversationId, tx)) return;
      await store.put(
        "conversation",
        intent.conversationId,
        {
          conversation,
          piId,
          deploymentId: intent.auth.deploymentId,
          last: 0,
          floor: 0,
          bytes: 0,
          published: !intent.parent,
        } satisfies ConversationRow,
        tx,
      );
      await store.put("pi-map", piId, { conversationId: intent.conversationId }, tx);
      await store.append(tx, `create:${intent.key}`, {
        ...this.draft(intent.conversationId),
        deploymentId: intent.auth.deploymentId,
        type: "conversation.created",
        payload: conversation,
      });
    });
    if (intent.parent) {
      // Copy the actual fork prefix, never a concurrently growing parent transcript or runnable state.
      const child = pi.session(intent.piId);
      const row = await store.get<ConversationRow>("conversation", intent.conversationId);
      check(row, "interrupted", "Fork mapping unavailable");
      const entries = await child.entries(
        {
          order: "ascending",
          ...(row.bookmark ? { minEntryId: Number(row.bookmark) as EntryId } : {}),
        },
        100,
        BACKGROUND_CONTEXT,
      );
      await this.host.authority.current(auth, resources);
      for (const entry of entries.items) {
        if (row.bookmark && entry.id <= Number(row.bookmark)) continue;
        await this.projectEntry(row, entry);
      }
      if (entries.next)
        throw new ServiceError(
          "unavailable",
          "Fork prefix copy continues",
          { retryAfterMs: 5000 },
          true,
        );
      await store.transaction(async (tx) => {
        await this.host.authority.current(auth, resources, tx);
        const current = await store.get<ConversationRow>("conversation", intent.conversationId, tx);
        check(current, "interrupted", "Fork mapping unavailable");
        current.published = true;
        await store.put("conversation", intent.conversationId, current, tx);
        await store.append(tx, `fork:${intent.key}`, {
          ...this.draft(intent.conversationId),
          deploymentId: intent.auth.deploymentId,
          type: "conversation.forked",
          payload: {
            conversation: current.conversation,
            parentConversationId: intent.parent!,
            parentEventSeq: intent.through!,
          },
        });
      });
    }
    return this.#settleCreation(
      intent,
      (await store.get<ConversationRow>("conversation", intent.conversationId))!.conversation,
    );
  }
  async #estimateFork(
    intent: CreationIntent,
    auth: D.AuthContext,
    resources: D.ResourceScope,
  ): Promise<void> {
    const { store, pi } = this.host;
    const prior = intent.forkEstimate;
    check(
      prior && intent.parent && intent.at && intent.operationId && intent.growthBytes !== undefined,
      "interrupted",
      "Fork estimate identity unavailable",
    );
    const operationId = intent.operationId;
    const parent = await store.get<ConversationRow>("conversation", intent.parent);
    check(parent, "conflict", "Fork source unavailable");
    await this.host.authority.current(auth, resources);
    const harness = await pi.pi();
    const page = await harness.commit(
      (tx) =>
        tx.scanEntries(
          {
            conversationId: Number(parent.piId) as ConversationId,
            maxEntryId: intent.at as EntryId,
            order: "ascending",
          },
          Math.min(100, store.policy.bounds.sqlPageRows),
          prior.cursor,
        ),
      BACKGROUND_CONTEXT,
    );
    await this.host.authority.current(auth, resources);
    const estimate: NonNullable<CreationIntent["forkEstimate"]> = {
      highWater: prior.highWater,
      bytes:
        prior.bytes +
        page.items.reduce(
          (sum, entry) => sum + new TextEncoder().encode(JSON.stringify(entry)).length,
          0,
        ),
      complete: !page.next,
      ...(page.next ? { cursor: page.next } : {}),
    };
    // Public copied history and an actual object high-water mark are estimates
    // of prospective copy growth, never a physical upper bound or a measurement
    // of the not-yet-created child. Refine only BEFORE any capacity RPC.
    const bytes = Math.max(
      intent.growthBytes,
      estimate.bytes + new TextEncoder().encode(JSON.stringify(intent)).length + 8192,
    );
    await store.transaction(async (tx) => {
      await this.host.authority.current(auth, resources, tx);
      const claim = await store.get<GrowthClaim>("growth-claim", operationId, tx);
      check(
        claim && !claim.reservationId && claim.bytes === intent.growthBytes,
        "conflict",
        "Fork growth is already bound or changed",
      );
      store.admissionHeadroom((await store.pendingGrowth(tx)) - claim.bytes + bytes);
      await store.put("growth-claim", operationId, { ...claim, bytes }, tx);
      intent.forkEstimate = estimate;
      intent.growthBytes = bytes;
      await store.put("creation", intent.key, intent, tx, Date.now());
    });
    if (page.next)
      throw new ServiceError(
        "unavailable",
        "Fork history estimate continues",
        { retryAfterMs: 5000 },
        true,
      );
  }
  async #settleCreation(
    intent: CreationIntent,
    conversation: D.Conversation,
  ): Promise<D.Conversation> {
    const { store } = this.host;
    const auth = { ...intent.auth, deadline: Date.now() + 30000 };
    const resources = scope({
      agentIds: [this.host.agentId],
      conversationIds: intent.parent ? [intent.parent] : [],
      actions: [intent.parent ? "conversations.fork" : "conversations.create"],
    });
    await this.host.authority.current(auth, resources);
    if (intent.state === "complete") return conversation;
    const capacity = await store.get<D.CapacityReservation>("creation-capacity", intent.key);
    if (capacity) {
      const settled = unwrap(
        await this.host.authority.control.settleCapacity(auth, {
          reservationId: capacity.reservationId,
          disposition: "consumed",
        }),
      );
      check(
        same(settled, { ...capacity, state: "settled" }),
        "conflict",
        "Creation settlement identity changed",
      );
    }
    intent.state = "complete";
    await store.transaction(async (tx) => {
      await this.host.authority.current(auth, resources, tx);
      await store.put("creation", intent.key, intent, tx);
      if (capacity)
        await this.host.authority.physical.completed(
          capacity.reservationId,
          tx,
          intent.operationId,
        );
    });
    await this.host.authority.current(auth, resources);
    return conversation;
  }
  async submit(
    auth: D.AuthContext,
    cid: string,
    body: D.MessageSubmit | D.SteerInput,
    steer = false,
  ): Promise<D.AdmissionReceipt> {
    return this.lanes.run(cid, async () => {
      const { store } = this.host;
      await this.host.authority.authorize(
        auth,
        steer ? "conversations.steer" : "messages.submit",
        cid,
      );
      const key = `${auth.principalId}:${cid}:${body.clientRequestId}`;
      const fingerprint = await digest({ body, steer });
      const rejected = await store.get<RejectedAdmission>("admission-rejected", key);
      if (rejected)
        check(rejected.digest === fingerprint, "conflict", "Idempotency payload changed");
      const existing = await store.get<Admission>("admission", key);
      if (existing) {
        check(existing.digest === fingerprint, "conflict", "Idempotency payload changed");
        if (existing.receipt) return existing.receipt;
        return this.finishAdmission(existing);
      }
      const pending = await store.get<AdmissionIntent>("admission-intent", key);
      if (pending) {
        check(pending.digest === fingerprint, "conflict", "Idempotency payload changed");
        await this.host.arm();
        return this.finishSubmission(pending);
      }
      const row = await store.get<ConversationRow>("conversation", cid);
      check(row?.published, "not_found", "Conversation unavailable");
      check(
        body.expectedConversationRevision === undefined ||
          body.expectedConversationRevision === row.conversation.revision,
        "conflict",
        "Conversation revision changed",
      );
      const growthBytes = store.modelGrowth(new TextEncoder().encode(body.content).byteLength);
      await this.host.authority.physical.makeRoom(
        auth,
        scope({
          agentIds: [this.host.agentId],
          conversationIds: [cid],
          actions: [steer ? "conversations.steer" : "messages.submit"],
        }),
        growthBytes,
      );
      const candidate: AdmissionIntent = {
        key,
        digest: fingerprint,
        conversationId: cid,
        content: body.content,
        auth,
        operationId: resourceId("m", this.host.agentId),
        messageId: resourceId("m", this.host.agentId),
        taskId: resourceId("t", this.host.agentId),
        mode: steer ? "steer" : "busyBehavior" in body ? body.busyBehavior : "followUp",
        state: "pending",
        policyVersion: store.policy.version,
        growthBytes,
      };
      const intent = await store.transaction(async (tx) => {
        const old = await store.get<AdmissionIntent>("admission-intent", key, tx);
        if (old) {
          check(old.digest === fingerprint, "conflict", "Idempotency payload changed");
          return old;
        }
        await this.host.authority.current(
          auth,
          scope({
            agentIds: [this.host.agentId],
            conversationIds: [cid],
            actions: [steer ? "conversations.steer" : "messages.submit"],
          }),
          tx,
        );
        const current = await store.get<ConversationRow>("conversation", cid, tx);
        check(
          current?.published &&
            (body.expectedConversationRevision === undefined ||
              body.expectedConversationRevision === current.conversation.revision),
          "conflict",
          "Conversation revision changed",
        );
        await store.claimGrowth(candidate.operationId, growthBytes, tx);
        await store.put("admission-intent", key, candidate, tx, Date.now());
        await this.host.authority.current(
          auth,
          scope({
            agentIds: [this.host.agentId],
            conversationIds: [cid],
            actions: [steer ? "conversations.steer" : "messages.submit"],
          }),
          tx,
        );
        return candidate;
      });
      // All opaque identities and the original payload/authority exist before
      // model lookup or the first capacity RPC. Lost replies reuse this operation.
      await this.host.arm();
      return this.finishSubmission(intent);
    });
  }
  async finishSubmission(intent: AdmissionIntent): Promise<D.AdmissionReceipt> {
    try {
      return await this.#finishSubmission(intent);
    } catch (error) {
      const current = await this.host.store.get<AdmissionIntent>("admission-intent", intent.key);
      if (current)
        await this.host.store.put(
          "admission-intent",
          intent.key,
          current,
          undefined,
          repairRetryAt(error),
        );
      throw error;
    }
  }
  async #finishSubmission(intent: AdmissionIntent): Promise<D.AdmissionReceipt> {
    const { store } = this.host;
    const old = await store.get<Admission>("admission", intent.key);
    if (old) return old.receipt ?? this.finishAdmission(old);
    const auth = { ...intent.auth, deadline: Date.now() + 30000 },
      resources = scope({
        agentIds: [this.host.agentId],
        conversationIds: [intent.conversationId],
        actions: [intent.mode === "steer" ? "conversations.steer" : "messages.submit"],
      });
    await this.host.authority.current(auth, resources);
    if (!intent.model) {
      const model = await this.host.selectModel(auth, resources.actions[0]!, intent.conversationId);
      await store.transaction(async (tx) => {
        await this.host.authority.current(auth, resources, tx);
        const current = await store.get<AdmissionIntent>("admission-intent", intent.key, tx);
        check(current && current.digest === intent.digest, "conflict", "Admission intent changed");
        if (current.model) check(same(current.model, model), "conflict", "Admission model changed");
        intent = { ...current, model };
        await store.put("admission-intent", intent.key, intent, tx, Date.now());
        await this.host.authority.current(auth, resources, tx);
      });
    }
    const model = intent.model;
    check(model, "interrupted", "Admission model unavailable");
    await this.host.authority.physical.beforeGrowth(auth, resources);
    const capacity = unwrap(
      await this.host.authority.control.reserveCapacity(auth, {
        operationId: intent.operationId,
        ownerId: intent.conversationId,
        policyVersion: intent.policyVersion,
        bytes: intent.growthBytes ?? new TextEncoder().encode(intent.content).length + 8192,
        admissionSlots: 1,
      }),
    );
    const admission: Admission = { ...intent, capacity, model };
    await store.transaction(async (tx) => {
      await this.host.authority.current(auth, resources, tx);
      const current = await store.get<AdmissionIntent>("admission-intent", intent.key, tx);
      check(
        current && current.digest === intent.digest && current.operationId === intent.operationId,
        "conflict",
        "Admission intent changed",
      );
      const row = await store.get<ConversationRow>("conversation", intent.conversationId, tx);
      check(row?.published, "not_found", "Conversation unavailable");
      const key = intent.key,
        cid = intent.conversationId,
        operationId = intent.operationId;
      await store.put("admission", key, admission, tx, Date.now());
      await store.bindGrowth(operationId, capacity.reservationId, tx);
      await store.put("task-admission", admission.taskId, { key }, tx);
      await store.put("operation-admission", operationId, { key }, tx);
      await store.put("input-pending", `${cid}:${operationId}`, { key }, tx);
      await store.put("dirty", cid, { piId: row.piId }, tx, Date.now());
      await store.remove("admission-intent", key, tx);
      await this.host.authority.current(auth, resources, tx);
    });
    await this.host.authority.current(auth, resources);
    return this.finishAdmission(admission);
  }
  async finishAdmission(admission: Admission): Promise<D.AdmissionReceipt> {
    const { store, pi } = this.host;
    const rejected = await store.get<RejectedAdmission>("admission-rejected", admission.key);
    if (rejected?.operationId === admission.operationId && !rejected.reclaimed)
      return this.finishRejection(admission, rejected);
    const row = await store.get<ConversationRow>("conversation", admission.conversationId);
    check(row, "not_found", "Conversation unavailable");
    const harness = await pi.pi();
    const conversation = await harness.conversation(
      Number(row.piId) as ConversationId,
      BACKGROUND_CONTEXT,
    );
    check(conversation, "interrupted", "Pi conversation unavailable");
    let submission = await harness.commit(
      (tx) => tx.submissionByRequest(conversation.id, admission.operationId),
      BACKGROUND_CONTEXT,
    );
    if (!submission) {
      await this.host.authority.authorize(
        { ...admission.auth, deadline: Date.now() + 30000 },
        admission.mode === "steer" ? "conversations.steer" : "messages.submit",
        admission.conversationId,
      );
      try {
        await pi
          .session(row.piId)
          .setModel({ provider: admission.model.providerId, id: admission.model.modelId });
        await this.configureRun(
          { ...admission.auth, deadline: Date.now() + 30000 },
          row.piId,
          admission.conversationId,
          admission.mode === "steer" ? "conversations.steer" : "messages.submit",
        );
        await pi.session(row.piId).submit(admission.content, {
          operationId: admission.operationId,
          whenBusy: admission.mode,
          ...(admission.mode === "steer" ? { whenIdle: "reject" as const } : {}),
        });
      } catch (error) {
        if (error instanceof ConversationBusy || error instanceof ConversationIdle) {
          const rejected: RejectedAdmission = {
            digest: admission.digest,
            operationId: admission.operationId,
            reason: error instanceof ConversationIdle ? "idle" : "busy",
            acknowledged: false,
            reclaimed: false,
          };
          await store.transaction(async (tx) => {
            const auth = { ...admission.auth, deadline: Date.now() + 30000 };
            const resources = scope({
              agentIds: [this.host.agentId],
              conversationIds: [admission.conversationId],
              actions: [admission.mode === "steer" ? "conversations.steer" : "messages.submit"],
            });
            await this.host.authority.current(auth, resources, tx);
            // No model work was admitted. Cleanup/reopen must not require this
            // provider's credentials merely to finish its unused settlement.
            admission.state = "rejection_pending";
            await store.put("admission", admission.key, admission, tx, Date.now());
            await store.put("admission-rejected", admission.key, rejected, tx);
            await this.host.authority.current(auth, resources, tx);
          });
          return this.finishRejection(admission, rejected);
        }
        throw error;
      }
      submission = await harness.commit(
        (tx) => tx.submissionByRequest(conversation.id, admission.operationId),
        BACKGROUND_CONTEXT,
      );
    }
    check(submission, "interrupted", "Admission acknowledgment uncertain");
    admission.submission = submission.id;
    admission.state = "accepted";
    const receipt = await store.transaction(async (tx) => {
      const current = await store.get<Admission>("admission", admission.key, tx);
      if (current?.receipt) return current.receipt;
      const message: D.Message = {
        messageId: admission.messageId,
        role: "user",
        content: admission.content,
        timestamp: Date.now(),
      };
      const event = await store.append(tx, `admission:${admission.operationId}`, {
        ...this.draft(admission.conversationId),
        deploymentId: admission.auth.deploymentId,
        type: "message.committed",
        payload: message,
        taskId: admission.taskId,
      });
      const task: D.Task = {
        taskId: admission.taskId,
        conversationId: admission.conversationId,
        version: 1,
        status: { state: "queued" },
      };
      await store.put("task", task.taskId, task, tx);
      await store.append(tx, `task:${task.taskId}:1`, {
        ...this.draft(admission.conversationId),
        deploymentId: admission.auth.deploymentId,
        type: "task.queued",
        payload: task,
        taskId: task.taskId,
      });
      const receipt: D.AdmissionReceipt = {
        operationId: admission.operationId,
        messageId: admission.messageId,
        taskId: admission.taskId,
        revision: `r${event.eventSeq}`,
        eventSeq: event.eventSeq,
      };
      admission.receipt = receipt;
      await store.put("admission", admission.key, admission, tx, Date.now());
      if (submission?.entry) {
        await store.put(
          "input-entry",
          `${row.piId}:${submission.entry}`,
          { messageId: admission.messageId },
          tx,
        );
        await store.put("entry-public", `${row.piId}:${submission.entry}`, message, tx);
        await store.put(
          "entry-event",
          `${admission.conversationId}:${event.eventSeq}`,
          { entry: submission.entry },
          tx,
        );
        await store.remove(
          "input-pending",
          `${admission.conversationId}:${admission.operationId}`,
          tx,
        );
      }
      return receipt;
    });
    await this.host.notify(admission.conversationId);
    return receipt;
  }
  async finishRejection(admission: Admission, rejection: RejectedAdmission): Promise<never> {
    const { store, authority } = this.host,
      auth = { ...admission.auth, deadline: Date.now() + 30000 },
      resources = scope({
        agentIds: [this.host.agentId],
        conversationIds: [admission.conversationId],
        actions: [admission.mode === "steer" ? "conversations.steer" : "messages.submit"],
      });
    await authority.current(auth, resources);
    if (!rejection.acknowledged) {
      const receipt = unwrap(
        await authority.control.settleCapacity(auth, {
          reservationId: admission.capacity.reservationId,
          disposition: "unused",
          observedBytes: 0,
        }),
      );
      check(
        receipt.reservationId === admission.capacity.reservationId && receipt.state === "settled",
        "conflict",
        "Unused settlement receipt changed",
      );
      await store.transaction(async (tx) => {
        await authority.current(auth, resources, tx);
        rejection.acknowledged = true;
        await store.put("admission-rejected", admission.key, rejection, tx);
        await authority.physical.completed(
          receipt.reservationId,
          tx,
          admission.operationId,
          "unused",
        );
      });
    }
    // A lost older report may be acknowledged first; only a new queued barrier
    // containing this exact unused proof can reclaim its local estimate.
    for (
      let i = 0;
      i < 2 && (await store.get("storage-completed", admission.capacity.reservationId));
      i++
    )
      await authority.physical.beforeGrowth(auth, resources);
    await store.transaction(async (tx) => {
      await authority.current(auth, resources, tx);
      check(
        !(await store.get("storage-completed", admission.capacity.reservationId, tx)) &&
          !(await store.get("growth-claim", admission.operationId, tx)),
        "interrupted",
        "Unused growth observation remains pending",
      );
      rejection.reclaimed = true;
      await store.put("admission-rejected", admission.key, rejection, tx);
      await store.remove("admission", admission.key, tx);
      await store.remove("task-admission", admission.taskId, tx);
      await store.remove("operation-admission", admission.operationId, tx);
      await store.remove(
        "input-pending",
        `${admission.conversationId}:${admission.operationId}`,
        tx,
      );
      await authority.current(auth, resources, tx);
    });
    check(
      false,
      "conflict",
      rejection.reason === "idle" ? "Conversation is idle" : "Conversation is busy",
    );
  }
  async projectEntry(
    row: ConversationRow,
    entry: import("@earendil-works/pi-durable").EntryRecord,
  ): Promise<void> {
    const cid = row.conversation.conversationId;
    const input = await this.host.store.get<{ messageId: string }>(
      "input-entry",
      `${row.piId}:${entry.id}`,
    );
    const inherited = await this.host.store.get<EntryMessages>(
      "entry-public",
      `${entry.conversationId}:${entry.id}`,
    );
    const messages = entry.model ?? [];
    const text = messages
      .flatMap((m) =>
        typeof m.content === "string"
          ? [m.content]
          : m.content.filter((p) => p.type === "text").map((p) => p.text),
      )
      .join("\n");
    const role: D.Message["role"] =
      entry.kind === "pi.user" ? "user" : entry.kind === "pi.toolResult" ? "tool" : "assistant";
    const projected =
      (text || inherited) && !input
        ? (
            await Promise.all(
              (inherited
                ? entryMessages(inherited)
                : [
                    {
                      messageId: `e${cid.slice(1, 70)}_${entry.id}`,
                      role,
                      content: text,
                      timestamp: Date.now(),
                    },
                  ]
              ).map(messageParts),
            )
          ).flat()
        : [];
    await this.host.store.transaction(async (tx) => {
      if (projected.length) {
        const latest = await this.host.store.get<EntryMessages>(
          "entry-public",
          `${entry.conversationId}:${entry.id}`,
          tx,
        );
        check(
          same(latest ? entryMessages(latest) : null, inherited ? entryMessages(inherited) : null),
          "conflict",
          "Entry projection changed; retry the retained source",
        );
        const acks: D.FactAck[] = [];
        for (const [index, message] of projected.entries()) {
          acks.push(
            await this.host.store.append(
              tx,
              `entry:${row.piId}:${entry.id}${index ? `:part:${index}` : ""}`,
              {
                ...this.draft(cid),
                deploymentId: row.deploymentId,
                type: message.role === "assistant" ? "message.completed" : "message.committed",
                payload: message,
              },
            ),
          );
        }
        const end = acks.at(-1)?.eventSeq;
        for (const ack of acks)
          await this.host.store.put(
            "entry-event",
            `${cid}:${ack.eventSeq}`,
            { entry: entry.id, end },
            tx,
          );
        await this.host.store.put(
          "entry-public",
          `${entry.conversationId}:${entry.id}`,
          projected,
          tx,
        );
      }
      const current = await this.host.store.get<ConversationRow>("conversation", cid, tx);
      check(current, "not_found", "Conversation unavailable");
      current.bookmark = String(entry.id);
      await this.host.store.put("conversation", cid, current, tx);
      row.bookmark = current.bookmark;
    });
  }
}
