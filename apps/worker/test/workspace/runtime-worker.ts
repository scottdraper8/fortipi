import { DurableObject } from "cloudflare:workers";
import { createHash } from "node:crypto";
import type * as D from "../../src/boundary/dto.js";
import type { Env } from "../../src/boundary/env.js";
import { outcome } from "../../src/workspace/errors.js";
import { admitLocalUpload } from "../../src/workspace/local-admission.js";
import { hashInventory } from "../../src/workspace/streams.js";
import {
  internalHeader,
  WorkspaceObject as WorkspaceBase,
} from "../../src/workspace/workspace-object.js";

/** Actual binding application plus a test-only post-transaction response barrier. */
export class WorkspaceObject extends WorkspaceBase {
  override async authority(ctx: D.AuthContext, workspaceId: string, action = "workspace.read") {
    const authority = await super.authority(ctx, workspaceId, action);
    if (ctx.requestId === "revoke-during-metadata")
      await this.invalidateGeneration(
        {
          kind: "control-recovery",
          deploymentId: ctx.deploymentId,
          revocationId: "metadata-reader-revoked",
          recipient: { kind: "workspace", id: workspaceId },
          actions: ["invalidate"],
          deadline: ctx.deadline,
        },
        {
          revocationId: "metadata-reader-revoked",
          subject: {
            kind: "credential",
            credentialId: ctx.credentialId,
            minimumGeneration: ctx.generation + 1,
          },
        },
      );
    return authority;
  }
  override async initializeStore(
    ctx: D.AuthContext,
    input: D.StoreAllocation,
  ): Promise<D.Outcome<D.StoreState>> {
    if (
      input.role === "revision-store" &&
      input.uploadId === "interrupt-init-ordered" &&
      !this.state.get("test-init-interrupted")
    ) {
      // Fault after the real durable role boundary, before Computer's directory initialization.
      this.state.put("test-init-interrupted", true);
      this.state.put("child", {
        allocation: input,
        source: "child",
        state: "writable",
        version: 1,
      } satisfies D.StoreState);
      return {
        ok: false,
        code: "interrupted",
        requestId: ctx.requestId,
        message: "Injected lost initialization acknowledgment",
        retryable: false,
        details: { reason: "uncertain_effects" },
      };
    }
    return super.initializeStore(ctx, input);
  }
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/__test/seed") {
      return new Response(null, { status: 404 });
    }
    if (path === "/__test/barrier")
      return new Response(this.state.get("test-barrier") ? "ready" : "waiting");
    if (path === "/__test/metadata-queued") {
      const { auth } = JSON.parse(request.headers.get(internalHeader) ?? "null") as {
        auth: D.AuthContext;
      };
      let enter = () => {};
      let release = () => {};
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const hold = this.mutex.run(async () => {
        enter();
        await gate;
      });
      await entered;
      const invalidation = this.invalidateGeneration(
        {
          kind: "control-recovery",
          deploymentId: auth.deploymentId,
          revocationId: "queued-metadata-floor",
          recipient: { kind: "workspace", id: "workspace" },
          actions: ["invalidate"],
          deadline: auth.deadline,
        },
        {
          revocationId: "queued-metadata-floor",
          subject: {
            kind: "credential",
            credentialId: auth.credentialId,
            minimumGeneration: auth.generation + 1,
          },
        },
      );
      const target = new URL(request.url);
      target.pathname = "/__fortipi/operational-metadata";
      const pending = super.fetch(new Request(target, request));
      release();
      await hold;
      const ack = await invalidation;
      if (!ack.ok) throw new Error("Queued metadata revocation failed");
      return pending;
    }
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
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__test/artifact-observation")
      return Response.json((await this.ctx.storage.get("artifact-observation")) ?? null);
    if (url.pathname === "/__test/artifact-stream")
      return Response.json((await this.ctx.storage.get("artifact-stream")) ?? { cancelled: false });
    if (url.pathname === "/__test/artifact-release") {
      await this.ctx.storage.put("artifact-release", true);
      return new Response(null, { status: 204 });
    }
    const artifact = /^\/internal\/artifacts\/workspace\/([A-Za-z0-9_-]+)$/.exec(url.pathname)?.[1];
    if (!artifact) return new Response(null, { status: 404 });
    const auth = JSON.parse(request.headers.get("X-Fortipi-Context") ?? "null") as D.AuthContext;
    const prior = await this.ctx.storage.get<{ count: number }>("artifact-observation");
    await this.ctx.storage.put("artifact-observation", {
      count: (prior?.count ?? 0) + 1,
      credentialId: auth.credentialId,
      registrationId: auth.registrationId,
      method: request.method,
      search: url.search,
      range: request.headers.get("Range"),
      rawAuthority: request.headers.has(internalHeader),
      untrustedHeader: request.headers.has("x-untrusted"),
    });
    if (artifact === "absent") return Response.json({ code: "not_found" }, { status: 404 });
    const bytes = Uint8Array.from({ length: artifact === "empty" ? 0 : 393217 }, (_, i) => i % 251);
    const range = request.headers.get("Range");
    const start = range ? Number(/^bytes=(\d+)-/.exec(range)?.[1]) : 0;
    const end = range ? Number(/-(\d+)$/.exec(range)?.[1]) : bytes.length - 1;
    const selected = bytes.slice(start, end + 1);
    let offset = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        while (
          artifact === "stream" &&
          offset > 0 &&
          !cancelled &&
          !(await this.ctx.storage.get("artifact-release"))
        )
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
        if (cancelled) return;
        if (offset === selected.length) return controller.close();
        const next = selected.slice(offset, offset + 65536);
        offset += next.length;
        controller.enqueue(
          artifact === "truncated" && offset === selected.length ? next.slice(1) : next,
        );
      },
      cancel: async () => {
        cancelled = true;
        if (artifact === "stream")
          await this.ctx.storage.put("artifact-stream", { cancelled: true, offset });
      },
    });
    return new Response(body, {
      status: range ? 206 : 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(artifact === "oversized" ? 16777217 : selected.length),
        "X-Content-SHA256": createHash("sha256").update(selected).digest("hex"),
        "X-Fortipi-Context": "must-never-be-public",
        ...(range ? { "Content-Range": `bytes ${start}-${end}/${bytes.length}` } : {}),
      },
    });
  }
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
  | { kind: "cancel-execution"; input: D.CancelRequest }
  | { kind: "renew"; input: D.LeaseRenewal }
  | { kind: "release"; input: D.LeaseRelease }
  | { kind: "begin"; input: D.OperationRequest<"beginUpload"> }
  | { kind: "chunk"; input: D.OperationRequest<"putUploadChunk">; bytes: number[] }
  | { kind: "validate"; input: D.OperationRequest<"validateUpload"> }
  | { kind: "commit"; input: D.OperationRequest<"commitUpload"> }
  | { kind: "receipt"; input: D.CommitLookup }
  | { kind: "public-receipt"; input: D.OperationRequest<"getCommitReceipt"> }
  | { kind: "manifest"; input: D.OperationRequest<"getWorkspaceManifest"> }
  | { kind: "list"; input: D.OperationRequest<"listWorkspaceFiles"> }
  | { kind: "stat"; input: D.OperationRequest<"statWorkspaceFile"> }
  | { kind: "read-metadata"; input: D.OperationRequest<"readWorkspaceFile"> }
  | { kind: "diff"; input: D.OperationRequest<"diffWorkspace"> }
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
  | { kind: "child-materialize"; input: D.StoreAllocation; entry: D.ManifestEntry; bytes: number[] }
  | { kind: "delete"; input: D.StoreRetirement };
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ready") return new Response("ready");
    if (url.pathname === "/admit") {
      const input = (await request.json()) as {
        upload: D.UploadBegin;
        limits: D.ExecutorTransferLimits | null;
      };
      return Response.json(
        await outcome(() => {
          admitLocalUpload(input.upload, input.limits);
          return { admitted: true };
        }),
      );
    }
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
    if (request.headers.get("x-test-artifacts-only") === "1")
      for (const grant of ctx.grants) grant.resources.actions = ["artifacts.read"];
    if (request.headers.get("x-test-write-only") === "1")
      for (const grant of ctx.grants) grant.resources.actions = ["workspace.write"];
    if (request.headers.get("x-test-dispatch-write") === "1")
      for (const grant of ctx.grants)
        grant.resources.actions = ["jobs.dispatch", "workspace.write"];
    if (request.headers.get("x-test-dispatch-only") === "1")
      for (const grant of ctx.grants) grant.resources.actions = ["jobs.dispatch"];
    if (request.headers.get("x-test-split-actions") === "1") {
      const grant = ctx.grants[0];
      if (!grant) throw new Error("Split action grant missing");
      ctx.grants.push({
        ...grant,
        grantId: "dispatch-only",
        resources: { ...grant.resources, actions: ["jobs.dispatch"] },
      });
      grant.resources = { ...grant.resources, actions: ["workspace.write"] };
    }
    if (request.headers.get("x-test-read-only") === "1")
      for (const grant of ctx.grants) grant.resources.actions = ["workspace.read"];
    if (request.headers.get("x-test-recovery") === "1") {
      ctx.credentialId = "recovery-credential";
      ctx.registrationId = "recovery-registration";
    }
    if (request.headers.get("x-test-unregistered") === "1") delete ctx.registrationId;
    if (request.headers.get("x-test-expired") === "1") ctx.credentialExpiresAt = Date.now() - 1;
    if (request.headers.get("x-test-other-agent") === "1")
      for (const grant of ctx.grants) grant.resources.agentIds = ["other"];
    if (request.headers.get("x-test-other-target") === "1")
      for (const grant of ctx.grants) {
        grant.resources.executorIds = ["other"];
        grant.resources.backendIds = ["other"];
      }
    if (request.headers.get("x-test-other-conversation") === "1")
      for (const grant of ctx.grants) grant.resources.conversationIds = ["other"];
    if (request.headers.get("x-test-split-scope") === "1") {
      const grant = ctx.grants[0];
      if (!grant) throw new Error("Split grant missing");
      ctx.grants.push({
        ...grant,
        grantId: "scope-only",
        resources: { ...grant.resources, actions: [] },
      });
      grant.resources = { ...grant.resources, conversationIds: ["other"] };
    }
    if (request.headers.get("x-test-mixed-read") === "1") {
      const grant = ctx.grants[0];
      if (!grant) throw new Error("Mixed grant missing");
      ctx.grants.push({
        ...grant,
        grantId: "unrelated-reader",
        resources: {
          ...grant.resources,
          actions: ["workspace.read"],
          conversationIds: ["other"],
        },
      });
    }
    const authority = env.WORKSPACES.getByName("workspace");
    if (url.pathname === "/operational-metadata") {
      const headers = new Headers();
      if (request.headers.get("x-test-no-context") !== "1")
        headers.set(internalHeader, JSON.stringify({ auth: ctx }));
      return authority.fetch(
        new Request(
          `https://workspace.internal/${request.headers.get("x-test-metadata-queued") === "1" ? "__test/metadata-queued" : "__fortipi/operational-metadata"}${url.search}`,
          {
            method: request.method,
            headers,
          },
        ),
      );
    }
    if (url.pathname === "/artifact-stream-control") {
      const response = await authority.fetch(
        new Request(
          "https://workspace.internal/v1/workspaces/workspace/artifacts/stream?revision=original-base",
          { headers: { [internalHeader]: JSON.stringify({ auth: ctx }) } },
        ),
      );
      if (!response.body) throw new Error("Missing artifact stream");
      const reader = response.body.getReader();
      let firstBytes = 0;
      while (firstBytes < 65536) {
        const next = await reader.read();
        if (next.done) throw new Error("Artifact ended before its first chunk");
        firstBytes += next.value.length;
      }
      let rejected = false;
      let afterFloorBytes = 0;
      if (url.searchParams.get("mode") === "cancel") {
        await reader.cancel();
        await env.CONTROL_PLANE.getByName("control").fetch(
          new Request("https://control.internal/__test/artifact-release"),
        );
      } else {
        const revoked = await authority.invalidateGeneration(
          {
            kind: "control-recovery",
            deploymentId: ctx.deploymentId,
            revocationId: "stream-reader-revoked",
            recipient: { kind: "workspace", id: "workspace" },
            actions: ["invalidate"],
            deadline: ctx.deadline,
          },
          {
            revocationId: "stream-reader-revoked",
            subject: { kind: "credential", credentialId: ctx.credentialId, minimumGeneration: 2 },
          },
        );
        if (!revoked.ok) throw new Error("Stream revocation failed");
        await env.CONTROL_PLANE.getByName("control").fetch(
          new Request("https://control.internal/__test/artifact-release"),
        );
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            afterFloorBytes += next.value.length;
          }
        } catch {
          rejected = true;
        }
        await reader.cancel().catch(() => {});
      }
      let cancelled = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const state = await (
          await env.CONTROL_PLANE.getByName("control").fetch(
            new Request("https://control.internal/__test/artifact-stream"),
          )
        ).json<{ cancelled: boolean }>();
        if (state.cancelled) {
          cancelled = true;
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      return Response.json({
        length: response.headers.get("Content-Length"),
        firstBytes,
        afterFloorBytes,
        rejected,
        cancelled,
      });
    }
    if (url.pathname === "/terminal-proof")
      return authority.fetch(
        new Request("https://workspace.internal/__fortipi/terminal-proof", {
          method: request.method,
          headers: { [internalHeader]: JSON.stringify({ auth: ctx }) },
          ...(request.body ? { body: request.body } : {}),
        }),
      );
    if (url.pathname === "/artifact-observation")
      return env.CONTROL_PLANE.getByName("control").fetch(
        new Request("https://control.internal/__test/artifact-observation"),
      );
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
      case "cancel-execution":
        return Response.json(await authority.cancelExecution(ctx, call.input));
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
      case "public-receipt":
        return Response.json(await authority.getCommitReceipt(ctx, call.input));
      case "manifest":
        return Response.json(await authority.manifest(ctx, call.input));
      case "list":
        return Response.json(await authority.list(ctx, call.input));
      case "stat":
        return Response.json(await authority.stat(ctx, call.input));
      case "read-metadata":
        return Response.json(await authority.read(ctx, call.input));
      case "diff":
        return Response.json(await authority.diff(ctx, call.input));
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
      case "child-materialize":
        return env.WORKSPACES.getByName(call.input.childId).fetch(
          new Request(
            `https://workspace.internal/__fortipi/store/${call.kind === "child-mutate" ? "blob" : "materialize"}`,
            {
              method: "PUT",
              headers: {
                [internalHeader]: JSON.stringify({
                  auth: ctx,
                  allocation: call.input,
                  entry: call.entry,
                }),
              },
              body: Uint8Array.from(call.bytes),
            },
          ),
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
