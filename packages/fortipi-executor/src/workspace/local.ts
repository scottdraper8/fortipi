import { randomUUID } from "node:crypto";
import type {
  Assignment,
  LocalApply,
  LocalObservation,
  LocalObserve,
  LocalPrepare,
  LocalPrepared,
  LocalReadRequest,
  LocalReadResult,
  LocalReceiptAck,
  LocalWorkspaceRequest,
  LocalWorkspaceResponse,
  TransportAck,
} from "fortipi-contract/executor";
import {
  canonicalJson,
  commitDigest,
  manifestDigest,
  validateLocalLease,
} from "fortipi-contract/executor";
import type { Binding, Limits, Profile } from "../config.js";
import type { Ledger, LocalRow } from "../ledger.js";
import { hash } from "../policy.js";
import { validate } from "../transport.js";
import type { Manifest } from "./manifest.js";
import { checkManifest, differences, inventoryFor, scan } from "./manifest.js";
import type { SafeRoot } from "./paths.js";
import type { Staging } from "./staging.js";

export interface LocalBindingImport {
  requestId: string;
  rootBindingId: string;
  bindingVersion: number;
  revision: string;
  expectedManifestHash: string;
  expectedRootIdentity: string;
  approvalDigest: string;
}
export interface LocalBindingImportReceipt {
  requestId: string;
  importId: string;
  rootBindingId: string;
  bindingVersion: number;
  revision: string;
  manifestHash: string;
  manifest: Manifest;
  rootIdentity: string;
  importedAt: number;
}

