import type { SqliteExecutor } from "@earendil-works/chord/sqlite";
import { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { check, id, pressure, same } from "../api/common.js";
import type * as D from "../boundary/dto.js";

export type Sql = Pick<SqliteExecutor, "get" | "all" | "run" | "runCounted">;
export interface ConversationRow {
  conversation: D.Conversation;
  deploymentId: string;
  piId: string;
  last: number;
  floor: number;
  bytes: number;
  bookmark?: string;
  published: boolean;
}
export class Store {
  readonly db: DurableObjectSqliteDatabase;
  readonly policy: D.InfrastructurePolicy;
  readonly storage: DurableObjectStorage;
  constructor(storage: DurableObjectStorage, policy: D.InfrastructurePolicy) {
    this.storage = storage;
    this.policy = policy;
    this.db = new DurableObjectSqliteDatabase(storage);
  }
  physicalBytes(): number {
    return this.storage.sql.databaseSize;
  }
  admissionHeadroom(reservedBytes: number): void {
    const observed = this.physicalBytes();
    const limit = Math.floor(
      this.policy.bounds.objectBytes * (1 - this.policy.bounds.headroomFraction),
    );
    check(
      Number.isSafeInteger(reservedBytes) && reservedBytes >= 0,
      "invalid_request",
      "Invalid storage reservation",
    );
    check(
      observed + reservedBytes <= limit,
      "quota_paused",
      "Object storage completion headroom is reserved",
      {
        pressure: {
          resource: "storage",
          scope: { kind: "object" },
          source: "policy",
          measurement: "observed",
          limit,
          remaining: Math.max(0, limit - observed),
          reason: "Object storage completion headroom is reserved",
          action: "reclaim-storage",
        },
      },
    );
  }
  async open(): Promise<void> {
    await this.transaction(async (tx) =>
      tx.run(`
      CREATE TABLE IF NOT EXISTS fp_records_v1(kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, due INTEGER, PRIMARY KEY(kind,id));
      CREATE INDEX IF NOT EXISTS fp_records_due_v1 ON fp_records_v1(kind,due,id);
      CREATE INDEX IF NOT EXISTS fp_records_conversation_v1 ON fp_records_v1(kind,json_extract(data,'$.conversationId'),id) WHERE kind='task' OR kind='approval';
      CREATE INDEX IF NOT EXISTS fp_records_job_conversation_v1 ON fp_records_v1(kind,json_extract(data,'$.job.conversationId'),id) WHERE kind='job';
      CREATE INDEX IF NOT EXISTS fp_records_model_pending_v1 ON fp_records_v1(kind,json_extract(data,'$.state')) WHERE kind='admission' OR kind='creation';
      CREATE INDEX IF NOT EXISTS fp_records_intent_model_v1 ON fp_records_v1(kind,json_extract(data,'$.state')) WHERE kind='admission-intent';
      CREATE TABLE IF NOT EXISTS fp_events_v1(conversation TEXT NOT NULL, seq INTEGER NOT NULL, source TEXT NOT NULL, data TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(conversation,seq), UNIQUE(conversation,source));
      CREATE TABLE IF NOT EXISTS fp_sources_v1(conversation TEXT NOT NULL, source TEXT NOT NULL, seq INTEGER NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY(conversation,source));
      CREATE TABLE IF NOT EXISTS fp_messages_v1(conversation TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(conversation,id));
      CREATE INDEX IF NOT EXISTS fp_messages_order_v1 ON fp_messages_v1(conversation,position);
    `),
    );
  }
  async get<T>(kind: string, key: string, tx: Sql = this.db): Promise<T | undefined> {
    const row = await tx.get<{ data: string }>(
      "SELECT data FROM fp_records_v1 WHERE kind=? AND id=?",
      kind,
      key,
    );
    return row ? (JSON.parse(row.data) as T) : undefined;
  }
  async put(
    kind: string,
    key: string,
    value: unknown,
    tx: Sql = this.db,
    due: number | null = null,
  ): Promise<void> {
    if (tx === this.db)
      return this.transaction((current) => this.put(kind, key, value, current, due));
    await tx.run(
      "INSERT INTO fp_records_v1(kind,id,data,due) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data,due=excluded.due",
      kind,
      key,
      JSON.stringify(value),
      due,
    );
  }
  async remove(kind: string, key: string, tx: Sql = this.db): Promise<void> {
    if (tx === this.db) return this.transaction((current) => this.remove(kind, key, current));
    await tx.run("DELETE FROM fp_records_v1 WHERE kind=? AND id=?", kind, key);
  }
  async page<T>(
    kind: string,
    limit = 100,
    after = "",
    due?: number,
  ): Promise<{ id: string; value: T }[]> {
    const rows = await this.db.all<{ id: string; data: string }>(
      "SELECT id,data FROM fp_records_v1 WHERE kind=? AND id>? AND (? IS NULL OR due<=?) ORDER BY id LIMIT ?",
      kind,
      after,
      due ?? null,
      due ?? null,
      Math.min(100, limit),
    );
    return rows.map((row) => ({ id: row.id, value: JSON.parse(row.data) as T }));
  }
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const result = await fn(tx);
      return result;
    });
  }
  async append(tx: Sql, source: string, draft: D.EventDraft): Promise<D.FactAck> {
    const cid = draft.conversationId;
    const existing = await tx.get<{ seq: number; event_id: string }>(
      "SELECT seq,event_id FROM fp_sources_v1 WHERE conversation=? AND source=?",
      cid,
      source,
    );
    const ack = (seq: number, eventId: string): D.FactAck => ({
      factId: source,
      recipient: {
        kind: "agent",
        id: draft.type === "conversation.created" ? draft.payload.agentId : "",
      },
      eventId,
      eventSeq: seq,
      persisted: true,
    });
    if (existing) return ack(existing.seq, existing.event_id);
    const row = await this.get<ConversationRow>("conversation", cid, tx);
    check(row, "not_found", "Conversation unavailable");
    check(
      row.last < Number.MAX_SAFE_INTEGER,
      "quota_paused",
      "Event sequence exhausted",
      pressure("storage", Number.MAX_SAFE_INTEGER, "Event sequence exhausted"),
    );
    const event = {
      ...draft,
      eventSeq: row.last + 1,
      eventId: id(),
      timestamp: Date.now(),
    } satisfies D.KnownDurableEvent;
    const data = JSON.stringify(event);
    const bytes = new TextEncoder().encode(data).byteLength;
    await tx.run(
      "INSERT INTO fp_events_v1 VALUES(?,?,?,?,?)",
      cid,
      event.eventSeq,
      source,
      data,
      bytes,
    );
    await tx.run(
      "INSERT INTO fp_sources_v1 VALUES(?,?,?,?)",
      cid,
      source,
      event.eventSeq,
      event.eventId,
    );
    if (event.type === "message.committed" || event.type === "message.completed") {
      await tx.run(
        "INSERT INTO fp_messages_v1 VALUES(?,?,?,?) ON CONFLICT(conversation,id) DO UPDATE SET data=excluded.data",
        cid,
        event.payload.messageId,
        event.eventSeq,
        JSON.stringify(event.payload),
      );
    }
    row.last = event.eventSeq;
    row.bytes += bytes;
    row.conversation.revision = `r${row.last}`;
    if (event.type.startsWith("task.") && "status" in event.payload)
      row.conversation.taskState = event.payload.status as D.TaskState;
    await this.put("conversation", cid, row, tx);
    const result = ack(event.eventSeq, event.eventId);
    result.recipient = { kind: "agent", id: row.conversation.agentId };
    return result;
  }
  async snapshot(cid: string): Promise<D.ConversationProjection> {
    return this.transaction(async (tx) => {
      const row = await this.get<ConversationRow>("conversation", cid, tx);
      check(row?.published, "not_found", "Conversation unavailable");
      const messages = await tx.all<{ data: string }>(
        "SELECT data FROM (SELECT position,data FROM fp_messages_v1 WHERE conversation=? ORDER BY position DESC LIMIT 100) ORDER BY position",
        cid,
      );
      return {
        conversation: row.conversation,
        messages: messages.map((m) => JSON.parse(m.data) as D.Message),
        projectionRevision: row.conversation.revision,
        lastEventSeq: row.last,
        retainedFloor: row.floor,
      };
    });
  }
  async replay(cid: string, query: D.ReplayQuery): Promise<D.ReplayPage> {
    return this.transaction(async (tx) => {
      const row = await this.get<ConversationRow>("conversation", cid, tx);
      check(row?.published, "not_found", "Conversation unavailable");
      const through = query.through ?? row.last;
      check(
        query.after <= through && through <= row.last,
        "cursor.invalid",
        "Cursor is ahead of committed history",
      );
      check(query.after >= row.floor, "cursor.expired", "Replay window expired; load a snapshot");
      const rows = await tx.all<{ data: string }>(
        "SELECT data FROM fp_events_v1 WHERE conversation=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?",
        cid,
        query.after,
        through,
        Math.min(100, query.limit ?? 100),
      );
      const events = rows.map((r) => JSON.parse(r.data) as D.KnownDurableEvent);
      const nextAfter = events.at(-1)?.eventSeq ?? query.after;
      return {
        events,
        after: query.after,
        through,
        lastEventSeq: row.last,
        nextAfter,
        hasMore: nextAfter < through,
        retainedFloor: row.floor,
      };
    });
  }
  /** Retire replay envelopes only; source identities, canonical messages, receipts and authority remain. */
  async retain(cid: string): Promise<boolean> {
    return this.transaction(async (tx) => {
      const row = await this.get<ConversationRow>("conversation", cid, tx);
      if (!row) return false;
      const bounds = this.policy.bounds;
      if (
        row.last - row.floor <= bounds.conversationEvents &&
        row.bytes <= bounds.conversationBytes
      )
        return false;
      const oldest = await tx.all<{ seq: number; bytes: number }>(
        "SELECT seq,bytes FROM fp_events_v1 WHERE conversation=? ORDER BY seq LIMIT 100",
        cid,
      );
      for (const entry of oldest) {
        if (
          row.last - row.floor <= bounds.conversationEvents &&
          row.bytes <= bounds.conversationBytes
        )
          break;
        row.floor = entry.seq;
        row.bytes -= entry.bytes;
      }
      await tx.run("DELETE FROM fp_events_v1 WHERE conversation=? AND seq<=?", cid, row.floor);
      await this.put("conversation", cid, row, tx);
      return (
        row.last - row.floor > bounds.conversationEvents || row.bytes > bounds.conversationBytes
      );
    });
  }
  async exactEvent(cid: string, seq: number): Promise<D.KnownDurableEvent | undefined> {
    const row = await this.db.get<{ data: string }>(
      "SELECT data FROM fp_events_v1 WHERE conversation=? AND seq=?",
      cid,
      seq,
    );
    if (row) return JSON.parse(row.data) as D.KnownDurableEvent;
    // Terminal attestations are retained independently of replay-window reclamation.
    return this.get<D.KnownDurableEvent>("terminal-event", `${cid}:${seq}`);
  }
  async once<T>(
    kind: string,
    key: string,
    payload: unknown,
    fn: (tx: Sql) => Promise<T>,
  ): Promise<T> {
    return this.transaction(async (tx) => {
      const old = await this.get<{ payload: unknown; value: T }>(kind, key, tx);
      if (old) {
        check(same(old.payload, payload), "conflict", "Request identity changed");
        return old.value;
      }
      const value = await fn(tx);
      await this.put(kind, key, { payload, value }, tx);
      return value;
    });
  }
}
