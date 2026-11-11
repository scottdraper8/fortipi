import { createHash } from "node:crypto";
import { canonicalJson, digestJson, manifestDigest, wireLimits } from "fortipi-contract";
import type * as D from "../boundary/dto.js";
import {
  type AllocationRecord,
  authorize,
  permitsResource,
  type RevisionRecord,
  same,
} from "./authority.js";
import { requireThat } from "./errors.js";
import { checkedManifest } from "./manifest.js";
import { chunkBytes } from "./streams.js";
import type { WorkspaceObject } from "./workspace-object.js";

type FileEntry = Extract<D.ManifestEntry, { type: "file" }>;
type Reference = D.AdminArtifactReference;
interface Member {
  entry: FileEntry;
  parts: { artifactId: string; offset: number; size: number; sha256: string }[];
}
interface ExportIdentity {
  intent: string;
  principalId: string;
  request: D.ExportRequest;
  workspaceId: string;
  expiresAt: number;
  indexId: string;
}
interface RetainedExportRecord extends ExportIdentity {
  revision: RevisionRecord;
  members: Member[];
  reservedBytes: number;
  state: "copying" | "ready" | "partial" | "unavailable";
  descriptor: D.ExportDescriptor;
}
interface ExpiredExportRecord extends ExportIdentity {
  state: "expired";
  artifactIds: string[];
}
type ExportRecord = RetainedExportRecord | ExpiredExportRecord;
const grid = 64 * 1024;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** App-owned bounded immutable export copies; no Computer/Store private SQL or live-root reads. */
export class WorkspaceExports {
  private readonly owner: WorkspaceObject;
  private readonly active = new Map<string, Promise<D.ExportDescriptor>>();
  private readers = 0;
  constructor(owner: WorkspaceObject) {
    this.owner = owner;
    owner.state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS fp_ws_export_chunk (export_id TEXT NOT NULL, artifact_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, sha256 TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(export_id,artifact_id,chunk_index))",
    );
  }
  private row(id: string): ExportRecord {
    const row = this.owner.state.get<ExportRecord>(`export:${id}`);
    requireThat(row, "not_found", "Retained export unavailable");
    return row;
  }
  private authorize(ctx: D.AuthContext, row: ExportRecord): void {
    const owner = this.owner;
    authorize(owner.state, ctx, row.workspaceId, row.request.action);
    requireThat(
      owner.isSelf(row.workspaceId) &&
        !owner.state.get("child") &&
        ctx.principalId === row.principalId &&
        row.expiresAt > Date.now(),
      "unauthorized",
      "Current retained export authority required",
    );
    requireThat(
      ctx.grants.some(
        (grant) =>
          (grant.expiresAt === undefined || grant.expiresAt > Date.now()) &&
          permitsResource(grant.resources.actions, row.request.action) &&
          (Object.keys(row.request.resources) as (keyof D.ResourceScope)[]).every((key) =>
            row.request.resources[key].every((value) =>
              permitsResource(grant.resources[key], value),
            ),
          ),
      ),
      "unauthorized",
      "One current logical export grant must cover the requested resources",
    );
  }
  async create(ctx: D.AuthContext, input: D.ExportRequest): Promise<D.ExportDescriptor> {
    requireThat(
      /^[A-Za-z0-9_-]{1,128}$/.test(input.exportId) &&
        (input.action === "exports.create" || input.action === "backups.create") &&
        Number.isSafeInteger(input.maxBytes) &&
        input.maxBytes >= 0 &&
        input.maxBytes <= this.owner.policy.bounds.snapshotBytes &&
        Number.isSafeInteger(input.deadline) &&
        input.deadline > Date.now(),
      "invalid_request",
      "Invalid bounded export request",
    );
    const owner = this.owner;
    const workspaceId = owner.current().workspaceId;
    const keys = [
      "agentIds",
      "conversationIds",
      "workspaceIds",
      "actions",
      "tools",
      "executorIds",
      "backendIds",
    ] as const;
    requireThat(
      input.resources &&
        Object.keys(input.resources).length === keys.length &&
        keys.every(
          (key) =>
            Array.isArray(input.resources[key]) &&
            input.resources[key].length <= 100 &&
            input.resources[key].every(
              (value) =>
                typeof value === "string" &&
                value.length > 0 &&
                value.length <= 128 &&
                value !== "*",
            ) &&
            new Set(input.resources[key]).size === input.resources[key].length,
        ),
      "invalid_request",
      "Concrete bounded export resources required",
    );
    requireThat(
      Array.isArray(input.resources.workspaceIds) &&
        input.resources.workspaceIds.includes(workspaceId) &&
        !Object.values(input.resources).some((values) => values.includes("*")),
      "unauthorized",
      "Concrete requested workspace membership required",
    );
    // Deadline repair cannot alter the retained cut, action, resources, principal or byte budget.
    const intent = await digestJson("operation", {
      exportId: input.exportId,
      action: input.action,
      resources: input.resources,
      maxBytes: input.maxBytes,
      workspaceId,
      principalId: ctx.principalId,
    });
    const row = await owner.mutex.run(async () => {
      const prior = owner.state.get<ExportRecord>(`export:${input.exportId}`);
      if (prior) {
        this.authorize(ctx, prior);
        requireThat(prior.state !== "expired", "not_found", "Export expired");
        requireThat(prior.intent === intent, "conflict", "Export intent changed");
        return prior;
      }
      const revision = owner.revision(owner.current().binding.revision);
      const row: RetainedExportRecord = {
        intent,
        principalId: ctx.principalId,
        request: input,
        revision,
        workspaceId,
        expiresAt: Math.min(input.deadline, Date.now() + 3_600_000),
        indexId: crypto.randomUUID(),
        members: [],
        reservedBytes: 0,
        state: "copying",
        descriptor: {
          exportId: input.exportId,
          state: "partial",
          artifacts: [],
          unavailableWorkspaceIds: [],
          credentialsExcluded: true,
        },
      };
      this.authorize(ctx, row);
      const manifest = checkedManifest(revision.manifest, owner.policy);
      requireThat(
        (await manifestDigest(manifest)) === revision.manifestHash,
        "conflict",
        "Export manifest hash changed",
      );
      this.authorize(ctx, row);
      const maximum = Math.min(owner.policy.bounds.artifactBytes, wireLimits.artifactBytes);
      let count = 1;
      for (const entry of manifest.entries)
        if (entry.type === "file") {
          const parts: Member["parts"] = [];
          const number = Math.max(1, Math.ceil(entry.size / maximum));
          count += number;
          if (count > 16) {
            row.state = "partial";
            break;
          }
          for (let index = 0; index < number; index++)
            parts.push({
              artifactId: crypto.randomUUID(),
              offset: index * maximum,
              size: Math.min(maximum, entry.size - index * maximum),
              sha256: "0".repeat(64),
            });
          row.members.push({ entry, parts });
        }
      const indexSize = this.index(row).length;
      row.reservedBytes =
        indexSize +
        manifest.entries.reduce((sum, entry) => sum + (entry.type === "file" ? entry.size : 0), 0);
      if (indexSize > maximum || row.reservedBytes > input.maxBytes) row.state = "partial";
      if (
        !revision.store &&
        (owner.current().binding.config.kind === "local" || row.members.length > 0)
      )
        row.state = "unavailable";
      if (row.state !== "copying") {
        row.descriptor.state = row.state === "unavailable" ? "unavailable" : "partial";
        row.descriptor.unavailableWorkspaceIds = [workspaceId];
        row.reservedBytes = 0;
      }
      const usage = owner.state.get<{ count: number; bytes: number }>("export-usage") ?? {
        count: 0,
        bytes: 0,
      };
      requireThat(
        usage.count < owner.policy.bounds.retainedVersions &&
          usage.bytes + row.reservedBytes <= owner.policy.bounds.snapshotBytes &&
          owner.state.bytes + row.reservedBytes + (owner.state.get<number>("reserved") ?? 0) <=
            owner.policy.bounds.workspaceBytes * (1 - owner.policy.bounds.headroomFraction),
        "quota_exceeded",
        "Retained export capacity reached",
      );
      owner.state.transaction(() => {
        this.physical(new TextEncoder().encode(canonicalJson(row)).length + 8192);
        owner.state.put(`export:${input.exportId}`, row);
        owner.state.put("export-usage", {
          count: usage.count + 1,
          bytes: usage.bytes + row.reservedBytes,
        });
        owner.state.put(`due:${String(row.expiresAt).padStart(16, "0")}:export:${input.exportId}`, {
          at: row.expiresAt,
          kind: "export",
          id: input.exportId,
        });
        this.physical(0);
      });
      return row;
    });
    const alarm = await owner.state.storage.getAlarm();
    if (alarm === null || row.expiresAt < alarm) await owner.state.storage.setAlarm(row.expiresAt);
    if (row.state !== "copying")
      return owner.mutex.run(() => {
        const current = this.row(input.exportId);
        this.authorize(ctx, current);
        requireThat(current.state !== "expired", "not_found", "Export expired");
        return current.descriptor;
      });
    const prior = this.active.get(input.exportId);
    if (prior)
      return prior.then(async (result) => {
        await owner.mutex.run(() => this.authorize(ctx, this.row(input.exportId)));
        return result;
      });
    const copying = this.copy(ctx, row).finally(() => {
      this.active.delete(input.exportId);
    });
    this.active.set(input.exportId, copying);
    return copying;
  }
  private index(row: RetainedExportRecord): Uint8Array {
    return new TextEncoder().encode(
      canonicalJson({
        version: 1,
        workspaceId: row.workspaceId,
        revision: row.revision.revision,
        manifestHash: row.revision.manifestHash,
        manifest: row.revision.manifest,
        files: row.members.map(({ entry, parts }) => ({ path: entry.path, parts })),
      }),
    );
  }
  /** Same existing store/read path, authority POST proof before the child's GET; never public read. */
  member(
    ctx: D.AuthContext,
    exportId: string,
    allocation: D.StoreAllocation,
    entry: D.ManifestEntry,
  ): D.StoreState {
    const row = this.row(exportId);
    this.authorize(ctx, row);
    requireThat(row.state === "copying", "not_found", "Export copy unavailable");
    const stored = row.revision.store;
    const registry =
      stored && this.owner.state.get<AllocationRecord>(`allocation:${stored.allocationId}`);
    requireThat(
      row.state === "copying" &&
        stored &&
        registry?.referenced &&
        registry.state.state === "sealed" &&
        same(registry.seal, stored) &&
        same(registry.state.allocation, allocation) &&
        row.members.some((member) => same(member.entry, entry)) &&
        row.revision.manifest.entries.some((member) => same(member, entry)) &&
        same(this.owner.revision(row.revision.revision), row.revision),
      "unauthorized",
      "Retained export member/allocation required",
    );
    return registry.state;
  }
  private put(
    row: RetainedExportRecord,
    artifactId: string,
    index: number,
    bytes: Uint8Array,
  ): void {
    requireThat(
      bytes.length <= grid && bytes.length <= chunkBytes,
      "payload_too_large",
      "Export chunk bound exceeded",
    );
    this.physical(bytes.length + 8192);
    this.owner.state.storage.sql.exec(
      "INSERT INTO fp_ws_export_chunk(export_id,artifact_id,chunk_index,sha256,bytes) VALUES(?,?,?,?,?)",
      row.request.exportId,
      artifactId,
      index,
      hash(bytes),
      bytes.slice().buffer,
    );
    this.physical(0);
  }
  private physical(growth: number): void {
    const bounds = this.owner.policy.bounds;
    requireThat(
      this.owner.state.bytes + growth <=
        Math.min(bounds.objectBytes, bounds.workspaceBytes, bounds.installBytes) *
          (1 - bounds.headroomFraction),
      "quota_exceeded",
      "Export physical storage headroom exhausted",
    );
  }
  private async copy(ctx: D.AuthContext, row: RetainedExportRecord): Promise<D.ExportDescriptor> {
    const owner = this.owner;
    const check = () => {
      const current = this.row(row.request.exportId);
      this.authorize(ctx, current);
      requireThat(
        current.state === "copying" && current.intent === row.intent,
        "interrupted",
        "Export copy no longer active",
      );
    };
    try {
      await owner.mutex.run(() => {
        check();
        owner.state.storage.sql.exec(
          "DELETE FROM fp_ws_export_chunk WHERE export_id=?",
          row.request.exportId,
        );
      });
      for (const member of row.members) {
        const store = row.revision.store;
        requireThat(store, "interrupted", "Export source unavailable");
        const allocation = await owner.mutex.run(() => {
          check();
          const registry = owner.state.get<AllocationRecord>(`allocation:${store.allocationId}`);
          requireThat(registry, "interrupted", "Export allocation unavailable");
          this.member(ctx, row.request.exportId, registry.state.allocation, member.entry);
          return registry.state.allocation;
        });
        const response = await owner.childFetch(ctx, allocation, "/read", {
          entry: member.entry,
          exportId: row.request.exportId,
        });
        requireThat(response.ok && response.body, "interrupted", "Export member bytes unavailable");
        const reader = response.body.getReader();
        const deadline = Math.min(ctx.deadline, row.expiresAt);
        const timer = setTimeout(
          () => {
            void reader.cancel();
          },
          Math.max(1, deadline - Date.now()),
        );
        const whole = createHash("sha256");
        let length = 0;
        let partIndex = 0;
        let partBytes = 0;
        let partHash = createHash("sha256");
        let chunkIndex = 0;
        let pending = new Uint8Array(Math.min(grid, member.parts[0]?.size ?? 0));
        let pendingLength = 0;
        try {
          for (;;) {
            await owner.mutex.run(check);
            const next = await reader.read();
            await owner.mutex.run(check);
            requireThat(Date.now() < deadline, "interrupted", "Export copy expired");
            if (next.done) break;
            length += next.value.length;
            requireThat(
              length <= member.entry.size,
              "interrupted",
              "Export member length mismatch",
            );
            whole.update(next.value);
            for (let offset = 0; offset < next.value.length; ) {
              const part = member.parts[partIndex];
              requireThat(part, "interrupted", "Export part overflow");
              const count = Math.min(pending.length - pendingLength, next.value.length - offset);
              requireThat(count > 0, "interrupted", "Export part grid mismatch");
              pending.set(next.value.subarray(offset, offset + count), pendingLength);
              pendingLength += count;
              offset += count;
              partBytes += count;
              if (pendingLength === pending.length) {
                partHash.update(pending);
                await owner.mutex.run(() => {
                  owner.state.transaction(() => {
                    check();
                    this.put(row, part.artifactId, chunkIndex++, pending);
                  });
                });
                pendingLength = 0;
                pending = new Uint8Array(Math.min(grid, part.size - partBytes));
              }
              if (partBytes === part.size) {
                part.sha256 = partHash.digest("hex");
                partIndex++;
                partBytes = 0;
                chunkIndex = 0;
                partHash = createHash("sha256");
                pending = new Uint8Array(Math.min(grid, member.parts[partIndex]?.size ?? 0));
              }
            }
          }
          requireThat(
            length === member.entry.size && whole.digest("hex") === member.entry.sha256,
            "interrupted",
            "Export member SHA or size mismatch",
          );
          if (member.entry.size === 0) {
            const part = member.parts[0];
            requireThat(part, "internal", "Empty export member missing");
            part.sha256 = hash(new Uint8Array());
          }
        } finally {
          clearTimeout(timer);
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      }
      const index = this.index(row);
      requireThat(
        index.length + row.members.reduce((sum, member) => sum + member.entry.size, 0) ===
          row.reservedBytes,
        "internal",
        "Export reconstruction index changed size",
      );
      const reference = (artifactId: string, size: number, sha256: string): Reference => ({
        artifactId,
        size,
        sha256,
        endpoint: `/v1/admin/artifacts/${artifactId}`,
        scope: { kind: "workspace", workspaceId: row.workspaceId, revision: row.revision.revision },
      });
      const artifacts = [
        reference(row.indexId, index.length, hash(index)),
        ...row.members.flatMap((member) =>
          member.parts.map((part) => reference(part.artifactId, part.size, part.sha256)),
        ),
      ];
      return await owner.mutex.run(() => {
        check();
        owner.state.transaction(() => {
          for (
            let offset = 0, indexNumber = 0;
            offset < index.length;
            offset += grid, indexNumber++
          )
            this.put(row, row.indexId, indexNumber, index.slice(offset, offset + grid));
          row.state = "ready";
          row.descriptor = { ...row.descriptor, state: "ready", artifacts };
          owner.state.put(`export:${row.request.exportId}`, row);
          for (const artifact of artifacts)
            owner.state.put(`export-artifact:${artifact.artifactId}`, row.request.exportId);
          this.physical(0);
        });
        return row.descriptor;
      });
    } catch (error) {
      await owner.mutex.run(() => {
        const saved = this.row(row.request.exportId);
        if (saved.state === "copying") {
          owner.state.storage.sql.exec(
            "DELETE FROM fp_ws_export_chunk WHERE export_id=?",
            row.request.exportId,
          );
          // A retry may recopy this SAME retained cut; it can never select a newer root.
        }
      });
      throw error;
    }
  }
  async peer(ctx: D.AuthContext, artifactId: string, signal: AbortSignal) {
    const row = await this.owner.mutex.run(() => {
      const id = this.owner.state.get<string>(`export-artifact:${artifactId}`);
      requireThat(id, "not_found", "Retained export artifact unavailable");
      const row = this.row(id);
      this.authorize(ctx, row);
      requireThat(row.state === "ready", "not_found", "Export copy incomplete");
      return row;
    });
    const reference = row.descriptor.artifacts.find(
      (artifact) => artifact.artifactId === artifactId,
    );
    requireThat(
      reference && "scope" in reference,
      "not_found",
      "Export artifact membership required",
    );
    return { reference, open: () => this.stream(ctx, row, reference, signal) };
  }
  private stream(
    ctx: D.AuthContext,
    row: RetainedExportRecord,
    reference: Reference,
    signal: AbortSignal,
  ): ReadableStream<Uint8Array> {
    requireThat(
      !signal.aborted && this.readers < Math.min(4, this.owner.policy.bounds.transferConcurrency),
      "interrupted",
      "Export stream unavailable",
    );
    this.readers++;
    let closed = false;
    let index = 0;
    let length = 0;
    const whole = createHash("sha256");
    let fail: (error: Error) => void = () => {};
    const finish = () => {
      if (!closed) {
        closed = true;
        this.readers--;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      }
    };
    const abort = () => {
      if (!closed) {
        finish();
        fail(new Error("Export stream cancelled or expired"));
      }
    };
    const timer = setTimeout(
      abort,
      Math.max(1, Math.min(ctx.deadline, row.expiresAt) - Date.now()),
    );
    signal.addEventListener("abort", abort, { once: true });
    return new ReadableStream({
      start(controller) {
        fail = (error) => controller.error(error);
      },
      pull: async (controller) => {
        try {
          await this.owner.mutex.run(() => {
            this.authorize(ctx, this.row(row.request.exportId));
            requireThat(!closed, "interrupted", "Export stream closed");
            const chunk = this.owner.state.storage.sql
              .exec<{ bytes: ArrayBuffer; sha256: string }>(
                "SELECT bytes,sha256 FROM fp_ws_export_chunk WHERE export_id=? AND artifact_id=? AND chunk_index=?",
                row.request.exportId,
                reference.artifactId,
                index++,
              )
              .toArray()[0];
            if (!chunk) {
              requireThat(
                length === reference.size && whole.digest("hex") === reference.sha256,
                "interrupted",
                "Retained export bytes incomplete",
              );
              finish();
              controller.close();
            } else {
              const bytes = new Uint8Array(chunk.bytes);
              requireThat(
                bytes.length <= grid &&
                  hash(bytes) === chunk.sha256 &&
                  length + bytes.length <= reference.size,
                "interrupted",
                "Retained export chunk changed",
              );
              length += bytes.length;
              whole.update(bytes);
              controller.enqueue(bytes);
            }
          });
        } catch (error) {
          finish();
          controller.error(error);
        }
      },
      cancel: finish,
    });
  }
  expire(id: string): void {
    const row = this.row(id);
    if (row.state === "expired") return;
    this.owner.state.storage.sql.exec("DELETE FROM fp_ws_export_chunk WHERE export_id=?", id);
    for (const artifact of row.descriptor.artifacts)
      this.owner.state.delete(`export-artifact:${artifact.artifactId}`);
    const usage = this.owner.state.get<{ count: number; bytes: number }>("export-usage");
    requireThat(usage, "internal", "Export retention accounting missing");
    this.owner.state.put("export-usage", {
      count: usage.count - 1,
      bytes: usage.bytes - row.reservedBytes,
    });
    const expired: ExpiredExportRecord = {
      state: "expired",
      intent: row.intent,
      principalId: row.principalId,
      request: row.request,
      workspaceId: row.workspaceId,
      expiresAt: row.expiresAt,
      indexId: row.indexId,
      artifactIds: [
        row.indexId,
        ...row.members.flatMap((member) => member.parts.map((part) => part.artifactId)),
      ],
    };
    // Retain only immutable intent/IDs; released manifests/member layouts are not fake empty cuts.
    this.owner.state.put(`export:${id}`, expired);
  }
}
