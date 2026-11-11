import Ajv from "ajv/dist/2020.js";
import { publicCommitReceipt, schemaRegistry } from "fortipi-contract";
import type * as D from "../boundary/dto.js";
import { authorizeReservedAction, same } from "./authority.js";
import { requireThat, WorkspaceError } from "./errors.js";
import type { WorkspaceObject } from "./workspace-object.js";

const ajv = new Ajv({ strict: true, allErrors: false, validateFormats: false });
for (const schema of Object.values(schemaRegistry)) ajv.addSchema(schema);
const valid = ajv.compile<D.JobCommitted>({
  $ref: "https://fortipi.dev/schemas/1.0.0/executor-messages.schema.json#/$defs/JobCommitted",
});

/** A workspace evidence check, not an AgentSession terminal-coordinate attestation. Caller holds the FIFO. */
export function terminalProof(
  owner: WorkspaceObject,
  ctx: D.AuthContext,
  input: unknown,
): D.JobCommitted {
  requireThat(valid(input), "invalid_request", "Invalid terminal proof");
  const { identity, evidence } = input;
  const lease = identity.lease;
  const authority = owner.current();
  requireThat(
    owner.isSelf(authority.workspaceId) &&
      !owner.state.get("child") &&
      lease.ownerKind === "job" &&
      lease.workspaceId === authority.workspaceId &&
      identity.baseRevision === lease.baseRevision &&
      input.terminalVersion > 0,
    "conflict",
    "Terminal workspace identity mismatch",
  );
  let reservation: D.TargetReservation;
  try {
    reservation = authorizeReservedAction(owner.state, ctx, lease, "workspace.write");
  } catch (error) {
    if (
      evidence.kind === "committed" ||
      !(error instanceof WorkspaceError) ||
      error.code !== "unauthorized"
    )
      throw error;
    reservation = authorizeReservedAction(owner.state, ctx, lease, "workspace.read");
  }
  requireThat(
    reservation.ownerKind === "job" &&
      reservation.jobId === identity.jobId &&
      lease.jobId === identity.jobId &&
      reservation.executionId === identity.executionId &&
      reservation.operationDigest === identity.operationDigest &&
      reservation.deadline === identity.deadline &&
      same(reservation.target, identity.target),
    "conflict",
    "Terminal reservation identity mismatch",
  );
  const cloud = owner.state.get<{ prepared: D.PreparedExecution }>(
    `execution:${identity.executionId}`,
  );
  if (cloud) {
    const original = cloud.prepared.request.identity;
    requireThat(
      original.assignmentDigest === identity.assignmentDigest &&
        original.operationDigest === identity.operationDigest,
      "conflict",
      "Terminal assignment mismatch",
    );
  }
  if (evidence.kind === "committed") {
    const receipt = owner.state.get<D.CommitReceipt>(`receipt:${evidence.receipt.commitId}`);
    requireThat(
      receipt &&
        receipt.workspaceId === authority.workspaceId &&
        receipt.jobId === identity.jobId &&
        receipt.operationId === lease.operationId &&
        receipt.baseRevision === identity.baseRevision &&
        same(publicCommitReceipt(receipt), evidence.receipt),
      "conflict",
      "Terminal receipt is not authoritative",
    );
    const revision = owner.revision(receipt.revision);
    requireThat(
      revision.manifestHash === receipt.manifestHash &&
        (receipt.providerKind !== "computer" || same(revision.store, receipt.storeRef)),
      "conflict",
      "Terminal revision is not retained",
    );
  } else {
    requireThat(
      evidence.workspaceId === authority.workspaceId &&
        evidence.executionId === identity.executionId &&
        evidence.baseRevision === identity.baseRevision &&
        evidence.observedAt <= Date.now() &&
        owner.revision(evidence.baseRevision).manifestHash === evidence.manifestHash,
      "conflict",
      "Unchanged-base evidence is not authoritative",
    );
  }
  return input;
}
