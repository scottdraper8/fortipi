import { DurableObject } from "cloudflare:workers";
import {
  commitDigest,
  localIntentDigest,
  localStageDigest,
  manifestDigest,
  validateLocalStage,
  validateUploadBlobs,
} from "fortipi-contract";
import type * as D from "../../../src/boundary/dto.js";
import type { Env } from "../../../src/boundary/env.js";
import { check, hash, id, json, outcome, ref, same, success } from "../../../src/control/store.js";
import type { FixtureControl } from "./worker.js";

type RecipientEnv = Omit<Env, "CONTROL_PLANE"> & {
  CONTROL_PLANE: DurableObjectNamespace<FixtureControl>;
};

/** Real SQLite authority floors with controlled lost acknowledgments; no product enforcement claim. */
export class TestRecipient extends DurableObject<RecipientEnv> {
  async streamAudit(): Promise<string> {
    return json({
      calls: (await this.ctx.storage.get<number>("streamCalls")) ?? 0,
      last: (await this.ctx.storage.get("streamLast")) ?? null,
      error: (await this.ctx.storage.get<string>("streamError")) ?? null,
    });
  }
  async streamFailure(mode: "status" | "throw" | null): Promise<void> {
    await this.ctx.storage.put("streamFailure", mode);
  }
  async fetch(request: Request): Promise<Response> {
    try {
      return await this.streamFetch(request);
    } catch (error) {
      await this.ctx.storage.put(
        "streamError",
        error instanceof Error
          ? error.message.replace(/([?&]ticket=)[^\s"]+/g, "$1<redacted>").slice(0, 200)
          : "unknown",
      );
      throw error;
    }
  }
  private async streamFetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/v1/stream") return new Response(null, { status: 404 });
    const envelope = request.headers.get("X-Fortipi-Socket") ?? "";
    const registrationEnvelope = await this.env.CONTROL_PLANE.getByName("control")
      .streamRegistration(envelope)
      .catch(async (error: unknown) => {
        await this.ctx.storage.put(
          "streamError",
          error instanceof Error ? error.message.slice(0, 200) : "unknown",
        );
        throw error;
      });
    const registration: unknown = JSON.parse(registrationEnvelope);
    const calls = ((await this.ctx.storage.get<number>("streamCalls")) ?? 0) + 1;
    const audit = {
      actorId: this.ctx.id.toString(),
      method: request.method,
      path: url.pathname,
      query: url.search ? "<query-present>" : "",
      socket: envelope,
      context: request.headers.get("X-Fortipi-Context"),
      hasBearer: request.headers.has("Authorization"),
      hasCookie: request.headers.has("Cookie"),
      hasProtocol: request.headers.has("Sec-WebSocket-Protocol"),
      hasConnectionId: request.headers.has("X-Fortipi-Connection-Id"),
      registration,
    };
    await this.ctx.storage.put("streamCalls", calls);
    await this.ctx.storage.put("streamLast", audit);
    check(
      registration &&
        typeof registration === "object" &&
        "recipient" in registration &&
        registration.recipient &&
        typeof registration.recipient === "object" &&
        "kind" in registration.recipient &&
        registration.recipient.kind === "agent" &&
        "id" in registration.recipient &&
        typeof registration.recipient.id === "string" &&
        this.ctx.id.equals(this.env.AGENT_SESSIONS.idFromName(registration.recipient.id)),
      "unauthorized",
      "Fixture requires its actual registration before upgrade",
    );
    const failure = await this.ctx.storage.get<string>("streamFailure");
    if (failure === "throw") throw new Error("Synthetic unavailable stream target");
    if (failure === "status") return new Response(null, { status: 503 });
    const pair = new WebSocketPair();
    pair[1].accept();
    pair[1].send(json({ type: "fixture.stream", ...audit }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  private outputs = 0;
  async outputCount(): Promise<number> {
    return this.outputs;
  }
  async setQuotaFault(fault: D.ProtocolError | null): Promise<void> {
    await this.ctx.storage.put("quotaFault", fault);
  }
  async hasReceipt(deliveryId: string): Promise<boolean> {
    return (await this.ctx.storage.get(deliveryId)) !== undefined;
  }
  get contractVersion(): "1.0" {
    return "1.0";
  }
  async setLeaseDrop(kind: "acquire" | "renew" | "release" | null): Promise<void> {
    await this.ctx.storage.put("dropLease", kind);
  }
  async allocateStage(input: D.UploadBegin): Promise<string> {
    validateUploadBlobs(input, { required: true });
    const uploadId = id();
    const mode = {
      kind: "staged-change" as const,
      uploadId,
      manifest: input.manifest,
      mutations: input.mutations,
      postManifestHash: input.manifestHash,
      stagedDigest: await localStageDigest({
        uploadId,
        manifest: input.manifest,
        mutations: input.mutations,
      }),
    };
    await validateLocalStage(mode);
    await this.ctx.storage.put(`stage:${uploadId}`, input);
    return uploadId;
  }
  async leaseInput(kind: string, requestId: string): Promise<string> {
    return JSON.stringify((await this.ctx.storage.get(`leaseInput:${kind}:${requestId}`)) ?? null);
  }
  private async leaseFloors(
    transaction: DurableObjectTransaction,
    ctx: D.AuthContext,
    reservation: D.TargetReservation,
  ): Promise<void> {
    check(
      ctx.generation >= ((await transaction.get<number>(`credential:${ctx.credentialId}`)) ?? 0),
      "unauthenticated",
      "Synthetic credential floor",
    );
    if (reservation.target.kind === "executor")
      check(
        reservation.target.generation >=
          ((await transaction.get<number>(`executor:${reservation.target.executorId}`)) ?? 0),
        "unauthenticated",
        "Synthetic executor floor",
      );
  }
  async acquireLease(ctx: D.AuthContext, input: D.TargetReservation): Promise<D.Outcome<D.Lease>> {
    const digest = await hash(json(input));
    const result = await outcome(ctx.requestId, () =>
      this.ctx.storage.transaction(async (transaction) => {
        await this.leaseFloors(transaction, ctx, input);
        const key = `leaseInput:acquire:${input.reservationId}`;
        const prior = await transaction.get<{
          digest: string;
          input: D.TargetReservation;
          lease: D.Lease;
        }>(key);
        if (prior) {
          check(prior.digest === digest, "conflict", "Synthetic reservation body changed");
          return prior.lease;
        }
        const binding = await transaction.get<D.WorkspaceBinding>("binding");
        const manifest = await transaction.get<D.ManifestResponse>("manifest");
        check(
          input.ownerKind === "workspace-operation" &&
            binding?.bindingVersion === input.bindingVersion &&
            manifest?.revision === input.baseRevision &&
            input.expiresAt > Date.now(),
          "conflict",
          "Synthetic lease base/admission changed",
        );
        const current = await transaction.get<{ lease: D.Lease; released: boolean }>("heldLease");
        check(
          !current || current.released || current.lease.expiresAt <= Date.now(),
          "conflict",
          "Synthetic held lease",
        );
        const fence = ((await transaction.get<number>("fence")) ?? 0) + 1;
        const holder =
          input.target.kind === "executor" ? input.target.executorId : input.target.backendId;
        const lease: D.WorkspaceOperationLease = {
          leaseId: id(),
          operationId: input.operationId,
          credential: input.credential,
          registrationId: input.registrationIds.workspace,
          workspaceId: input.workspaceId,
          baseRevision: input.baseRevision,
          executorId: holder,
          executorGeneration: input.target.generation,
          ownerKind: "workspace-operation",
          leaseVersion: 1,
          fence: String(fence),
          expiresAt: input.expiresAt,
        };
        await transaction.put("fence", fence);
        await transaction.put("heldLease", { lease, reservation: input, released: false });
        await transaction.put(key, { input, digest, lease });
        return lease;
      }),
    );
    if (result.ok && (await this.ctx.storage.get("dropLease")) === "acquire")
      throw new Error("Synthetic lost lease acquisition ack");
    return result;
  }
  async renewLease(ctx: D.AuthContext, input: D.LeaseRenewal): Promise<D.Outcome<D.Lease>> {
    const digest = await hash(json(input));
    const result = await outcome(ctx.requestId, () =>
      this.ctx.storage.transaction(async (transaction) => {
        const held = await transaction.get<{
          lease: D.Lease;
          reservation: D.TargetReservation;
          released: boolean;
        }>("heldLease");
        check(held, "conflict", "Synthetic lease unavailable");
        await this.leaseFloors(transaction, ctx, held.reservation);
        check(
          !held.released && held.lease.leaseId === input.lease.leaseId,
          "conflict",
          "Synthetic released lease",
        );
        const key = `leaseInput:renew:${input.requestId}`;
        const prior = await transaction.get<{ digest: string; lease: D.Lease }>(key);
        if (prior) {
          check(prior.digest === digest, "conflict", "Synthetic renewal body changed");
          return prior.lease;
        }
        check(
          same(held.lease, input.lease) &&
            input.expectedLeaseVersion === held.lease.leaseVersion &&
            held.lease.expiresAt > Date.now() &&
            input.expiresAt <= held.reservation.deadline,
          "conflict",
          "Synthetic renewal CAS",
        );
        const lease = {
          ...held.lease,
          leaseVersion: held.lease.leaseVersion + 1,
          expiresAt: input.expiresAt,
        };
        await transaction.put("heldLease", { ...held, lease });
        await transaction.put(key, { input, digest, lease });
        return lease;
      }),
    );
    if (result.ok && (await this.ctx.storage.get("dropLease")) === "renew")
      throw new Error("Synthetic lost lease renewal ack");
    return result;
  }
  async releaseLease(
    ctx: D.AuthContext,
    input: D.LeaseRelease,
  ): Promise<D.Outcome<D.ReleaseReceipt>> {
    const digest = await hash(json(input));
    const result = await outcome(ctx.requestId, () =>
      this.ctx.storage.transaction(async (transaction) => {
        const held = await transaction.get<{
          lease: D.Lease;
          reservation: D.TargetReservation;
          released: boolean;
        }>("heldLease");
        check(held, "conflict", "Synthetic lease unavailable");
        await this.leaseFloors(transaction, ctx, held.reservation);
        const key = `leaseInput:release:${input.requestId}`;
        const prior = await transaction.get<{ digest: string; receipt: D.ReleaseReceipt }>(key);
        if (prior) {
          check(prior.digest === digest, "conflict", "Synthetic release body changed");
          return prior.receipt;
        }
        check(!held.released && same(held.lease, input.lease), "conflict", "Synthetic release CAS");
        const receipt = { leaseId: held.lease.leaseId, released: true, tombstoneId: id() };
        await transaction.put("heldLease", { ...held, released: true });
        await transaction.put(key, { input, digest, receipt });
        return receipt;
      }),
    );
    if (result.ok && (await this.ctx.storage.get("dropLease")) === "release")
      throw new Error("Synthetic lost lease release ack");
    return result;
  }
  async invalidateGeneration(
    _ctx: D.RecoveryContext,
    input: D.Invalidation,
  ): Promise<D.Outcome<D.InvalidationAck>> {
    const quota = await this.ctx.storage.get<D.ProtocolError>("quotaFault");
    if (quota) return { ...quota, ok: false };
    const key =
      input.subject.kind === "credential"
        ? `credential:${input.subject.credentialId}`
        : `executor:${input.subject.executorId}`;
    const floor = Math.max(
      (await this.ctx.storage.get<number>(key)) ?? 0,
      input.subject.minimumGeneration,
    );
    await this.ctx.storage.put(key, floor);
    const delay = await this.ctx.storage.get<number>("invalidationDelay");
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    if (await this.ctx.storage.get<boolean>("drop"))
      throw new Error("Synthetic lost invalidation acknowledgment");
    return success({ ...input, recipient: _ctx.recipient, persistedFloor: floor });
  }
  async receiveExecutorOutput(
    _ctx: D.AuthContext,
    input: D.OutputDelivery,
  ): Promise<D.Outcome<D.DeliveryAck>> {
    this.outputs++;
    const fault = await this.ctx.storage.get<D.ProtocolError>("quotaFault");
    if (fault) return { ...fault, ok: false };
    return this.receipt(input.deliveryId, input.sequence, input);
  }
  async receiveExecutorResult(
    _ctx: D.AuthContext,
    input: D.ResultDelivery,
  ): Promise<D.Outcome<D.DeliveryAck>> {
    return this.receipt(input.deliveryId, input.sequence, input);
  }
  private async receipt(
    deliveryId: string,
    sequence: number,
    payload: unknown,
  ): Promise<D.Outcome<D.DeliveryAck>> {
    const prior = await this.ctx.storage.get<unknown>(deliveryId);
    if (prior && !same(prior, payload)) throw new Error("Changed duplicate delivery");
    await this.ctx.storage.put(deliveryId, payload);
    if (await this.ctx.storage.get<boolean>("drop"))
      throw new Error("Synthetic lost output acknowledgment");
    return success({ deliveryId, sequence, persisted: true });
  }
  async setDrop(value: boolean): Promise<void> {
    await this.ctx.storage.put("drop", value);
  }
  async setInvalidationDelay(milliseconds: number): Promise<void> {
    check(
      Number.isInteger(milliseconds) && milliseconds >= 0 && milliseconds <= 1000,
      "invalid_request",
      "Invalid fixture delay",
    );
    await this.ctx.storage.put("invalidationDelay", milliseconds);
  }
  async setBindingDrop(value: boolean): Promise<void> {
    await this.ctx.storage.put("dropBinding", value);
  }
  async prepareLocalCommit(
    _ctx: D.AuthContext,
    input: {
      scope: D.LocalScope;
      commitId: string;
      preparation: D.LocalPrepared;
      expectedPostManifestHash?: string;
    },
  ): Promise<D.Outcome<D.LocalCommitIntent>> {
    const value = {
      commitId: input.commitId,
      scope: input.scope,
      preparationId: input.preparation.preparationId,
      preManifestHash: input.preparation.preManifestHash,
      ...(input.expectedPostManifestHash
        ? { expectedPostManifestHash: input.expectedPostManifestHash }
        : {}),
      state: "pending_apply" as const,
    };
    const intent: D.LocalCommitIntent = { ...value, intentDigest: await localIntentDigest(value) };
    const prior = await this.ctx.storage.get<D.LocalCommitIntent>(`intent:${intent.commitId}`);
    if (prior) {
      check(prior.intentDigest === intent.intentDigest, "conflict", "Synthetic intent changed");
      return success(prior);
    }
    await this.ctx.storage.put(`intent:${intent.commitId}`, intent);
    return success(intent);
  }
  async localIntent(commitId: string): Promise<string | undefined> {
    const intent = await this.ctx.storage.get<D.LocalCommitIntent>(`intent:${commitId}`);
    return intent === undefined ? undefined : JSON.stringify(intent);
  }
  async commitLocal(
    _ctx: D.AuthContext,
    input: { intent: D.LocalCommitIntent; observation: D.LocalObservation; manifest: D.Manifest },
  ): Promise<D.Outcome<D.CommitReceipt>> {
    const observation = input.observation;
    check(
      observation.state === "applied" &&
        observation.preparationId === input.intent.preparationId &&
        observation.commitId === input.intent.commitId,
      "conflict",
      "Synthetic actual observation required",
    );
    const scope = input.intent.scope;
    const manifestHash = await manifestDigest(input.manifest);
    check(
      manifestHash === observation.postManifestHash,
      "conflict",
      "Synthetic post manifest mismatch",
    );
    const digest = await commitDigest({
      commitId: input.intent.commitId,
      operationId: scope.operationId,
      workspaceId: scope.workspaceId,
      baseRevision: scope.baseRevision,
      manifestHash,
      leaseIdentity: scope.lease,
      storage: {
        kind: "local",
        preparationId: observation.preparationId,
        observationSeq: observation.observationSeq,
        preManifestHash: observation.preManifestHash,
        postManifestHash: observation.postManifestHash,
      },
    });
    const receipt: D.CommitReceipt = {
      providerKind: "local",
      commitId: input.intent.commitId,
      operationId: scope.operationId,
      workspaceId: scope.workspaceId,
      baseRevision: scope.baseRevision,
      revision: "fixture_committed_revision",
      manifestHash,
      commitDigest: digest,
      committedAt: Date.now(),
      sourceFactId: "fixture_source_fact",
      preparationId: observation.preparationId,
      observationSeq: observation.observationSeq,
    };
    await this.ctx.storage.put(`receipt:${receipt.commitId}`, receipt);
    return success(receipt);
  }
  async getReceipt(
    _ctx: D.AuthContext,
    input: D.CommitLookup,
  ): Promise<D.Outcome<D.CommitReceipt>> {
    const receipt = await this.ctx.storage.get<D.CommitReceipt>(`receipt:${input.commitId}`);
    check(
      receipt &&
        receipt.workspaceId === input.workspaceId &&
        receipt.commitDigest === input.commitDigest,
      "not_found",
      "Synthetic receipt missing",
    );
    return success(receipt);
  }
  async applyBinding(
    ctx: D.ResourceAuthContext,
    input: D.WorkspaceBindingApplication,
  ): Promise<D.Outcome<D.WorkspaceBinding>> {
    const floor = (await this.ctx.storage.get<number>(`credential:${ctx.credentialId}`)) ?? 0;
    check(ctx.generation >= floor, "unauthenticated", "Synthetic credential floor");
    const key = `binding_request:${ctx.principalId}:${input.requestId}`;
    const digest = await hash(json(input));
    const old = await this.ctx.storage.get<{ digest: string; ack: D.WorkspaceBinding }>(key);
    if (old) {
      check(old.digest === digest, "conflict", "Synthetic changed binding request");
      if (await this.ctx.storage.get<boolean>("dropBinding"))
        throw new Error("Synthetic lost binding ack");
      return success(old.ack);
    }
    const current = await this.ctx.storage.get<D.WorkspaceBinding>("binding");
    check(
      (current?.bindingVersion ?? null) === input.expectedVersion,
      "conflict",
      "Synthetic binding CAS",
    );
    const empty: D.Manifest = { version: 1, entries: [] };
    let manifest = empty;
    let revision = "uninitialized";
    let availability: D.WorkspaceBinding["availability"] = "unknown";
    if (input.binding.config.kind === "local") {
      const cp = this.env.CONTROL_PLANE.getByName("control");
      const generation = await cp.resolveExecutorGeneration(ctx, {
        workspaceId: input.binding.workspaceId,
        bindingVersion: input.binding.bindingVersion,
        executorId: input.binding.config.executorId,
      });
      check(
        generation.ok && generation.value.executorGeneration === input.executor?.generation,
        "conflict",
        "Synthetic generation scope",
      );
      if (input.import) {
        const response = await cp.requestLocalWorkspace(ctx, {
          kind: "snapshot",
          operationId: input.requestId,
          workspaceId: input.binding.workspaceId,
          bindingVersion: input.binding.bindingVersion,
          rootBindingId: input.binding.config.rootBindingId,
          executorId: input.binding.config.executorId,
          executorGeneration: generation.value.executorGeneration,
          credential: ref(ctx),
          revision: input.import.revision,
          deadline: ctx.deadline,
        });
        check(
          response.ok && "kind" in response.value && response.value.kind === "snapshot",
          "conflict",
          "Synthetic retained snapshot unavailable",
        );
        check(
          same(response.value.result.manifest, input.import.manifest) &&
            response.value.result.revision === input.import.revision,
          "conflict",
          "Synthetic import drift",
        );
        manifest = response.value.result.manifest;
        revision = response.value.result.revision;
        availability = "available";
      }
    } else {
      revision = `fixture_revision_${input.binding.bindingVersion}`;
      availability = "available";
    }
    const manifestHash = await manifestDigest(manifest);
    const ack: D.WorkspaceBinding = { ...input.binding, revision, manifestHash, availability };
    await this.ctx.storage.transaction(async (transaction) => {
      check(
        ctx.generation >= ((await transaction.get<number>(`credential:${ctx.credentialId}`)) ?? 0),
        "unauthenticated",
        "Synthetic publication floor",
      );
      await transaction.put("binding", ack);
      await transaction.put(key, { digest, ack });
      if (availability === "available")
        await transaction.put("manifest", {
          workspaceId: ack.workspaceId,
          revision,
          manifestHash,
          manifest,
        } satisfies D.ManifestResponse);
    });
    if (await this.ctx.storage.get<boolean>("dropBinding"))
      throw new Error("Synthetic lost binding ack");
    return success(ack);
  }
  async floor(key: string): Promise<number> {
    return (await this.ctx.storage.get<number>(key)) ?? 0;
  }
  async setManifest(value: D.ManifestResponse): Promise<void> {
    await this.ctx.storage.put("manifest", value);
  }
  async ingestFacts(
    _ctx: D.FactDeliveryContext,
    input: D.FactBatch,
  ): Promise<D.Outcome<D.FactBatchAck>> {
    const acks: D.FactAck[] = [];
    for (const fact of input.facts) {
      const ack = await this.ctx.storage.transaction(async (transaction) => {
        const old = await transaction.get<D.FactAck>(`fact:${fact.factId}`);
        if (old) return old;
        const eventSeq = ((await transaction.get<number>("eventSeq")) ?? 0) + 1;
        const ack: D.FactAck = {
          factId: fact.factId,
          recipient: input.recipient,
          eventId: crypto.randomUUID().replaceAll("-", ""),
          eventSeq,
          persisted: true,
        };
        await transaction.put(`fact:${fact.factId}`, ack);
        await transaction.put("eventSeq", eventSeq);
        return ack;
      });
      acks.push(ack);
    }
    if (await this.ctx.storage.get<boolean>("drop")) throw new Error("Synthetic lost fact ack");
    return success({ acks });
  }
  async eventCount(): Promise<number> {
    return (await this.ctx.storage.get<number>("eventSeq")) ?? 0;
  }
  async manifest(
    _ctx: D.AuthContext,
    _input: D.OperationRequest<"getWorkspaceManifest">,
  ): Promise<D.Outcome<D.OperationResponse<"getWorkspaceManifest">>> {
    const result = await this.ctx.storage.get<D.ManifestResponse>("manifest");
    if (!result) throw new Error("Synthetic manifest unavailable");
    return success({ status: 200, body: result });
  }
}
