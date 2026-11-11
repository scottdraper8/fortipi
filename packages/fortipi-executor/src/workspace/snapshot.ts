import { lstat, rmdir } from "node:fs/promises";
import { join } from "node:path";
import type { Assignment, UploadBlobPlan } from "fortipi-contract/executor";
import { manifestDigest, validateUploadBlobs } from "fortipi-contract/executor";
import type { Limits } from "../config.js";
import { secureDirectory, syncDirectory } from "../config.js";
import type { Ledger } from "../ledger.js";
import type { PlatformAdapter } from "../platform/types.js";
import { hash } from "../policy.js";
import type { HttpTransport } from "../transport.js";
import { readBounded, validate } from "../transport.js";
import type { Manifest } from "./manifest.js";
import { checkManifest, differences, inventoryFor, mutationsFor, scan } from "./manifest.js";
import { SafeRoot } from "./paths.js";

export interface Scratch {
  path: string;
  manifest: Manifest;
  manifestHash: string;
  executionId: string;
}
export class Snapshots {
  directory: string;
  ledger: Ledger;
  http: HttpTransport;
  platform: PlatformAdapter;
  limits: Limits;
  constructor(directory: string, ledger: Ledger, http: HttpTransport, platform: PlatformAdapter) {
    this.directory = directory;
    this.ledger = ledger;
    this.http = http;
    this.platform = platform;
    this.limits = http.limits;
  }
  async materialize(assignment: Assignment): Promise<SafeRoot> {
    const id = assignment.identity;
    const previous = this.ledger.record<Scratch>("stages", `scratch_${id.executionId}`);
    if (previous) throw new Error("existing or uncertain scratch is query-only");
    const base = `/v1/workspaces/${encodeURIComponent(assignment.workspaceId)}`;
    const response = validate<{
      workspaceId: string;
      revision: string;
      manifest: Manifest;
      manifestHash: string;
    }>(
      "workspaces.schema.json",
      "ManifestResponse",
      await this.http.json(`${base}/manifest?revision=${encodeURIComponent(id.baseRevision)}`),
    );
    if (
      response.workspaceId !== assignment.workspaceId ||
      response.revision !== id.baseRevision ||
      (await manifestDigest(response.manifest)) !== response.manifestHash
    )
      throw new Error("snapshot revision integrity");
    checkManifest(response.manifest, this.limits, "sensitive");
    this.ledger.transaction(() => {
      const reserved = Number(
        (
          this.ledger.db.prepare("SELECT value FROM meta WHERE key='scratch_reserved'").get() as
            | { value: string }
            | undefined
        )?.value ?? 0,
      );
      if (reserved + this.limits.snapshotBytes > this.limits.snapshotBytes * 2)
        throw new Error("local scratch capacity exhausted; pending results retained");
      this.ledger.db
        .prepare(
          "INSERT INTO meta VALUES ('scratch_reserved',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(String(reserved + this.limits.snapshotBytes));
      this.ledger.db
        .prepare("INSERT INTO meta VALUES (?,?)")
        .run(`scratch_reservation_${id.executionId}`, String(this.limits.snapshotBytes));
    });
    await secureDirectory(this.directory, this.platform);
    const path = join(this.directory, id.executionId);
    await secureDirectory(path, this.platform);
    this.ledger.saveRecord("stages", `scratch_${id.executionId}`, {
      path,
      manifest: response.manifest,
      manifestHash: response.manifestHash,
      executionId: id.executionId,
    });
    const root = await SafeRoot.open(path, this.platform);
    this.ledger.saveRecord("stages", `scratch_root_${id.executionId}`, { key: root.key });
    checkManifest(response.manifest, this.limits, root.identity.caseBehavior);
    const directories = new Set<string>();
    for (const entry of response.manifest.entries) {
      const parts = entry.path.split("/");
      if (entry.type === "file") parts.pop();
      for (let n = 1; n <= parts.length; n++) directories.add(parts.slice(0, n).join("/"));
    }
    for (const directory of [...directories].sort(
      (a, b) => a.split("/").length - b.split("/").length,
    ))
      await root.mkdir(directory);
    for (const entry of response.manifest.entries) {
      if (entry.type !== "file") continue;
      checkManifest(response.manifest, this.http.limits, root.identity.caseBehavior);
      const { r, bytes } = await this.http.withTransfer(async () => {
        const r = await this.http.request(
          `${base}/blobs/${entry.sha256}?revision=${encodeURIComponent(id.baseRevision)}`,
          {},
          true,
          Math.min(id.deadline, id.lease.expiresAt),
        );
        const bytes = await readBounded(r, entry.size);
        return { r, bytes };
      });
      if (
        bytes.byteLength !== entry.size ||
        hash(bytes) !== entry.sha256 ||
        Number(r.headers.get("Content-Length")) !== entry.size ||
        r.headers.get("X-Content-SHA256") !== entry.sha256
      )
        throw new Error("snapshot file integrity");
      checkManifest(response.manifest, this.http.limits, root.identity.caseBehavior);
      await root.write(entry.path, bytes, entry.mode);
    }
    const actual = await scan(root, this.limits);
    if (actual.manifestHash !== response.manifestHash)
      throw new Error("snapshot materialization mismatch");
    return root;
  }
  async diff(assignment: Assignment, root: SafeRoot) {
    const old = this.ledger.record<Scratch>("stages", `scratch_${assignment.identity.executionId}`);
    const identity = this.ledger.record<{ key: string }>(
      "stages",
      `scratch_root_${assignment.identity.executionId}`,
    );
    if (!old || old.path !== root.identity.path || identity?.key !== root.key)
      throw new Error("missing scratch is not an empty diff");
    root.rememberModes(old.manifest);
    const after = await scan(root, this.limits);
    return { before: old, after, changes: differences(old.manifest, after.manifest) };
  }
  async stage(
    assignment: Assignment,
    root: SafeRoot,
    requestId: string,
    commitId: string,
  ): Promise<{ uploadId: string; commitId: string; manifestHash: string; stageId: string }> {
    const id = assignment.identity;
    const lease = () =>
      this.ledger.existing(assignment.identity)?.assignment.identity.lease ??
      assignment.identity.lease;
    if (Date.now() >= Math.min(id.deadline, lease().expiresAt))
      throw new Error("expired staging lease");
    const { before, after } = await this.diff(assignment, root);
    const mutations = mutationsFor(before.manifest, after.manifest).map((m) =>
      m.kind === "put"
        ? {
            kind: "put" as const,
            path: m.entry.path,
            sha256: m.entry.sha256,
            size: m.entry.size,
            mode: m.entry.mode,
          }
        : m.kind === "mkdir"
          ? { ...m, mode: 493 as const }
          : m,
    );
    const base = `/v1/workspaces/${encodeURIComponent(assignment.workspaceId)}/uploads`;
    const previous = this.ledger.record<{ requestId: string; commitId: string; body: unknown }>(
      "stages",
      `upload_intent_${id.executionId}`,
    );
    if (previous) {
      requestId = previous.requestId;
      commitId = previous.commitId;
    }
    const blobs: UploadBlobPlan[] = [];
    if (!previous) {
      const seen = new Set<string>();
      for (const m of mutations)
        if (m.kind === "put") {
          const bytes = await root.read(m.path, this.limits.fileBytes);
          if (bytes.length !== m.size || hash(bytes) !== m.sha256)
            throw new Error("scratch changed before upload plan");
          if (!seen.has(m.sha256)) {
            seen.add(m.sha256);
            blobs.push({ sha256: m.sha256, chunks: inventoryFor(bytes, this.http.chunkBytes) });
          }
        }
    }
    const begin = previous?.body ?? {
      requestId,
      baseRevision: id.baseRevision,
      lease: lease(),
      operationId: id.lease.operationId,
      commitId,
      manifestHash: after.manifestHash,
      manifest: after.manifest,
      mutations,
      blobs,
    };
    this.ledger.saveRecord("stages", `upload_intent_${id.executionId}`, {
      requestId,
      commitId,
      body: begin,
    });
    const proposal = validate<Parameters<typeof validateUploadBlobs>[0]>(
      "workspaces.schema.json",
      "UploadBegin",
      begin,
    );
    validateUploadBlobs(proposal, { required: false });
    const opened = validate<{ uploadId: string; manifestHash: string; baseRevision: string }>(
      "workspaces.schema.json",
      "UploadStatus",
      await this.http.json(base, begin),
    );
    if (opened.manifestHash !== after.manifestHash || opened.baseRevision !== id.baseRevision)
      throw new Error("upload allocation correlation mismatch");
    const uploadId = opened.uploadId;
    this.ledger.saveRecord("stages", `upload_open_${id.executionId}`, {
      uploadId,
      commitId,
      requestId,
    });
    const uploaded = new Set<string>();
    for (const mutation of mutations) {
      if (mutation.kind !== "put") continue;
      const bytes = await root.read(mutation.path, this.limits.fileBytes);
      if (hash(bytes) !== mutation.sha256) throw new Error("scratch drift during upload");
      const plan =
        proposal.blobs?.find((b) => b.sha256 === mutation.sha256) ??
        (proposal.blobs === undefined
          ? { sha256: mutation.sha256, chunks: inventoryFor(bytes, 262144) }
          : undefined);
      if (
        !plan ||
        plan.chunks.chunkBytes > this.http.chunkBytes ||
        JSON.stringify(inventoryFor(bytes, plan.chunks.chunkBytes)) !== JSON.stringify(plan.chunks)
      )
        throw new Error("upload chunk grid/bytes no longer eligible");
      if (uploaded.has(mutation.sha256)) continue;
      for (
        let offset = 0, index = 0;
        offset < bytes.length;
        offset += plan.chunks.chunkBytes, index++
      ) {
        if (plan.chunks.chunkBytes > Math.min(this.http.chunkBytes, this.http.limits.chunkBytes))
          throw new Error("upload chunk grid no longer eligible");
        checkManifest(after.manifest, this.http.limits, root.identity.caseBehavior);
        if (Date.now() >= Math.min(id.deadline, lease().expiresAt))
          throw new Error("expired upload");
        const chunk = bytes.subarray(offset, offset + plan.chunks.chunkBytes);
        const r = await this.http.withTransfer(() =>
          this.http.request(
            `${base}/${uploadId}/blobs/${mutation.sha256}/chunks/${index}?length=${chunk.length}&sha256=${hash(chunk)}`,
            { method: "PUT", body: chunk, headers: { "Content-Type": "application/octet-stream" } },
            true,
            Math.min(id.deadline, lease().expiresAt),
          ),
        );
        if (r.status !== 204) throw new Error("upload chunk not acknowledged");
      }
      uploaded.add(mutation.sha256);
    }
    if ((await scan(root, this.limits)).manifestHash !== after.manifestHash)
      throw new Error("scratch changed during staging");
    const sealed = validate<{
      uploadId: string;
      manifestHash: string;
      stageId: string;
      validated: true;
    }>(
      "workspaces.schema.json",
      "UploadValidation",
      await this.http.json(`${base}/${uploadId}/validate`, undefined, "POST"),
    );
    if (sealed.uploadId !== uploadId || sealed.manifestHash !== after.manifestHash)
      throw new Error("validated stage mismatch");
    const result = {
      uploadId,
      commitId,
      manifestHash: sealed.manifestHash,
      stageId: sealed.stageId,
    };
    this.ledger.saveRecord("stages", `upload_ready_${id.executionId}`, result);
    return result;
  }
  async cleanup(assignment: Assignment, manifestHash: string): Promise<void> {
    const job = this.ledger.existing(assignment.identity);
    if (!job?.committed || job.result?.manifestHash !== manifestHash)
      throw new Error("scratch cleanup requires durable terminal evidence");
    const id = assignment.identity,
      scratch = this.ledger.record<Scratch>("stages", `scratch_${id.executionId}`),
      rootIdentity = this.ledger.record<{ key: string }>(
        "stages",
        `scratch_root_${id.executionId}`,
      );
    if (!scratch || !rootIdentity) throw new Error("scratch cleanup identity unavailable");
    const intentKey = `cleanup_intent_${id.executionId}`,
      intent = this.ledger.record<{ manifestHash: string; manifest: Manifest }>(
        "stages",
        intentKey,
      );
    if (intent && intent.manifestHash !== manifestHash)
      throw new Error("scratch cleanup proof conflict");
    let absent = false;
    try {
      await lstat(scratch.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      absent = true;
    }
    if (absent && !intent) throw new Error("missing scratch has no cleanup proof");
    if (!absent) {
      const root = await SafeRoot.open(scratch.path, this.platform);
      const actual = await scan(root, this.limits);
      if (root.key !== rootIdentity.key || (!intent && actual.manifestHash !== manifestHash))
        throw new Error("scratch cleanup drift");
      if (intent) {
        const entries = new Map(intent.manifest.entries.map((e) => [e.path, JSON.stringify(e)]));
        if (actual.manifest.entries.some((e) => entries.get(e.path) !== JSON.stringify(e)))
          throw new Error("scratch cleanup found unjournaled bytes");
      } else
        this.ledger.saveRecord("stages", intentKey, { manifestHash, manifest: actual.manifest });
      for (const name of await root.entries())
        for (const path of await root.deletionPaths(name, this.limits.manifestEntries))
          await root.delete(path);
      await root.verify();
      await rmdir(scratch.path);
      await syncDirectory(this.directory);
    }
    this.ledger.transaction(() => {
      this.ledger.saveRecord("stages", `cleanup_done_${id.executionId}`, { manifestHash });
      const key = `scratch_reservation_${id.executionId}`,
        reservation = this.ledger.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as
          | { value: string }
          | undefined;
      if (reservation) {
        const total = Number(
          (
            this.ledger.db.prepare("SELECT value FROM meta WHERE key='scratch_reserved'").get() as
              | { value: string }
              | undefined
          )?.value ?? 0,
        );
        this.ledger.db
          .prepare("UPDATE meta SET value=? WHERE key='scratch_reserved'")
          .run(String(Math.max(0, total - Number(reservation.value))));
        this.ledger.db.prepare("DELETE FROM meta WHERE key=?").run(key);
      }
      this.ledger.release(rootIdentity.key, id.jobId);
      this.ledger.db.prepare("DELETE FROM meta WHERE key=?").run(`cleanup_pending_${id.jobId}`);
    });
  }
}
