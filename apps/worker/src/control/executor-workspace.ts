import { createHash } from "node:crypto";
import { effectiveLimits, manifestDigest, validateUploadBlobs, wireLimits } from "fortipi-contract";
import type * as D from "../boundary/dto.js";
import type { Env } from "../boundary/env.js";
import { contains, emptyScope, requireGrant } from "./authorization.js";
import type { Bindings } from "./bindings.js";
import { type Directory, valid } from "./directory.js";
import { type DispatchRecord, sameExecution } from "./dispatch.js";
import type { Executors } from "./executors.js";
import type { CredentialRecord, Identities } from "./identity.js";
import { check, fail, hash, id, json, ref, type Store, same, within } from "./store.js";
import type { ExecutorState } from "./tickets.js";

interface Upload {
  digest: string;
  body: D.UploadBegin;
  status?: D.UploadStatus;
  validation?: D.UploadValidation;
}
interface TransportDispatch extends DispatchRecord {
  executorUpload?: Upload;
}
interface Authority {
  record: TransportDispatch;
  owner: D.AuthContext;
  lease: D.Lease;
  limits: D.ExecutorTransferLimits;
  deadline: number;
}
type Route = {
  jobId: string;
  kind: "manifest" | "blob" | "begin" | "chunk" | "validate";
  sha256?: string;
  uploadId?: string;
  chunkIndex?: number;
};