function scopeKey(request: LocalPrepare | LocalApply | LocalObserve | LocalReceiptAck): string {
  const { expiresAt: _expiry, leaseVersion: _version, ...lease } = request.lease;
  return canonicalJson({
    operationId: request.operationId,
    operationDigest: request.operationDigest,
    workspaceId: request.workspaceId,
    bindingVersion: request.bindingVersion,
    rootBindingId: request.rootBindingId,
    executorId: request.executorId,
    executorGeneration: request.executorGeneration,
    credential: request.credential,
    baseRevision: request.baseRevision,
    lease,
    deadline: request.deadline,
    commitId: request.kind === "receipt" ? request.receipt.commitId : request.commitId,
  });
}
export class LocalWorkspace {
  root: SafeRoot;
  binding: Binding;
  profile: Profile;
  ledger: Ledger;
  staging: Staging;
  limits: Limits;
  private queue: Promise<void> = Promise.resolve();
  constructor(
    root: SafeRoot,
    binding: Binding,
    profile: Profile,
    ledger: Ledger,
    staging: Staging,
  ) {
    this.root = root;
    this.binding = binding;
    this.profile = profile;
    this.ledger = ledger;
    this.staging = staging;
    this.limits = staging.limits;
    const saved = ledger.db
      .prepare("SELECT value FROM meta WHERE key=?")
      .get(`binding_${binding.rootBindingId}`) as { value: string } | undefined;
    if (saved) {
      const value = JSON.parse(saved.value) as {
        bindingVersion: number;
        revision: string;
        manifestHash: string;
      };
      if (value.bindingVersion === binding.bindingVersion) {
        binding.revision = value.revision;
        binding.manifestHash = value.manifestHash;
      }
    }
    const known = this.ledger.record<{ manifest: Manifest }>(
      "revisions",
      this.revisionKey(this.binding.revision),
    );
    if (known) this.root.rememberModes(known.manifest);
  }
  async serialized<T>(fn: () => Promise<T>): Promise<T> {
    const before = this.queue;
    let release: () => void = () => {};
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await before;
    try {
      return await fn();
    } finally {
      release();
    }
  }
  revisionKey(revision: string): string {
    return `${this.binding.rootBindingId}:${this.binding.bindingVersion}:${revision}`;
  }
  importProposal(requestId: string): LocalBindingImport {
    const body = {
      requestId,
      rootBindingId: this.binding.rootBindingId,
      bindingVersion: this.binding.bindingVersion,
      revision: this.binding.revision,
      expectedManifestHash: this.binding.manifestHash,
      expectedRootIdentity: hash(this.root.key),
    };
    return {
      ...body,
      approvalDigest: hash(
        `fortipi:local-binding-import:v1\n${canonicalJson({ body, context: { deploymentId: this.profile.deploymentId, executorId: this.profile.executorId, executorGeneration: this.profile.executorGeneration, workspaceId: this.binding.workspaceId, ledgerId: this.profile.ledgerId } })}`,
      ),
    };
  }
  async importBinding(input: LocalBindingImport): Promise<LocalBindingImportReceipt> {
    return this.serialized(async () => {
      if (
        !/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId) ||
        canonicalJson(input) !== canonicalJson(this.importProposal(input.requestId))
      )
        throw new Error("local import exact approval/root/version/revision mismatch");
      await this.root.verify();
      const oldRoot = this.ledger.db
        .prepare("SELECT value FROM meta WHERE key=?")
        .get(`root_${input.rootBindingId}`) as { value: string } | undefined;
      if (
        !this.ledger.rootAvailable(this.root.key) ||
        (oldRoot && !this.ledger.rootAvailable(oldRoot.value))
      )
        throw new Error("local import cannot clear active or quarantined root pins");
      const bodyDigest = hash(canonicalJson(input)),
        key = `import_${input.requestId}`;
      const old = this.ledger.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as
        | { value: string }
        | undefined;
      const actual = await this.current(input.expectedManifestHash);
      if (old) {
        const previous = JSON.parse(old.value) as {
          bodyDigest: string;
          receipt: LocalBindingImportReceipt;
        };
        if (previous.bodyDigest !== bodyDigest) throw new Error("local import request conflict");
        return previous.receipt;
      }
      validate("workspaces.schema.json", "ManifestResponse", {
        workspaceId: this.binding.workspaceId,
        revision: input.revision,
        manifestHash: actual.manifestHash,
        manifest: actual.manifest,
      });
      const receipt: LocalBindingImportReceipt = {
        requestId: input.requestId,
        importId: randomUUID(),
        rootBindingId: input.rootBindingId,
        bindingVersion: input.bindingVersion,
        revision: input.revision,
        manifestHash: actual.manifestHash,
        manifest: actual.manifest,
        rootIdentity: input.expectedRootIdentity,
        importedAt: Date.now(),
      };
      this.ledger.transaction(() => {
        this.ledger.capacity(Buffer.byteLength(canonicalJson(receipt)) * 2, true);
        this.ledger.saveRecord("revisions", this.revisionKey(input.revision), actual);
        this.ledger.db
          .prepare("INSERT INTO meta VALUES (?,?)")
          .run(key, canonicalJson({ bodyDigest, receipt }));
        this.ledger.db
          .prepare(
            "INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          )
          .run(`root_${input.rootBindingId}`, this.root.key);
        this.ledger.db
          .prepare(
            "INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          )
          .run(
            `binding_${input.rootBindingId}`,
            canonicalJson({
              bindingVersion: input.bindingVersion,
              revision: input.revision,
              manifestHash: input.expectedManifestHash,
            }),
          );
      });
      return receipt;
    });
  }
  authorize(request: LocalWorkspaceRequest): void {
    if (
      this.binding.providerKind !== "local" ||
      request.executorId !== this.profile.executorId ||
      request.executorGeneration !== this.profile.executorGeneration ||
      request.workspaceId !== this.binding.workspaceId ||
      request.rootBindingId !== this.binding.rootBindingId ||
      request.bindingVersion !== this.binding.bindingVersion ||
      !this.profile.resources.workspaceIds.includes(request.workspaceId)
    )
      throw new Error("local workspace authority mismatch");
    if (["prepare", "apply", "observe", "receipt"].includes(request.kind))
      validateLocalLease(
        request as LocalPrepare,
        request.kind as "prepare" | "apply" | "observe" | "receipt",
        Date.now(),
      );
    else if (Date.now() >= request.deadline) throw new Error("local request deadline");
    if (request.kind === "prepare" || request.kind === "apply") {
      const key = `fence_${request.rootBindingId}_${request.bindingVersion}`,
        old = this.ledger.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as
          | { value: string }
          | undefined;
      if (old && BigInt(request.lease.fence) < BigInt(old.value))
        throw new Error("workspace.conflict: stale_fence");
      if (!old || BigInt(request.lease.fence) > BigInt(old.value))
        this.ledger.db
          .prepare(
            "INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          )
          .run(key, request.lease.fence);
    }
  }
  async request(request: LocalWorkspaceRequest): Promise<LocalWorkspaceResponse> {
    if (Buffer.byteLength(canonicalJson(request)) > this.staging.http.jsonBytes)
      throw new Error("payload_too_large: local request");
    validate("workspaces.schema.json", "LocalWorkspaceRequest", request);
    return this.serialized(async () => {
      this.authorize(request);
      await this.root.verify();
      if (request.kind === "prepare") return this.prepare(request);
      if (request.kind === "apply") return this.apply(request);
      if (request.kind === "observe") return this.observe(request);
      if (request.kind === "receipt") return this.receipt(request);
      return this.read(request);
    });
  }
  private async current(expected: string): Promise<{ manifest: Manifest; manifestHash: string }> {
    const current = await scan(this.root, this.limits);
    if (current.manifestHash !== expected) throw new Error("workspace.conflict: local_drift");
    return current;
  }
  private correlated(request: LocalApply | LocalObserve | LocalReceiptAck): LocalRow {
    const row = this.ledger.local(request.operationId);
    if (
      !row ||
      scopeKey(row.request) !== scopeKey(request) ||
      (request.preparationId !== undefined && row.prepared.preparationId !== request.preparationId)
    )
      throw new Error("unknown local operation or scope conflict");
    return row;
  }
  private renewPreparation(row: LocalRow, request: LocalPrepare | LocalApply): void {
    const old = row.request.lease,
      next = request.lease;
    if (next.leaseVersion < old.leaseVersion) return;
    if (next.leaseVersion === old.leaseVersion) {
      if (next.expiresAt !== old.expiresAt)
        throw new Error("workspace.conflict: lease observation conflict");
      return;
    }
    if (
      row.closed ||
      Date.now() >= row.prepared.expiresAt ||
      next.expiresAt <= old.expiresAt ||
      next.expiresAt > row.request.deadline
    )
      throw new Error("workspace.conflict: expired_lease");
    row.request.lease = next;
    row.prepared.expiresAt = Math.min(next.expiresAt, row.request.deadline);
    this.ledger.saveLocal(row);
  }
  async prepare(request: LocalPrepare): Promise<LocalPrepared> {
    const old = this.ledger.local(request.operationId);
    if (old) {
      if (old.closed) throw new Error("workspace.conflict: expired_lease");
      if (
        scopeKey(old.request) !== scopeKey(request) ||
        canonicalJson(old.request.mode) !== canonicalJson(request.mode) ||
        old.request.expectedManifestHash !== request.expectedManifestHash
      )
        throw new Error("local operation conflict");
      this.renewPreparation(old, request);
      return old.prepared;
    }
    if (
      request.baseRevision !== this.binding.revision ||
      request.expectedManifestHash !== this.binding.manifestHash
    )
      throw new Error("workspace.conflict: stale base");
    if (!this.ledger.record("revisions", this.revisionKey(request.baseRevision)))
      throw new Error("workspace.conflict: revision_unavailable; explicit local import required");
    this.ledger.transaction(() => {
      this.ledger.capacity(this.limits.snapshotBytes, true);
      this.ledger.pin(this.root.key, request.operationId);
    });
    try {
      const before = await this.current(request.expectedManifestHash);
      this.ledger.saveRecord("revisions", this.revisionKey(request.baseRevision), before);
      if (request.mode.kind === "staged-change") {
        const stage = await this.staging.forRequest(request);
        checkManifest(stage.manifest, this.limits, this.root.identity.caseBehavior);
        if ((await manifestDigest(stage.manifest)) !== request.mode.postManifestHash)
          throw new Error("staged manifest mismatch");
        // An explicit complete mutation set must produce precisely the proposed manifest.
        const entries = new Map(before.manifest.entries.map((e) => [e.path, e]));
        for (const m of stage.mutations) {
          const path = m.kind === "put" ? m.entry.path : m.path,
            parents = path.split("/");
          parents.pop();
          while (parents.length) {
            if (entries.get(parents.join("/"))?.type !== "directory")
              throw new Error("mutation parent directory missing");
            parents.pop();
          }
          if (m.kind === "delete") {
            if (entries.get(m.path)?.type === "directory")
              await this.root.deletionPaths(m.path, this.limits.manifestEntries);
            for (const key of entries.keys())
              if (key === m.path || key.startsWith(`${m.path}/`)) entries.delete(key);
          } else if (m.kind === "mkdir") {
            if (entries.get(m.path)?.type === "file")
              throw new Error("mkdir requires explicit deletion of existing file");
            entries.set(m.path, { path: m.path, type: "directory", mode: 493 });
          } else {
            if (entries.get(m.entry.path)?.type === "directory")
              await this.root.deletionPaths(m.entry.path, this.limits.manifestEntries);
            for (const key of entries.keys())
              if (key.startsWith(`${m.entry.path}/`)) entries.delete(key);
            entries.set(m.entry.path, m.entry);
          }
        }
        if (
          (await manifestDigest({ version: 1, entries: [...entries.values()] })) !==
          request.mode.postManifestHash
        )
          throw new Error("mutation set does not describe post-manifest");
      }
      const prepared: LocalPrepared = {
        preparationId: randomUUID(),
        operationId: request.operationId,
        operationDigest: request.operationDigest,
        preManifestHash: before.manifestHash,
        expiresAt: Math.min(request.lease.expiresAt, request.deadline),
        state: "prepared",
        ...(request.mode.kind === "staged-change"
          ? { stagedDigest: request.mode.stagedDigest }
          : {}),
      };
      const observation: LocalObservation = {
        operationId: request.operationId,
        operationDigest: request.operationDigest,
        preparationId: prepared.preparationId,
        commitId: request.commitId,
        observationSeq: 0,
        preManifestHash: before.manifestHash,
        state: "prepared",
        ...(request.mode.kind === "native-execution"
          ? { executionId: request.mode.executionId }
          : {}),
      };
      this.ledger.saveLocal({ request, prepared, observation, journal: [] });
      return prepared;
    } catch (error) {
      this.ledger.release(this.root.key, request.operationId);
      throw error;
    }
  }
  async apply(request: LocalApply): Promise<LocalObservation> {
    const row = this.correlated(request);
    this.renewPreparation(row, request);
    if (row.closed || Date.now() >= row.prepared.expiresAt)
      throw new Error("workspace.conflict: expired_lease");
    // Repeat apply is observational, including prepared native execution. Only job.assign may spawn.
    if (row.observation.state !== "prepared" || row.request.mode.kind === "native-execution")
      return row.observation;
    await this.current(row.observation.preManifestHash);
    this.authorize(request); // Recheck after async reads and before durable claim.
    if (!this.ledger.rootAvailable(this.root.key, request.operationId))
      throw new Error("root quarantined");
    row.observation = { ...row.observation, state: "applying", observationSeq: 1 };
    this.ledger.transaction(() => this.ledger.saveLocal(row));
    try {
      const stage = this.staging.get(row.request);
      const effect = async (path: string, fn: () => Promise<void>) => {
        this.authorize(request);
        row.journal.push({ path, state: "intent" });
        this.ledger.saveLocal(row);
        await fn();
        const journal = row.journal.at(-1);
        if (journal) journal.state = "done";
        this.ledger.saveLocal(row);
      };
      const remove = async (path: string) => {
        for (const target of await this.root.deletionPaths(path, this.limits.manifestEntries))
          await effect(target, () => this.root.delete(target));
      };
      for (const mutation of stage.mutations) {
        this.authorize(request);
        const path = mutation.kind === "put" ? mutation.entry.path : mutation.path;
        if (mutation.kind === "put") {
          let directory = false;
          try {
            directory = (await this.root.stat(path)).isDirectory();
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          if (directory) await remove(path);
          const bytes = await this.staging.bytes(mutation.blob);
          await effect(path, () => this.root.write(path, bytes, mutation.entry.mode));
        } else if (mutation.kind === "mkdir") await effect(path, () => this.root.mkdir(path));
        else await remove(path);
      }
      const after = await scan(this.root, this.limits);
      if (
        row.request.mode.kind !== "staged-change" ||
        after.manifestHash !== row.request.mode.postManifestHash
      )
        throw new Error("post-apply drift");
      row.manifest = after.manifest;
      row.observation = {
        ...row.observation,
        state: "applied",
        postManifestHash: after.manifestHash,
        appliedAt: Date.now(),
        observationSeq: 2,
      };
      this.ledger.saveLocal(row);
      return row.observation;
    } catch {
      row.observation = {
        ...row.observation,
        state: "partial",
        reason: "apply interrupted or post-state differs",
        observationSeq: 2,
      };
      this.ledger.transaction(() => {
        this.ledger.saveLocal(row);
        this.ledger.quarantine(this.root.key);
      });
      return row.observation;
    }
  }
  async observe(request: LocalObserve): Promise<LocalObservation> {
    const row = this.correlated(request);
    if (row.observation.state === "applied" || row.observation.state === "prepared") {
      try {
        await this.current(row.observation.postManifestHash ?? row.observation.preManifestHash);
      } catch {
        row.observation = {
          ...row.observation,
          state: "drift",
          reason: "local bytes changed",
          observationSeq: row.observation.observationSeq + 1,
        };
        this.ledger.saveLocal(row);
        this.ledger.quarantine(this.root.key);
      }
    }
    return row.observation;
  }
  async receipt(request: LocalReceiptAck): Promise<TransportAck> {
    const row = this.correlated(request),
      receipt = request.receipt,
      o = row.observation;
    if (o.receipt) {
      if (canonicalJson(o.receipt) !== canonicalJson(receipt) || receipt.providerKind !== "local")
        throw new Error("conflicting receipt");
      return { deliveryId: receipt.commitId, sequence: receipt.observationSeq, persisted: true };
    }
    if (
      receipt.providerKind !== "local" ||
      o.state !== "applied" ||
      !row.manifest ||
      receipt.preparationId !== o.preparationId ||
      receipt.observationSeq !== o.observationSeq ||
      receipt.workspaceId !== request.workspaceId ||
      receipt.operationId !== request.operationId ||
      receipt.baseRevision !== request.baseRevision ||
      receipt.manifestHash !== o.postManifestHash ||
      receipt.jobId !==
        (row.request.lease.ownerKind === "job" ? row.request.lease.jobId : undefined)
    )
      throw new Error("receipt observation mismatch");
    const digest = await commitDigest({
      workspaceId: request.workspaceId,
      commitId: receipt.commitId,
      operationId: request.operationId,
      baseRevision: request.baseRevision,
      manifestHash: receipt.manifestHash,
      leaseIdentity: row.request.lease,
      storage: {
        kind: "local",
        preparationId: o.preparationId,
        observationSeq: o.observationSeq,
        preManifestHash: o.preManifestHash,
        postManifestHash: receipt.manifestHash,
      },
      ...(receipt.jobId ? { jobId: receipt.jobId } : {}),
      ...(row.request.mode.kind === "staged-change" ? { uploadId: row.request.mode.uploadId } : {}),
    });
    if (digest !== receipt.commitDigest) throw new Error("receipt commit digest mismatch");
    await this.current(receipt.manifestHash);
    this.ledger.transaction(() => {
      row.observation = { ...row.observation, receipt };
      this.ledger.saveLocal(row);
      this.ledger.saveRecord("revisions", this.revisionKey(receipt.revision), {
        manifest: row.manifest,
        manifestHash: receipt.manifestHash,
      });
      this.ledger.db
        .prepare(
          "INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(
          `binding_${this.binding.rootBindingId}`,
          canonicalJson({
            bindingVersion: this.binding.bindingVersion,
            revision: receipt.revision,
            manifestHash: receipt.manifestHash,
          }),
        );
      this.ledger.release(this.root.key, request.operationId);
    });
    this.binding.revision = receipt.revision;
    this.binding.manifestHash = receipt.manifestHash;
    return { deliveryId: receipt.commitId, sequence: receipt.observationSeq, persisted: true };
  }
  async nativeIntent(assignment: Assignment): Promise<void> {
    const row = this.ledger.local(assignment.identity.lease.operationId);
    if (
      row?.request.mode.kind !== "native-execution" ||
      row.closed ||
      row.request.mode.jobId !== assignment.identity.jobId ||
      row.request.mode.executionId !== assignment.identity.executionId ||
      row.request.mode.assignmentDigest !== assignment.identity.assignmentDigest ||
      row.request.operationDigest !== assignment.identity.operationDigest ||
      row.observation.state !== "prepared"
    )
      throw new Error("native execution preparation required");
    this.authorize(row.request);
    await this.current(row.request.expectedManifestHash);
    row.observation = { ...row.observation, state: "applying", observationSeq: 1 };
    this.ledger.saveLocal(row);
  }
  async nativeFinished(assignment: Assignment, certain: boolean): Promise<LocalObservation> {
    return this.serialized(async () => {
      const row = this.ledger.local(assignment.identity.lease.operationId);
      if (!row) throw new Error("native local journal lost");
      if (certain) {
        try {
          const after = await scan(this.root, this.limits);
          row.manifest = after.manifest;
          row.observation = {
            ...row.observation,
            state: "applied",
            postManifestHash: after.manifestHash,
            appliedAt: Date.now(),
            observationSeq: 2,
          };
        } catch {
          certain = false;
        }
      }
      if (!certain) {
        row.observation = {
          ...row.observation,
          state: "unknown",
          reason: "uncertain native exit or post-state",
          observationSeq: 2,
        };
        this.ledger.quarantine(this.root.key);
      }
      this.ledger.saveLocal(row);
      return row.observation;
    });
  }
  async read(request: LocalReadRequest): Promise<LocalReadResult> {
    if (!this.ledger.rootAvailable(this.root.key))
      throw new Error("workspace.conflict: root busy or quarantined");
    const known = this.ledger.record<{ manifest: Manifest; manifestHash: string }>(
      "revisions",
      this.revisionKey(request.revision),
    );
    const expected = known?.manifestHash;
    if (!expected) throw new Error("workspace.conflict: revision_unavailable");
    const current = await this.current(expected);
    const revision = request.revision;
    let result: LocalReadResult;
    let producerDoneKey: string | undefined;
    if (request.kind === "snapshot")
      result = {
        kind: "snapshot",
        result: {
          workspaceId: request.workspaceId,
          revision,
          manifest: current.manifest,
          manifestHash: current.manifestHash,
        },
      };
    else if (request.kind === "list") {
      const prefix = request.path ? `${request.path}/` : "";
      const items = current.manifest.entries.filter(
        (e) => e.path.startsWith(prefix) && !e.path.slice(prefix.length).includes("/"),
      );
      if (items.length > 100) throw new Error("list result exceeds public page bound");
      result = { kind: "list", result: { revision, items } };
    } else if (request.kind === "stat") {
      const entry = current.manifest.entries.find((e) => e.path === request.path);
      if (!entry) throw new Error("not_found");
      result = { kind: "stat", result: { revision, entry } };
    } else if (request.kind === "diff") {
      const other = this.ledger.record<{ manifest: Manifest; manifestHash: string }>(
        "revisions",
        this.revisionKey(request.otherRevision),
      );
      if (!other) throw new Error("workspace.conflict: revision_unavailable");
      const items = differences(current.manifest, other.manifest);
      if (items.length > 100) throw new Error("diff exceeds public page bound");
      result = { kind: "diff", result: { revision, otherRevision: request.otherRevision, items } };
    } else {
      const entry = current.manifest.entries.find((e) => e.path === request.path);
      if (entry?.type !== "file") throw new Error("not_found");
      const { transfers: _transfers, ...scope } = request,
        scopeHash = hash(canonicalJson(scope)),
        key = `read_${this.binding.rootBindingId}_${this.binding.bindingVersion}_${request.operationId}`;
      const old = this.ledger.record<{
        scopeHash: string;
        reference: Extract<LocalReadResult, { kind: "read" }>["result"];
      }>("stages", key);
      if (old && old.scopeHash !== scopeHash) throw new Error("read operation body conflict");
      if (request.transfers !== undefined && !old)
        throw new Error("local read metadata phase required before transfer");
      const bytes = await this.root.read(entry.path, this.limits.fileBytes);
      if (bytes.length !== entry.size || hash(bytes) !== entry.sha256)
        throw new Error("workspace.conflict: local_drift");
      const grid = old?.reference.chunks?.chunkBytes ?? this.staging.http.chunkBytes;
      if (grid > this.staging.http.chunkBytes)
        throw new Error("negotiated chunk grid no longer eligible");
      const chunks = inventoryFor(bytes, grid),
        reference: Extract<LocalReadResult, { kind: "read" }>["result"] = {
          workspaceId: request.workspaceId,
          revision,
          sha256: entry.sha256,
          size: entry.size,
          chunks,
          endpoint: `/v1/workspaces/${request.workspaceId}/read?revision=${encodeURIComponent(revision)}&path=${encodeURIComponent(entry.path)}`,
          owner: { kind: "local", executorId: this.profile.executorId },
        };
      if (old && canonicalJson(old.reference) !== canonicalJson(reference))
        throw new Error("workspace.conflict: local_drift");
      if (!old) {
        this.ledger.capacity(Buffer.byteLength(canonicalJson(reference)) * 2, true);
        this.ledger.saveRecord("stages", key, { scopeHash, reference });
      }
      result = { kind: "read", result: reference };
      if (request.transfers !== undefined) {
        if (request.transfers.length !== 1)
          throw new Error("exactly one scoped read transfer required");
        const descriptor = request.transfers?.find(
          (d) =>
            d.purpose === "local-read" &&
            d.operationId === request.operationId &&
            d.baseRevision === revision &&
            d.content.kind === "workspace-file" &&
            d.content.path === request.path &&
            d.content.manifestHash === expected &&
            d.workspaceId === request.workspaceId &&
            d.bindingVersion === request.bindingVersion &&
            canonicalJson(d.credential) === canonicalJson(request.credential) &&
            d.chunkBytes === chunks.chunkBytes &&
            canonicalJson(d.chunkHashes) === canonicalJson(chunks.chunkHashes) &&
            d.fileSha256 === entry.sha256 &&
            d.size === entry.size,
        );
        if (!descriptor) throw new Error("authorized read transfer required");
        this.staging.check(descriptor);
        const producerKey = `producer_${descriptor.transferId}_${descriptor.attemptId}`,
          prior = this.ledger.db.prepare("SELECT value FROM meta WHERE key=?").get(producerKey) as
            | { value: string }
            | undefined;
        if (prior) {
          const p = JSON.parse(prior.value) as { scopeHash: string; state: string };
          if (p.scopeHash !== scopeHash) throw new Error("read producer body conflict");
          if (p.state !== "done")
            throw new Error("uncertain read producer requires a newly authorized attempt");
        } else {
          this.ledger.transaction(() => {
            this.ledger.capacity(4096, true);
            this.ledger.db
              .prepare("INSERT INTO meta VALUES (?,?)")
              .run(producerKey, canonicalJson({ scopeHash, state: "intent" }));
          });
          for (let i = 0; i < descriptor.chunkHashes.length; i++) {
            this.staging.check(descriptor);
            await this.staging.http.chunk(
              descriptor,
              i,
              bytes.subarray(i * descriptor.chunkBytes, (i + 1) * descriptor.chunkBytes),
            );
          }
          producerDoneKey = producerKey;
        }
      }
    }
    await this.current(expected);
    if (producerDoneKey) {
      const prior = this.ledger.db
        .prepare("SELECT value FROM meta WHERE key=?")
        .get(producerDoneKey) as { value: string };
      const value = JSON.parse(prior.value) as { scopeHash: string };
      this.ledger.db
        .prepare("UPDATE meta SET value=? WHERE key=?")
        .run(canonicalJson({ scopeHash: value.scopeHash, state: "done" }), producerDoneKey);
    }
    return result;
  }
  async expirePrepared(): Promise<void> {
    await this.serialized(async () => {
      const rows = this.ledger.db
        .prepare(
          "SELECT data FROM local_ops WHERE json_extract(data,'$.request.rootBindingId')=? AND json_extract(data,'$.observation.state')='prepared' AND COALESCE(json_extract(data,'$.closed'),0)=0 LIMIT 100",
        )
        .all(this.binding.rootBindingId) as { data: string }[];
      for (const value of rows) {
        const row = JSON.parse(value.data) as LocalRow;
        if (
          Date.now() < row.prepared.expiresAt ||
          !this.ledger.rootAvailable(this.root.key, row.request.operationId)
        )
          continue;
        const job =
          row.request.mode.kind === "native-execution"
            ? this.ledger.get(row.request.mode.jobId)
            : undefined;
        if (job && job.state !== "pending" && job.state !== "closed") continue;
        this.ledger.transaction(() => {
          row.closed = true;
          row.observation = {
            ...row.observation,
            reason: "preparation expired before effects; apply permanently closed",
          };
          this.ledger.saveLocal(row);
          if (job?.state === "pending") {
            job.state = "closed";
            job.decision = "deny";
            job.reason = "local preparation expired before spawn";
            this.ledger.put(job);
          }
          this.ledger.release(this.root.key, row.request.operationId);
        });
      }
    });
  }
}
