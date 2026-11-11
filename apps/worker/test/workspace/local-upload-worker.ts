import { commitDigest, manifestDigest } from "fortipi-contract";
import type * as D from "../../src/boundary/dto.js";
import type { Env } from "../../src/boundary/env.js";
import original, { ControlFixture as BaseControl } from "./runtime-worker.ts";

export { WorkspaceObject } from "./runtime-worker.ts";

/** CP metadata/ACK model only. Sagan's separate assembly exercises actual native bytes/apply. */
export class ControlFixture extends BaseControl {
  async resolveExecutorGeneration() {
    return {
      ok: true as const,
      value: {
        executorId: "executor",
        executorGeneration: 1,
        transferLimits: {
          chunkBytes: 65536,
          fileBytes: 4194304,
          snapshotBytes: 4194304,
          artifactBytes: 1048576,
          manifestEntries: 512,
        },
      },
    };
  }
  async openTransfer(
    _ctx: D.AuthContext,
    input: Omit<
      Extract<D.TransferDescriptor, { purpose: "local-stage" }>,
      "transferId" | "attemptId"
    >,
  ): Promise<D.Outcome<D.TransferDescriptor>> {
    if (input.purpose !== "local-stage" || input.size !== 0 || input.chunkHashes.length !== 0)
      throw new Error("Expected exact zero-byte local-stage descriptor");
    const descriptor = { ...input, transferId: "empty-transfer", attemptId: "empty-attempt" };
    await this.ctx.storage.put("local-descriptor", descriptor);
    await this.ctx.storage.put("opens", ((await this.ctx.storage.get<number>("opens")) ?? 0) + 1);
    return { ok: true, value: descriptor };
  }
  async observeTransfer(
    _ctx: D.AuthContext,
    input: { transferId: string; attemptId: string },
  ): Promise<D.Outcome<D.TransferStatus>> {
    const descriptor = await this.ctx.storage.get<D.TransferDescriptor>("local-descriptor");
    if (input.transferId !== descriptor?.transferId || input.attemptId !== descriptor.attemptId)
      throw new Error("Transfer correlation mismatch");
    const count = ((await this.ctx.storage.get<number>("observes")) ?? 0) + 1;
    await this.ctx.storage.put("observes", count);
    return {
      ok: true,
      value: {
        ...input,
        state: count === 1 ? "waiting" : "verified",
        bytes: 0,
        verifiedChunks: [],
      },
    };
  }
  async requestLocalWorkspace(
    ctx: D.AuthContext,
    input: D.LocalWorkspaceRequest,
  ): Promise<D.Outcome<D.LocalWorkspaceResponse>> {
    if (input.kind === "snapshot") {
      const manifest: D.Manifest = { version: 1, entries: [] };
      return {
        ok: true,
        value: {
          kind: "snapshot",
          result: {
            workspaceId: input.workspaceId,
            revision: input.revision,
            manifest,
            manifestHash: await manifestDigest(manifest),
          },
        },
      };
    }
    if (input.kind === "prepare") {
      const descriptor = await this.ctx.storage.get<D.TransferDescriptor>("local-descriptor");
      if (
        descriptor?.purpose !== "local-stage" ||
        input.mode.kind !== "staged-change" ||
        descriptor.content.uploadId !== input.mode.uploadId ||
        (await this.ctx.storage.get<number>("observes")) !== 2
      )
        throw new Error("Prepare preceded exact empty transfer settlement");
      await this.ctx.storage.put("local-prepare", input);
      return {
        ok: true,
        value: {
          state: "prepared",
          preparationId: "native-preparation",
          operationId: input.operationId,
          operationDigest: input.operationDigest,
          preManifestHash: input.expectedManifestHash,
          expiresAt: ctx.deadline,
        },
      };
    }
    const prepared = await this.ctx.storage.get<D.LocalPrepare>("local-prepare");
    if (prepared?.mode.kind !== "staged-change") throw new Error("Preparation missing");
    if (input.kind === "apply") {
      await this.ctx.storage.put(
        "applies",
        ((await this.ctx.storage.get<number>("applies")) ?? 0) + 1,
      );
      return {
        ok: true,
        value: {
          state: "applied",
          operationId: input.operationId,
          operationDigest: input.operationDigest,
          commitId: input.commitId,
          preparationId: input.preparationId,
          observationSeq: 1,
          appliedAt: Date.now(),
          preManifestHash: prepared.expectedManifestHash,
          postManifestHash: prepared.mode.postManifestHash,
        },
      };
    }
    if (input.kind !== "receipt" || input.receipt.providerKind !== "local")
      throw new Error("Unexpected local fixture request");
    const digest = await commitDigest({
      commitId: input.receipt.commitId,
      uploadId: prepared.mode.uploadId,
      operationId: input.operationId,
      workspaceId: input.workspaceId,
      baseRevision: input.baseRevision,
      manifestHash: input.receipt.manifestHash,
      leaseIdentity: prepared.lease,
      storage: {
        kind: "local",
        preparationId: input.preparationId,
        observationSeq: 1,
        preManifestHash: prepared.expectedManifestHash,
        postManifestHash: prepared.mode.postManifestHash,
      },
    });
    if (input.receipt.commitDigest !== digest)
      throw new Error("Native receipt upload preimage mismatch");
    const receipts = ((await this.ctx.storage.get<number>("receipts")) ?? 0) + 1;
    await this.ctx.storage.put("receipts", receipts);
    if (receipts === 1)
      return {
        ok: false,
        code: "interrupted",
        requestId: ctx.requestId,
        message: "Synthetic lost receipt acknowledgment",
        retryable: false,
        details: { reason: "uncertain_effects" },
      };
    return {
      ok: true,
      value: { deliveryId: input.receipt.commitId, sequence: 1, persisted: true },
    };
  }
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/__test/local-state") return super.fetch(request);
    return Response.json({
      opens: await this.ctx.storage.get("opens"),
      observes: await this.ctx.storage.get("observes"),
      applies: await this.ctx.storage.get("applies"),
      receipts: await this.ctx.storage.get("receipts"),
    });
  }
}
export default {
  fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === "/local-state")
      return env.CONTROL_PLANE.getByName("control").fetch(
        new Request("https://control.internal/__test/local-state"),
      );
    return original.fetch(request, env);
  },
};