/** Assigned-job transport only. The executor is never given application authority. */
export class ExecutorWorkspace {
  readonly #store: Store;
  readonly #identities: Identities;
  readonly #bindings: Bindings;
  readonly #executors: Executors;
  readonly #directory: Directory;
  readonly #env: Env;
  readonly #active = new Map<AbortController, () => Authority>();
  constructor(
    store: Store,
    identities: Identities,
    bindings: Bindings,
    executors: Executors,
    directory: Directory,
    env: Env,
  ) {
    this.#store = store;
    this.#identities = identities;
    this.#bindings = bindings;
    this.#executors = executors;
    this.#directory = directory;
    this.#env = env;
  }
  #route(request: Request): Route {
    const path = new URL(request.url).pathname;
    const match =
      /^\/v1\/executor\/jobs\/([A-Za-z0-9_-]{1,128})\/(manifest|blobs\/([a-f0-9]{64})|uploads(?:\/([A-Za-z0-9_-]{1,128})\/(validate|blobs\/([a-f0-9]{64})\/chunks\/(0|[1-9][0-9]*)))?)$/.exec(
        path,
      );
    check(match, "not_found", "Assigned workspace route unavailable");
    const kind =
      match[2] === "manifest"
        ? "manifest"
        : match[3]
          ? "blob"
          : match[5] === "validate"
            ? "validate"
            : match[6]
              ? "chunk"
              : "begin";
    check(
      request.method ===
        (kind === "manifest" || kind === "blob" ? "GET" : kind === "chunk" ? "PUT" : "POST"),
      "invalid_request",
      "Assigned workspace method mismatch",
    );
    check(
      !request.headers.has("Range"),
      "invalid_request",
      "Assigned workspace reads require complete files",
    );
    if (kind === "manifest" || kind === "blob")
      check(request.body === null, "invalid_request", "Unexpected assigned workspace body");
    return {
      jobId: match[1] ?? "",
      kind,
      ...(match[3] || match[6] ? { sha256: match[3] ?? match[6] } : {}),
      ...(match[4] ? { uploadId: match[4] } : {}),
      ...(match[7] ? { chunkIndex: Number(match[7]) } : {}),
    };
  }
  #query(request: Request, chunk: boolean): D.ExecutorJobChunkQuery | D.ExecutorJobQuery {
    const params = new URL(request.url).searchParams;
    const values: Record<string, unknown> = {};
    for (const [key, value] of params) {
      check(!(key in values), "invalid_request", "Duplicate assigned workspace query");
      if (key === "connectionEpoch" || key === "length") {
        check(/^[1-9][0-9]*$/.test(value), "invalid_request", "Invalid assigned workspace number");
        values[key] = Number(value);
      } else values[key] = value;
    }
    check(
      valid("executor-messages", chunk ? "ExecutorJobChunkQuery" : "ExecutorJobQuery", values),
      "invalid_request",
      "Invalid assigned workspace query",
    );
    check(
      typeof values.executionId === "string" &&
        typeof values.assignmentDigest === "string" &&
        typeof values.connectionEpoch === "number",
      "invalid_request",
      "Assigned workspace scope missing",
    );
    const query: D.ExecutorJobQuery = {
      executionId: values.executionId,
      assignmentDigest: values.assignmentDigest,
      connectionEpoch: values.connectionEpoch,
    };
    if (!chunk) return query;
    check(
      typeof values.length === "number" && typeof values.sha256 === "string",
      "invalid_request",
      "Assigned workspace chunk scope missing",
    );
    return { ...query, length: values.length, sha256: values.sha256 };
  }
  #authority(ctx: D.AuthContext, route: Route, query: D.ExecutorJobQuery): Authority {
    const publisher = this.#identities.current(ctx);
    check(
      publisher.role === "executor" && publisher.executorId,
      "unauthorized",
      "Executor credential required",
    );
    const record = this.#store.get<TransportDispatch>("dispatch", query.executionId);
    check(record?.attempted, "conflict", "Execution was not assigned");
    const { assignment, reservation } = record.intent;
    const identity = assignment.identity;
    const target = identity.target;
    check(
      target.kind === "executor" &&
        target.executorId === publisher.executorId &&
        identity.jobId === route.jobId &&
        identity.executionId === query.executionId &&
        identity.assignmentDigest === query.assignmentDigest &&
        assignment.reservationId === reservation.reservationId &&
        reservation.ownerKind === "job" &&
        reservation.jobId === identity.jobId &&
        reservation.executionId === identity.executionId &&
        reservation.operationDigest === identity.operationDigest &&
        same(reservation.target, target) &&
        same(this.#store.get("reservation_id", reservation.reservationId), reservation),
      "unauthorized",
      "Assigned workspace identity mismatch",
    );
    const executor = this.#store.get<ExecutorState>("executor", target.executorId);
    check(
      executor &&
        executor.status !== "revoked" &&
        executor.credentialId === publisher.credentialId &&
        executor.generation === target.generation &&
        executor.epoch === query.connectionEpoch,
      "unauthenticated",
      "Assigned workspace executor changed",
    );
    this.#executors.channel(target.executorId, target.generation);
    const resources = {
      ...emptyScope(),
      agentIds: [reservation.agentId],
      conversationIds: [reservation.conversationId],
      workspaceIds: [reservation.workspaceId],
      executorIds: [target.executorId],
      tools: [assignment.tool],
    };
    requireGrant(
      ctx,
      route.kind === "manifest" || route.kind === "blob" ? "transfers.input" : "transfers.output",
      resources,
    );
    const credential = this.#store.get<CredentialRecord>(
      "credential",
      reservation.credential.credentialId,
    );
    check(
      credential && credential.role !== "executor" && same(ref(credential), reservation.credential),
      "unauthenticated",
      "Original execution owner changed",
    );
    const owner: D.AuthContext = {
      ...ref(credential),
      principalId: credential.principalId,
      role: credential.role,
      grants: credential.grants,
      deploymentId: this.#identities.deploymentId,
      requestId: id(),
      authenticatedAt: Date.now(),
      credentialExpiresAt: credential.expiresAt,
      deadline: ctx.deadline,
      registrationId: reservation.registrationIds.workspace,
    };
    this.#identities.current(owner);
    check(
      same(
        this.#store.get("reservation", `${owner.principalId}:${reservation.operationId}`),
        reservation,
      ),
      "unauthorized",
      "Original reservation changed",
    );
    const fullScope = {
      ...resources,
      actions: [...new Set([...reservation.actions, "jobs.dispatch"])],
    };
    requireGrant(owner, "jobs.dispatch", fullScope);
    const registration = this.#store.get<D.AuthorityRegistration>(
      "recipient",
      reservation.registrationIds.workspace,
    );
    const grant = owner.grants.find(
      (g) =>
        (g.expiresAt === undefined || g.expiresAt > Date.now()) &&
        contains(g.resources, fullScope) &&
        registration &&
        contains(g.resources, registration.resources),
    );
    check(
      registration &&
        registration.registrationId === owner.registrationId &&
        registration.recipient.kind === "workspace" &&
        registration.recipient.id === reservation.workspaceId &&
        same(registration.credential, reservation.credential) &&
        registration.executor?.executorId === target.executorId &&
        registration.executor.generation === target.generation &&
        contains(registration.resources, {
          ...fullScope,
          tools: registration.resources.tools.length === 0 ? [] : fullScope.tools,
        }) &&
        grant,
      "unauthorized",
      "Execution requires its exact current Workspace registration and grant",
    );
    const binding = this.#bindings.current(reservation.workspaceId);
    check(
      binding?.config.kind === "computer" &&
        binding.bindingVersion === reservation.bindingVersion &&
        assignment.bindingVersion === reservation.bindingVersion &&
        assignment.workspaceId === reservation.workspaceId,
      "conflict",
      "Assigned workspace binding changed",
    );
    const retained = this.#store.get<{ lease: D.Lease; state?: string }>(
      "lease",
      identity.lease.leaseId,
    );
    const lease = retained?.lease ?? identity.lease;
    check(
      (!retained?.state || retained.state === "active") &&
        valid("workspaces", "Lease", lease) &&
        sameExecution(identity, { ...identity, lease }) &&
        lease.ownerKind === "job" &&
        lease.jobId === identity.jobId &&
        lease.operationId === reservation.operationId &&
        lease.workspaceId === reservation.workspaceId &&
        same(lease.credential, reservation.credential) &&
        lease.registrationId === registration.registrationId &&
        lease.executorId === target.executorId &&
        lease.executorGeneration === target.generation &&
        lease.baseRevision === identity.baseRevision,
      "conflict",
      "Assigned workspace lease changed",
    );
    const terminal =
      this.#store.storage.sql
        .exec<{ n: number }>(
          "SELECT 1 n FROM cp_records WHERE kind='command' AND key>=? AND key<? LIMIT 1",
          `${identity.executionId}:job.committed:`,
          `${identity.executionId}:job.committed;`,
        )
        .toArray().length > 0;
    check(
      !record.cancel && record.observation?.state !== "terminal" && !terminal,
      "conflict",
      "Execution authority is terminal or cancelled",
    );
    const deadline = Math.min(
      ctx.deadline,
      identity.deadline,
      reservation.deadline,
      lease.expiresAt,
      owner.credentialExpiresAt ?? Number.MAX_SAFE_INTEGER,
      grant.expiresAt ?? Number.MAX_SAFE_INTEGER,
    );
    check(deadline > Date.now(), "conflict", "Assigned workspace authority expired");
    owner.deadline = deadline;
    const advertised = this.#executors.transferLimits(target.executorId, target.generation);
    const policy = effectiveLimits(this.#directory.policy());
    return {
      record,
      owner,
      lease,
      deadline,
      limits: {
        chunkBytes: Math.min(advertised.chunkBytes, 262144),
        fileBytes: Math.min(advertised.fileBytes, policy.fileBytes),
        snapshotBytes: Math.min(advertised.snapshotBytes, policy.snapshotBytes),
        artifactBytes: Math.min(advertised.artifactBytes, policy.artifactBytes),
        manifestEntries: Math.min(advertised.manifestEntries, policy.manifestEntries),
      },
    };
  }
  async #bytes(
    stream: ReadableStream<Uint8Array> | null,
    limit: number,
    deadline: number,
    current: () => Authority,
    exact?: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    check(stream, "invalid_request", "Assigned workspace body required");
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    const abort = () => {
      void reader.cancel().catch(() => {});
    };
    const timer = setTimeout(abort, Math.max(1, deadline - Date.now()));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      for (;;) {
        current();
        const next = await reader.read();
        current();
        if (next.done) break;
        size += next.value.length;
        check(
          size <= limit && Date.now() < deadline,
          "payload_too_large",
          "Assigned workspace body exceeds bound",
        );
        chunks.push(next.value);
      }
      check(
        exact === undefined || size === exact,
        "invalid_request",
        "Assigned workspace body length mismatch",
      );
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return bytes;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  #enter(
    current: () => Authority,
    incoming: AbortSignal,
    deadline: number,
  ): { signal: AbortSignal; release: () => void } {
    // Reclaim only previously authorized requests whose current authority ended.
    // This manager's pool is separate from the older Relay rendezvous pool.
    for (const [controller, authority] of this.#active) {
      try {
        authority();
      } catch {
        controller.abort();
      }
    }
    const limit = effectiveLimits(this.#directory.policy()).transferConcurrency;
    check(this.#active.size < limit, "quota_exceeded", "Assigned workspace concurrency exhausted", {
      retryAfterMs: 1000,
      pressure: {
        resource: "concurrency",
        scope: { kind: "object", id: this.#identities.deploymentId },
        source: "policy",
        measurement: "observed",
        limit,
        remaining: 0,
        reason: "Assigned workspace requests occupy the configured concurrent transfer slots",
        action: "retry-later",
      },
    });
    const controller = new AbortController();
    const abort = () => controller.abort();
    const release = () => {
      this.#active.delete(controller);
      clearTimeout(timer);
      incoming.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", release);
    };
    const timer = setTimeout(abort, Math.max(1, deadline - Date.now()));
    this.#active.set(controller, current);
    controller.signal.addEventListener("abort", release, { once: true });
    incoming.addEventListener("abort", abort, { once: true });
    if (incoming.aborted) abort();
    return { signal: controller.signal, release };
  }
  #upload(authority: Authority, route: Route): Upload {
    const upload = authority.record.executorUpload;
    check(
      upload && upload.body.requestId === route.uploadId,
      "unauthorized",
      "Upload does not belong to this execution",
    );
    return upload;
  }
  #save(current: () => Authority, upload: Upload): void {
    this.#store.tx(() => {
      const authority = current();
      const old = authority.record.executorUpload;
      check(!old || old.digest === upload.digest, "conflict", "Assigned upload body changed");
      if (!old)
        check(
          this.#store.storage.sql.databaseSize +
            new TextEncoder().encode(json(upload)).length * 3 +
            4096 <=
            this.#store.admissionBytes,
          "quota_exceeded",
          "Assigned upload admission preserves repair headroom",
        );
      this.#store.put("dispatch", authority.record.intent.assignment.identity.executionId, {
        ...authority.record,
        executorUpload: { ...old, ...upload },
      });
    });
  }
  async fetch(ctx: D.AuthContext, request: Request, responseHeaders: Headers): Promise<Response> {
    const route = this.#route(request);
    const query = this.#query(request, route.kind === "chunk");
    const current = () => {
      check(!request.signal.aborted, "interrupted", "Assigned workspace request interrupted");
      return this.#authority(ctx, route, query);
    };
    let authority = current();
    if (route.kind === "chunk" || route.kind === "validate") this.#upload(authority, route);
    const slot = this.#enter(current, request.signal, authority.deadline);
    let streaming = false;
    try {
      request = new Request(request, { signal: slot.signal });
      const workspaceId = authority.record.intent.reservation.workspaceId;
      const stub = this.#env.WORKSPACES.getByName(workspaceId);
      const version = await within(
        stub.contractVersion,
        Math.max(1, authority.deadline - Date.now()),
      );
      authority = current();
      check(version === "1.0", "unsupported", "Workspace contract mismatch");
      const headers = new Headers(responseHeaders);
      if (route.kind === "manifest" || route.kind === "blob") {
        const envelope = json({ auth: authority.owner });
        check(
          new TextEncoder().encode(envelope).length <= 65536,
          "payload_too_large",
          "Workspace authority header exceeds bound",
        );
        const access: D.ExecutorWorkspaceAccess = {
          assignment: authority.record.intent.assignment,
          lease: authority.lease,
        };
        const body = json(access);
        check(
          new TextEncoder().encode(body).length <= wireLimits.jsonBytes,
          "payload_too_large",
          "Workspace access exceeds control bound",
        );
        const response = await within(
          stub.fetch(
            new Request(
              `https://workspace.internal/__fortipi/job-snapshot${route.sha256 ? `?sha256=${route.sha256}` : ""}`,
              {
                method: "POST",
                headers: {
                  "x-fortipi-workspace-context": envelope,
                  "Content-Type": "application/json",
                },
                body,
                signal: request.signal,
              },
            ),
          ),
          Math.max(1, authority.deadline - Date.now()),
        );
        try {
          authority = current();
          if (response.status !== 200) {
            const bytes = await this.#bytes(
              response.body,
              65536,
              authority.deadline,
              current,
              undefined,
              request.signal,
            );
            current();
            let error: unknown;
            try {
              error = JSON.parse(new TextDecoder().decode(bytes));
            } catch {}
            if (error && typeof error === "object" && "error" in error) error = error.error;
            check(
              valid("common", "ProtocolError", error),
              "unavailable",
              "Workspace snapshot unavailable",
            );
            const typed = error as D.ProtocolError;
            fail(typed.code, "Workspace snapshot refused", typed.details);
          }
          if (route.kind === "manifest") {
            const bytes = await this.#bytes(
              response.body,
              wireLimits.jsonBytes,
              authority.deadline,
              current,
              undefined,
              request.signal,
            );
            current();
            let result: D.ManifestResponse;
            try {
              result = JSON.parse(new TextDecoder().decode(bytes));
            } catch {
              fail("invalid_request", "Invalid workspace manifest JSON");
            }
            check(
              valid("workspaces", "ManifestResponse", result) &&
                result.workspaceId === workspaceId &&
                result.revision === authority.record.intent.assignment.identity.baseRevision,
              "conflict",
              "Workspace manifest scope mismatch",
            );
            const digest = await manifestDigest(result.manifest);
            authority = current();
            check(
              digest === result.manifestHash &&
                result.manifest.entries.length <= authority.limits.manifestEntries &&
                result.manifest.entries.reduce(
                  (total, entry) => total + (entry.type === "file" ? entry.size : 0),
                  0,
                ) <= authority.limits.snapshotBytes,
              "conflict",
              "Workspace manifest proof or bounds mismatch",
            );
            return Response.json(result, { headers });
          }
          const lengthText = response.headers.get("Content-Length") ?? "";
          const length = Number(lengthText);
          check(
            /^(0|[1-9][0-9]*)$/.test(lengthText) &&
              Number.isSafeInteger(length) &&
              length <=
                Math.min(authority.limits.fileBytes, this.#directory.policy().bounds.fileBytes) &&
              response.headers.get("X-Content-SHA256") === route.sha256 &&
              response.headers.get("Content-Type") === "application/octet-stream" &&
              response.body,
            "conflict",
            "Workspace blob metadata mismatch",
          );
          headers.set("Content-Type", "application/octet-stream");
          headers.set("Content-Length", String(length));
          headers.set("X-Content-SHA256", route.sha256 ?? "");
          if (length === 0) {
            check(
              route.sha256 === createHash("sha256").digest("hex"),
              "conflict",
              "Empty workspace blob hash mismatch",
            );
            await this.#bytes(response.body, 0, authority.deadline, current, 0, request.signal);
            current();
            return new Response(new Uint8Array(), { headers });
          }
          const reader = response.body.getReader();
          const digest = createHash("sha256");
          let seen = 0;
          let finished = false;
          let failStream: (error: unknown) => void = () => {};
          const finish = async () => {
            if (!finished) {
              finished = true;
              clearTimeout(timer);
              request.signal.removeEventListener("abort", abort);
              await reader.cancel().catch(() => {});
              reader.releaseLock();
              slot.release();
            }
          };
          const abort = () => {
            failStream(new Error("Assigned byte stream interrupted"));
            void finish();
          };
          const timer = setTimeout(abort, Math.max(1, authority.deadline - Date.now()));
          request.signal.addEventListener("abort", abort, { once: true });
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              failStream = (error) => controller.error(error);
            },
            async pull(controller) {
              try {
                const before = current();
                check(
                  !finished && !request.signal.aborted && length <= before.limits.fileBytes,
                  "interrupted",
                  "Assigned byte stream authority changed",
                );
                const next = await reader.read();
                const after = current();
                check(
                  !finished && length <= after.limits.fileBytes,
                  "interrupted",
                  "Assigned byte stream authority changed",
                );
                if (next.done) {
                  check(
                    seen === length && digest.digest("hex") === route.sha256,
                    "conflict",
                    "Workspace blob hash or length mismatch",
                  );
                  await finish();
                  current();
                  controller.close();
                } else {
                  seen += next.value.length;
                  check(
                    seen <= length,
                    "payload_too_large",
                    "Workspace blob exceeded declared length",
                  );
                  digest.update(next.value);
                  // A known-length HTTP response may finish as soon as the last
                  // bytes are emitted. Verify EOF and SHA before releasing them.
                  if (seen === length) {
                    const end = await reader.read();
                    current();
                    check(
                      end.done && digest.digest("hex") === route.sha256,
                      "conflict",
                      "Workspace blob hash or trailing bytes mismatch",
                    );
                    await finish();
                    current();
                    controller.enqueue(next.value);
                    controller.close();
                    return;
                  }
                  controller.enqueue(next.value);
                }
              } catch (error) {
                await finish();
                controller.error(error);
              }
            },
            cancel: finish,
          });
          const result = new Response(stream.pipeThrough(new FixedLengthStream(length)), {
            headers,
          });
          streaming = true;
          return result;
        } catch (error) {
          await response.body?.cancel().catch(() => {});
          throw error;
        }
      }
      if (route.kind === "begin") {
        const bytes = await this.#bytes(
          request.body,
          wireLimits.jsonBytes,
          authority.deadline,
          current,
          undefined,
          request.signal,
        );
        authority = current();
        let body: D.UploadBegin;
        try {
          body = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          fail("invalid_request", "Invalid upload JSON");
        }
        check(
          valid("workspaces", "UploadBegin", body),
          "invalid_request",
          "Invalid assigned upload",
        );
        try {
          validateUploadBlobs(body, { required: false });
        } catch {
          fail("invalid_request", "Assigned upload chunk inventory is invalid");
        }
        const identity = authority.record.intent.assignment.identity;
        check(
          body.operationId === authority.lease.operationId &&
            body.baseRevision === identity.baseRevision &&
            sameExecution(identity, { ...identity, lease: body.lease }),
          "conflict",
          "Upload does not match assigned operation and lease",
        );
        const digest = await hash(json(body));
        authority = current();
        const manifestHash = await manifestDigest(body.manifest);
        authority = current();
        check(
          manifestHash === body.manifestHash &&
            body.manifest.entries.length <= authority.limits.manifestEntries &&
            body.manifest.entries.every(
              (entry) => entry.type !== "file" || entry.size <= authority.limits.fileBytes,
            ) &&
            body.manifest.entries.reduce(
              (total, entry) => total + (entry.type === "file" ? entry.size : 0),
              0,
            ) <= authority.limits.snapshotBytes &&
            (body.blobs ?? []).every(
              (blob) => blob.chunks.chunkBytes <= authority.limits.chunkBytes,
            ),
          "conflict",
          "Assigned upload manifest or current bounds mismatch",
        );
        const old = authority.record.executorUpload;
        // Retry the first complete body even when another current renewal has
        // superseded its lease observation. Current authority is checked separately.
        check(
          same(body.lease, identity.lease) ||
            same(body.lease, authority.lease) ||
            (old?.digest === digest && same(old.body.lease, body.lease)),
          "conflict",
          "Assigned upload lease was never retained",
        );
        check(!old || old.digest === digest, "conflict", "Assigned upload request changed");
        this.#save(current, old ?? { digest, body });
        const result = await within<D.Outcome<D.OperationResponse<"beginUpload">>>(
          stub.beginUpload(current().owner, {
            operationId: "beginUpload",
            path: { workspaceId },
            query: {},
            body,
          }),
          Math.max(1, authority.deadline - Date.now()),
        );
        authority = current();
        if (!result.ok) fail(result.code, "Assigned upload refused", result.details);
        check(result.value.status === 201, "conflict", "Assigned upload status mismatch");
        const status = result.value.body;
        check(
          result.value.status === 201 &&
            valid("workspaces", "UploadStatus", status) &&
            status.uploadId === body.requestId &&
            status.baseRevision === body.baseRevision &&
            status.manifestHash === body.manifestHash,
          "conflict",
          "Assigned upload receipt mismatch",
        );
        this.#save(current, { digest, body, status });
        return Response.json(status, { status: 201, headers });
      }
      const upload = this.#upload(authority, route);
      if (route.kind === "chunk") {
        check(
          "length" in query && route.sha256 && Number.isSafeInteger(route.chunkIndex),
          "invalid_request",
          "Invalid upload chunk selector",
        );
        const length = query.length;
        const entry = upload.body.mutations.find(
          (mutation) => mutation.kind === "put" && mutation.sha256 === route.sha256,
        );
        const plan = upload.body.blobs?.find((blob) => blob.sha256 === route.sha256);
        const grid = plan?.chunks.chunkBytes ?? 262144;
        const chunkIndex = route.chunkIndex ?? -1;
        check(
          entry?.kind === "put" &&
            chunkIndex >= 0 &&
            chunkIndex < Math.ceil(entry.size / grid) &&
            length === Math.min(grid, entry.size - chunkIndex * grid) &&
            (!plan || plan.chunks.chunkHashes[chunkIndex] === query.sha256),
          "conflict",
          "Assigned chunk is not in its retained upload grid",
        );
        check(
          length <= authority.limits.chunkBytes,
          "payload_too_large",
          "Assigned upload chunk exceeds current bound",
        );
        const bytes = await this.#bytes(
          request.body,
          length,
          authority.deadline,
          current,
          length,
          request.signal,
        );
        authority = current();
        const digest = await hash(bytes);
        authority = current();
        check(
          digest === query.sha256 && length <= authority.limits.chunkBytes,
          "conflict",
          "Assigned chunk hash or current bound mismatch",
        );
        const result = await within<D.Outcome<D.OperationResponse<"putUploadChunk">>>(
          stub.putChunk(authority.owner, {
            operationId: "putUploadChunk",
            path: {
              workspaceId,
              uploadId: upload.body.requestId,
              sha256: route.sha256,
              chunkIndex: route.chunkIndex ?? 0,
            },
            query: { length, sha256: query.sha256 },
            body: bytes,
          }),
          Math.max(1, authority.deadline - Date.now()),
        );
        current();
        if (!result.ok) fail(result.code, "Assigned chunk refused", result.details);
        check(result.value.status === 204, "conflict", "Assigned chunk receipt mismatch");
        return new Response(null, { status: 204, headers });
      }
      if (request.body) {
        await this.#bytes(request.body, 0, authority.deadline, current, 0, request.signal);
        authority = current();
      }
      const result = await within<D.Outcome<D.OperationResponse<"validateUpload">>>(
        stub.validateUpload(authority.owner, {
          operationId: "validateUpload",
          path: { workspaceId, uploadId: upload.body.requestId },
          query: {},
          body: undefined,
        }),
        Math.max(1, authority.deadline - Date.now()),
      );
      current();
      if (!result.ok) fail(result.code, "Assigned validation refused", result.details);
      check(result.value.status === 200, "conflict", "Assigned validation status mismatch");
      const validation = result.value.body;
      check(
        result.value.status === 200 &&
          valid("workspaces", "UploadValidation", validation) &&
          validation.uploadId === upload.body.requestId &&
          validation.manifestHash === upload.body.manifestHash &&
          (!upload.validation || same(upload.validation, validation)),
        "conflict",
        "Assigned stage receipt changed",
      );
      this.#save(current, { ...upload, validation });
      return Response.json(validation, { headers });
    } finally {
      if (!streaming) slot.release();
    }
  }
}
