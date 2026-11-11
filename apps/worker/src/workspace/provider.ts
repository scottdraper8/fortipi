import type * as D from "../boundary/dto.js";
import type { FactoryDependencies } from "../boundary/env.js";
import type {
  WorkspaceProvider,
  WorkspaceStreams,
  WorkspaceTransfer,
} from "../boundary/workspace-provider.js";
import { outcome, requireThat } from "./errors.js";
import { internalHeader } from "./workspace-object.js";

/** Adapters retain provider independence; they never receive or return a raw Computer stub. */
export class Provider implements WorkspaceProvider {
  readonly contractVersion = "1.0" as const;
  readonly capabilities = ["read", "write", "snapshot", "diff"] as const;
  readonly deps: FactoryDependencies;
  constructor(deps: FactoryDependencies) {
    this.deps = deps;
  }
  describe: D.ApiMethod<"describeWorkspace"> = (ctx, input) =>
    this.deps.authority.describe(ctx, input);
  list: D.ApiMethod<"listWorkspaceFiles"> = (ctx, input) => this.deps.authority.list(ctx, input);
  stat: D.ApiMethod<"statWorkspaceFile"> = (ctx, input) => this.deps.authority.stat(ctx, input);
  snapshot: D.ApiMethod<"snapshotWorkspace"> = (ctx, input) =>
    this.deps.authority.snapshot(ctx, input);
  diff: D.ApiMethod<"diffWorkspace"> = (ctx, input) => this.deps.authority.diff(ctx, input);
  read(ctx: D.AuthContext, input: D.OperationRequest<"readWorkspaceFile">) {
    return this.deps.authority.read(ctx, input);
  }
  write(ctx: D.AuthContext, input: D.WorkspaceTransaction) {
    return this.deps.authority.transact(ctx, input);
  }
  delete(ctx: D.AuthContext, input: D.WorkspaceTransaction) {
    return this.deps.authority.transact(ctx, input);
  }
  mkdir(ctx: D.AuthContext, input: D.WorkspaceTransaction) {
    return this.deps.authority.transact(ctx, input);
  }
}
export function createWorkspaceProvider(
  _config: D.WorkspaceConfig,
  deps: FactoryDependencies,
): Promise<D.Outcome<WorkspaceProvider>> {
  return Promise.resolve({ ok: true, value: new Provider(deps) });
}
export class Transfer implements WorkspaceTransfer, WorkspaceStreams {
  readonly contractVersion = "1.0" as const;
  readonly deps: FactoryDependencies;
  constructor(deps: FactoryDependencies) {
    this.deps = deps;
  }
  private request(ctx: D.AuthContext, action: string, input: unknown): Promise<Response> {
    return this.deps.authority.fetch(
      new Request(`https://workspace.internal/__fortipi/transfer/${action}`, {
        method: "POST",
        headers: { [internalHeader]: JSON.stringify({ auth: ctx }) },
        body: JSON.stringify(input),
      }),
    );
  }
  materialize(ctx: D.AuthContext, input: D.SnapshotPlan): Promise<D.Outcome<D.ScratchHandle>> {
    return outcome(async () => {
      const response = await this.request(ctx, "materialize", input);
      requireThat(response.ok, "interrupted", "Materialization incomplete");
      return (await response.json()) as D.ScratchHandle;
    }, ctx.requestId);
  }
  upload(ctx: D.AuthContext, input: D.ScratchResult): Promise<D.Outcome<D.ValidatedStage>>;
  upload(
    ctx: D.AuthContext,
    input: D.UploadLookup,
    bytes: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<D.Outcome<D.ValidatedStage>>;
  upload(
    ctx: D.AuthContext,
    input: D.ScratchResult | D.UploadLookup,
    bytes?: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<D.Outcome<D.ValidatedStage>> {
    return outcome(async () => {
      const response = bytes
        ? await this.deps.authority.fetch(
            new Request("https://workspace.internal/__fortipi/transfer/upload-stream", {
              method: "POST",
              headers: {
                [internalHeader]: JSON.stringify({ auth: ctx }),
                "x-fortipi-upload": JSON.stringify(input),
              },
              body: bytes,
              ...(signal ? { signal } : {}),
            }),
          )
        : await this.request(ctx, "upload", input);
      requireThat(response.ok, "interrupted", "Upload not fully validated");
      return (await response.json()) as D.ValidatedStage;
    }, ctx.requestId);
  }
  commit(ctx: D.AuthContext, input: D.CommitInput) {
    return this.deps.authority.commit(ctx, input);
  }
  abort(ctx: D.AuthContext, input: D.UploadLookup): Promise<D.Outcome<D.CleanupReceipt>> {
    return outcome(async () => {
      const response = await this.request(ctx, "abort", input);
      requireThat(response.ok, "interrupted", "Cleanup not confirmed");
      return (await response.json()) as D.CleanupReceipt;
    }, ctx.requestId);
  }
  read(
    ctx: D.AuthContext,
    input: D.ByteReference,
    signal?: AbortSignal,
  ): Promise<D.Outcome<ReadableStream<Uint8Array>>> {
    return outcome(async () => {
      requireThat(
        input.endpoint.startsWith(`/v1/workspaces/${input.workspaceId}/`) &&
          !input.endpoint.includes("..") &&
          !input.endpoint.startsWith("//"),
        "unauthorized",
        "Authority-relative byte endpoint required",
      );
      const response = await this.deps.authority.fetch(
        new Request(`https://workspace.internal${input.endpoint}`, {
          headers: { [internalHeader]: JSON.stringify({ auth: ctx }) },
          ...(signal ? { signal } : {}),
        }),
      );
      requireThat(
        response.ok &&
          response.body &&
          response.headers.get("X-Content-SHA256") === input.sha256 &&
          response.headers.get("Content-Length") === String(input.size),
        "interrupted",
        "Byte reference mismatch",
      );
      return response.body;
    }, ctx.requestId);
  }
}
