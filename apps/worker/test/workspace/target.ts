import { workspaceLeaseDigest } from "fortipi-contract";
import type * as D from "../../src/boundary/dto.js";

/** Synthetic CP fixture identity, with the actual portable non-job recipe and storage holder. */
export async function workspaceTarget(
  operationId: string,
  baseRevision: string,
  overrides: Partial<
    Pick<
      Extract<D.TargetRequest, { ownerKind: "workspace-operation" }>,
      "target" | "bindingVersion" | "deadline" | "expiresAt"
    >
  > = {},
): Promise<Extract<D.TargetRequest, { ownerKind: "workspace-operation" }>> {
  const preimage = {
    deploymentId: "test-deployment",
    operationId,
    workspaceId: "workspace",
    bindingVersion: overrides.bindingVersion ?? 1,
    baseRevision,
    target: overrides.target ?? {
      kind: "backend" as const,
      backendId: "workspace",
      generation: overrides.bindingVersion ?? 1,
    },
    credential: { credentialId: "credential", generation: 1, grantVersion: 1 },
    deadline: overrides.deadline ?? Date.now() + 30_000,
  };
  return {
    ownerKind: "workspace-operation",
    operationId,
    workspaceId: "workspace",
    bindingVersion: preimage.bindingVersion,
    baseRevision,
    target: preimage.target,
    operationDigest: await workspaceLeaseDigest(preimage),
    actions: ["workspace.write"],
    deadline: preimage.deadline,
    expiresAt: overrides.expiresAt ?? preimage.deadline,
  };
}
