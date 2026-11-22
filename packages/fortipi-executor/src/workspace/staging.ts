import { join } from "node:path";
import type { LocalPrepare, PreparedResult, TransferDescriptor } from "fortipi-contract/executor";
import {
  canonicalJson,
  localStageDigest,
  manifestDigest,
  validateLocalStage,
  validateRelativePath,
  validateTransfer,
  workspaceLeaseDigest,
} from "fortipi-contract/executor";
import type { Limits, Profile } from "../config.js";
import { privateBytes, privateWrite, secureDirectory } from "../config.js";
import type { Ledger } from "../ledger.js";
import { hash, immutableIdentity } from "../policy.js";
import type { HttpTransport } from "../transport.js";
import { validate } from "../transport.js";
import type { Manifest, Mutation } from "./manifest.js";
import { checkManifest } from "./manifest.js";

export interface Stage {
  uploadId: string;
  operationId: string;
  operationDigest: string;
  workspaceId: string;
  bindingVersion: number;
  baseRevision: string;
  manifest: Manifest;
  mutations: Mutation[];
  stagedDigest: string;
}
function fileProof(d: Extract<TransferDescriptor, { purpose: "local-stage" }>) {
  const { expiresAt: _expiry, leaseVersion: _version, ...leaseIdentity } = d.lease;
  return {
    workspaceId: d.workspaceId,
    bindingVersion: d.bindingVersion,
    operationId: d.operationId,
    operationDigest: d.operationDigest,
    baseRevision: d.baseRevision,
    uploadId: d.content.uploadId,
    manifestHash: d.content.manifestHash,
    sha256: d.fileSha256,
    size: d.size,
    credential: d.credential,
    leaseIdentity,
    chunks: { chunkBytes: d.chunkBytes, chunkHashes: d.chunkHashes },
  };
}
export class Staging {
  directory: string;
  ledger: Ledger;
  http: HttpTransport;
  profile: Profile;
  limits: Limits;
  constructor(directory: string, ledger: Ledger, http: HttpTransport) {
    this.directory = directory;
    this.ledger = ledger;
    this.http = http;
    this.profile = http.profile;
    this.limits = http.limits;
  }
  async initialize(): Promise<void> {
    await secureDirectory(this.directory);
  }
  check(descriptor: TransferDescriptor): void {
    validate("transfers.schema.json", "TransferDescriptor", descriptor);
    validateTransfer(descriptor, Date.now());
    const p = this.profile;
    if (
      descriptor.deploymentId !== p.deploymentId ||
      descriptor.executorId !== p.executorId ||
      descriptor.executorGeneration !== p.executorGeneration ||
      !p.resources.workspaceIds.includes(descriptor.workspaceId) ||
      descriptor.size >
        (descriptor.purpose === "output"
          ? Math.min(this.limits.artifactBytes, this.http.limits.artifactBytes)
          : this.limits.fileBytes) ||
      descriptor.chunkBytes > this.http.chunkBytes
    )
      throw new Error("transfer not authorized for this executor");
    for (const key of Object.keys(p.resources) as (keyof Profile["resources"])[])
      if (!descriptor.consumer[key].every((id) => p.resources[key].includes(id)))
        throw new Error("transfer consumer broadens local authority");
    const binding = p.bindings.find(
      (b) =>
        b.workspaceId === descriptor.workspaceId && b.bindingVersion === descriptor.bindingVersion,
    );
    if (
      !binding ||
      (descriptor.purpose === "local-read" && binding.revision !== descriptor.baseRevision)
    )
      throw new Error("transfer binding mismatch");
    if (descriptor.lease) {
      const floor = this.ledger.db
        .prepare("SELECT value FROM meta WHERE key=?")
        .get(`fence_${binding.rootBindingId}_${binding.bindingVersion}`) as
        | { value: string }
        | undefined;
      if (floor && BigInt(descriptor.lease.fence) < BigInt(floor.value))
        throw new Error("transfer stale_fence");
    }
    if (descriptor.jobId) {
      const job = this.ledger.get(descriptor.jobId);
      if (
        (!job && descriptor.purpose === "output") ||
        (job &&
          (job.assignment.identity.executionId !== descriptor.executionId ||
            job.assignment.identity.operationDigest !== descriptor.operationDigest ||
            (descriptor.purpose !== "output" &&
              canonicalJson(job.assignment.identity.lease.credential) !==
                canonicalJson(descriptor.credential)) ||
            job.assignment.identity.baseRevision !== descriptor.baseRevision ||
            (descriptor.lease &&
              job.assignment.identity.lease.leaseId !== descriptor.lease.leaseId)))
      )
        throw new Error("transfer execution mismatch");
    }
    const local = this.ledger.local(descriptor.operationId);
    if (
      local &&
      (local.request.operationDigest !== descriptor.operationDigest ||
        local.request.workspaceId !== descriptor.workspaceId ||
        local.request.bindingVersion !== descriptor.bindingVersion ||
        (descriptor.purpose !== "output" &&
          canonicalJson(local.request.credential) !== canonicalJson(descriptor.credential)) ||
        (descriptor.lease && descriptor.lease.leaseId !== local.request.lease.leaseId))
    )
      throw new Error("transfer local operation mismatch");
    if (descriptor.purpose === "output") this.outputReference(descriptor);
  }
  outputReference(
    descriptor: Extract<TransferDescriptor, { purpose: "output" }>,
  ): PreparedResult["output"]["artifacts"][number] {
    this.http.assertExecutorAuthority();
    const job = this.ledger.get(descriptor.jobId),
      assignment = job?.assignment,
      identity = assignment?.identity,
      binding = this.profile.bindings.find(
        (b) =>
          b.workspaceId === descriptor.workspaceId &&
          b.bindingVersion === descriptor.bindingVersion &&
          (assignment?.rootBindingId === undefined || b.rootBindingId === assignment.rootBindingId),
      );
    if (
      !assignment ||
      !identity ||
      !job?.result ||
      !binding ||
      descriptor.lease !== undefined ||
      assignment.workspaceId !== descriptor.workspaceId ||
      assignment.bindingVersion !== descriptor.bindingVersion ||
      assignment.operationContext.deploymentId !== descriptor.deploymentId ||
      identity.jobId !== descriptor.jobId ||
      identity.executionId !== descriptor.executionId ||
      identity.operationDigest !== descriptor.operationDigest ||
      identity.lease.operationId !== descriptor.operationId ||
      identity.baseRevision !== descriptor.baseRevision ||
      identity.target.kind !== "executor" ||
      identity.target.executorId !== descriptor.executorId ||
      identity.target.generation !== descriptor.executorGeneration ||
      immutableIdentity(job.result.identity) !== immutableIdentity(identity) ||
      !descriptor.consumer.actions.includes("artifacts.read") ||
      !descriptor.consumer.workspaceIds.includes(descriptor.workspaceId) ||
      !descriptor.consumer.executorIds.includes(descriptor.executorId) ||
      !descriptor.consumer.agentIds.includes(assignment.operationContext.agentId) ||
      !descriptor.consumer.conversationIds.includes(assignment.operationContext.conversationId) ||
      descriptor.chunkBytes >
        Math.min(this.http.chunkBytes, this.http.limits.chunkBytes, this.limits.chunkBytes)
    )
      throw new Error("native artifact execution/member scope mismatch");
    const matches = job.result.output.artifacts.filter(
      (a) => a.artifactId === descriptor.content.artifactId,
    );
    const reference = matches[0];
    if (!reference || matches.length !== 1) throw new Error("native artifact member unavailable");
    validate("common.schema.json", "ByteReference", reference);
    if (
      reference.workspaceId !== descriptor.workspaceId ||
      reference.revision !== descriptor.baseRevision ||
      reference.owner.kind !== "local" ||
      reference.owner.executorId !== descriptor.executorId ||
      reference.outputSource?.stream !== descriptor.content.stream ||
      reference.sha256 !== descriptor.fileSha256 ||
      reference.size !== descriptor.size ||
      !reference.chunks ||
      reference.chunks.chunkBytes !== descriptor.chunkBytes ||
      canonicalJson(reference.chunks.chunkHashes) !== canonicalJson(descriptor.chunkHashes)
    )
      throw new Error("native artifact source/hash/grid mismatch");
    return reference;
  }
  async receive(descriptor: TransferDescriptor): Promise<void> {
    this.check(descriptor);
    if (descriptor.direction !== "to-executor" || descriptor.content.kind !== "workspace-file")
      throw new Error("invalid input transfer");
    if (
      descriptor.lease.ownerKind === "workspace-operation" &&
      descriptor.operationDigest !==
        (await workspaceLeaseDigest({
          deploymentId: this.profile.deploymentId,
          operationId: descriptor.operationId,
          workspaceId: descriptor.workspaceId,
          bindingVersion: descriptor.bindingVersion,
          baseRevision: descriptor.baseRevision,
          target: {
            kind: "executor",
            executorId: descriptor.executorId,
            generation: descriptor.executorGeneration,
          },
          credential: descriptor.credential,
          deadline: descriptor.deadline,
        }))
    )
      throw new Error("local stage operation digest mismatch");
    const proof = fileProof(descriptor);
    this.ledger.capacity(Buffer.byteLength(canonicalJson(proof)) * 2, true);
    this.ledger.saveRecord("stages", `input_plan_${proof.uploadId}_${proof.sha256}`, proof);
    this.ledger.transaction(() => {
      const key = `blob_reserved_${descriptor.fileSha256}`;
      const previous = this.ledger.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as
        | { value: string }
        | undefined;
      if (previous) {
        if (Number(previous.value) !== descriptor.size)
          throw new Error("reserved blob length conflict");
        return;
      }
      const total = this.ledger.db
        .prepare(
          "SELECT COALESCE(SUM(CAST(value AS INTEGER)),0) AS n FROM meta WHERE key LIKE 'blob_reserved_%'",
        )
        .get() as { n: number };
      if (total.n + descriptor.size > this.limits.snapshotBytes)
        throw new Error("local staging capacity exhausted");
      this.ledger.capacity(descriptor.size);
      this.ledger.db.prepare("INSERT INTO meta VALUES (?,?)").run(key, String(descriptor.size));
    });
    const pieces: Uint8Array[] = [];
    for (let index = 0; index < descriptor.chunkHashes.length; index++) {
      this.check(descriptor);
      const bytes = await this.http.chunk(descriptor, index);
      if (!bytes) throw new Error("missing chunk");
      pieces.push(bytes);
    }
    const data = Buffer.concat(pieces);
    if (data.length !== descriptor.size || hash(data) !== descriptor.fileSha256)
      throw new Error("transfer file integrity");
    const path = join(this.directory, descriptor.fileSha256);
    try {
      await privateWrite(path, data, undefined, true);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" ||
        hash(await privateBytes(path, undefined, this.limits.fileBytes)) !== descriptor.fileSha256
      )
        throw error;
    }
    this.ledger.saveRecord(
      "stages",
      `transfer_${descriptor.transferId}_${descriptor.attemptId}`,
      descriptor,
    );
    this.ledger.saveRecord("stages", `verified_blob_${proof.uploadId}_${proof.sha256}`, proof);
    this.ledger.saveRecord(
      "stages",
      `input_${descriptor.content.uploadId}_${hash(descriptor.content.path)}_${descriptor.fileSha256}`,
      { ...proof, path: descriptor.content.path },
    );
  }
  async register(stage: Omit<Stage, "stagedDigest">): Promise<Stage> {
    checkManifest(stage.manifest, this.limits, "sensitive");
    if (stage.mutations.length > this.limits.manifestEntries) throw new Error("mutation capacity");
    for (const mutation of stage.mutations) {
      const path = mutation.kind === "put" ? mutation.entry.path : mutation.path;
      validateRelativePath(path);
      if (mutation.kind === "put") {
        if (mutation.blob !== mutation.entry.sha256 || !/^[a-f0-9]{64}$/.test(mutation.blob))
          throw new Error("staged blob identity");
        const bytes = await this.bytes(mutation.blob);
        if (bytes.length !== mutation.entry.size || hash(bytes) !== mutation.blob)
          throw new Error("staged bytes missing or corrupt");
        const proof = this.ledger.record<{
          workspaceId: string;
          bindingVersion: number;
          operationId: string;
          operationDigest: string;
          baseRevision: string;
          uploadId: string;
          path: string;
          sha256: string;
          size: number;
        }>("stages", `input_${stage.uploadId}_${hash(path)}_${mutation.blob}`);
        if (
          !proof ||
          proof.workspaceId !== stage.workspaceId ||
          proof.bindingVersion !== stage.bindingVersion ||
          proof.operationId !== stage.operationId ||
          proof.operationDigest !== stage.operationDigest ||
          proof.baseRevision !== stage.baseRevision ||
          proof.uploadId !== stage.uploadId ||
          proof.path !== path ||
          proof.sha256 !== mutation.blob ||
          proof.size !== mutation.entry.size
        )
          throw new Error("staged file has no matching scoped transfer proof");
      }
    }
    const mutations = stage.mutations.map((m) =>
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
    const stagedDigest = await localStageDigest({
      uploadId: stage.uploadId,
      manifest: stage.manifest,
      mutations,
    });
    await validateLocalStage({
      kind: "staged-change",
      uploadId: stage.uploadId,
      manifest: stage.manifest,
      mutations,
      stagedDigest,
      postManifestHash: await manifestDigest(stage.manifest),
    });
    const result = { ...stage, stagedDigest };
    this.ledger.saveRecord("stages", stage.uploadId, result);
    return result;
  }
  async bytes(sha256: string): Promise<Buffer> {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("invalid staged hash");
    const path = join(this.directory, sha256);
    const value = await privateBytes(path, undefined, this.limits.fileBytes);
    if (value.length > this.limits.fileBytes || hash(value) !== sha256)
      throw new Error("staged integrity");
    return value;
  }
  get(request: LocalPrepare): Stage {
    if (request.mode.kind !== "staged-change") throw new Error("native mode has no stage");
    const stage = this.ledger.record<Stage>("stages", request.mode.uploadId);
    if (
      !stage ||
      stage.operationId !== request.operationId ||
      stage.operationDigest !== request.operationDigest ||
      stage.workspaceId !== request.workspaceId ||
      stage.bindingVersion !== request.bindingVersion ||
      stage.baseRevision !== request.baseRevision ||
      stage.stagedDigest !== request.mode.stagedDigest
    )
      throw new Error("stage scope mismatch");
    const { expiresAt: _expires, leaseVersion: _version, ...leaseIdentity } = request.lease;
    for (const mutation of stage.mutations)
      if (mutation.kind === "put") {
        const proof = this.ledger.record<{ leaseIdentity: unknown; credential: unknown }>(
          "stages",
          `input_${stage.uploadId}_${hash(mutation.entry.path)}_${mutation.blob}`,
        );
        if (
          !proof ||
          canonicalJson(proof.leaseIdentity) !== canonicalJson(leaseIdentity) ||
          canonicalJson(proof.credential) !== canonicalJson(request.credential)
        )
          throw new Error("staged transfer lease/credential mismatch");
      }
    return stage;
  }
  async forRequest(request: LocalPrepare): Promise<Stage> {
    if (request.mode.kind !== "staged-change") throw new Error("native mode has no stage");
    await validateLocalStage(request.mode);
    const { expiresAt: _expiry, leaseVersion: _version, ...leaseIdentity } = request.lease;
    for (const m of request.mode.mutations)
      if (m.kind === "put") {
        const proof = this.ledger.record<ReturnType<typeof fileProof>>(
          "stages",
          `verified_blob_${request.mode.uploadId}_${m.sha256}`,
        );
        if (
          !proof ||
          proof.workspaceId !== request.workspaceId ||
          proof.bindingVersion !== request.bindingVersion ||
          proof.operationId !== request.operationId ||
          proof.operationDigest !== request.operationDigest ||
          proof.baseRevision !== request.baseRevision ||
          proof.manifestHash !== request.mode.postManifestHash ||
          proof.size !== m.size ||
          canonicalJson(proof.credential) !== canonicalJson(request.credential) ||
          canonicalJson(proof.leaseIdentity) !== canonicalJson(leaseIdentity)
        )
          throw new Error("staged put lacks exact upload-scoped verified bytes");
        this.ledger.saveRecord(
          "stages",
          `input_${request.mode.uploadId}_${hash(m.path)}_${m.sha256}`,
          { ...proof, path: m.path },
        );
      }
    const mutations: Mutation[] = request.mode.mutations.map((m) =>
      m.kind === "put"
        ? {
            kind: "put",
            entry: { path: m.path, type: "file", mode: m.mode, size: m.size, sha256: m.sha256 },
            blob: m.sha256,
          }
        : m.kind === "mkdir"
          ? { kind: "mkdir", path: m.path }
          : m,
    );
    const stage = await this.register({
      uploadId: request.mode.uploadId,
      operationId: request.operationId,
      operationDigest: request.operationDigest,
      workspaceId: request.workspaceId,
      bindingVersion: request.bindingVersion,
      baseRevision: request.baseRevision,
      manifest: request.mode.manifest,
      mutations,
    });
    if (stage.stagedDigest !== request.mode.stagedDigest)
      throw new Error("staged metadata digest mismatch");
    return this.get(request);
  }
}
