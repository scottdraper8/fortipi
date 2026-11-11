import { assignmentDigest, operationDigest } from "fortipi-contract";
import type { ControlPlaneRpc } from "../../src/boundary/control-plane.js";
import type * as D from "../../src/boundary/dto.js";
import { uuid, value } from "./harness.ts";

export async function assignedJob(
  h: {
    deploymentId: string;
    cp: Pick<ControlPlaneRpc, "reserveTarget" | "recordDispatchIntent" | "assignOnce">;
  },
  actor: D.AuthContext,
  options: { leaseExpiresAt?: number; actions?: string[] } = {},
) {
  const operation: D.OperationDigestInput = {
    deploymentId: h.deploymentId,
    agentId: "agent",
    conversationId: "conversation",
    workspaceId: "workspace",
    tool: "shell",
    arguments: { command: "synthetic fixture process; never executed" },
    baseRevision: "original_base",
    target: { kind: "executor", executorId: "executor", generation: 1 },
    policyVersion: 1,
    grantVersion: actor.grantVersion,
    deadline: Date.now() + 60000,
  };
  const reservation = value(
    await h.cp.reserveTarget(actor, {
      ownerKind: "job",
      jobId: uuid(),
      executionId: uuid(),
      operationId: uuid(),
      operationDigest: await operationDigest(operation),
      agentId: "agent",
      conversationId: "conversation",
      workspaceId: "workspace",
      bindingVersion: 1,
      target: operation.target,
      actions: options.actions ?? ["jobs.dispatch", "workspace.write"],
      deadline: operation.deadline,
      expiresAt: options.leaseExpiresAt ?? Date.now() + 30000,
    }),
  );
  if (reservation.ownerKind !== "job") throw new Error("Expected job reservation");
  const lease: D.Lease = {
    ownerKind: "job",
    jobId: reservation.jobId,
    leaseId: uuid(),
    operationId: reservation.operationId,
    credential: reservation.credential,
    registrationId: reservation.registrationIds.workspace,
    leaseVersion: 1,
    workspaceId: "workspace",
    executorId: "executor",
    executorGeneration: 1,
    fence: "1",
    baseRevision: operation.baseRevision,
    expiresAt: reservation.expiresAt,
  };
  const assignment: D.Assignment = {
    operationContext: {
      deploymentId: h.deploymentId,
      agentId: "agent",
      conversationId: "conversation",
      policyVersion: 1,
    },
    identity: {
      jobId: reservation.jobId,
      executionId: reservation.executionId,
      operationDigest: reservation.operationDigest,
      assignmentDigest: await assignmentDigest({
        operation,
        executionId: reservation.executionId,
        reservationId: reservation.reservationId,
        leaseId: lease.leaseId,
        fence: lease.fence,
        executorGeneration: 1,
      }),
      target: operation.target,
      lease,
      baseRevision: operation.baseRevision,
      deadline: operation.deadline,
    },
    reservationId: reservation.reservationId,
    tool: operation.tool,
    arguments: operation.arguments,
    workspaceId: "workspace",
    bindingVersion: 1,
    rootBindingId: "root",
  };
  value(await h.cp.recordDispatchIntent(actor, { reservation, assignment, expectedJobVersion: 1 }));
  value(await h.cp.assignOnce(actor, assignment));
  return { assignment, reservation, identity: assignment.identity };
}
