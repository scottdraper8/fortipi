import { validateChunkInventory, validateTransfer } from "fortipi-contract";
import type * as D from "../boundary/dto.js";
import type { Env } from "../boundary/env.js";
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
  ): Promise<D.TransferDescriptor> {
    this.identities.current(ctx);
    requireGrant(ctx, input.purpose === "local-stage" ? "workspace.write" : "workspace.read", {
      ...emptyScope(),
      workspaceIds: [input.workspaceId],
      executorIds: [input.executorId],
    });
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
          state: descriptor.size === 0 ? "verified" : "waiting",
          verifiedChunks: [],
          bytes: 0,
        },
        principal: ctx.principalId,
        incarnation: this.incarnation,
      } satisfies Transfer,
      "",
      "",
      descriptor.expiresAt,
    );
    this.executors.send(descriptor.executorId, descriptor.executorGeneration, {
      type: "transfer.open",
      requestId: id(),
      payload: descriptor,
    });
    return descriptor;
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
          : "workspace.read",
      { ...emptyScope(), workspaceIds: [d.workspaceId], executorIds: [d.executorId] },
    );
    const source = this.store.get<import("./identity.js").CredentialRecord>(
      "credential",
      d.credential.credentialId,
    );
    check(
      source?.status === "active" && source.generation === d.credential.generation,
      "unauthenticated",
      "Transfer authority revoked",
    );
    const e = this.store.get<ExecutorState>("executor", d.executorId);
    check(
      e && e.status !== "revoked" && e.generation === d.executorGeneration,
      "unauthenticated",
      "Transfer executor revoked",
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
    const length = Math.min(d.chunkBytes, d.size - index * d.chunkBytes);
    const url = new URL(request.url);
    check(
      Number(url.searchParams.get("length")) === length &&
        url.searchParams.get("sha256") === d.chunkHashes[index],
      "conflict",
      "Chunk identity mismatch",
    );
    const executor = ctx.role === "executor";
    const producer = d.direction === "from-executor" ? executor : !executor;
    check(
      producer ? request.method === "PUT" : request.method === "GET",
      "unauthorized",
      "Wrong transfer direction",
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
      consumer.resolve(
        new Response(stream, {
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
          latest.status.verifiedChunks.length === d.chunkHashes.length ? "verified" : "waiting";
        this.store.put("transfer", d.transferId, latest, "", "", d.expiresAt);
      });
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
    const row = this.store.get<Transfer>("transfer", transferId);
    if (row) {
      row.status = { ...row.status, state: "interrupted", reason };
      this.store.put("transfer", transferId, row);
    }
  }
  revoke(subject: D.Invalidation["subject"]): void {
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
