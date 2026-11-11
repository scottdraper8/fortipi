import { DurableObject } from "cloudflare:workers";
import type * as D from "../../src/boundary/dto.js";
import type { Env } from "../../src/boundary/env.js";
import { hashInventory } from "../../src/workspace/streams.js";
import {
  internalHeader,
  WorkspaceObject as WorkspaceBase,
} from "../../src/workspace/workspace-object.js";

/** Actual binding application plus a test-only post-transaction response barrier. */
export class WorkspaceObject extends WorkspaceBase {
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/__test/seed") {
      return new Response(null, { status: 404 });
    }
    if (path === "/__test/barrier")
      return new Response(this.state.get("test-barrier") ? "ready" : "waiting");
    return super.fetch(request);
  }
  override async commitUpload(
    ctx: D.AuthContext,
    input: D.OperationRequest<"commitUpload">,
  ): Promise<D.Outcome<D.OperationResponse<"commitUpload">>> {
    const result = await super.commitUpload(ctx, input);
    if (
      input.body.requestId === "crash-after-commit" &&
      result.ok &&
      !this.state.get("test-barrier")
    ) {
      this.state.put("test-barrier", true);
      await new Promise<never>(() => {});
    }
    return result;
  }
}
export class ControlFixture extends DurableObject {
  async reserveTarget(
    ctx: D.AuthContext,
    request: D.TargetRequest,
  ): Promise<D.Outcome<D.TargetReservation>> {
    const key = `target:${request.operationId}`;
    const existing = await this.ctx.storage.get<D.TargetReservation>(key);
    if (existing) return { ok: true, value: existing };
    const common = {
      reservationId: `reservation-${request.operationId}`,
      credential: {
        credentialId: ctx.credentialId,
        generation: ctx.generation,
        grantVersion: ctx.grantVersion,
      },
    };
    const value: D.TargetReservation =
      request.ownerKind === "job"
        ? {
            ...request,
            ...common,
            registrationIds: {
              agent: "agent-registration",
              workspace: ctx.registrationId ?? "registration",
            },
          }
        : {
            ...request,
            ...common,
            registrationIds: { workspace: ctx.registrationId ?? "registration" },
          };
    await this.ctx.storage.put(key, value);
    return { ok: true, value };
  }
  async reserveCapacity(
    _ctx: D.AuthContext,
    input: {
      operationId: string;
      ownerId: string;
      policyVersion: number;
      bytes: number;
      admissionSlots: number;
    },
  ): Promise<D.Outcome<D.CapacityReservation>> {
    return { ok: true, value: { ...input, reservationId: input.operationId, state: "reserved" } };
  }
}
type Call =
  | { kind: "acquire"; input: D.TargetRequest }
  | { kind: "reservation"; input: D.TargetRequest }
  | { kind: "binding"; input: D.WorkspaceBindingApplication }
  | { kind: "prepare-execution"; input: D.ExecutionRequest }
  | { kind: "start-execution"; input: D.PreparedExecution }
  | { kind: "query-execution"; input: D.ExecutionIdentity }
  | { kind: "collect-execution"; input: D.ExecutionIdentity }
  | { kind: "renew"; input: D.LeaseRenewal }
  | { kind: "release"; input: D.LeaseRelease }
  | { kind: "begin"; input: D.OperationRequest<"beginUpload"> }
  | { kind: "chunk"; input: D.OperationRequest<"putUploadChunk">; bytes: number[] }
  | { kind: "validate"; input: D.OperationRequest<"validateUpload"> }
  | { kind: "commit"; input: D.OperationRequest<"commitUpload"> }
  | { kind: "receipt"; input: D.CommitLookup }
  | { kind: "manifest"; input: D.OperationRequest<"getWorkspaceManifest"> }
  | { kind: "describe"; input: D.OperationRequest<"describeWorkspace"> }
  | { kind: "invalidate"; input: D.Invalidation }
  | { kind: "facts"; input: D.FactPageRequest }
  | { kind: "ack"; input: D.FactAckRequest }
  | { kind: "allocate"; input: D.StoreAllocationRequest }
  | { kind: "store"; input: D.StoreLookup }
  | { kind: "initialize"; input: D.StoreAllocation }
  | { kind: "retire"; input: D.StoreLookup }
  | {
      kind: "capacity";
      input: {
        operationId: string;
        ownerId: string;
        policyVersion: number;
        bytes: number;
        admissionSlots: number;
      };
    }
  | { kind: "child-state"; input: D.StoreLookup }
  | { kind: "child-mutate"; input: D.StoreAllocation; entry: D.ManifestEntry; bytes: number[] }
  | { kind: "delete"; input: D.StoreRetirement };
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ready") return new Response("ready");
    if (url.pathname === "/inventory" && request.body)
      return Response.json(
        await hashInventory(
          request.body,
          Number(url.searchParams.get("size")),
          Number(url.searchParams.get("grid")),
          Date.now() + 5000,
        ),
      );
    const ctx: D.AuthContext = {
      deploymentId: "test-deployment",
      principalId: "principal",
      role: "client",
      credentialId: "credential",
      generation: 1,
      grantVersion: 1,
      requestId: request.headers.get("x-test-request-id") ?? "request",
      authenticatedAt: Date.now(),
      credentialExpiresAt: null,
      deadline: Date.now() + 30_000,
      registrationId: "registration",
      grants: [
        {
          grantId: "grant",
          version: 1,
          resources: {
            agentIds: ["agent"],
            conversationIds: ["conversation"],
            workspaceIds: ["workspace"],
            actions: [
              "workspace.read",
              "workspace.write",
              "workspaces.create",
              "workspaces.rebind",
              "artifacts.read",
            ],
            tools: ["javascript"],
            executorIds: ["executor"],
            backendIds: ["backend"],
          },
        },
      ],
    };
    if (request.headers.get("x-test-bootstrap") === "1") {
      ctx.role = "admin";
      ctx.grants = [
        {
          grantId: "bootstrap",
          version: 1,
          resources: {
            workspaceIds: ["*"],
            actions: ["*"],
            agentIds: ["*"],
            conversationIds: ["*"],
            executorIds: ["*"],
            backendIds: ["*"],
            tools: ["*"],
          },
        },
      ];
    }
    if (request.headers.get("x-test-no-grants") === "1") ctx.grants = [];
    const authority = env.WORKSPACES.getByName("workspace");
    if (url.pathname === "/seed")
      return Response.json(
        await authority.applyBinding(
          { ...ctx, registrationId: "registration" },
          {
            requestId: "fixture-initial-binding",
            binding: { workspaceId: "workspace", bindingVersion: 1, config: { kind: "computer" } },
            expectedVersion: null,
          },
        ),
      );
    if (url.pathname === "/barrier")
      return authority.fetch(new Request("https://fixture.internal/__test/barrier"));
    if (url.pathname === "/read" || url.pathname.startsWith("/v1/workspaces/")) {
      const headers = new Headers(request.headers);
      headers.set(internalHeader, JSON.stringify({ auth: ctx }));
      return authority.fetch(new Request(request, { headers }));
    }
    const call = (await request.json()) as Call;
    switch (call.kind) {
      case "binding":
        return Response.json(
          await authority.applyBinding({ ...ctx, registrationId: "registration" }, call.input),
        );
      case "reservation":
        return Response.json(
          await env.CONTROL_PLANE.getByName("control").reserveTarget(ctx, call.input),
        );
      case "prepare-execution":
      case "start-execution":
      case "query-execution":
      case "collect-execution":
        return authority.fetch(
          new Request(`https://workspace.internal/__fortipi/authority/${call.kind.split("-")[0]}`, {
            method: "POST",
            headers: { [internalHeader]: JSON.stringify({ auth: ctx }) },
            body: JSON.stringify(call.input),
          }),
        );
      case "acquire": {
        const reservation = await env.CONTROL_PLANE.getByName("control").reserveTarget(
          ctx,
          call.input,
        );
        return Response.json(
          reservation.ok ? await authority.acquireLease(ctx, reservation.value) : reservation,
        );
      }
      case "renew":
        return Response.json(await authority.renewLease(ctx, call.input));
      case "release":
        return Response.json(await authority.releaseLease(ctx, call.input));
      case "begin":
        return Response.json(await authority.beginUpload(ctx, call.input));
      case "chunk":
        return Response.json(
          await authority.putChunk(ctx, { ...call.input, body: Uint8Array.from(call.bytes) }),
        );
      case "validate":
        return Response.json(await authority.validateUpload(ctx, call.input));
      case "commit":
        return Response.json(await authority.commitUpload(ctx, call.input));
      case "receipt":
        return Response.json(await authority.getReceipt(ctx, call.input));
      case "manifest":
        return Response.json(await authority.manifest(ctx, call.input));
      case "describe":
        return Response.json(await authority.describe(ctx, call.input));
      case "invalidate":
        return Response.json(
          await authority.invalidateGeneration(
            {
              kind: "control-recovery",
              deploymentId: ctx.deploymentId,
              revocationId: call.input.revocationId,
              recipient: { kind: "workspace", id: "workspace" },
              actions: ["invalidate"],
              deadline: ctx.deadline,
            },
            call.input,
          ),
        );
      case "facts":
        return authority.fetch(
          new Request("https://workspace.internal/__fortipi/facts", {
            method: "POST",
            headers: { [internalHeader]: JSON.stringify({ auth: ctx }) },
            body: JSON.stringify(call.input),
          }),
        );
      case "ack":
        return Response.json(await authority.ackFacts(ctx, call.input));
      case "allocate":
        return Response.json(await authority.allocateStore(ctx, call.input));
      case "capacity":
        return Response.json(await authority.reserveCapacity(ctx, call.input));
      case "child-state":
        return Response.json(
          await env.WORKSPACES.getByName(call.input.childId).describeStore(ctx, call.input),
        );
      case "child-mutate":
        return env.WORKSPACES.getByName(call.input.childId).fetch(
          new Request("https://workspace.internal/__fortipi/store/blob", {
            method: "PUT",
            headers: {
              [internalHeader]: JSON.stringify({
                auth: ctx,
                allocation: call.input,
                entry: call.entry,
              }),
            },
            body: Uint8Array.from(call.bytes),
          }),
        );
      case "store":
        return Response.json(await authority.describeStore(ctx, call.input));
      case "initialize":
        return Response.json(
          await env.WORKSPACES.getByName(call.input.childId).initializeStore(ctx, call.input),
        );
      case "retire":
        return Response.json(await authority.retireStore(ctx, call.input));
      case "delete":
        return Response.json(await authority.deleteStore(ctx, call.input));
    }
  },
};
