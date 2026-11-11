import type { Workspace, WorkspaceRuntimeResult } from "@cloudflare/computer";
import type { ContainerBackend } from "@cloudflare/computer/backends/container";
import {
  assertUtf8Bytes,
  assignmentDigest,
  canonicalJson,
  manifestDigest,
  operationDigest,
  operationForAssignment,
  requireCapability,
  wireLimits,
} from "fortipi-contract";
import type * as D from "../boundary/dto.js";
import type { Env } from "../boundary/env.js";
import type { FencedContainerAPI } from "../container/host-adapter.js";
import {
  authorize,
  authorizeReservedAction,
  permitsResource,
  same,
  validateLease,
} from "../workspace/authority.js";
import type { ComputerStore } from "../workspace/computer.js";
import { outcome, requireThat, unwrap } from "../workspace/errors.js";
import { checkedManifest, snapshotBytes } from "../workspace/manifest.js";
import { WorkspaceStorage } from "../workspace/storage.js";
import { chunkBytes } from "../workspace/streams.js";
import {
  boundedJson,
  internalHeader,
  type WorkspaceObject,
} from "../workspace/workspace-object.js";
import { codemode } from "./codemode.js";
import { linux, linuxHostId } from "./linux.js";
import { type NativeContext, quiesceNative, validQuiescence } from "./quiescence.js";

