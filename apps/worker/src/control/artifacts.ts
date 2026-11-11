import { createHash } from "node:crypto";
import type * as D from "../boundary/dto.js";
import { artifactScope, type NativeArtifact } from "./artifact-index.js";
import { contains, requireGrant } from "./authorization.js";
import type { Identities } from "./identity.js";
import type { Relay } from "./relay.js";
import { check, ref, type Store, same } from "./store.js";
import type { Tickets } from "./tickets.js";

/** Reads retained owner bytes through fresh two-live-request attempts. No cloud blob is created. */
export class Artifacts {
  readonly store: Store;
  readonly identities: Identities;
  readonly relay: Relay;
  readonly tickets: Tickets;
  constructor(store: Store, identities: Identities, relay: Relay, tickets: Tickets) {
    this.store = store;
    this.identities = identities;
    this.relay = relay;
    this.tickets = tickets;
  }
  private authorize(ctx: D.AuthContext, row: NativeArtifact): void {
    this.identities.current(ctx);
    const scope = artifactScope(row);
    requireGrant(ctx, "artifacts.read", scope);
    const registration = ctx.registrationId
      ? this.store.get<D.AuthorityRegistration>("recipient", ctx.registrationId)
      : undefined;
    check(
      registration &&
        same(registration.credential, ref(ctx)) &&
        registration.recipient.kind === "workspace" &&
        registration.recipient.id === row.reference.workspaceId &&
        registration.executor &&
        registration.executor.executorId === row.reference.owner.executorId &&
        row.identity.target.kind === "executor" &&
        registration.executor.generation === row.identity.target.generation &&
        contains(registration.resources, scope),
      "unauthorized",
      "Artifact requires registered current reader",
    );
    const limits = this.relay.executors.transferLimits(
      registration.executor.executorId,
      registration.executor.generation,
    );
    check(
      row.reference.chunks &&
        row.reference.chunks.chunkBytes <= limits.chunkBytes &&
        row.reference.size <=
          Math.min(
            limits.artifactBytes,
            this.relay.directory.policy().bounds.artifactBytes,
            this.relay.directory.policy().bounds.fileBytes,
          ),
      "payload_too_large",
      "Artifact exceeds current registered bounds",
    );
    check(
      row.reference.owner.expiresAt === undefined || row.reference.owner.expiresAt > Date.now(),
      "not_found",
      "Artifact retention expired",
    );
  }
  async fetch(
    ctx: D.AuthContext,
    request: Request,
    workspaceId: string,
    artifactId: string,
  ): Promise<Response> {
    this.identities.current(ctx);
    requireGrant(ctx, "artifacts.read", {
      agentIds: [],
      conversationIds: [],
      workspaceIds: [workspaceId],
      executorIds: [],
      backendIds: [],
      tools: [],
      actions: [],
    });
    check(request.method === "GET", "invalid_request", "Artifact requires GET");
    const incoming = ctx.registrationId
      ? this.store.get<D.AuthorityRegistration>("recipient", ctx.registrationId)
      : undefined;
    check(
      incoming &&
        same(incoming.credential, ref(ctx)) &&
        incoming.recipient.kind === "workspace" &&
        incoming.recipient.id === workspaceId &&
        incoming.resources.workspaceIds.includes(workspaceId),
      "unauthorized",
      "Artifact caller requires its current Workspace registration",
    );
    const row = this.store.get<NativeArtifact>("native_artifact", artifactId);
    check(row && row.reference.workspaceId === workspaceId, "not_found", "Artifact unavailable");
    requireGrant(ctx, "artifacts.read", artifactScope(row));
    check(row.identity.target.kind === "executor", "conflict", "Artifact target missing");
    const size = row.reference.size;
    const url = new URL(request.url);
    check(
      [...url.searchParams.keys()].every(
        (key) =>
          (key === "revision" || key === "range[start]" || key === "range[end]") &&
          url.searchParams.getAll(key).length === 1,
      ),
      "invalid_request",
      "Unsupported artifact query",
    );
    const revision = url.searchParams.get("revision");
    check(
      revision === null || revision === row.reference.revision,
      "conflict",
      "Artifact revision does not match retained output",
    );
    let start = 0;
    let end = size - 1;
    const rawRange = request.headers.get("Range");
    const queryStart = url.searchParams.get("range[start]");
    const queryEnd = url.searchParams.get("range[end]");
    const partial = rawRange !== null || queryStart !== null || queryEnd !== null;
    if (partial) {
      const match = rawRange === null ? null : /^bytes=(\d+)-(\d+)$/.exec(rawRange);
      check(
        rawRange === null || match,
        "invalid_request",
        "Only a bounded single byte range is supported",
      );
      const first = match?.[1] ?? queryStart;
      const last = match?.[2] ?? queryEnd;
      check(
        first !== null &&
          first !== undefined &&
          last !== null &&
          last !== undefined &&
          /^\d+$/.test(first) &&
          /^\d+$/.test(last),
        "invalid_request",
        "Range endpoints required",
      );
      start = Number(first);
      end = Number(last);
      check(
        Number.isSafeInteger(start) &&
          Number.isSafeInteger(end) &&
          start >= 0 &&
          end >= start &&
          (queryStart === null || Number(queryStart) === start) &&
          (queryEnd === null || Number(queryEnd) === end),
        "invalid_request",
        "Artifact range outside retained bytes",
      );
      check(end < size, "range_not_satisfiable", "Artifact range outside retained bytes");
    }
    const registration = this.tickets.register(ctx, {
      credential: ref(ctx),
      recipient: incoming.recipient,
      resources: artifactScope(row),
      executor: {
        executorId: row.identity.target.executorId,
        generation: row.identity.target.generation,
      },
    });
    ctx = { ...ctx, registrationId: registration.registrationId };
    this.authorize(ctx, row);
    let digest = row.reference.sha256;
    if (partial) {
      const selected = createHash("sha256");
      let position = 0;
      for await (const bytes of this.pass(ctx, row, request.signal)) {
        const from = Math.max(0, start - position);
        const to = Math.min(bytes.length, end + 1 - position);
        if (to > from) selected.update(bytes.subarray(from, to));
        position += bytes.length;
      }
      digest = selected.digest("hex");
    }
    // Prime the consumer before announcing the producer, including the empty-file proof wait.
    const source = this.selected(ctx, row, request.signal, start, end, digest);
    const first = await source.next();
    this.authorize(ctx, row);
    let initial = first;
    const body = new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          try {
            this.authorize(ctx, row);
            const part = initial;
            initial = { done: true, value: undefined };
            if (part.done) {
              controller.close();
              return;
            }
            controller.enqueue(part.value);
            initial = await source.next();
          } catch (error) {
            controller.error(error);
            await source.return(undefined).catch(() => undefined);
          }
        },
        cancel: async () => {
          await source.return(undefined);
        },
      },
      { highWaterMark: 0 },
    );
    const headers = new Headers({
      "Cache-Control": "no-store",
      "Content-Type": "application/octet-stream",
      "Content-Length": String(partial ? end - start + 1 : size),
      "X-Content-Sha256": digest,
      "Accept-Ranges": "bytes",
    });
    if (partial) headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
    const fixed = new FixedLengthStream(partial ? end - start + 1 : size);
    void body.pipeTo(fixed.writable).catch(() => undefined);
    return new Response(fixed.readable, { status: partial ? 206 : 200, headers });
  }
  private async *selected(
    ctx: D.AuthContext,
    row: NativeArtifact,
    signal: AbortSignal,
    start: number,
    end: number,
    expected: string,
  ): AsyncGenerator<Uint8Array, void> {
    let pending: Uint8Array | undefined;
    let position = 0;
    const selected = createHash("sha256");
    for await (const bytes of this.pass(ctx, row, signal)) {
      const from = Math.max(0, start - position);
      const to = Math.min(bytes.length, end + 1 - position);
      if (to > from) {
        const part = bytes.slice(from, to);
        selected.update(part);
        if (pending) yield pending;
        pending = part;
      }
      position += bytes.length;
    }
    check(selected.digest("hex") === expected, "conflict", "Artifact response checksum changed");
    this.authorize(ctx, row);
    if (pending) yield pending;
  }
  private async *pass(
    ctx: D.AuthContext,
    row: NativeArtifact,
    signal: AbortSignal,
  ): AsyncGenerator<Uint8Array, void> {
    this.authorize(ctx, row);
    check(!signal.aborted, "interrupted", "Artifact reader cancelled");
    const reference = row.reference;
    check(
      row.identity.target.kind === "executor" &&
        reference.chunks &&
        reference.outputSource &&
        reference.artifactId,
      "conflict",
      "Retained artifact metadata missing",
    );
    const expiresAt = Math.min(
      ctx.deadline,
      Date.now() + 30000,
      ctx.credentialExpiresAt ?? Number.MAX_SAFE_INTEGER,
      ...ctx.grants
        .filter((g) => g.expiresAt !== undefined && contains(g.resources, artifactScope(row)))
        .map((g) => g.expiresAt ?? Number.MAX_SAFE_INTEGER),
      reference.owner.expiresAt ?? Number.MAX_SAFE_INTEGER,
    );
    const descriptor = await this.relay.open(
      ctx,
      {
        deploymentId: ctx.deploymentId,
        direction: "from-executor",
        purpose: "output",
        workspaceId: reference.workspaceId,
        bindingVersion: row.bindingVersion,
        operationId: row.operationId,
        operationDigest: row.identity.operationDigest,
        jobId: row.identity.jobId,
        executionId: row.identity.executionId,
        executorId: row.identity.target.executorId,
        executorGeneration: row.identity.target.generation,
        credential: ref(ctx),
        consumer: artifactScope(row),
        baseRevision: row.identity.baseRevision,
        content: {
          kind: "job-output",
          artifactId: reference.artifactId,
          stream: reference.outputSource.stream,
        },
        fileSha256: reference.sha256,
        size: reference.size,
        chunkBytes: reference.chunks.chunkBytes,
        chunkHashes: reference.chunks.chunkHashes,
        expiresAt,
        deadline: Math.min(ctx.deadline, expiresAt),
      },
      false,
    );
    const abort = (): void =>
      this.relay.abortAttempt(
        descriptor.transferId,
        descriptor.attemptId,
        "Artifact reader cancelled",
      );
    signal.addEventListener("abort", abort, { once: true });
    const chunkRequest = (index: number): Promise<Response> =>
      this.relay.chunk(
        ctx,
        new Request(
          `https://control.internal/internal/transfers/${descriptor.transferId}/peer/chunks/${index}?attemptId=${descriptor.attemptId}&length=${Math.min(descriptor.chunkBytes, descriptor.size - index * descriptor.chunkBytes)}&sha256=${descriptor.chunkHashes[index]}`,
          { signal },
        ),
        descriptor.transferId,
        descriptor.attemptId,
        index,
      );
    let complete = false;
    try {
      const initial = descriptor.size > 0 ? chunkRequest(0) : undefined;
      // Attach a handler immediately; a synchronous authority refusal must not leak a rejected peer promise.
      initial?.catch(() => undefined);
      await this.relay.announce(ctx, descriptor);
      this.authorize(ctx, row);
      const whole = createHash("sha256");
      let size = 0;
      for (let index = 0; index < descriptor.chunkHashes.length; index++) {
        this.authorize(ctx, row);
        const response = await (index === 0 ? initial : chunkRequest(index));
        check(response?.status === 200, "interrupted", "Artifact chunk unavailable");
        const reader = response.body?.getReader();
        check(reader, "interrupted", "Artifact chunk body missing");
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            check(!signal.aborted, "interrupted", "Artifact reader cancelled");
            this.authorize(ctx, row);
            size += part.value.length;
            check(size <= reference.size, "conflict", "Artifact length exceeded");
            whole.update(part.value);
            yield part.value;
          }
        } finally {
          await reader.cancel().catch(() => undefined);
        }
      }
      check(
        size === reference.size && whole.digest("hex") === reference.sha256,
        "conflict",
        "Artifact whole-file checksum mismatch",
      );
      this.authorize(ctx, row);
      complete = true;
    } finally {
      signal.removeEventListener("abort", abort);
      if (!complete) this.relay.abortAttempt(descriptor.transferId, descriptor.attemptId);
    }
  }
}
