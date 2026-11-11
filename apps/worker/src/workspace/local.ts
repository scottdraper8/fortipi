import { digestJson, validateChunkInventory } from "fortipi-contract";
import type { ControlPlaneRpc } from "../boundary/control-plane.js";
import type * as D from "../boundary/dto.js";
import { requireThat, unwrap } from "./errors.js";

/** Metadata adapter only: bytes and retained native snapshots stay with the owning daemon. */
export class LocalProvider {
  readonly control: Pick<ControlPlaneRpc, "resolveExecutorGeneration" | "requestLocalWorkspace">;
  constructor(
    control: Pick<ControlPlaneRpc, "resolveExecutorGeneration" | "requestLocalWorkspace">,
  ) {
    this.control = control;
  }
  private async makeRequest(
    ctx: D.AuthContext,
    binding: D.WorkspaceBinding,
    revision: string,
    kind: "snapshot" | "list" | "stat" | "read" | "diff",
    path?: string,
    otherRevision?: string,
  ): Promise<D.LocalReadRequest> {
    requireThat(binding.config.kind === "local", "invalid_request", "Local binding required");
    const owner = unwrap(
      await this.control.resolveExecutorGeneration(ctx, {
        workspaceId: binding.workspaceId,
        bindingVersion: binding.bindingVersion,
        executorId: binding.config.executorId,
      }),
    );
    const common = {
      operationId: `read_${await digestJson("operation", { kind: "local-observation", requestId: ctx.requestId, workspaceId: binding.workspaceId, bindingVersion: binding.bindingVersion, revision, action: kind, path: path ?? null, otherRevision: otherRevision ?? null })}`,
      workspaceId: binding.workspaceId,
      bindingVersion: binding.bindingVersion,
      rootBindingId: binding.config.rootBindingId,
      executorId: owner.executorId,
      executorGeneration: owner.executorGeneration,
      credential: {
        credentialId: ctx.credentialId,
        generation: ctx.generation,
        grantVersion: ctx.grantVersion,
      },
      revision,
      deadline: ctx.deadline,
    };
    let request: D.LocalReadRequest;
    if (kind === "read" || kind === "stat") {
      requireThat(path, "invalid_request", "Path required");
      request = { ...common, kind, path };
    } else if (kind === "diff") {
      requireThat(otherRevision, "invalid_request", "Other revision required");
      request = { ...common, kind, otherRevision };
    } else request = { ...common, kind, ...(path ? { path } : {}) };
    return request;
  }
  private async request(
    ctx: D.AuthContext,
    binding: D.WorkspaceBinding,
    revision: string,
    kind: "snapshot" | "list" | "stat" | "read" | "diff",
    path?: string,
    otherRevision?: string,
  ): Promise<D.LocalWorkspaceResponse> {
    return unwrap(
      await this.control.requestLocalWorkspace(
        ctx,
        await this.makeRequest(ctx, binding, revision, kind, path, otherRevision),
      ),
    );
  }
  async readPlan(
    ctx: D.AuthContext,
    binding: D.WorkspaceBinding,
    revision: string,
    path: string,
  ): Promise<{ request: D.LocalReadRequest; reference: D.ByteReference }> {
    const request = await this.makeRequest(ctx, binding, revision, "read", path);
    const result = unwrap(await this.control.requestLocalWorkspace(ctx, request));
    requireThat(
      "kind" in result &&
        result.kind === "read" &&
        result.result.chunks &&
        result.result.owner.kind === "local" &&
        result.result.owner.executorId === request.executorId,
      "interrupted",
      "Owner read metadata/chunk inventory unavailable",
    );
    try {
      validateChunkInventory(result.result.chunks, result.result.size);
    } catch {
      requireThat(false, "workspace.conflict", "Owner chunk inventory is incompatible", {
        reason: "local_drift",
      });
    }
    return { request, reference: result.result };
  }
  async produce(
    ctx: D.AuthContext,
    request: D.LocalReadRequest,
    transfers: D.TransferDescriptor[],
    reference: D.ByteReference,
  ): Promise<void> {
    requireThat(request.kind === "read", "invalid_request", "Read producer scope required");
    const result = unwrap(await this.control.requestLocalWorkspace(ctx, { ...request, transfers }));
    requireThat(
      "kind" in result &&
        result.kind === "read" &&
        result.result.sha256 === reference.sha256 &&
        result.result.size === reference.size &&
        result.result.workspaceId === reference.workspaceId &&
        result.result.revision === reference.revision &&
        JSON.stringify(result.result.chunks) === JSON.stringify(reference.chunks),
      "workspace.conflict",
      "Owner read changed during transfer",
      { reason: "local_drift" },
    );
  }
  async snapshot(
    ctx: D.AuthContext,
    binding: D.WorkspaceBinding,
    revision: string,
  ): Promise<D.ManifestResponse> {
    const result = await this.request(ctx, binding, revision, "snapshot");
    requireThat(
      "kind" in result && result.kind === "snapshot",
      "interrupted",
      "Owner snapshot observation unavailable",
    );
    return result.result;
  }
  async list(
    ctx: D.AuthContext,
    binding: D.WorkspaceBinding,
    revision: string,
    path?: string,
  ): Promise<D.WorkspaceList> {
    const result = await this.request(ctx, binding, revision, "list", path);
    requireThat(
      "kind" in result && result.kind === "list",
      "interrupted",
      "Owner list observation unavailable",
    );
    return result.result;
  }
  async stat(
    ctx: D.AuthContext,
    binding: D.WorkspaceBinding,
    revision: string,
    path: string,
  ): Promise<D.WorkspaceStat> {
    const result = await this.request(ctx, binding, revision, "stat", path);
    requireThat(
      "kind" in result && result.kind === "stat",
      "interrupted",
      "Owner stat observation unavailable",
    );
    return result.result;
  }
  async read(
    ctx: D.AuthContext,
    binding: D.WorkspaceBinding,
    revision: string,
    path: string,
  ): Promise<D.ByteReference> {
    return (await this.readPlan(ctx, binding, revision, path)).reference;
  }
  async diff(
    ctx: D.AuthContext,
    binding: D.WorkspaceBinding,
    revision: string,
    otherRevision: string,
  ): Promise<D.WorkspaceDiff> {
    const result = await this.request(ctx, binding, revision, "diff", undefined, otherRevision);
    requireThat(
      "kind" in result && result.kind === "diff",
      "interrupted",
      "Owner diff observation unavailable",
    );
    return result.result;
  }
}