interface RecordEntry {
  prepared: D.PreparedExecution;
  allocation: D.StoreAllocation;
  state: "prepared" | "attempted" | "running" | "terminal" | "unknown";
  observation: D.ExecutionObservation;
  result?: WorkspaceRuntimeResult<"utf8">;
  manifest?: D.Manifest;
  cancelRequested?: boolean;
  runtimeId?: string;
  observationKey: string;
  hostId?: string;
  nativeImageDigest?: string;
  nativeContext?: NativeContext;
  storageQuiescent?: boolean;
  collection?: { requestId: string; commitId: string; manifestHash: string };
}
interface Envelope {
  auth: D.AuthContext;
  allocation: D.StoreAllocation;
}
interface ScratchEvidence {
  identity: D.ExecutionIdentity;
  result: WorkspaceRuntimeResult<"utf8">;
  proof?: string;
  runtimeId?: string;
  quiescent?: boolean;
  quiescence?: D.RuntimeQuiescence;
}
export class ExecutionLedger {
  readonly owner: WorkspaceObject;
  readonly env: Env;
  private workspace: Workspace | undefined;
  private container: ContainerBackend | undefined;
  private host: FencedContainerAPI | undefined;
  private identity: D.ExecutionIdentity | undefined;
  private completion: Promise<void> | undefined;
  private result: WorkspaceRuntimeResult<"utf8"> | undefined;
  private active = false;
  private uncertain = false;
  private scratchStore: ComputerStore | undefined;
  constructor(owner: WorkspaceObject, env: Env) {
    this.owner = owner;
    this.env = env;
  }
  pins(allocation: D.StoreAllocation): boolean {
    if (allocation.role !== "scratch") return false;
    const row = this.owner.state.get<RecordEntry>(`execution:${allocation.executionId}`);
    return Boolean(row && row.state !== "prepared" && row.storageQuiescent !== true);
  }
  private config(ctx: D.AuthContext): Exclude<D.BackendConfig, { kind: "native" }> {
    requireThat(
      "execution" in this.env.FORTIPI_CONFIG,
      "unsupported",
      "Execution backend is not selected",
    );
    const config = this.env.FORTIPI_CONFIG.execution;
    requireThat(
      config.kind !== "native",
      "unsupported",
      "Native execution belongs to the authorized executor",
    );
    requireThat(
      requireCapability(
        this.owner.policy,
        config.kind === "cloud-js" ? "loader" : "containers",
        ctx.deploymentId,
      ),
      "unsupported",
      "Selected paid backend is not verified",
      {
        requiredCapability: config.kind === "cloud-js" ? "loader" : "containers",
        setup: "Explicitly configure and verify the selected paid binding",
      },
    );
    return config;
  }
  private row(ctx: D.AuthContext, identity: D.ExecutionIdentity): RecordEntry {
    const authority = this.owner.current();
    if (
      ctx.grants.some(
        (grant) =>
          (grant.expiresAt === undefined || grant.expiresAt > Date.now()) &&
          permitsResource(grant.resources.workspaceIds, authority.workspaceId) &&
          permitsResource(grant.resources.actions, "workspace.read"),
      )
    )
      authorize(this.owner.state, ctx, authority.workspaceId, "workspace.read");
    else authorizeReservedAction(this.owner.state, ctx, identity.lease, "workspace.write");
    const row = this.owner.state.get<RecordEntry>(`execution:${identity.executionId}`);
    requireThat(
      row && sameExecutionIdentity(identity, row.prepared.request.identity),
      "conflict",
      "Execution identity mismatch",
    );
    return row;
  }
  prepare(
    ctx: D.AuthContext,
    request: D.ExecutionRequest,
  ): Promise<D.Outcome<D.PreparedExecution>> {
    return outcome(async () => {
      const authority = await this.owner.authority(ctx, request.workspaceId, "workspace.write");
      const config = this.config(ctx);
      assertUtf8Bytes(canonicalJson(request), 1_048_576);
      const assignment: D.Assignment = {
        operationContext: request.operationContext,
        identity: request.identity,
        reservationId: request.reservation.reservationId,
        tool: request.tool,
        arguments: request.arguments,
        workspaceId: request.workspaceId,
        bindingVersion: request.bindingVersion,
        ...(request.approval ? { approval: request.approval } : {}),
      };
      const operation = operationForAssignment(assignment);
      requireThat(
        request.operationContext.deploymentId === ctx.deploymentId &&
          request.operationContext.agentId === request.reservation.agentId &&
          request.operationContext.conversationId === request.reservation.conversationId &&
          request.reservation.operationDigest === request.identity.operationDigest &&
          (await operationDigest(operation)) === request.identity.operationDigest &&
          (await assignmentDigest({
            operation,
            executionId: request.identity.executionId,
            reservationId: request.reservation.reservationId,
            leaseId: request.identity.lease.leaseId,
            fence: request.identity.lease.fence,
            executorGeneration: request.identity.lease.executorGeneration,
          })) === request.identity.assignmentDigest,
        "conflict",
        "Canonical cloud execution identity mismatch",
      );
      requireThat(
        authority.binding.config.kind === "computer" &&
          request.identity.target.kind === "backend" &&
          request.identity.target.backendId === config.backendId &&
          request.bindingVersion === authority.binding.bindingVersion &&
          request.identity.baseRevision === authority.binding.revision &&
          request.identity.lease.ownerKind === "job" &&
          request.identity.lease.jobId === request.identity.jobId &&
          request.reservation.ownerKind === "job" &&
          request.reservation.jobId === request.identity.jobId &&
          request.reservation.executionId === request.identity.executionId,
        "conflict",
        "Backend, workspace or job mismatch",
      );
      requireThat(
        request.identity.lease.executorId === config.backendId &&
          request.identity.lease.executorGeneration === request.identity.target.generation &&
          ctx.grants.some(
            (grant) =>
              (grant.expiresAt === undefined || grant.expiresAt > Date.now()) &&
              permitsResource(grant.resources.workspaceIds, request.workspaceId) &&
              permitsResource(grant.resources.backendIds, config.backendId) &&
              permitsResource(grant.resources.tools, request.tool),
          ),
        "unauthorized",
        "Cloud tool and target grants required",
      );
      // CP re-observes the already-issued reservation. It cannot synthesize a new assignment.
      const {
        reservationId: _id,
        credential: _credential,
        registrationIds: _registrations,
        ...targetRequest
      } = request.reservation;
      requireThat(
        same(
          unwrap(await this.owner.control().reserveTarget(ctx, targetRequest)),
          request.reservation,
        ),
        "unauthorized",
        "Target reservation mismatch",
      );
      const prior = await this.owner.mutex.run(() =>
        this.owner.state.get<RecordEntry>(`execution:${request.identity.executionId}`),
      );
      if (prior) {
        requireThat(same(prior.prepared.request, request), "conflict", "Preparation changed");
        return prior.prepared;
      }
      const base = await this.owner.mutex.run(() => {
        validateLease(this.owner.state, this.owner.current(), request.identity.lease, ctx);
        return this.owner.revision(request.identity.baseRevision);
      });
      const reservedBytes = Math.max(
        1024 * 1024,
        snapshotBytes(base.manifest) * 2 + this.owner.policy.bounds.outputBytesPerJob + 1024 * 1024,
      );
      const capacity = unwrap(
        await this.owner.reserveCapacity(ctx, {
          operationId: `scratch-${request.identity.executionId}`,
          ownerId: request.workspaceId,
          policyVersion: this.owner.policy.version,
          bytes: reservedBytes,
          admissionSlots: 0,
        }),
      );
      const installCapacity = unwrap(
        await this.owner.control().reserveCapacity(ctx, {
          operationId: `scratch-${request.identity.executionId}`,
          ownerId: request.workspaceId,
          policyVersion: this.owner.policy.version,
          bytes: reservedBytes,
          admissionSlots: 0,
        }),
      );
      await this.owner.mutex.run(() =>
        this.owner.state.put(
          `install-capacity:${capacity.reservationId}`,
          installCapacity.reservationId,
        ),
      );
      await new WorkspaceStorage(this.owner).reserveCollection(
        ctx,
        request.identity.executionId,
        (snapshotBytes(base.manifest) + this.owner.policy.bounds.outputBytesPerJob) * 3 +
          1024 * 1024,
      );
      const allocation = unwrap(
        await this.owner.allocateStore(ctx, {
          authorityId: request.workspaceId,
          workspaceId: request.workspaceId,
          role: "scratch",
          jobId: request.identity.jobId,
          executionId: request.identity.executionId,
          baseRevision: request.identity.baseRevision,
          generation: request.identity.lease.executorGeneration,
          operationDigest: request.identity.operationDigest,
          capacityReservationId: capacity.reservationId,
          reservedBytes,
          deadline: request.identity.deadline,
        }),
      );
      unwrap(await this.owner.stub(allocation.childId).initializeStore(ctx, allocation));
      await new WorkspaceStorage(this.owner).initialized(ctx, allocation);
      for (const entry of base.manifest.entries) {
        const response = await this.owner.childFetch(ctx, allocation, "/materialize", {
          method: "PUT",
          entry,
          ...(entry.type === "file" ? { body: await this.owner.readStored(ctx, base, entry) } : {}),
        });
        requireThat(
          response.ok,
          "interrupted",
          "Scratch materialization interrupted; do not execute partial scratch",
        );
      }
      const prepared: D.PreparedExecution = {
        preparationId: crypto.randomUUID(),
        request,
        scratchId: allocation.childId,
        preparedAt: Date.now(),
        expiresAt: Math.min(request.identity.deadline, request.identity.lease.expiresAt),
      };
      return this.owner.mutex.run(() =>
        this.owner.state.transaction(() => {
          validateLease(this.owner.state, this.owner.current(), request.identity.lease, ctx);
          const raced = this.owner.state.get<RecordEntry>(
            `execution:${request.identity.executionId}`,
          );
          if (raced) {
            requireThat(
              same(raced.prepared.request, request),
              "conflict",
              "Concurrent preparation changed",
            );
            return raced.prepared;
          }
          this.owner.state.put(`execution:${request.identity.executionId}`, {
            observationKey: crypto.randomUUID(),
            ...(config.kind === "linux"
              ? {
                  hostId: linuxHostId(
                    config.host,
                    this.env.WORKSPACES.idFromName(allocation.childId).toString(),
                  ),
                  nativeImageDigest: config.imageDigest,
                  nativeContext: new WorkspaceStorage(this.owner).registerHost(
                    ctx,
                    allocation,
                    config,
                  ),
                }
              : {}),
            prepared,
            allocation,
            state: "prepared",
            observation: { identity: request.identity, state: "unknown" },
          } satisfies RecordEntry);
          return prepared;
        }),
      );
    }, ctx.requestId);
  }
  startOnce(
    ctx: D.AuthContext,
    prepared: D.PreparedExecution,
  ): Promise<D.Outcome<D.ExecutionObservation>> {
    return outcome(async () => {
      const row = await this.owner.mutex.run(() =>
        this.owner.state.transaction(() => {
          const row = this.row(ctx, prepared.request.identity);
          requireThat(same(row.prepared, prepared), "conflict", "Preparation identity mismatch");
          if (row.state !== "prepared") return { row, start: false };
          validateLease(
            this.owner.state,
            this.owner.current(),
            prepared.request.identity.lease,
            ctx,
          );
          requireThat(
            prepared.expiresAt > Date.now() && !row.cancelRequested,
            "conflict",
            "Prepared execution expired or cancelled",
          );
          row.state = "attempted";
          row.observation = {
            identity: prepared.request.identity,
            state: "unknown",
            backendExecutionId: prepared.request.identity.executionId,
          };
          this.owner.state.put(`execution:${prepared.request.identity.executionId}`, row);
          return { row, start: true };
        }),
      );
      if (!row.start) return unwrap(await this.queryExisting(ctx, prepared.request.identity));
      // The durable attempted record precedes ALL calls capable of starting upstream code.
      const response = await this.send(ctx, row.row, "start", prepared);
      if (!response.ok) return row.row.observation;
      const observation = (await response.json()) as D.ExecutionObservation;
      requireThat(
        observation.state !== "waiting_for_local_policy" && observation.state !== "preparing",
        "interrupted",
        "Cloud runtime cannot report native local consent",
      );
      await this.owner.mutex.run(() => {
        const current = this.row(ctx, prepared.request.identity);
        if (observation.state !== "not_started" && observation.runtimeUuid) {
          requireThat(
            !current.runtimeId || current.runtimeId === observation.runtimeUuid,
            "interrupted",
            "Recorded container runtime changed",
          );
          current.runtimeId = observation.runtimeUuid;
          this.owner.state.put(`execution:${prepared.request.identity.executionId}`, current);
        }
        if (current.state === "attempted") {
          current.state = observation.state === "running" ? "running" : "unknown";
          current.observation = observation;
          this.owner.state.put(`execution:${prepared.request.identity.executionId}`, current);
        }
      });
      return observation;
    }, ctx.requestId);
  }
  queryExisting(
    ctx: D.AuthContext,
    identity: D.ExecutionIdentity,
  ): Promise<D.Outcome<D.ExecutionObservation>> {
    return outcome(async () => {
      const row = await this.owner.mutex.run(() => this.row(ctx, identity));
      if (row.state === "terminal") return row.observation;
      if (row.state === "prepared") return { identity, state: "unknown" }; // No closed-assignment proof: a late start may still arrive.
      const response = await this.send(ctx, row, "query", identity);
      if (!response.ok) return { identity, state: "unknown" };
      const observation = (await response.json()) as D.ExecutionObservation;
      requireThat(
        observation.state !== "waiting_for_local_policy" && observation.state !== "preparing",
        "interrupted",
        "Cloud runtime cannot report native local consent",
      );
      const runtimeId = observation.state === "not_started" ? undefined : observation.runtimeUuid;
      if (runtimeId)
        await this.owner.mutex.run(() => {
          const current = this.row(ctx, identity);
          requireThat(
            !current.runtimeId || current.runtimeId === runtimeId,
            "interrupted",
            "Query observed a replacement runtime",
          );
          current.runtimeId = runtimeId;
          this.owner.state.put(`execution:${identity.executionId}`, current);
        });
      return observation;
    }, ctx.requestId);
  }
  cancel(ctx: D.AuthContext, input: D.CancelRequest): Promise<D.Outcome<D.CancelDisposition>> {
    return outcome(async () => {
      const row = await this.owner.mutex.run(() => {
        const row = this.row(ctx, input.identity);
        authorize(this.owner.state, ctx, this.owner.current().workspaceId, "workspace.write");
        row.cancelRequested = true;
        this.owner.state.put(`execution:${input.identity.executionId}`, row);
        return row;
      });
      if (row.state === "prepared") return { state: "not-started", possibleExternalEffects: false };
      if (row.state === "terminal")
        return { state: "already-terminal", possibleExternalEffects: true };
      const response = await this.send(ctx, row, "cancel", input.identity);
      return response.ok
        ? { state: "stopped", possibleExternalEffects: true }
        : { state: "unknown", possibleExternalEffects: true };
    }, ctx.requestId);
  }
  collectResult(
    ctx: D.AuthContext,
    identity: D.ExecutionIdentity,
  ): Promise<D.Outcome<D.PreparedResult>> {
    return outcome(async () => {
      const row = await this.owner.mutex.run(() => this.row(ctx, identity));
      requireThat(
        row.observation.state !== "waiting_for_local_policy" &&
          row.observation.state !== "preparing",
        "interrupted",
        "Cloud runtime cannot report native local consent",
      );
      if (row.observation.state !== "not_started" && row.observation.result?.uploadId)
        return row.observation.result;
      const response = await this.send(ctx, row, "collect", identity);
      requireThat(response.ok, "interrupted", "Runtime result or full scratch sync unavailable");
      const collected = (await response.json()) as {
        result: WorkspaceRuntimeResult<"utf8">;
        manifest: D.Manifest;
        runtimeId?: string;
      };
      requireThat(
        collected.result.sync.status === "complete" &&
          collected.result.skipped.length === 0 &&
          collected.result.sync.skipped.length === 0 &&
          (!row.hostId || collected.runtimeId !== undefined) &&
          (!row.runtimeId || collected.runtimeId === row.runtimeId),
        "interrupted",
        "Scratch sync incomplete or runtime replaced",
      );
      const manifest = checkedManifest(collected.manifest, this.owner.policy);
      const hash = await manifestDigest(manifest);
      const result: D.PreparedResult = {
        identity,
        sequence: 1,
        state:
          collected.result.exitCode === 0 && collected.result.status === "completed"
            ? "succeeded"
            : "failed",
        manifestHash: hash,
        output: {
          tail: tail(
            `${collected.result.stdout}${collected.result.stderr}`,
            this.owner.policy.bounds.inlineTailBytes,
          ),
          artifacts: await this.owner.captureArtifacts(
            ctx,
            row.allocation,
            identity,
            collected.result,
          ),
          truncated: Boolean(collected.result.truncated),
        },
        possibleExternalEffects: true,
      };
      // Changed files are transferred through the same bounded staged-upload/seal path as external uploads.
      if (
        hash !== this.owner.revision(identity.baseRevision).manifestHash &&
        result.state === "succeeded"
      ) {
        const collection = await this.owner.mutex.run(() => {
          const current = this.row(ctx, identity);
          if (current.collection)
            requireThat(
              current.collection.manifestHash === hash,
              "conflict",
              "Collected snapshot changed on retry",
            );
          else {
            current.collection = {
              requestId: crypto.randomUUID(),
              commitId: crypto.randomUUID(),
              manifestHash: hash,
            };
            this.owner.state.put(`execution:${identity.executionId}`, current);
          }
          return current.collection;
        });
        const uploadId = collection.requestId;
        const commitId = collection.commitId;
        const base = this.owner.revision(identity.baseRevision).manifest;
        const mutations: D.Mutation[] = base.entries
          .filter((entry) => !manifest.entries.some((item) => item.path === entry.path))
          .map((entry) => ({ kind: "delete", path: entry.path }));
        for (const entry of manifest.entries)
          if (!base.entries.some((item) => same(item, entry)))
            mutations.push(
              entry.type === "directory"
                ? { kind: "mkdir", path: entry.path, mode: 493 }
                : {
                    kind: "put",
                    path: entry.path,
                    sha256: entry.sha256,
                    size: entry.size,
                    mode: entry.mode,
                  },
            );
        const begun = unwrap(
          await this.owner.beginUpload(ctx, {
            operationId: "beginUpload",
            path: { workspaceId: row.prepared.request.workspaceId },
            query: {},
            body: {
              requestId: uploadId,
              baseRevision: identity.baseRevision,
              lease: identity.lease,
              operationId: identity.lease.operationId,
              commitId,
              manifestHash: hash,
              manifest,
              mutations,
            },
          }),
        );
        requireThat(begun.status === 201, "interrupted", "Could not stage collected snapshot");
        for (const mutation of mutations)
          if (mutation.kind === "put") {
            const entry = manifest.entries.find((item) => item.path === mutation.path);
            requireThat(entry?.type === "file", "internal", "Collected file missing");
            const source = await this.owner.childFetch(ctx, row.allocation, "/scratch-read", {
              entry,
            });
            requireThat(source.ok && source.body, "interrupted", "Collected file unavailable");
            const reader = source.body.getReader();
            let pending = new Uint8Array(0);
            let index = 0;
            const put = async (bytes: Uint8Array) => {
              const sha256 = await sha(bytes);
              unwrap(
                await this.owner.putChunk(ctx, {
                  operationId: "putUploadChunk",
                  path: {
                    workspaceId: row.prepared.request.workspaceId,
                    uploadId: begun.body.uploadId,
                    sha256: entry.sha256,
                    chunkIndex: index++,
                  },
                  query: { length: bytes.length, sha256 },
                  body: bytes,
                }),
              );
            };
            try {
              for (;;) {
                const next = await reader.read();
                if (next.done) break;
                const joined = new Uint8Array(pending.length + next.value.length);
                joined.set(pending);
                joined.set(next.value, pending.length);
                let offset = 0;
                while (joined.length - offset >= chunkBytes) {
                  await put(joined.slice(offset, offset + chunkBytes));
                  offset += chunkBytes;
                }
                pending = joined.slice(offset);
              }
              if (pending.length) await put(pending);
            } finally {
              await reader.cancel().catch(() => {});
              reader.releaseLock();
            }
          }
        unwrap(
          await this.owner.validateUpload(ctx, {
            operationId: "validateUpload",
            path: { workspaceId: row.prepared.request.workspaceId, uploadId: begun.body.uploadId },
            query: {},
            body: undefined,
          }),
        );
        result.uploadId = begun.body.uploadId;
        result.commitId = commitId;
      }
      await this.owner.mutex.run(() => {
        const current = this.row(ctx, identity);
        if (result.state === "succeeded")
          validateLease(this.owner.state, this.owner.current(), identity.lease, ctx);
        current.state = "terminal";
        current.manifest = manifest;
        current.result = collected.result;
        current.observation = { identity, state: "terminal", result };
        this.owner.state.put(`execution:${identity.executionId}`, current);
      });
      return result;
    }, ctx.requestId);
  }
  private send(
    ctx: D.AuthContext,
    row: RecordEntry,
    action: string,
    input: D.PreparedExecution | D.ExecutionIdentity,
  ): Promise<Response> {
    return this.owner.stub(row.allocation.childId).fetch(
      new Request(`https://workspace.internal/__fortipi/execution/${action}`, {
        method: "POST",
        headers: { [internalHeader]: JSON.stringify({ auth: ctx, allocation: row.allocation }) },
        body: JSON.stringify(input),
      }),
    );
  }
  async fetch(request: Request, envelope: Envelope, store: ComputerStore): Promise<Response> {
    const row = await this.owner.registry(envelope.auth, envelope.allocation);
    requireThat(
      row.state.allocation.role === "scratch" &&
        this.owner.isSelf(row.state.allocation.childId) &&
        row.state.state !== "retiring" &&
        row.state.state !== "deleted",
      "unauthorized",
      "Active registered scratch required",
    );
    const action = new URL(request.url).pathname.split("/").at(-1);
    if (action === "start") {
      const prepared = await boundedJson<D.PreparedExecution>(request, wireLimits.jsonBytes);
      requireThat(
        prepared.scratchId === envelope.allocation.childId &&
          prepared.request.identity.executionId ===
            (row.state.allocation.role === "scratch" ? row.state.allocation.executionId : "") &&
          prepared.request.identity.operationDigest === row.state.allocation.operationDigest,
        "conflict",
        "Scratch execution identity mismatch",
      );
      const identity = prepared.request.identity;
      if (this.identity) {
        requireThat(
          this.identity.assignmentDigest === identity.assignmentDigest,
          "conflict",
          "Scratch already assigned",
        );
        return Response.json({
          identity,
          state: this.result ? "terminal" : this.uncertain ? "unknown" : "running",
        });
      }
      // Durable authority start intent is re-observed before dispatch; child never infers permission from a request body.
      const permission = await this.owner.stub(envelope.allocation.authorityId).fetch(
        new Request("https://workspace.internal/__fortipi/execution/permit", {
          method: "POST",
          headers: { [internalHeader]: JSON.stringify(envelope) },
          body: JSON.stringify(identity),
        }),
      );
      requireThat(permission.ok, "conflict", "Assignment closed or no durable start intent");
      const config = this.config(envelope.auth);
      const { proof, nativeContext } = (await permission.json()) as {
        proof: string;
        nativeContext?: NativeContext;
      };
      const first = await this.owner.mutex.run(() => {
        const previous = this.owner.state.get<string>("scratch-start");
        if (previous) {
          requireThat(
            previous === identity.assignmentDigest,
            "conflict",
            "Scratch start identity changed",
          );
          return false;
        }
        this.owner.state.put("scratch-start", identity.assignmentDigest);
        return true;
      });
      if (!first) return Response.json({ identity, state: "unknown" });
      this.scratchStore = store;
      requireThat(
        !this.owner.state.get("scratch-stop-intent"),
        "interrupted",
        "Scratch writer lane is permanently stopping or stopped",
      );
      if (config.kind === "cloud-js") {
        requireThat(
          !nativeContext,
          "conflict",
          "Prepared native runtime cannot change backend kind",
        );
        this.owner.state.put("scratch-runtime-kind", "cloud-js");
        this.workspace = await store.configure([
          codemode(this.env, envelope.auth.deploymentId, config),
        ]);
      } else {
        requireThat(
          nativeContext &&
            nativeContext.hostId === linuxHostId(config.host, this.owner.objectId) &&
            nativeContext.imageDigest === config.imageDigest &&
            nativeContext.authorityId === envelope.allocation.authorityId &&
            nativeContext.allocationId === envelope.allocation.allocationId &&
            nativeContext.childId === envelope.allocation.childId,
          "interrupted",
          "Original prepared native host/image context is unavailable or changed",
        );
        this.owner.state.put("scratch-runtime-kind", "linux");
        this.owner.state.put("scratch-native-context", nativeContext);
        const actual = await linux(
          this.env,
          envelope.auth.deploymentId,
          this.owner.objectId,
          config,
          nativeContext,
          async (runtime) => {
            // Preserve the real SDK acknowledgment before any execution can use the host.
            this.owner.state.put("scratch-native-runtime", runtime.runtimeId);
            const acknowledged = await this.owner.stub(envelope.allocation.authorityId).fetch(
              new Request("https://workspace.internal/__fortipi/execution/observed", {
                method: "POST",
                headers: { [internalHeader]: JSON.stringify(envelope) },
                body: JSON.stringify({ identity, proof, runtimeId: runtime.runtimeId }),
              }),
            );
            requireThat(
              acknowledged.ok,
              "interrupted",
              "Actual native runtime acknowledgment remains unresolved",
            );
          },
        );
        this.host = actual.host;
        this.container = actual.backend;
        this.workspace = await store.configure([actual.backend]);
      }
      this.identity = identity;
      this.active = true;
      store.runtimePinned = true;
      const source = prepared.request.arguments.source;
      requireThat(
        typeof source === "string" && new TextEncoder().encode(source).length <= 65_536,
        "invalid_request",
        "Execution requires bounded source",
      );
      // No FIFO/blockConcurrencyWhile spans connect/run. Authenticated upstream callbacks can progress.
      const workspace = this.workspace;
      const handle = await workspace.runtime
        .exec(source, {
          id: identity.executionId,
          backend: config.backendId,
          cwd: "/workspace",
          encoding: "utf8",
          ...(prepared.request.arguments.input === undefined
            ? {}
            : { input: prepared.request.arguments.input }),
          timeoutMs: Math.min(
            30_000,
            identity.deadline - Date.now(),
            ...(config.kind === "linux" ? [config.runtime.timeoutMs, config.runtime.cpuMs] : []),
          ),
          sync: "wait",
          onInterrupt: "fail",
          output: { maxBytes: this.owner.policy.bounds.inlineTailBytes, maxLines: 256 },
        })
        .catch((error: unknown) => {
          this.uncertain = true;
          throw error;
        });
      this.completion = handle
        .result()
        .then(async (result) => {
          this.result = result;
          if (this.host) this.host.queryOnly = true;
          const synchronized =
            result.sync.status === "complete" &&
            result.sync.skipped.length === 0 &&
            result.skipped.length === 0;
          let evidence: ScratchEvidence = {
            identity,
            result,
            proof,
            quiescent: false,
            ...(this.host?.runtime ? { runtimeId: this.host.runtime.runtimeId } : {}),
          };
          if (result.sync.status === "complete")
            await this.owner.mutex.run(() => this.owner.state.put("scratch-result", evidence));
          if (synchronized) {
            try {
              evidence = await this.closeWriter(store, evidence);
            } catch {
              this.uncertain = true;
            }
          }
          await this.observe(envelope, evidence);
        })
        .catch(() => {
          this.uncertain = true;
        });
      this.completion.catch(() => {});
      return Response.json({
        identity,
        state: "running",
        backendExecutionId: identity.executionId,
        ...(this.host?.runtime ? { runtimeUuid: this.host.runtime.runtimeId } : {}),
      });
    }
    const identity = await boundedJson<D.ExecutionIdentity>(request, wireLimits.jsonBytes);
    const saved = this.active ? undefined : this.owner.state.get<ScratchEvidence>("scratch-result");
    if (saved && saved.identity.assignmentDigest === identity.assignmentDigest && !this.active) {
      this.identity = saved.identity;
      this.result = saved.result;
      this.active = !this.owner.state.get("scratch-quiescent");
      store.runtimePinned = this.active;
    }
    if (this.host) this.host.queryOnly = true;
    requireThat(
      (this.workspace || this.result) &&
        this.identity?.assignmentDigest === identity.assignmentDigest,
      "interrupted",
      "Runtime unavailable after interruption; no replacement launch permitted",
    );
    if (action === "cancel") {
      if (this.result) return new Response(null, { status: 204 });
      requireThat(this.workspace, "interrupted", "Existing runtime unavailable");
      await this.workspace.runtime.killExec(identity.executionId, {
        backend: identity.target.kind === "backend" ? identity.target.backendId : "",
        signal: "SIGKILL",
      });
      await this.completion;
      this.active = false;
      store.runtimePinned = false;
      return new Response(null, { status: 204 });
    }
    if (action === "query") {
      if (!this.result && !this.active) {
        requireThat(this.workspace, "interrupted", "Existing runtime unavailable");
        await this.workspace.runtime.getExec(identity.executionId, {
          backend: identity.target.kind === "backend" ? identity.target.backendId : "",
          encoding: "utf8",
          resume: "tail",
        });
      }
      return Response.json({
        identity,
        state: this.result
          ? this.result.sync.status === "complete"
            ? "terminal"
            : "pending_sync"
          : this.uncertain
            ? "unknown"
            : this.active
              ? "running"
              : "unknown",
        ...(this.host?.runtime ? { runtimeUuid: this.host.runtime.runtimeId } : {}),
      });
    }
    if (action === "collect") {
      await this.completion;
      let evidence = this.owner.state.get<ScratchEvidence>("scratch-result");
      if (
        evidence &&
        evidence.identity.assignmentDigest === identity.assignmentDigest &&
        evidence.result.sync.status === "complete" &&
        !evidence.quiescent
      )
        evidence = await this.closeWriter(store, evidence);
      if (evidence?.proof) await this.observe(envelope, evidence);
    }
    requireThat(
      action === "collect" &&
        !this.active &&
        this.result &&
        this.result.sync.status === "complete" &&
        this.result.skipped.length === 0 &&
        this.result.sync.skipped.length === 0,
      "interrupted",
      "Terminal execution with complete sync required",
    );
    await this.completion;
    return Response.json({
      result: this.result,
      manifest: await store.snapshot(),
      ...(this.host?.runtime
        ? { runtimeId: this.host.runtime.runtimeId }
        : saved?.runtimeId
          ? { runtimeId: saved.runtimeId }
          : {}),
    });
  }
  async callback(request: Request): Promise<Response> {
    requireThat(
      this.active && this.container && !this.owner.state.get("scratch-stop-intent"),
      "unauthorized",
      "No pending active container transport",
    );
    return this.container.handleFetch(request);
  }
  hasCallback(): boolean {
    return (
      this.active && this.container !== undefined && !this.owner.state.get("scratch-stop-intent")
    );
  }
  private async closeWriter(
    store: ComputerStore,
    evidence: ScratchEvidence,
  ): Promise<ScratchEvidence> {
    const kind = this.owner.state.get<string>("scratch-runtime-kind");
    let quiescence: D.RuntimeQuiescence | undefined;
    if (kind === "linux")
      quiescence = await quiesceNative(
        this.owner,
        this.env,
        evidence.identity,
        evidence.result,
        evidence.runtimeId,
      );
    else
      requireThat(
        kind === "cloud-js" || (evidence.quiescent && this.owner.state.get("scratch-quiescent")),
        "interrupted",
        "Original runtime kind is unknown; retain active allocation",
      );
    this.active = false;
    this.container = undefined;
    await store.quiesce();
    this.workspace = undefined;
    const closed = { ...evidence, quiescent: true, ...(quiescence ? { quiescence } : {}) };
    await this.owner.mutex.run(() => this.owner.state.put("scratch-result", closed));
    return closed;
  }
  private async observe(envelope: Envelope, evidence: ScratchEvidence): Promise<void> {
    requireThat(evidence.proof, "interrupted", "Original completion proof unavailable");
    const response = await this.owner.stub(envelope.allocation.authorityId).fetch(
      new Request("https://workspace.internal/__fortipi/execution/observed", {
        method: "POST",
        headers: { [internalHeader]: JSON.stringify(envelope) },
        body: JSON.stringify(evidence),
      }),
    );
    requireThat(response.ok, "interrupted", "Completion observation remains unacknowledged");
  }
  async permit(request: Request, ctx: D.AuthContext): Promise<Response> {
    const identity = await boundedJson<D.ExecutionIdentity>(request, wireLimits.jsonBytes);
    const proof = await this.owner.mutex.run(() => {
      const row = this.row(ctx, identity);
      validateLease(this.owner.state, this.owner.current(), identity.lease, ctx);
      requireThat(
        row.state === "attempted" && !row.cancelRequested,
        "conflict",
        "No eligible attempted execution",
      );
      return {
        proof: row.observationKey,
        ...(row.nativeContext ? { nativeContext: row.nativeContext } : {}),
      };
    });
    return Response.json(proof);
  }
  async observed(
    request: Request,
    allocation: D.StoreAllocation,
    ctx: D.AuthContext,
  ): Promise<Response> {
    const observed = await boundedJson<{
      identity: D.ExecutionIdentity;
      result?: WorkspaceRuntimeResult<"utf8">;
      proof: string;
      runtimeId?: string;
      quiescent?: boolean;
      quiescence?: D.RuntimeQuiescence;
    }>(request, wireLimits.jsonBytes);
    requireThat(
      new TextEncoder().encode(JSON.stringify(observed.result ?? null)).length <=
        this.owner.policy.bounds.inlineTailBytes * 3 + 65_536,
      "payload_too_large",
      "Execution observation exceeds bound",
    );
    await this.owner.mutex.run(() =>
      this.owner.state.transaction(() => {
        const row = this.owner.state.get<RecordEntry>(`execution:${observed.identity.executionId}`);
        requireThat(
          row &&
            same(row.allocation, allocation) &&
            row.observationKey === observed.proof &&
            row.prepared.request.identity.assignmentDigest === observed.identity.assignmentDigest &&
            row.state !== "prepared",
          "unauthorized",
          "Invalid private completion proof",
        );
        if (!observed.result) {
          requireThat(
            Object.keys(observed).sort().join(",") === "identity,proof,runtimeId" &&
              row.nativeContext &&
              observed.runtimeId,
            "invalid_request",
            "Exact native SDK acknowledgment required",
          );
          this.row(ctx, observed.identity);
          validateLease(this.owner.state, this.owner.current(), observed.identity.lease, ctx);
          new WorkspaceStorage(this.owner).acknowledgeHost(row.nativeContext, observed.runtimeId);
          requireThat(
            !row.runtimeId || row.runtimeId === observed.runtimeId,
            "conflict",
            "Acknowledged runtime identity changed",
          );
          row.runtimeId = observed.runtimeId;
          this.owner.state.put(`execution:${observed.identity.executionId}`, row);
          return;
        }
        requireThat(
          row.result?.sync.status !== "complete" || same(row.result, observed.result),
          "conflict",
          "Completed runtime evidence changed",
        );
        row.result = observed.result;
        row.state = observed.result.sync.status === "complete" ? "terminal" : "unknown";
        row.storageQuiescent =
          row.storageQuiescent ||
          (observed.quiescent === true &&
            observed.result.sync.status === "complete" &&
            observed.result.sync.skipped.length === 0 &&
            observed.result.skipped.length === 0 &&
            (!row.hostId ||
              (validQuiescence(observed.quiescence) &&
                observed.quiescence.runtimeId === observed.runtimeId &&
                observed.quiescence.imageDigest === row.nativeImageDigest)));
        if (observed.runtimeId) {
          requireThat(
            !row.runtimeId || row.runtimeId === observed.runtimeId,
            "interrupted",
            "Runtime identity changed",
          );
          row.runtimeId = observed.runtimeId;
        }
        row.observation = {
          identity: observed.identity,
          state: observed.result.sync.status === "complete" ? "terminal" : "pending_sync",
          ...(observed.runtimeId ? { runtimeUuid: observed.runtimeId } : {}),
          ...(row.observation.state === "terminal" && row.observation.result
            ? { result: row.observation.result }
            : {}),
        };
        this.owner.state.put(`execution:${observed.identity.executionId}`, row);
      }),
    );
    return new Response(null, { status: 204 });
  }
  async stopChild(): Promise<void> {
    const started = this.owner.state.get<string>("scratch-start");
    const saved = this.owner.state.get<{ result: WorkspaceRuntimeResult<"utf8"> }>(
      "scratch-result",
    );
    requireThat(
      !started || this.workspace || this.completion || saved?.result.sync.status === "complete",
      "interrupted",
      "Lost runtime/sync authority cannot prove scratch quiescence; retain its allocation",
    );
    if (this.active && this.workspace && this.identity)
      await this.workspace.runtime.killExec(this.identity.executionId, {
        backend: this.identity.target.kind === "backend" ? this.identity.target.backendId : "",
        signal: "SIGKILL",
      });
    await this.completion;
    await this.workspace?.close();
    if (this.scratchStore) this.scratchStore.runtimePinned = false;
    this.active = false;
    this.container = undefined;
    this.host = undefined;
    this.workspace = undefined;
    this.scratchStore = undefined;
  }
}
function tail(text: string, maximum: number): string {
  const bytes = new TextEncoder().encode(text);
  return new TextDecoder().decode(bytes.slice(-maximum));
}
function sameExecutionIdentity(a: D.ExecutionIdentity, b: D.ExecutionIdentity): boolean {
  const immutable = (identity: D.ExecutionIdentity) => {
    const { expiresAt: _expiry, leaseVersion: _version, ...lease } = identity.lease;
    return { ...identity, lease };
  };
  return same(immutable(a), immutable(b));
}
async function sha(bytes: Uint8Array): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(bytes).digest("hex");
}
