import {
  canonicalJson,
  commitDigest,
  digestJson,
  localStageDigest,
  publicCommitReceipt,
  validateLocalStage,
} from "fortipi-contract";
import type * as D from "../boundary/dto.js";
import { authorize, permitsResource, same, transferConsumer, validateLease } from "./authority.js";
import { requireThat, unwrap, WorkspaceError } from "./errors.js";
import { applyMutations, checkedManifest, manifestDigest } from "./manifest.js";
import type { WorkspaceObject } from "./workspace-object.js";

interface LocalUpload {
  request: D.UploadBegin;
  owner: D.CredentialRef;
  status: D.UploadStatus;
  binding: D.WorkspaceBinding;
  scope: D.LocalScope;
  transfers: Record<string, D.TransferDescriptor>;
  preparation?: D.LocalPrepared;
  intent?: D.LocalCommitIntent;
  stageId?: string;
  applyAttempted: boolean;
  observation?: D.LocalObservation;
}
const ref = (ctx: D.AuthContext): D.CredentialRef => ({
  credentialId: ctx.credentialId,
  generation: ctx.generation,
  grantVersion: ctx.grantVersion,
});
const sorted = (manifest: D.Manifest) => ({
  version: 1,
  entries: [...manifest.entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
});
/** Local staging metadata and apply intent only. This class never constructs Computer or persists bytes. */
export class LocalUploads {
  readonly owner: WorkspaceObject;
  private readonly pendingTransfers = new Map<string, Promise<D.TransferDescriptor>>();
  constructor(owner: WorkspaceObject) {
    this.owner = owner;
  }
  has(uploadId: string): boolean {
    return this.owner.state.get(`local-upload:${uploadId}`) !== undefined;
  }
  get(ctx: D.AuthContext, workspaceId: string, uploadId: string, writable = true): LocalUpload {
    authorize(this.owner.state, ctx, workspaceId, "workspace.write");
    const row = this.owner.state.get<LocalUpload>(`local-upload:${uploadId}`);
    requireThat(
      row && same(row.owner, ref(ctx)) && row.scope.workspaceId === workspaceId,
      "not_found",
      "Local upload unavailable",
    );
    if (writable) {
      validateLease(this.owner.state, this.owner.current(), row.scope.lease, ctx);
      requireThat(
        row.status.expiresAt > Date.now() &&
          (row.status.state === "open" || row.status.state === "validated"),
        "conflict",
        "Local upload expired or closed",
      );
    }
    return row;
  }
  async begin(
    ctx: D.AuthContext,
    input: D.OperationRequest<"beginUpload">,
  ): Promise<D.OperationResponse<"beginUpload">> {
    const authority = this.owner.current();
    requireThat(
      authority.binding.config.kind === "local",
      "invalid_request",
      "Local binding required",
    );
    const config = authority.binding.config;
    const manifest = checkedManifest(input.body.manifest, this.owner.policy);
    const hash = await manifestDigest(manifest);
    const requestDigest = await digestJson("operation", {
      kind: "local-upload",
      request: input.body,
      owner: ref(ctx),
    });
    const key = `local-upload-request:${ctx.principalId}:${input.body.requestId}`;
    const prior = await this.owner.mutex.run(() => {
      authorize(this.owner.state, ctx, authority.workspaceId, "workspace.write");
      const prior = this.owner.state.get<{ digest: string; uploadId: string }>(key);
      if (prior)
        requireThat(prior.digest === requestDigest, "conflict", "Local upload request changed");
      return prior;
    });
    if (prior)
      return {
        status: 201,
        body: this.get(ctx, authority.workspaceId, prior.uploadId, false).status,
      };
    const generation = unwrap(
      await this.owner.control().resolveExecutorGeneration(ctx, {
        workspaceId: authority.workspaceId,
        bindingVersion: authority.binding.bindingVersion,
        executorId: authority.binding.config.executorId,
      }),
    );
    const puts = uniquePuts(input.body);
    requireThat(
      puts.reduce(
        (sum, entry) =>
          sum +
          (input.body.blobs?.find((plan) => plan.sha256 === entry.sha256)?.chunks.chunkHashes
            .length ?? 0),
        0,
      ) <= 1024,
      "payload_too_large",
      "Local upload exceeds chunk receipt capacity",
    );
    for (const entry of puts)
      checkedManifest(
        {
          version: 1,
          entries: [
            {
              type: "file",
              path: entry.path,
              mode: entry.mode,
              sha256: entry.sha256,
              size: entry.size,
            },
          ],
        },
        this.owner.policy,
      );
    const metadataBytes = new TextEncoder().encode(canonicalJson(input.body)).length * 4 + 262144;
    await this.owner.mutex.run(() => {
      const current = this.owner.current();
      const active = validateLease(this.owner.state, current, input.body.lease, ctx);
      requireThat(
        current.binding.bindingVersion === authority.binding.bindingVersion &&
          input.body.baseRevision === active.baseRevision &&
          input.body.operationId === active.operationId &&
          hash === input.body.manifestHash &&
          same(
            sorted(
              applyMutations(
                this.owner.revision(active.baseRevision).manifest,
                input.body.mutations,
              ),
            ),
            sorted(manifest),
          ),
        "conflict",
        "Local proposed snapshot must equal its explicit mutations",
      );
      requireThat(
        this.owner.state.bytes + metadataBytes <=
          this.owner.policy.bounds.objectBytes * (1 - this.owner.policy.bounds.headroomFraction),
        "quota_exceeded",
        "Local authority metadata headroom exhausted",
      );
    });
    // Only metadata is reserved in cloud storage. Local file bytes never enter Computer or a cloud byte store.
    const admission = {
      operationId: `local-metadata-${requestDigest}`,
      ownerId: authority.workspaceId,
      policyVersion: this.owner.policy.version,
      bytes: metadataBytes,
      admissionSlots: 0,
    };
    unwrap(await this.owner.reserveCapacity(ctx, admission));
    unwrap(await this.owner.control().reserveCapacity(ctx, admission));
    return this.owner.mutex.run(() =>
      this.owner.state.transaction(() => {
        const current = this.owner.current();
        const active = validateLease(this.owner.state, current, input.body.lease, ctx);
        requireThat(
          current.binding.bindingVersion === authority.binding.bindingVersion &&
            active.executorId === generation.executorId &&
            active.executorGeneration === generation.executorGeneration &&
            input.body.operationId === active.operationId &&
            input.body.baseRevision === active.baseRevision &&
            hash === input.body.manifestHash &&
            same(
              sorted(
                applyMutations(
                  this.owner.revision(active.baseRevision).manifest,
                  input.body.mutations,
                ),
              ),
              sorted(manifest),
            ),
          "workspace.conflict",
          "Local stage base or explicit mutations mismatch",
          { reason: "expected_revision" },
        );
        const existing = this.owner.state.get<{ digest: string; uploadId: string }>(key);
        if (existing) {
          requireThat(existing.digest === requestDigest, "conflict", "Local upload changed");
          return {
            status: 201 as const,
            body: this.get(ctx, authority.workspaceId, existing.uploadId, false).status,
          };
        }
        const target = this.owner.state.get<D.TargetReservation>(`reservation:${active.leaseId}`);
        requireThat(target, "conflict", "Local target reservation missing");
        const bytes = uniquePuts(input.body).reduce((sum, mutation) => sum + mutation.size, 0);
        requireThat(
          bytes <= this.owner.policy.bounds.stagingBytesPerWorkspace &&
            (this.owner.state.get<number>("local-upload-bytes") ?? 0) + bytes <=
              this.owner.policy.bounds.stagingBytesPerWorkspace &&
            (this.owner.state.get<number>("local-upload-count") ?? 0) < 2,
          "quota_exceeded",
          "Local staging metadata admission bound reached",
        );
        const uploadId = crypto.randomUUID();
        const scope: D.LocalScope = {
          operationId: active.operationId,
          operationDigest: target.operationDigest,
          workspaceId: authority.workspaceId,
          bindingVersion: current.binding.bindingVersion,
          rootBindingId: config.rootBindingId,
          executorId: generation.executorId,
          executorGeneration: generation.executorGeneration,
          credential: ref(ctx),
          baseRevision: active.baseRevision,
          lease: active,
          deadline: target.deadline,
        };
        const row: LocalUpload = {
          request: input.body,
          owner: ref(ctx),
          binding: current.binding,
          scope,
          transfers: {},
          applyAttempted: false,
          status: {
            uploadId,
            state: "open",
            baseRevision: active.baseRevision,
            manifestHash: hash,
            receivedChunks: [],
            expiresAt: Math.min(Date.now() + 900_000, target.deadline),
          },
        };
        this.owner.state.put(`local-upload:${uploadId}`, row);
        this.owner.state.put(key, { digest: requestDigest, uploadId });
        this.owner.state.put(
          "local-upload-count",
          (this.owner.state.get<number>("local-upload-count") ?? 0) + 1,
        );
        this.owner.state.put(
          "local-upload-bytes",
          (this.owner.state.get<number>("local-upload-bytes") ?? 0) + bytes,
        );
        return { status: 201 as const, body: row.status };
      }),
    );
  }
  async put(
    ctx: D.AuthContext,
    input: D.OperationRequest<"putUploadChunk">,
  ): Promise<D.OperationResponse<"putUploadChunk">> {
    const row = await this.owner.mutex.run(() =>
      this.get(ctx, input.path.workspaceId, input.path.uploadId),
    );
    const mutation = uniquePuts(row.request).find((entry) => entry.sha256 === input.path.sha256);
    const plan = row.request.blobs?.find((entry) => entry.sha256 === input.path.sha256);
    requireThat(
      mutation &&
        plan &&
        input.path.chunkIndex >= 0 &&
        Number.isInteger(input.path.chunkIndex) &&
        input.path.chunkIndex < plan.chunks.chunkHashes.length &&
        input.query.sha256 === plan.chunks.chunkHashes[input.path.chunkIndex] &&
        input.query.length ===
          Math.min(
            plan.chunks.chunkBytes,
            mutation.size - input.path.chunkIndex * plan.chunks.chunkBytes,
          ),
      "invalid_request",
      "Local chunk does not match its exact announced grid",
    );
    let descriptor = await this.owner.mutex.run(
      () => this.get(ctx, input.path.workspaceId, input.path.uploadId).transfers[mutation.sha256],
    );
    if (!descriptor || descriptor.expiresAt <= Date.now()) {
      const key = `${row.status.uploadId}:${mutation.sha256}`;
      const waiting = this.pendingTransfers.get(key);
      if (waiting) descriptor = await waiting;
      else {
        const opening = (async () => {
          const active = await this.owner.mutex.run(() =>
            validateLease(this.owner.state, this.owner.current(), row.scope.lease, ctx),
          );
          const grant = ctx.grants.find(
            (grant) =>
              (grant.expiresAt === undefined || grant.expiresAt > Date.now()) &&
              permitsResource(grant.resources.workspaceIds, row.scope.workspaceId) &&
              permitsResource(grant.resources.actions, "workspace.write") &&
              permitsResource(grant.resources.executorIds, row.scope.executorId),
          );
          requireThat(grant, "unauthorized", "Local staging grant required");
          const opened = unwrap(
            await this.owner.control().openTransfer(ctx, {
              deploymentId: ctx.deploymentId,
              direction: "to-executor",
              purpose: "local-stage",
              workspaceId: row.scope.workspaceId,
              bindingVersion: row.scope.bindingVersion,
              operationId: row.scope.operationId,
              operationDigest: row.scope.operationDigest,
              ...(active.ownerKind === "job" ? { jobId: active.jobId } : {}),
              executorId: row.scope.executorId,
              executorGeneration: row.scope.executorGeneration,
              credential: row.scope.credential,
              consumer: transferConsumer(
                row.scope.workspaceId,
                "workspace.write",
                row.scope.executorId,
              ),
              baseRevision: row.scope.baseRevision,
              lease: active,
              content: {
                kind: "workspace-file",
                path: mutation.path,
                manifestHash: row.status.manifestHash,
                uploadId: row.status.uploadId,
              },
              fileSha256: mutation.sha256,
              size: mutation.size,
              chunkBytes: plan.chunks.chunkBytes,
              chunkHashes: plan.chunks.chunkHashes,
              expiresAt: Math.min(
                Date.now() + 60_000,
                active.expiresAt,
                ctx.deadline,
                row.scope.deadline,
                ctx.credentialExpiresAt ?? Infinity,
                grant.expiresAt ?? Infinity,
              ),
              deadline: row.scope.deadline,
            }),
          );
          await this.owner.mutex.run(() => {
            const current = this.get(ctx, input.path.workspaceId, input.path.uploadId);
            current.transfers[mutation.sha256] = opened;
            this.owner.state.put(`local-upload:${input.path.uploadId}`, current);
          });
          return opened;
        })();
        this.pendingTransfers.set(key, opening);
        try {
          descriptor = await opening;
        } finally {
          if (this.pendingTransfers.get(key) === opening) this.pendingTransfers.delete(key);
        }
      }
    }
    const { boundedBytes, bytesStream } = await import("./streams.js");
    const bytes = await boundedBytes(
      bytesStream(input.body),
      input.query.length,
      input.query.sha256,
      ctx.deadline,
    );
    const peer = new URL(
      `https://control.internal/internal/transfers/${descriptor.transferId}/peer/chunks/${input.path.chunkIndex}`,
    );
    peer.searchParams.set("attemptId", descriptor.attemptId);
    peer.searchParams.set("length", String(input.query.length));
    peer.searchParams.set("sha256", input.query.sha256);
    const delivered = await this.owner.control().fetch(
      new Request(peer, {
        method: "PUT",
        headers: { "X-Fortipi-Context": JSON.stringify(ctx) },
        body: bytes,
      }),
    );
    requireThat(delivered.status === 204, "interrupted", "Local chunk peer delivery incomplete");
    await this.owner.mutex.run(() => {
      const current = this.get(ctx, input.path.workspaceId, input.path.uploadId);
      const index = localChunkIndex(current.request, mutation.sha256, input.path.chunkIndex);
      if (!current.status.receivedChunks.includes(index)) current.status.receivedChunks.push(index);
      this.owner.state.put(`local-upload:${input.path.uploadId}`, current);
    });
    return { status: 204, body: undefined };
  }
  async validate(
    ctx: D.AuthContext,
    input: D.OperationRequest<"validateUpload">,
  ): Promise<D.OperationResponse<"validateUpload">> {
    const row = await this.owner.mutex.run(() =>
      this.get(ctx, input.path.workspaceId, input.path.uploadId),
    );
    if (row.stageId)
      return {
        status: 200,
        body: {
          uploadId: row.status.uploadId,
          manifestHash: row.status.manifestHash,
          stageId: row.stageId,
          validated: true,
        },
      };
    const count = uniquePuts(row.request).reduce(
      (sum, entry) =>
        sum +
        (row.request.blobs?.find((plan) => plan.sha256 === entry.sha256)?.chunks.chunkHashes
          .length ?? 0),
      0,
    );
    requireThat(
      row.status.receivedChunks.length === count,
      "conflict",
      "Local staged chunks are incomplete",
    );
    const mode: Extract<D.LocalPrepare["mode"], { kind: "staged-change" }> = {
      kind: "staged-change",
      uploadId: row.status.uploadId,
      manifest: row.request.manifest,
      mutations: row.request.mutations,
      postManifestHash: row.status.manifestHash,
      stagedDigest: await localStageDigest({
        uploadId: row.status.uploadId,
        manifest: row.request.manifest,
        mutations: row.request.mutations,
      }),
    };
    await validateLocalStage(mode);
    const active = await this.owner.mutex.run(() =>
      validateLease(this.owner.state, this.owner.current(), row.scope.lease, ctx),
    );
    const request: D.LocalPrepare = {
      ...row.scope,
      lease: active,
      kind: "prepare",
      commitId: row.request.commitId,
      expectedManifestHash: this.owner.revision(row.scope.baseRevision).manifestHash,
      mode,
    };
    requireThat(
      new TextEncoder().encode(canonicalJson(request)).length + 512 <= 1_048_576,
      "payload_too_large",
      "Complete local preparation frame exceeds its transport bound",
    );
    const prepared = unwrap(await this.owner.control().requestLocalWorkspace(ctx, request));
    requireThat(
      "state" in prepared &&
        prepared.state === "prepared" &&
        "preparationId" in prepared &&
        "expiresAt" in prepared,
      "interrupted",
      "Owner preparation not durably acknowledged",
    );
    const intent = unwrap(
      await this.owner.prepareLocalCommit(ctx, {
        scope: row.scope,
        commitId: row.request.commitId,
        preparation: prepared,
        expectedPostManifestHash: row.status.manifestHash,
      }),
    );
    return this.owner.mutex.run(() => {
      const current = this.get(ctx, input.path.workspaceId, input.path.uploadId);
      current.preparation = prepared;
      current.intent = intent;
      current.stageId ??= crypto.randomUUID();
      current.status.state = "validated";
      this.owner.state.put(`local-upload:${input.path.uploadId}`, current);
      return {
        status: 200 as const,
        body: {
          uploadId: current.status.uploadId,
          manifestHash: current.status.manifestHash,
          stageId: current.stageId,
          validated: true as const,
        },
      };
    });
  }
  async commit(
    ctx: D.AuthContext,
    input: D.OperationRequest<"commitUpload">,
  ): Promise<D.OperationResponse<"commitUpload">> {
    const row = await this.owner.mutex.run(() => {
      authorize(this.owner.state, ctx, input.path.workspaceId, "workspace.read");
      const row = this.owner.state.get<LocalUpload>(`local-upload:${input.path.uploadId}`);
      requireThat(
        row && row.scope.workspaceId === input.path.workspaceId,
        "not_found",
        "Local upload unavailable",
      );
      if (!this.owner.state.get(`receipt:${input.body.commitId}`))
        this.get(ctx, input.path.workspaceId, input.path.uploadId, false);
      return row;
    });
    const commit = input.body;
    requireThat(
      row.status.uploadId === commit.uploadId &&
        row.stageId === commit.stageId &&
        row.request.commitId === commit.commitId &&
        row.scope.operationId === commit.operationId &&
        row.scope.workspaceId === commit.workspaceId &&
        row.scope.baseRevision === commit.baseRevision &&
        row.status.manifestHash === commit.manifestHash &&
        sameLease(row.scope.lease, commit.lease) &&
        (row.scope.lease.ownerKind === "job"
          ? commit.jobId === row.scope.lease.jobId
          : commit.jobId === undefined) &&
        row.intent &&
        row.preparation,
      "conflict",
      "Local validated stage identity mismatch",
    );
    const existing = this.owner.state.get<D.CommitReceipt>(`receipt:${commit.commitId}`);
    if (existing) {
      const receipt = unwrap(
        await this.owner.getReceipt(ctx, {
          workspaceId: commit.workspaceId,
          commitId: commit.commitId,
          commitDigest: existing.commitDigest,
        }),
      );
      await this.owner.mutex.run(() => {
        if (row.status.state === "open" || row.status.state === "validated") this.close(row);
        row.status.state = "committed";
        this.owner.state.put(`local-upload:${input.path.uploadId}`, row);
      });
      unwrap(
        await this.owner.control().requestLocalWorkspace(ctx, {
          ...row.scope,
          kind: "receipt",
          preparationId: row.preparation.preparationId,
          receipt: publicCommitReceipt(receipt),
        }),
      );
      return { status: 200, body: publicCommitReceipt(receipt) };
    }
    const active = await this.owner.mutex.run(() =>
      validateLease(this.owner.state, this.owner.current(), row.scope.lease, ctx),
    );
    let observation: D.LocalObservation;
    const firstApply = await this.owner.mutex.run(() => {
      const current = this.get(ctx, input.path.workspaceId, input.path.uploadId);
      if (current.applyAttempted) return false;
      current.applyAttempted = true;
      this.owner.state.put(`local-upload:${input.path.uploadId}`, current);
      return true;
    });
    if (!firstApply) {
      const observed = unwrap(
        await this.owner.control().requestLocalWorkspace(ctx, {
          ...row.scope,
          kind: "observe",
          commitId: commit.commitId,
          preparationId: row.preparation.preparationId,
        }),
      );
      requireThat(
        "observationSeq" in observed,
        "interrupted",
        "Local effect observation unavailable",
      );
      observation = observed;
    } else {
      const applied = unwrap(
        await this.owner.control().requestLocalWorkspace(ctx, {
          ...row.scope,
          lease: active,
          kind: "apply",
          preparationId: row.preparation.preparationId,
          commitId: commit.commitId,
        }),
      );
      requireThat(
        "observationSeq" in applied,
        "interrupted",
        "Local apply acknowledgment uncertain; query the existing operation",
      );
      observation = applied;
    }
    await this.owner.mutex.run(() => {
      const current = this.get(ctx, input.path.workspaceId, input.path.uploadId, false);
      current.observation = observation;
      this.owner.state.put(`local-upload:${input.path.uploadId}`, current);
    });
    const receipt = unwrap(
      await this.owner.commitLocal(ctx, {
        intent: row.intent,
        observation,
        manifest: row.request.manifest,
      }),
    );
    await this.owner.mutex.run(() => {
      const current = this.get(ctx, input.path.workspaceId, input.path.uploadId, false);
      if (current.status.state === "open" || current.status.state === "validated")
        this.close(current);
      current.status.state = "committed";
      this.owner.state.put(`local-upload:${input.path.uploadId}`, current);
    });
    // Receipt delivery failure is recoverable by repeating receipt only, never apply.
    unwrap(
      await this.owner.control().requestLocalWorkspace(ctx, {
        ...row.scope,
        kind: "receipt",
        preparationId: row.preparation.preparationId,
        receipt: publicCommitReceipt(receipt),
      }),
    );
    return { status: 200, body: publicCommitReceipt(receipt) };
  }
  async publishObserved(
    ctx: D.AuthContext,
    input: Extract<D.CommitInput, { providerKind: "local" }>,
  ): Promise<D.CommitReceipt> {
    const row = await this.owner.mutex.run(() =>
      this.get(ctx, input.workspaceId, input.uploadId, false),
    );
    const observation = row.observation;
    const intent = row.intent;
    requireThat(
      observation?.state === "applied" &&
        intent &&
        row.preparation &&
        input.commitId === intent.commitId &&
        input.operationId === row.scope.operationId &&
        input.baseRevision === row.scope.baseRevision &&
        input.manifestHash === row.status.manifestHash &&
        input.preparationId === intent.preparationId &&
        input.observationSeq === observation.observationSeq &&
        sameLease(input.lease, row.scope.lease) &&
        (row.scope.lease.ownerKind === "job"
          ? input.jobId === row.scope.lease.jobId
          : input.jobId === undefined),
      "conflict",
      "Local publication requires its retained applied observation and full stage",
    );
    const digest = await commitDigest({
      commitId: input.commitId,
      operationId: input.operationId,
      workspaceId: input.workspaceId,
      baseRevision: input.baseRevision,
      manifestHash: input.manifestHash,
      leaseIdentity: input.lease,
      ...(input.jobId ? { jobId: input.jobId } : {}),
      storage: {
        kind: "local",
        preparationId: input.preparationId,
        observationSeq: input.observationSeq,
        preManifestHash: observation.preManifestHash,
        postManifestHash: observation.postManifestHash,
      },
    });
    requireThat(
      digest === input.commitDigest,
      "conflict",
      "Local final commit digest differs from actual observation",
    );
    const receipt = unwrap(
      await this.owner.commitLocal(ctx, { intent, observation, manifest: row.request.manifest }),
    );
    unwrap(
      await this.owner.control().requestLocalWorkspace(ctx, {
        ...row.scope,
        kind: "receipt",
        preparationId: intent.preparationId,
        receipt: publicCommitReceipt(receipt),
      }),
    );
    await this.owner.mutex.run(() => {
      const current = this.get(ctx, input.workspaceId, input.uploadId, false);
      if (current.status.state === "open" || current.status.state === "validated")
        this.close(current);
      current.status.state = "committed";
      this.owner.state.put(`local-upload:${input.uploadId}`, current);
    });
    return receipt;
  }
  abort(ctx: D.AuthContext, workspaceId: string, uploadId: string): void {
    const row = this.get(ctx, workspaceId, uploadId, false);
    requireThat(
      !row.applyAttempted && row.status.state !== "committed",
      "conflict",
      "Attempted local effects require observation/reconciliation",
    );
    if (row.status.state !== "aborted" && row.status.state !== "expired") {
      row.status.state = "aborted";
      this.close(row);
      this.owner.state.put(`local-upload:${uploadId}`, row);
    }
  }
  expire(uploadId: string): void {
    const row = this.owner.state.get<LocalUpload>(`local-upload:${uploadId}`);
    if (row && (row.status.state === "open" || row.status.state === "validated")) {
      row.status.state = "expired";
      this.close(row);
      this.owner.state.put(`local-upload:${uploadId}`, row);
    }
  }
  private close(row: LocalUpload): void {
    this.owner.state.put(
      "local-upload-count",
      Math.max(0, (this.owner.state.get<number>("local-upload-count") ?? 0) - 1),
    );
    this.owner.state.put(
      "local-upload-bytes",
      Math.max(
        0,
        (this.owner.state.get<number>("local-upload-bytes") ?? 0) -
          uniquePuts(row.request).reduce((sum, mutation) => sum + mutation.size, 0),
      ),
    );
  }
}
function uniquePuts(request: D.UploadBegin): Extract<D.Mutation, { kind: "put" }>[] {
  return [
    ...new Map(
      request.mutations
        .filter((mutation) => mutation.kind === "put")
        .map((mutation) => [mutation.sha256, mutation]),
    ).values(),
  ];
}
function localChunkIndex(request: D.UploadBegin, hash: string, offset: number): number {
  let count = 0;
  for (const entry of uniquePuts(request)) {
    if (entry.sha256 === hash) return count + offset;
    count +=
      request.blobs?.find((plan) => plan.sha256 === entry.sha256)?.chunks.chunkHashes.length ?? 0;
  }
  throw new WorkspaceError("invalid_request", "Blob not in this local upload");
}
function sameLease(a: D.Lease, b: D.Lease): boolean {
  const { expiresAt: _a, leaseVersion: _av, ...first } = a;
  const { expiresAt: _b, leaseVersion: _bv, ...second } = b;
  return same(first, second);
}
