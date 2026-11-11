import { validateChunkInventory, validateTransfer } from "fortipi-contract";
import type * as D from "../boundary/dto.js";
import type { Env } from "../boundary/env.js";
import { artifactForDescriptor, artifactScope } from "./artifact-index.js";
import { contains, emptyScope, requireGrant } from "./authorization.js";
import { type Directory, valid } from "./directory.js";
import type { DispatchRecord } from "./dispatch.js";
import type { Executors } from "./executors.js";
import type { Identities } from "./identity.js";
import { type LocalReadEvidence, readEvidenceKey } from "./local-workspace.js";
import { ControlError, check, hash, id, ref, type Store, same } from "./store.js";
import type { ExecutorState } from "./tickets.js";

interface Transfer {
  descriptor: D.TransferDescriptor;
  status: D.TransferStatus;
  principal: string;
  incarnation: string;
  openRequestId: string;
  connectionEpoch: number;
  registrationId?: string;
  producerReceipt?: { status: D.TransferStatus; ack: D.DeliveryAck };
}
interface Peer {
  request: Request;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
}
interface Rendezvous {
  producer?: Peer;
  consumer?: Peer;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  running: boolean;
  ready: Promise<void>;
  matched: () => void;
  deadline: number;
  cleanup: (() => void)[];
}
/** Only scope and receipts are durable. Each matched chunk has one verified transient buffer. */
export class Relay {
  readonly store: Store;
  readonly identities: Identities;
  readonly directory: Directory;
  readonly executors: Executors;
  readonly env: Env;
  private incarnation = id();
  private active = new Map<string, Rendezvous>();
  private producerWaiters = new Map<
    string,
    {
      promise: Promise<void>;
      resolve: () => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    store: Store,
    identities: Identities,
    directory: Directory,
    executors: Executors,
    env: Env,
  ) {
    this.store = store;
    this.identities = identities;
    this.directory = directory;
    this.executors = executors;
    this.env = env;
  }
  async open(
    ctx: D.AuthContext,
    input: Omit<D.TransferDescriptor, "transferId" | "attemptId">,
    announce = true,
  ): Promise<D.TransferDescriptor> {
    this.identities.current(ctx);
    requireGrant(
      ctx,
      input.purpose === "output"
        ? "artifacts.read"
        : input.purpose === "local-stage"
          ? "workspace.write"
          : "workspace.read",
      {
        ...emptyScope(),
        workspaceIds: [input.workspaceId],
        executorIds: [input.executorId],
      },
    );
    check(
      input.deploymentId === ctx.deploymentId &&
        same(input.credential, ref(ctx)) &&
        ctx.grants.some(
          (g) =>
            (g.expiresAt === undefined || g.expiresAt > Date.now()) &&
            contains(g.resources, input.consumer),
        ),
      "unauthorized",
      "Transfer authority mismatch",
    );
    const descriptor = { ...input, transferId: id(), attemptId: id() } as D.TransferDescriptor;
    if (descriptor.purpose === "output") {
      const artifact = artifactForDescriptor(this.store, descriptor);
      requireGrant(ctx, "artifacts.read", artifactScope(artifact));
      check(
        contains(descriptor.consumer, artifactScope(artifact)),
        "unauthorized",
        "Output consumer omits artifact scope",
      );
      this.outputRegistration(ctx, descriptor, ctx.registrationId);
    }
    const grant = ctx.grants.find(
      (g) =>
        (g.expiresAt === undefined || g.expiresAt > Date.now()) &&
        contains(g.resources, input.consumer),
    );
    check(
      grant &&
        descriptor.expiresAt <=
          Math.min(
            ctx.credentialExpiresAt ?? Number.MAX_SAFE_INTEGER,
            grant.expiresAt ?? Number.MAX_SAFE_INTEGER,
          ),
      "unauthorized",
      "Transfer outlives credential or grant",
    );
    check(
      valid("transfers", "TransferDescriptor", descriptor),
      "invalid_request",
      "Invalid transfer descriptor",
    );
    validateChunkInventory(
      { chunkBytes: descriptor.chunkBytes, chunkHashes: descriptor.chunkHashes },
      descriptor.size,
    );
    validateTransfer(descriptor, Date.now());
    if (descriptor.size === 0)
      check(
        descriptor.fileSha256 === (await hash(new Uint8Array())),
        "conflict",
        "Empty file checksum mismatch",
      );
    check(
      descriptor.size <= this.directory.policy().bounds.fileBytes &&
        descriptor.chunkHashes.length <= 256,
      "payload_too_large",
      "Transfer exceeds effective bounds",
    );
    const e = this.store.get<ExecutorState>("executor", descriptor.executorId);
    check(
      e && e.generation === descriptor.executorGeneration && e.status !== "revoked",
      "unavailable_executor",
      "Transfer executor unavailable",
    );
    this.checkLimits(descriptor);
    if (descriptor.purpose === "local-read") {
      const evidence = this.store.get<LocalReadEvidence>(
        "local_read",
        readEvidenceKey(ctx, descriptor.operationId),
      );
      check(
        evidence &&
          evidence.request.kind === "read" &&
          evidence.request.workspaceId === descriptor.workspaceId &&
          evidence.request.bindingVersion === descriptor.bindingVersion &&
          evidence.request.executorId === descriptor.executorId &&
          evidence.request.executorGeneration === descriptor.executorGeneration &&
          evidence.request.revision === descriptor.baseRevision &&
          descriptor.content.kind === "workspace-file" &&
          descriptor.content.path === evidence.request.path &&
          evidence.reference.sha256 === descriptor.fileSha256 &&
          evidence.reference.size === descriptor.size &&
          same(evidence.reference.chunks, {
            chunkBytes: descriptor.chunkBytes,
            chunkHashes: descriptor.chunkHashes,
          }),
        "conflict",
        "Read descriptor requires matching actual owner metadata",
      );
      const authority = this.env.WORKSPACES.getByName(descriptor.workspaceId);
      check(
        (await authority.contractVersion) === "1.0",
        "unsupported",
        "Workspace contract mismatch",
      );
      const result = await authority.manifest(ctx, {
        operationId: "getWorkspaceManifest",
        path: { workspaceId: descriptor.workspaceId },
        query: { revision: descriptor.baseRevision },
        body: undefined,
      });
      check(result.ok && result.value.status === 200, "conflict", "Retained manifest unavailable");
      const content = descriptor.content;
      check(content.kind === "workspace-file", "invalid_request", "Read content mismatch");
      check(
        result.value.body.manifestHash === content.manifestHash &&
          result.value.body.manifest.entries.some(
            (entry) =>
              entry.path === content.path &&
              entry.type === "file" &&
              entry.sha256 === descriptor.fileSha256 &&
              entry.size === descriptor.size,
          ),
        "unauthorized",
        "Transfer is not a committed manifest member",
      );
    }
    if (descriptor.lease) {
      const reservation = this.store.get<D.TargetReservation>(
        "reservation",
        `${ctx.principalId}:${descriptor.operationId}`,
      );
      check(
        reservation &&
          same(reservation.credential, descriptor.credential) &&
          reservation.workspaceId === descriptor.workspaceId &&
          reservation.bindingVersion === descriptor.bindingVersion &&
          reservation.operationDigest === descriptor.operationDigest &&
          reservation.target.kind === "executor" &&
          reservation.target.executorId === descriptor.executorId &&
          reservation.target.generation === descriptor.executorGeneration &&
          descriptor.lease.registrationId === reservation.registrationIds.workspace,
        "unauthorized",
        "Transfer requires reserved authority",
      );
      if (reservation.ownerKind === "job")
        check(
          descriptor.jobId === reservation.jobId &&
            descriptor.executionId === reservation.executionId,
          "conflict",
          "Transfer changed reserved job execution identity",
        );
    }
    if (descriptor.jobId && !descriptor.lease) {
      const dispatch = this.store.get<DispatchRecord>("dispatch", descriptor.executionId ?? "");
      check(
        dispatch &&
          dispatch.intent.assignment.identity.jobId === descriptor.jobId &&
          dispatch.intent.assignment.identity.operationDigest === descriptor.operationDigest &&
          dispatch.intent.reservation.workspaceId === descriptor.workspaceId &&
          dispatch.intent.reservation.bindingVersion === descriptor.bindingVersion &&
          dispatch.intent.reservation.operationId === descriptor.operationId &&
          dispatch.intent.reservation.target.kind === "executor" &&
          dispatch.intent.reservation.target.executorId === descriptor.executorId &&
          dispatch.intent.reservation.target.generation === descriptor.executorGeneration &&
          dispatch.intent.assignment.identity.baseRevision === descriptor.baseRevision,
        "unauthorized",
        "Transfer job scope mismatch",
      );
    }
    this.executors.channel(descriptor.executorId, descriptor.executorGeneration);
    await this.store.arm(descriptor.expiresAt);
    this.identities.current(ctx);
    this.store.put(
      "transfer",
      descriptor.transferId,
      {
        descriptor,
        status: {
          transferId: descriptor.transferId,
          attemptId: descriptor.attemptId,
          state: "waiting",
          verifiedChunks: [],
          bytes: 0,
        },
        principal: ctx.principalId,
        incarnation: this.incarnation,
        openRequestId: id(),
        connectionEpoch: e.epoch,
        ...(ctx.registrationId ? { registrationId: ctx.registrationId } : {}),
      } satisfies Transfer,
      "",
      "",
      descriptor.expiresAt,
    );
    if (announce) await this.announce(ctx, descriptor);
    return descriptor;
  }
  private outputRegistration(
    ctx: D.AuthContext,
    d: D.TransferDescriptor,
    registrationId: string | undefined,
  ): void {
    const registration = registrationId
      ? this.store.get<D.AuthorityRegistration>("recipient", registrationId)
      : undefined;
    check(
      registration &&
        same(registration.credential, ref(ctx)) &&
        registration.recipient.kind === "workspace" &&
        registration.recipient.id === d.workspaceId &&
        registration.executor?.executorId === d.executorId &&
        registration.executor.generation === d.executorGeneration &&
        contains(registration.resources, artifactScope(artifactForDescriptor(this.store, d))),
      "unauthorized",
      "Output requires current registered reader scope",
    );
  }
  async announce(ctx: D.AuthContext, d: D.TransferDescriptor): Promise<void> {
    const row = this.authorized(ctx, d.transferId, d.attemptId);
    const frame: D.ExecutorFrame = {
      type: "transfer.open",
      requestId: row.openRequestId,
      payload: d,
    };
    if (d.size !== 0) {
      this.executors.send(d.executorId, d.executorGeneration, frame);
      return;
    }
    const receipt = this.waitForReceipt(ctx, d);
    try {
      this.executors.send(d.executorId, d.executorGeneration, frame);
    } catch {
      this.abortAttempt(d.transferId, d.attemptId, "Transfer owner unavailable");
    }
    await receipt;
  }
  private async waitForReceipt(ctx: D.AuthContext, d: D.TransferDescriptor): Promise<void> {
    const row = this.authorized(ctx, d.transferId, d.attemptId);
    check(
      row.incarnation === this.incarnation &&
        row.status.state !== "interrupted" &&
        row.status.state !== "expired",
      "interrupted",
      "Transfer owner proof unavailable",
    );
    if (row.producerReceipt?.status.state === "verified" && row.status.state === "verified") return;
    let waiter = this.producerWaiters.get(d.transferId);
    if (!waiter) {
      check(
        this.producerWaiters.size < 16,
        "unavailable",
        "Producer acknowledgment window exhausted",
      );
      let resolveReceipt: () => void = () => undefined;
      let rejectReceipt: (error: Error) => void = () => undefined;
      const promise = new Promise<void>((resolve, reject) => {
        resolveReceipt = resolve;
        rejectReceipt = reject;
      });
      const timer = setTimeout(
        () =>
          this.abortAttempt(d.transferId, d.attemptId, "Transfer owner acknowledgment deadline"),
        Math.max(
          1,
          Math.min(
            10000,
            ctx.deadline - Date.now(),
            d.deadline - Date.now(),
            d.expiresAt - Date.now(),
          ),
        ),
      );
      waiter = { promise, resolve: resolveReceipt, reject: rejectReceipt, timer };
      this.producerWaiters.set(d.transferId, waiter);
    }
    await waiter.promise;
    this.authorized(ctx, d.transferId, d.attemptId);
    check(
      this.store.get<Transfer>("transfer", d.transferId)?.status.state === "verified",
      "interrupted",
      "Transfer owner did not verify the retained file",
    );
  }
  async receiveStatus(ctx: D.AuthContext, input: D.ExecutorDelivery): Promise<D.DeliveryAck> {
    check(input.frame.type === "transfer.status", "invalid_request", "Producer status required");
    const status = input.frame.payload;
    const row = this.authorized(ctx, status.transferId, status.attemptId, false, true);
    const executor = this.store.get<ExecutorState>("executor", input.executorId);
    check(
      ctx.role === "executor" &&
        input.executorId === row.descriptor.executorId &&
        input.generation === row.descriptor.executorGeneration &&
        executor?.epoch === input.connectionEpoch &&
        row.connectionEpoch === input.connectionEpoch &&
        input.frame.requestId === row.openRequestId &&
        row.incarnation === this.incarnation,
      "unauthenticated",
      "Producer status correlation mismatch",
    );
    if (row.producerReceipt) {
      check(same(row.producerReceipt.status, status), "conflict", "Producer status changed");
      return row.producerReceipt.ack;
    }
    check(
      status.state === "verified" || status.state === "interrupted",
      "conflict",
      "Terminal producer status required",
    );
    if (status.state === "verified") {
      check(
        row.status.state !== "interrupted" &&
          row.status.state !== "expired" &&
          status.bytes === row.descriptor.size &&
          same(
            [...status.verifiedChunks].sort((a, b) => a - b),
            row.descriptor.chunkHashes.map((_, i) => i),
          ) &&
          status.bytes === row.status.bytes &&
          same(
            [...row.status.verifiedChunks].sort((a, b) => a - b),
            [...status.verifiedChunks].sort((a, b) => a - b),
          ),
        "conflict",
        "Producer status cannot replace actual chunk receipts",
      );
      this.checkLimits(row.descriptor);
    }
    const ack: D.DeliveryAck = { deliveryId: id(), sequence: 0, persisted: true };
    row.producerReceipt = { status, ack };
    if (status.state === "verified") row.status = { ...row.status, state: "verified" };
    this.store.put("transfer", status.transferId, row, "", "", row.descriptor.expiresAt);
    if (status.state === "interrupted")
      this.abortAttempt(status.transferId, status.attemptId, "Producer interrupted");
    else {
      const waiter = this.producerWaiters.get(status.transferId);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.producerWaiters.delete(status.transferId);
        waiter.resolve();
      }
    }
    return ack;
  }
  private authorized(
    ctx: D.AuthContext,
    transferId: string,
    attemptId: string,
    allowExpired = false,
    status = false,
  ): Transfer {
    const c = this.identities.current(ctx);
    const row = this.store.get<Transfer>("transfer", transferId);
    check(row && row.descriptor.attemptId === attemptId, "not_found", "Transfer unavailable");
    const d = row.descriptor;
    requireGrant(
      ctx,
      ctx.role === "executor"
        ? status
          ? "transfers.status"
          : d.direction === "to-executor"
            ? "transfers.input"
            : "transfers.output"
        : d.purpose === "local-stage"
          ? "workspace.write"
          : d.purpose === "output"
            ? "artifacts.read"
            : "workspace.read",
      d.purpose === "output"
        ? {
            ...artifactScope(artifactForDescriptor(this.store, d)),
            actions: ctx.role === "executor" ? [] : ["artifacts.read"],
          }
        : { ...emptyScope(), workspaceIds: [d.workspaceId], executorIds: [d.executorId] },
    );
    const source = this.store.get<import("./identity.js").CredentialRecord>(
      "credential",
      d.credential.credentialId,
    );
    check(
      source?.status === "active" &&
        source.generation === d.credential.generation &&
        source.grantVersion === d.credential.grantVersion &&
        (source.expiresAt === null || source.expiresAt > Date.now()),
      "unauthenticated",
      "Transfer authority revoked",
    );
    const sourceCtx: D.AuthContext = {
      ...d.credential,
      principalId: source.principalId,
      role: source.role,
      grants: source.grants,
      deploymentId: d.deploymentId,
      requestId: ctx.requestId,
      authenticatedAt: Date.now(),
      credentialExpiresAt: source.expiresAt,
      deadline: Math.min(d.deadline, Date.now() + 30000),
    };
    requireGrant(
      sourceCtx,
      d.purpose === "output"
        ? "artifacts.read"
        : d.purpose === "local-stage"
          ? "workspace.write"
          : "workspace.read",
      d.consumer,
    );
    if (d.purpose === "output") this.outputRegistration(sourceCtx, d, row.registrationId);
    const e = this.store.get<ExecutorState>("executor", d.executorId);
    check(
      e && e.status !== "revoked" && e.generation === d.executorGeneration,
      "unauthenticated",
      "Transfer executor revoked",
    );
    if (d.purpose === "output" || d.size === 0 || d.purpose === "local-stage")
      check(
        e.epoch === row.connectionEpoch,
        "interrupted",
        "Transfer owner connection changed; authorize a new attempt",
      );
    check(
      (c.role === "executor" && c.executorId === d.executorId) ||
        (ctx.principalId === row.principal && same(ref(ctx), d.credential)),
      "unauthorized",
      "Transfer peer mismatch",
    );
    check(
      allowExpired || Date.now() < Math.min(d.expiresAt, d.deadline),
      "interrupted",
      "Transfer expired",
    );
    if (!status) this.checkLimits(d);
    return row;
  }
  private checkLimits(descriptor: D.TransferDescriptor): void {
    const caps = this.executors.transferLimits(
      descriptor.executorId,
      descriptor.executorGeneration,
    );
    check(
      descriptor.chunkBytes <= caps.chunkBytes &&
        descriptor.size <=
          Math.min(
            this.directory.policy().bounds.fileBytes,
            descriptor.purpose === "output" ? caps.artifactBytes : caps.fileBytes,
          ),
      "payload_too_large",
      "Transfer exceeds current registered executor bounds",
    );
  }
  observe(ctx: D.AuthContext, input: { transferId: string; attemptId: string }): D.TransferStatus {
    const row = this.authorized(ctx, input.transferId, input.attemptId, true, true);
    if (
      row.status.state !== "verified" &&
      Date.now() >= Math.min(row.descriptor.expiresAt, row.descriptor.deadline)
    )
      return { ...row.status, state: "expired" };
    return row.incarnation !== this.incarnation && row.status.state !== "verified"
      ? { ...row.status, state: "interrupted", reason: "Relay restarted; authorize a new attempt" }
      : row.status;
  }
  validateRead(ctx: D.AuthContext, input: D.LocalReadRequest): void {
    for (const descriptor of input.transfers ?? []) {
      const row = this.authorized(ctx, descriptor.transferId, descriptor.attemptId);
      check(
        same(row.descriptor, descriptor) &&
          row.incarnation === this.incarnation &&
          row.status.state !== "interrupted" &&
          row.status.state !== "expired" &&
          descriptor.purpose === "local-read" &&
          descriptor.direction === "from-executor" &&
          descriptor.workspaceId === input.workspaceId &&
          descriptor.bindingVersion === input.bindingVersion &&
          descriptor.executorId === input.executorId &&
          descriptor.executorGeneration === input.executorGeneration &&
          descriptor.operationId === input.operationId &&
          descriptor.baseRevision === input.revision &&
          same(descriptor.credential, input.credential) &&
          descriptor.content.kind === "workspace-file" &&
          (input.kind !== "read" || descriptor.content.path === input.path),
        "conflict",
        "Read transfer does not match its persisted request scope",
      );
    }
  }
  async chunk(
    ctx: D.AuthContext,
    request: Request,
    transferId: string,
    attemptId: string,
    index: number,
  ): Promise<Response> {
    const row = this.authorized(ctx, transferId, attemptId);
    const d = row.descriptor;
    check(
      row.status.state !== "interrupted" && row.status.state !== "expired",
      "interrupted",
      "Authorize a new transfer attempt after interruption",
    );
    check(
      row.incarnation === this.incarnation,
      "interrupted",
      "Relay restarted; authorize a new attempt",
    );
    check(
      Number.isSafeInteger(index) && index >= 0 && index < d.chunkHashes.length,
      "invalid_request",
      "Invalid transfer chunk",
    );
    const executor = ctx.role === "executor";
    const producer = d.direction === "from-executor" ? executor : !executor;
    check(
      producer ? request.method === "PUT" : request.method === "GET",
      "unauthorized",
      "Wrong transfer direction",
    );
    const length = Math.min(d.chunkBytes, d.size - index * d.chunkBytes);
    const url = new URL(request.url);
    // Consumer GET uses only attemptId; its chunk identity comes from the
    // retained descriptor. Producer PUT must declare the exact byte tuple.
    if (producer)
      check(
        Number(url.searchParams.get("length")) === length &&
          url.searchParams.get("sha256") === d.chunkHashes[index],
        "conflict",
        "Chunk identity mismatch",
      );
    const receipt = this.store.get<{ length: number; sha256: string }>(
      "chunk_receipt",
      `${attemptId}:${index}`,
    );
    if (receipt) {
      check(
        producer && same(receipt, { length, sha256: d.chunkHashes[index] }),
        "conflict",
        "Completed GET requires a new authorized attempt",
      );
      if (
        d.purpose === "local-stage" &&
        d.direction === "to-executor" &&
        row.status.verifiedChunks.length === d.chunkHashes.length
      )
        await this.waitForReceipt(ctx, d);
      return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
    }
    const key = `${transferId}:${attemptId}:${index}`;
    let rendezvous = this.active.get(key);
    if (!rendezvous) {
      check(
        this.active.size < Math.min(4, this.directory.policy().bounds.transferConcurrency) &&
          [...this.active.keys()].filter((k) => k.startsWith(`${transferId}:`)).length < 2,
        "unavailable",
        "Relay concurrency exhausted",
      );
      const controller = new AbortController();
      const timer = setTimeout(
        () => this.interrupt(key, "Rendezvous deadline"),
        Math.max(1, Math.min(10000, d.expiresAt - Date.now(), ctx.deadline - Date.now())),
      );
      let matched: () => void = () => undefined;
      const ready = new Promise<void>((resolve) => {
        matched = resolve;
      });
      rendezvous = {
        controller,
        timer,
        running: false,
        ready,
        matched,
        deadline: Math.min(Date.now() + 30000, d.expiresAt, d.deadline, ctx.deadline),
        cleanup: [],
      };
      this.active.set(key, rendezvous);
    }
    const pair = rendezvous;
    pair.deadline = Math.min(pair.deadline, ctx.deadline);
    check(producer ? !pair.producer : !pair.consumer, "conflict", "Transfer peer already claimed");
    let resolvePeer: (response: Response) => void = () => undefined;
    let rejectPeer: (error: Error) => void = () => undefined;
    const result = new Promise<Response>((resolve, reject) => {
      resolvePeer = resolve;
      rejectPeer = reject;
    });
    const peer = { request, resolve: resolvePeer, reject: rejectPeer };
    if (producer) pair.producer = peer;
    else pair.consumer = peer;
    const abort = (): void => this.interrupt(key, "Peer disconnected");
    request.signal.addEventListener("abort", abort, { once: true });
    pair.cleanup.push(() => request.signal.removeEventListener("abort", abort));
    try {
      if (pair.producer && pair.consumer) pair.matched();
      // The producer request owns and awaits pumping; the consumer can return its stream immediately.
      if (producer) {
        await pair.ready;
        if (!pair.controller.signal.aborted) {
          pair.running = true;
          clearTimeout(pair.timer);
          pair.timer = setTimeout(
            () => this.interrupt(key, "Chunk deadline"),
            Math.max(1, pair.deadline - Date.now()),
          );
          await this.pump(key, pair, row, index, length, ctx);
        }
      }
      return await result;
    } finally {
      if (producer) for (const cleanup of pair.cleanup.splice(0)) cleanup();
    }
  }
  private async pump(
    key: string,
    pair: Rendezvous,
    row: Transfer,
    index: number,
    length: number,
    ctx: D.AuthContext,
  ): Promise<void> {
    const producer = pair.producer;
    const consumer = pair.consumer;
    check(producer && consumer, "internal", "Missing relay peer");
    const d = row.descriptor;
    let idle: ReturnType<typeof setTimeout> | undefined;
    try {
      const reader = producer.request.body?.getReader();
      check(reader, "invalid_request", "Missing producer body");
      const bytes = new Uint8Array(length);
      let offset = 0;
      const cancel = (): void => {
        void reader.cancel().catch(() => undefined);
      };
      pair.controller.signal.addEventListener("abort", cancel, { once: true });
      try {
        for (;;) {
          const timeout = setTimeout(() => this.interrupt(key, "Producer idle deadline"), 10000);
          let part: ReadableStreamReadResult<Uint8Array>;
          try {
            part = await reader.read();
          } finally {
            clearTimeout(timeout);
          }
          check(!pair.controller.signal.aborted, "interrupted", "Relay interrupted");
          if (part.done) break;
          check(offset + part.value.length <= length, "payload_too_large", "Chunk length exceeded");
          bytes.set(part.value, offset);
          offset += part.value.length;
        }
      } finally {
        pair.controller.signal.removeEventListener("abort", cancel);
        await reader.cancel().catch(() => undefined);
      }
      check(
        offset === length && (await hash(bytes)) === d.chunkHashes[index],
        "conflict",
        "Chunk checksum mismatch",
      );
      this.authorized(ctx, d.transferId, d.attemptId);
      row.status.state = "streaming";
      this.store.put("transfer", d.transferId, row, "", "", d.expiresAt);
      let consumedResolve: () => void = () => undefined;
      let consumedReject: (reason: Error) => void = () => undefined;
      const consumed = new Promise<void>((resolve, reject) => {
        consumedResolve = resolve;
        consumedReject = reject;
      });
      let cursor = 0;
      const stream = new ReadableStream<Uint8Array>(
        {
          start: (controller) => {
            pair.controller.signal.addEventListener(
              "abort",
              () => {
                controller.error(new Error("Relay interrupted"));
                consumedReject(new Error("Relay interrupted"));
              },
              { once: true },
            );
          },
          pull: (controller) => {
            if (idle) clearTimeout(idle);
            if (pair.controller.signal.aborted) {
              controller.error(new Error("Relay interrupted"));
              return;
            }
            try {
              this.authorized(ctx, d.transferId, d.attemptId);
            } catch {
              this.interrupt(key, "Transfer authority changed");
              return;
            }
            const end = Math.min(length, cursor + 65536);
            controller.enqueue(bytes.subarray(cursor, end));
            cursor = end;
            if (cursor === length) {
              controller.close();
              consumedResolve();
            } else idle = setTimeout(() => this.interrupt(key, "Consumer idle deadline"), 10000);
          },
          cancel: () => {
            this.interrupt(key, "Consumer cancelled");
            consumedReject(new Error("Consumer cancelled"));
          },
        },
        { highWaterMark: 0 },
      );
      idle = setTimeout(() => this.interrupt(key, "Consumer idle deadline"), 10000);
      const fixed = new FixedLengthStream(length);
      void stream.pipeTo(fixed.writable).catch(() => undefined);
      consumer.resolve(
        new Response(fixed.readable, {
          headers: {
            "Cache-Control": "no-store",
            "Content-Type": "application/octet-stream",
            "Content-Length": String(length),
            "X-Content-Sha256": d.chunkHashes[index] ?? "",
          },
        }),
      );
      await consumed;
      if (idle) clearTimeout(idle);
      this.authorized(ctx, d.transferId, d.attemptId);
      this.store.tx(() => {
        const latest = this.store.get<Transfer>("transfer", d.transferId);
        check(latest, "interrupted", "Transfer missing");
        this.store.put("chunk_receipt", `${d.attemptId}:${index}`, {
          length,
          sha256: d.chunkHashes[index],
        });
        latest.status.verifiedChunks.push(index);
        latest.status.bytes += length;
        latest.status.state =
          latest.status.verifiedChunks.length === d.chunkHashes.length &&
          !(d.purpose === "local-stage" && d.direction === "to-executor")
            ? "verified"
            : "waiting";
        this.store.put("transfer", d.transferId, latest, "", "", d.expiresAt);
      });
      // GET has already reached EOF. The staging consumer can now fsync and
      // persist verified_blob before its correlated receipt releases the final
      // input producer. Output producers must finish PUT before sending status.
      const completed = this.store.get<Transfer>("transfer", d.transferId);
      if (
        d.purpose === "local-stage" &&
        d.direction === "to-executor" &&
        completed?.status.verifiedChunks.length === d.chunkHashes.length
      )
        await this.waitForReceipt(ctx, d);
      producer.resolve(
        new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } }),
      );
    } catch {
      this.interrupt(key, "Transfer interrupted");
    } finally {
      if (idle) clearTimeout(idle);
      clearTimeout(pair.timer);
      this.active.delete(key);
    }
  }
  private interrupt(key: string, reason: string): void {
    if (!this.active.has(key)) return;
    const [transferId = "", attemptId = ""] = key.split(":");
    this.abortAttempt(transferId, attemptId, reason);
  }
  abortAttempt(transferId: string, attemptId: string, reason = "Transfer interrupted"): void {
    const prefix = `${transferId}:${attemptId}:`;
    const pairs = [...this.active].filter(([activeKey]) => activeKey.startsWith(prefix));
    for (const [activeKey] of pairs) this.active.delete(activeKey);
    for (const [, pair] of pairs) {
      pair.controller.abort();
      for (const cleanup of pair.cleanup.splice(0)) cleanup();
      pair.matched();
      pair.producer?.reject(new ControlError("interrupted", reason));
      pair.consumer?.reject(new ControlError("interrupted", reason));
      clearTimeout(pair.timer);
    }
    this.executors.interruptTransfer(transferId, attemptId);
    const waiter = this.producerWaiters.get(transferId);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.producerWaiters.delete(transferId);
      waiter.reject(new ControlError("interrupted", reason));
    }
    const row = this.store.get<Transfer>("transfer", transferId);
    if (row) {
      row.status = { ...row.status, state: "interrupted", reason };
      this.store.put("transfer", transferId, row);
    }
  }
  revoke(subject: D.Invalidation["subject"]): void {
    for (const transferId of this.producerWaiters.keys()) {
      const row = this.store.get<Transfer>("transfer", transferId);
      if (
        row &&
        (subject.kind === "credential"
          ? row.descriptor.credential.credentialId === subject.credentialId
          : row.descriptor.executorId === subject.executorId)
      )
        this.abortAttempt(transferId, row.descriptor.attemptId, "Transfer authority revoked");
    }
    for (const key of this.active.keys()) {
      const row = this.store.get<Transfer>("transfer", key.split(":")[0] ?? "");
      if (
        row &&
        (subject.kind === "credential"
          ? row.descriptor.credential.credentialId === subject.credentialId
          : row.descriptor.executorId === subject.executorId)
      )
        this.interrupt(key, "Transfer authority revoked");
    }
  }
  expire(transferId: string): void {
    for (const key of this.active.keys())
      if (key.startsWith(`${transferId}:`)) this.interrupt(key, "Transfer expired");
    const row = this.store.get<Transfer>("transfer", transferId);
    if (row) {
      row.status = {
        ...row.status,
        state: row.status.state === "verified" ? "verified" : "expired",
      };
      this.store.put("transfer", transferId, row);
    }
  }
}
