import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { EntryId } from "@earendil-works/pi-durable";
import { check, digest, resourceId, ServiceError, same, scope, unwrap } from "../api/common.js";
import type * as D from "../boundary/dto.js";
import type { Jobs } from "../execution/jobs.js";
import type { Authority } from "./authority.js";
import type { Conversations } from "./conversations.js";
import type { ConversationRow, Store } from "./store.js";

interface RetainedExport {
  exportId: string;
  fingerprint: string;
  resources: D.ResourceScope;
  principalId: string;
  action: D.ExportRequest["action"];
  conversationIds: string[];
  text: string;
  sha256: string;
  size: number;
  complete: boolean;
  createdAt: number;
}
interface ExportWork {
  input: D.ExportRequest;
  fingerprint: string;
  auth: D.AuthContext;
  operationId: string;
  bytes: number;
  policyVersion: number;
  capacity?: D.CapacityReservation;
}
async function hash(bytes: Uint8Array) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
/** Copies explicit public data and supported committed Pi entries, never authority records. */
export class AgentExports {
  readonly conversations: Conversations;
  readonly jobs: Jobs;
  readonly store: Store;
  readonly authority: Authority;
  constructor(conversations: Conversations, jobs: Jobs) {
    this.conversations = conversations;
    this.jobs = jobs;
    this.store = conversations.host.store;
    this.authority = conversations.host.authority;
  }
  private async authorize(
    auth: D.AuthContext,
    resources: D.ResourceScope,
    action: D.ExportRequest["action"],
  ) {
    check(auth.role === "admin", "unauthorized", "Administrator export authority required");
    await this.authority.authorize(
      auth,
      action,
      undefined,
      scope({ ...resources, actions: [action] }),
    );
  }
  async prepare(auth: D.AuthContext, input: D.ExportRequest): Promise<D.ExportDescriptor> {
    check(
      input.deadline > Date.now() &&
        Number.isSafeInteger(input.maxBytes) &&
        input.maxBytes > 0 &&
        input.maxBytes <= this.store.policy.bounds.artifactBytes,
      "invalid_request",
      "Invalid retained export bounds",
    );
    check(
      input.resources.agentIds.includes(this.authority.agentId) ||
        input.resources.agentIds.includes("*"),
      "unauthorized",
      "Export agent scope mismatch",
    );
    check(
      input.action === "exports.create" || input.action === "backups.create",
      "invalid_request",
      "Explicit export action required",
    );
    const action = input.action;
    await this.authorize(auth, input.resources, action);
    const fingerprint = await digest({
      exportId: input.exportId,
      action,
      resources: input.resources,
      maxBytes: input.maxBytes,
    });
    const existing = await this.store.get<RetainedExport>("export", input.exportId);
    if (existing) {
      check(
        existing.fingerprint === fingerprint && existing.principalId === auth.principalId,
        "conflict",
        "Export identity changed",
      );
      return this.#retained(existing, auth);
    }
    // Bound retained-copy working memory actor-wide; SQL/CP calls stay outside
    // one another's transactions. This lane does not own timers or execution.
    return this.conversations.lanes.run("exports", async () => {
      const prior = await this.store.get<RetainedExport>("export", input.exportId);
      if (prior) {
        check(
          prior.fingerprint === fingerprint && prior.principalId === auth.principalId,
          "conflict",
          "Export identity changed",
        );
        return this.#retained(prior, auth);
      }
      const resources = scope({ ...input.resources, actions: [action] });
      let work = await this.store.get<ExportWork>("export-work", input.exportId);
      if (work)
        check(
          work.fingerprint === fingerprint && work.auth.principalId === auth.principalId,
          "conflict",
          "Export identity changed",
        );
      else {
        // A bounded NDJSON payload is copied into a JSON string. At most two
        // encoded payload bytes per byte are estimated here, plus the actual
        // encoded metadata and app records. This is not a SQLite upper bound.
        const metadataBytes = new TextEncoder().encode(JSON.stringify({ input, auth })).length;
        const bytes = input.maxBytes * 2 + metadataBytes * 2 + 8192;
        await this.authority.physical.makeRoom(auth, resources, bytes);
        const candidate: ExportWork = {
          input,
          auth,
          fingerprint,
          bytes,
          policyVersion: this.store.policy.version,
          operationId: resourceId("m", this.authority.agentId),
        };
        await this.store.transaction(async (tx) => {
          await this.authority.current(auth, resources, tx);
          await this.store.claimGrowth(candidate.operationId, bytes, tx);
          await this.store.put("export-work", input.exportId, candidate, tx, Date.now());
        });
        work = candidate;
      }
      await this.conversations.host.arm();
      if (!work.capacity) {
        const pending = work;
        await this.authority.physical.beforeGrowth(auth, resources);
        const capacity = unwrap(
          await this.authority.control.reserveCapacity(auth, {
            operationId: work.operationId,
            ownerId: this.authority.agentId,
            policyVersion: work.policyVersion,
            bytes: work.bytes,
            admissionSlots: 0,
          }),
        );
        await this.store.transaction(async (tx) => {
          await this.authority.current(auth, resources, tx);
          await this.store.bindGrowth(pending.operationId, capacity.reservationId, tx);
          work = { ...pending, capacity };
          await this.store.put("export-work", input.exportId, work, tx, Date.now());
        });
      }
      await this.authority.current(auth, resources);
      const parts: string[] = [],
        conversationIds: string[] = [];
      let size = 0,
        complete = true;
      const append = (value: unknown) => {
        const line = `${JSON.stringify(value)}\n`,
          bytes = new TextEncoder().encode(line).length;
        if (size + bytes > input.maxBytes) {
          complete = false;
          return false;
        }
        parts.push(line);
        size += bytes;
        return true;
      };
      append({
        type: "fortipi.agent.export",
        version: 1,
        exportId: input.exportId,
        agentId: this.authority.agentId,
      });
      let after = "";
      scan: while (complete && Date.now() < Math.min(input.deadline, auth.deadline)) {
        const rows = await this.store.page<ConversationRow>("conversation", 100, after);
        for (const candidate of rows) {
          after = candidate.id;
          if (
            !candidate.value.published ||
            !(
              input.resources.conversationIds.includes("*") ||
              input.resources.conversationIds.includes(candidate.id)
            )
          )
            continue;
          if (conversationIds.length === 100) {
            complete = false;
            break scan;
          }
          const cut = await this.store.transaction(async (tx) => {
            const row = await this.store.get<ConversationRow>("conversation", candidate.id, tx);
            check(row?.published, "not_found", "Export conversation unavailable");
            const tasks = await tx.all<{ data: string }>(
              "SELECT data FROM fp_records_v1 WHERE kind='task' AND json_extract(data,'$.conversationId')=? ORDER BY id LIMIT 100",
              candidate.id,
            );
            const jobs = await tx.all<{ data: string }>(
              "SELECT data FROM fp_records_v1 WHERE kind='job' AND json_extract(data,'$.job.conversationId')=? ORDER BY id LIMIT 100",
              candidate.id,
            );
            const approvals = await tx.all<{ data: string }>(
              "SELECT data FROM fp_records_v1 WHERE kind='approval' AND json_extract(data,'$.conversationId')=? ORDER BY id LIMIT 100",
              candidate.id,
            );
            return { row, tasks, jobs, approvals };
          });
          if (
            !append({
              type: "conversation",
              conversation: cut.row.conversation,
              through: cut.row.last,
              piEntryThrough: cut.row.bookmark ?? null,
            })
          )
            break scan;
          conversationIds.push(candidate.id);
          let position = 0;
          while (complete) {
            const messages = await this.store.db.all<{ data: string; position: number }>(
              "SELECT data,position FROM fp_messages_v1 WHERE conversation=? AND position>? AND position<=? ORDER BY position LIMIT 100",
              candidate.id,
              position,
              cut.row.last,
            );
            for (const message of messages) {
              position = message.position;
              if (
                !append({
                  type: "message",
                  conversationId: candidate.id,
                  message: JSON.parse(message.data),
                })
              )
                break scan;
            }
            if (messages.length < 100) break;
            if (Date.now() >= Math.min(input.deadline, auth.deadline)) {
              complete = false;
              break scan;
            }
          }
          if (cut.row.bookmark) {
            let entryAfter = 0;
            while (complete) {
              const page = await this.conversations.host.pi.session(cut.row.piId).entries(
                {
                  order: "ascending",
                  minEntryId: entryAfter as EntryId,
                  maxEntryId: Number(cut.row.bookmark) as EntryId,
                },
                100,
                BACKGROUND_CONTEXT,
              );
              for (const entry of page.items) {
                if (entry.id <= entryAfter) continue;
                entryAfter = entry.id;
                if (!append({ type: "entry", conversationId: candidate.id, entry })) break scan;
              }
              if (!page.next) break;
              if (Date.now() >= Math.min(input.deadline, auth.deadline)) {
                complete = false;
                break scan;
              }
            }
          }
          for (const row of cut.tasks)
            if (!append({ type: "task", task: JSON.parse(row.data) })) break scan;
          for (const row of cut.jobs)
            if (
              !append({
                type: "job",
                job: this.jobs.public(
                  (JSON.parse(row.data) as import("../execution/jobs.js").JobState).job,
                ),
              })
            )
              break scan;
          for (const row of cut.approvals)
            if (!append({ type: "approval", approval: JSON.parse(row.data) })) break scan;
          if ([cut.tasks, cut.jobs, cut.approvals].some((batch) => batch.length === 100)) {
            complete = false;
            break scan;
          }
        }
        if (rows.length < 100) break;
      }
      if (Date.now() >= Math.min(input.deadline, auth.deadline)) complete = false;
      const text = parts.join(""),
        sha256 = await hash(new TextEncoder().encode(text));
      await this.authorize(auth, input.resources, action);
      const retained: RetainedExport = {
        exportId: input.exportId,
        fingerprint,
        resources: input.resources,
        principalId: auth.principalId,
        action,
        conversationIds,
        text,
        sha256,
        size,
        complete,
        createdAt: Date.now(),
      };
      await this.store.transaction(async (tx) => {
        await this.authority.current(auth, scope({ ...input.resources, actions: [action] }), tx);
        await this.store.put("export", input.exportId, retained, tx);
      });
      // Ready describes immutable retained bytes. Settlement is durable repair
      // debt; a held CP reply must not block this receipt or the copy lane.
      await this.conversations.host.arm();
      await this.authority.current(auth, resources);
      return this.descriptor(retained);
    });
  }
  async #retained(retained: RetainedExport, auth: D.AuthContext): Promise<D.ExportDescriptor> {
    const resources = scope({ ...retained.resources, actions: [retained.action] });
    await this.authority.current(auth, resources);
    return this.descriptor(retained);
  }
  async #defer(exportId: string, error: unknown): Promise<void> {
    const retry = error instanceof ServiceError ? error.details?.retryAfterMs : undefined;
    const held =
      error instanceof ServiceError &&
      (error.retryable === false ||
        retry === 0 ||
        error.code === "unauthorized" ||
        error.code === "unauthenticated");
    const current = await this.store.get<ExportWork>("export-work", exportId);
    if (current)
      await this.store.put(
        "export-work",
        exportId,
        current,
        undefined,
        held
          ? null
          : Date.now() +
              (typeof retry === "number" && Number.isSafeInteger(retry) && retry > 0
                ? retry
                : 30000),
      );
  }
  async #complete(work: ExportWork, auth: D.AuthContext): Promise<void> {
    const resources = scope({ ...work.input.resources, actions: [work.input.action] });
    await this.authority.current(auth, resources);
    const retained = await this.store.get<RetainedExport>("export", work.input.exportId);
    check(
      retained?.fingerprint === work.fingerprint && work.capacity,
      "interrupted",
      "Export completion proof unavailable",
    );
    const capacity = work.capacity;
    const settled = unwrap(
      await this.authority.control.settleCapacity(auth, {
        reservationId: work.capacity.reservationId,
        disposition: "consumed",
      }),
    );
    check(
      same(settled, { ...work.capacity, state: "settled" }),
      "conflict",
      "Export settlement identity changed",
    );
    await this.store.transaction(async (tx) => {
      await this.authority.current(auth, resources, tx);
      const current = await this.store.get<ExportWork>("export-work", work.input.exportId, tx);
      if (!current) return;
      check(current.operationId === work.operationId, "conflict", "Export work changed");
      await this.authority.physical.completed(capacity.reservationId, tx, work.operationId);
      await this.store.remove("export-work", work.input.exportId, tx);
    });
    await this.authority.current(auth, resources);
  }
  async drain(budget: D.DrainBudget): Promise<D.DrainProgress> {
    let processed = 0;
    for (const row of await this.store.page<ExportWork>(
      "export-work",
      Math.min(1, budget.maxItems),
      "",
      Date.now(),
    )) {
      if (Date.now() >= budget.deadline) break;
      const auth = { ...row.value.auth, deadline: Math.min(budget.deadline, Date.now() + 30000) };
      try {
        if (await this.store.get("export", row.id)) {
          await this.#complete(row.value, auth);
        } else await this.prepare(auth, { ...row.value.input, deadline: auth.deadline });
      } catch (error) {
        await this.#defer(row.id, error);
      }
      processed++;
    }
    const due = await this.store.db.get<{ due: number | null }>(
      "SELECT min(due) AS due FROM fp_records_v1 WHERE kind='export-work' AND due IS NOT NULL",
    );
    return {
      processed,
      remaining: due?.due != null,
      ...(due?.due != null ? { nextWakeAt: Math.max(Date.now() + 5000, due.due) } : {}),
    };
  }
  private descriptor(retained: RetainedExport): D.ExportDescriptor {
    return {
      exportId: retained.exportId,
      state: retained.complete ? "ready" : "partial",
      artifacts: [
        {
          artifactId: retained.exportId,
          sha256: retained.sha256,
          size: retained.size,
          endpoint: `/v1/admin/artifacts/${encodeURIComponent(retained.exportId)}`,
          scope: {
            kind: "agent",
            agentId: this.authority.agentId,
            conversationIds: retained.conversationIds,
          },
        },
      ],
      unavailableWorkspaceIds: [],
      credentialsExcluded: true,
    };
  }
  async read(auth: D.AuthContext, artifactId: string, request: Request): Promise<Response> {
    check(
      request.method === "GET" && new URL(request.url).search === "",
      "invalid_request",
      "Invalid retained artifact request",
    );
    check(auth.role === "admin", "unauthorized", "Administrator artifact authority required");
    const retained = await this.store.get<RetainedExport>("export", artifactId);
    check(retained, "not_found", "Retained export unavailable");
    check(
      retained.principalId === auth.principalId,
      "unauthorized",
      "Export snapshot principal differs",
    );
    await this.authorize(auth, retained.resources, retained.action);
    const bytes = new TextEncoder().encode(retained.text);
    check(
      bytes.length === retained.size && (await hash(bytes)) === retained.sha256,
      "conflict",
      "Retained artifact integrity mismatch",
    );
    const header = request.headers.get("Range");
    let start = 0,
      end = bytes.length - 1;
    if (header) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(header);
      check(
        match && (match[1] || match[2]),
        "range_not_satisfiable",
        "A single byte range is required",
      );
      start = match[1] ? Number(match[1]) : Math.max(0, bytes.length - Number(match[2]));
      end = match[1] && match[2] ? Math.min(bytes.length - 1, Number(match[2])) : bytes.length - 1;
      check(
        Number.isSafeInteger(start) &&
          Number.isSafeInteger(end) &&
          start >= 0 &&
          start <= end &&
          end < bytes.length,
        "range_not_satisfiable",
        "Range outside retained artifact",
      );
    }
    const length = Math.max(0, end - start + 1),
      sha256 = header ? await hash(bytes.subarray(start, end + 1)) : retained.sha256;
    let offset = start;
    const authority = this.authority,
      resources = scope({ ...retained.resources, actions: [retained.action] });
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          request.signal.throwIfAborted();
          await authority.current(auth, resources);
          if (offset > end) {
            controller.close();
            return;
          }
          const next = Math.min(end + 1, offset + 65536);
          controller.enqueue(bytes.slice(offset, next));
          offset = next;
        } catch (error) {
          controller.error(error);
        }
      },
    });
    return new Response(stream, {
      status: header ? 206 : 200,
      headers: {
        "Content-Type": "application/x-ndjson",
        "Content-Length": String(length),
        "X-Content-SHA256": sha256,
        "Cache-Control": "no-store",
        "Accept-Ranges": "bytes",
        ...(header ? { "Content-Range": `bytes ${start}-${end}/${bytes.length}` } : {}),
      },
    });
  }
}
