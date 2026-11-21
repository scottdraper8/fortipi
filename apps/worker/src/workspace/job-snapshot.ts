import Ajv from "ajv/dist/2020.js";
import { manifestDigest, schemaRegistry, validateAssignment } from "fortipi-contract";
import type * as D from "../boundary/dto.js";
import {
  authorizeReservedAction,
  immutableLease,
  permitsResource,
  same,
  validateLease,
} from "./authority.js";
import { requireThat } from "./errors.js";
import type { WorkspaceObject } from "./workspace-object.js";

type Owner = Pick<
  WorkspaceObject,
  "state" | "mutex" | "isSelf" | "current" | "revision" | "readStored"
>;
const ajv = new Ajv({ strict: true, allErrors: false, validateFormats: false });
for (const schema of Object.values(schemaRegistry)) ajv.addSchema(schema);
const valid = ajv.compile<D.ExecutorWorkspaceAccess>({
  type: "object",
  additionalProperties: false,
  required: ["assignment", "lease"],
  properties: {
    assignment: {
      $ref: "https://fortipi.dev/schemas/1.0.0/executor-messages.schema.json#/$defs/Assignment",
    },
    lease: { $ref: "https://fortipi.dev/schemas/1.0.0/workspaces.schema.json#/$defs/Lease" },
  },
});

/** Current leased-base authority only; CP separately proves actual attempted dispatch/connection. */
function proof(owner: Owner, ctx: D.AuthContext, input: D.ExecutorWorkspaceAccess) {
  const { assignment, lease } = input;
  const { identity, operationContext } = assignment;
  const authority = owner.current();
  requireThat(
    owner.isSelf(assignment.workspaceId) &&
      !owner.state.get("child") &&
      authority.workspaceId === assignment.workspaceId &&
      authority.binding.config.kind === "computer" &&
      authority.binding.bindingVersion === assignment.bindingVersion &&
      authority.binding.revision === identity.baseRevision &&
      identity.target.kind === "executor" &&
      identity.lease.ownerKind === "job" &&
      lease.ownerKind === "job" &&
      same(immutableLease(identity.lease), immutableLease(lease)),
    "conflict",
    "Assigned Computer snapshot identity changed",
  );
  const reservation = authorizeReservedAction(owner.state, ctx, lease, "workspace.write");
  const active = validateLease(owner.state, authority, lease, ctx);
  requireThat(
    reservation.ownerKind === "job" &&
      reservation.reservationId === assignment.reservationId &&
      reservation.jobId === identity.jobId &&
      lease.jobId === identity.jobId &&
      reservation.executionId === identity.executionId &&
      reservation.operationId === lease.operationId &&
      reservation.operationDigest === identity.operationDigest &&
      reservation.bindingVersion === assignment.bindingVersion &&
      same(reservation.target, identity.target) &&
      identity.deadline <= reservation.deadline &&
      identity.deadline > Date.now() &&
      operationContext.deploymentId === ctx.deploymentId &&
      operationContext.agentId === reservation.agentId &&
      operationContext.conversationId === reservation.conversationId &&
      reservation.registrationIds.workspace === ctx.registrationId &&
      lease.expiresAt > Date.now() &&
      lease.expiresAt <= active.expiresAt &&
      lease.leaseVersion <= active.leaseVersion,
    "conflict",
    "Assigned snapshot reservation or lease changed",
  );
  requireThat(
    ctx.grants.some(
      (grant) =>
        (grant.expiresAt === undefined || grant.expiresAt > Date.now()) &&
        permitsResource(grant.resources.actions, "jobs.dispatch") &&
        reservation.actions.every((action) => permitsResource(grant.resources.actions, action)) &&
        permitsResource(grant.resources.actions, "workspace.write") &&
        permitsResource(grant.resources.tools, assignment.tool) &&
        permitsResource(grant.resources.workspaceIds, assignment.workspaceId) &&
        permitsResource(grant.resources.agentIds, operationContext.agentId) &&
        permitsResource(grant.resources.conversationIds, operationContext.conversationId) &&
        permitsResource(grant.resources.executorIds, lease.executorId),
    ),
    "unauthorized",
    "One current full job snapshot grant required",
  );
  const revision = owner.revision(identity.baseRevision);
  requireThat(
    revision.manifestHash === authority.binding.manifestHash,
    "conflict",
    "Assigned base hash changed",
  );
  return revision;
}

export async function jobSnapshot(
  owner: Owner,
  ctx: D.AuthContext,
  request: Request,
  body: unknown,
) {
  requireThat(valid(body), "invalid_request", "Invalid assigned workspace snapshot proof");
  try {
    await validateAssignment(body.assignment);
  } catch {
    requireThat(false, "conflict", "Assigned snapshot semantic digest mismatch");
  }
  const revision = await owner.mutex.run(() => proof(owner, ctx, body));
  const hash = await manifestDigest(revision.manifest);
  await owner.mutex.run(() => {
    const current = proof(owner, ctx, body);
    requireThat(
      hash === current.manifestHash,
      "conflict",
      "Assigned retained manifest hash mismatch",
    );
  });
  const sha256 = new URL(request.url).searchParams.get("sha256");
  if (sha256 === null)
    return {
      kind: "manifest" as const,
      body: {
        workspaceId: body.assignment.workspaceId,
        revision: revision.revision,
        manifestHash: revision.manifestHash,
        manifest: revision.manifest,
      } satisfies D.ManifestResponse,
    };
  const entry = revision.manifest.entries.find(
    (entry) => entry.type === "file" && entry.sha256 === sha256,
  );
  requireThat(entry?.type === "file", "not_found", "Blob is not a retained assigned base member");
  const deadline = Math.min(ctx.deadline, body.assignment.identity.deadline, body.lease.expiresAt);
  return {
    kind: "blob" as const,
    entry,
    deadline,
    open: async () => {
      await owner.mutex.run(() => proof(owner, ctx, body));
      const source = await owner.readStored(ctx, revision, entry);
      try {
        await owner.mutex.run(() => proof(owner, ctx, body));
      } catch (error) {
        await source.cancel().catch(() => {});
        throw error;
      }
      const reader = source.getReader();
      let closed = false;
      let fail: (error: Error) => void = () => {};
      const finish = async () => {
        if (!closed) {
          closed = true;
          clearTimeout(timer);
          request.signal.removeEventListener("abort", abort);
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      };
      const abort = () => {
        if (!closed) {
          fail(new Error("Assigned snapshot stream cancelled or expired"));
          void finish();
        }
      };
      const timer = setTimeout(abort, Math.max(1, deadline - Date.now()));
      request.signal.addEventListener("abort", abort, { once: true });
      return new ReadableStream<Uint8Array>({
        start(controller) {
          fail = (error) => controller.error(error);
          if (request.signal.aborted) abort();
        },
        pull: async (controller) => {
          try {
            await owner.mutex.run(() => {
              requireThat(
                !closed && Date.now() < deadline,
                "interrupted",
                "Snapshot stream closed",
              );
              proof(owner, ctx, body);
            });
            const next = await reader.read();
            await owner.mutex.run(() => {
              requireThat(
                !closed && Date.now() < deadline,
                "interrupted",
                "Snapshot stream closed",
              );
              proof(owner, ctx, body);
              if (!next.done) controller.enqueue(next.value);
            });
            if (next.done) {
              await finish();
              controller.close();
            }
          } catch (error) {
            await finish();
            controller.error(error);
          }
        },
        cancel: finish,
      });
    },
  };
}
