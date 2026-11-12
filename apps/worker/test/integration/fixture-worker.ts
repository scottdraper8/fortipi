// Disposable local composition only. These existing adapters retain the real
// PiHarness, queued SQLite, application authority and Computer implementation.
// The faux model and acknowledged barriers never enter installed/live assets.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ControlPort } from "../../src/agent/authority.js";
import type { ConversationRow } from "../../src/agent/store.js";
import type * as D from "../../src/boundary/dto.js";
import type { Env } from "../../src/boundary/env.js";
import { defaultModel } from "../../src/models/factory.js";
import {
  internalHeader,
  WorkspaceObject as RealWorkspaceObject,
} from "../../src/workspace/workspace-object.js";
import worker, { TestAgentSession as ExistingTestAgentSession } from "../agent/runtime-worker.ts";

export {
  ControlPlane,
  LinuxContainerHost,
  StorageGuardProbe,
  WorkspaceProxy,
} from "../agent/runtime-worker.ts";
export class TestAgentSession extends ExistingTestAgentSession {
  #authorityGate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  #invalidationGate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const original = this.authority.control;
    const control: ControlPort = {
      fetch: (request) => original.fetch(request),
      reserveCapacity: (ctx, input) => original.reserveCapacity(ctx, input),
      settleCapacity: (ctx, input) => original.settleCapacity(ctx, input),
      reserveTarget: (ctx, input) => original.reserveTarget(ctx, input),
      registerAuthorityRecipient: (ctx, input) => original.registerAuthorityRecipient(ctx, input),
      recordDispatchIntent: (ctx, input) => original.recordDispatchIntent(ctx, input),
      assignOnce: (ctx, input) => original.assignOnce(ctx, input),
      queryExecution: (ctx, input) => original.queryExecution(ctx, input),
      cancelExecution: (ctx, input) => original.cancelExecution(ctx, input),
      deliverExecutorFrame: (ctx, input) => original.deliverExecutorFrame(ctx, input),
      requestLocalWorkspace: (ctx, input) => original.requestLocalWorkspace(ctx, input),
      resolveExecutorGeneration: (ctx, input) => original.resolveExecutorGeneration(ctx, input),
      authorize: async (input) => {
        const decision = await original.authorize(input);
        const held = await this.store.get<string>("fixture", "evidence-authority-credential");
        if (
          held === input.principal.credentialId &&
          input.action === "conversations.read" &&
          decision.ok &&
          decision.value.allowed &&
          !this.#authorityGate
        ) {
          this.#authorityGate = Promise.withResolvers<void>();
          await this.store.put("fixture", "evidence-authority-entered", {
            credentialId: held,
            actualControlAllowed: true,
          });
          await this.#authorityGate.promise;
        }
        return decision;
      },
    };
    // The actual RPC stub stays untouched. Only this fixture's local port adds
    // an acknowledged scheduling barrier around the real CP decision.
    Object.defineProperty(this.authority, "control", { value: control });
  }
  override async invalidateGeneration(ctx: D.RecoveryContext, input: D.Invalidation) {
    if (await this.store.get<boolean>("fixture", "evidence-invalidation-hold")) {
      this.#invalidationGate ??= Promise.withResolvers<void>();
      await this.store.put("fixture", "evidence-invalidation-entered", {
        revocationId: input.revocationId,
      });
      await this.#invalidationGate.promise;
    }
    return super.invalidateGeneration(ctx, input);
  }
  override async onRequest(request: Request) {
    if (new URL(request.url).pathname === "/__integration/control") {
      if (request.headers.get("Authorization") !== `Bearer ${this.env.FORTIPI_ADMIN_TOKEN}`)
        return new Response(null, { status: 403 });
      const input = (await request.json()) as {
        action: string;
        credentialId?: string;
        conversationId?: string;
      };
      if (input.action === "hold-authority") {
        await this.store.put("fixture", "evidence-authority-credential", input.credentialId);
      } else if (input.action === "release-authority") {
        await this.store.remove("fixture", "evidence-authority-credential");
        this.#authorityGate?.resolve();
      } else if (input.action === "hold-invalidation") {
        await this.store.put("fixture", "evidence-invalidation-hold", true);
      } else if (input.action === "release-invalidation") {
        await this.store.remove("fixture", "evidence-invalidation-hold");
        this.#invalidationGate?.resolve();
      } else if (input.action === "hold-replay") {
        this.holdReplay(input.conversationId!);
      } else if (input.action === "release-replay") this.releaseReplay();
      else if (input.action === "compact" || input.action === "reset") {
        await this.lifecycle.start();
        const row = await this.store.get<ConversationRow>("conversation", input.conversationId!);
        if (!row) return new Response(null, { status: 404 });
        const harness = await this.pi.pi();
        const conversation = await harness.conversation(
          Number(row.piId) as import("@earendil-works/pi-durable").ConversationId,
          BACKGROUND_CONTEXT,
        );
        if (!conversation) return new Response(null, { status: 404 });
        let taskId: string | null = null;
        if (input.action === "compact") {
          const task = await conversation.compact(undefined, BACKGROUND_CONTEXT);
          await harness.waitForTask(task, BACKGROUND_CONTEXT);
          taskId = String(task);
        } else await conversation.reset("seed1010-explicit-handoff", BACKGROUND_CONTEXT);
        await this.runRepair();
        return Response.json({ operation: input.action, actualSupportedPiApi: true, taskId });
      } else if (input.action !== "state") return new Response(null, { status: 400 });
      return Response.json({
        authority: (await this.store.get("fixture", "evidence-authority-entered")) ?? null,
        invalidation: (await this.store.get("fixture", "evidence-invalidation-entered")) ?? null,
        replay: this.replayHeld(),
      });
    }
    return super.onRequest(request);
  }
}
export class WorkspaceObject extends RealWorkspaceObject {
  // Read-only fixture seam around the actual owner registry. It exposes no
  // credential value and never changes lease/capacity/allocation state.
  storeFixtureLease(leaseId: string) {
    const reservation = this.state.get<D.TargetReservation>(`reservation:${leaseId}`);
    if (!reservation) throw new Error("Actual store reservation unavailable");
    return {
      operationDigest: reservation.operationDigest,
      generation: reservation.target.generation,
      policyVersion: this.policy.version,
    };
  }
  async storeFixtureWriteBlob(
    auth: D.AuthContext,
    allocation: D.StoreAllocation,
    entry: D.ManifestEntry,
    bytes: Uint8Array,
  ) {
    return (
      await this.stub(allocation.childId).fetch(
        new Request("https://workspace.internal/__fortipi/store/blob", {
          method: "PUT",
          headers: { [internalHeader]: JSON.stringify({ auth, allocation, entry }) },
          body: new Uint8Array(bytes),
        }),
      )
    ).status;
  }
  override async commitUpload(ctx: D.AuthContext, input: D.OperationRequest<"commitUpload">) {
    const result = await super.commitUpload(ctx, input);
    const key = `evidence-after-commit:${input.body.commitId}`;
    if (
      result.ok &&
      result.value.status === 200 &&
      input.body.requestId.startsWith("thread10-after-commit-") &&
      !this.state.get(key)
    ) {
      this.state.put(key, { commitId: input.body.commitId, revision: result.value.body.revision });
      this.state.put("evidence-barrier", {
        commitId: input.body.commitId,
        revision: result.value.body.revision,
      });
      // Actual pointer/receipt/outbox transaction has returned. Hold only its
      // response; the supervisor must kill workerd, never export/reset state.
      await new Promise<never>(() => {});
    }
    return result;
  }
  override fetch(request: Request) {
    if (new URL(request.url).pathname === "/__integration/barrier") {
      if (request.headers.get("Authorization") !== `Bearer ${this.env.FORTIPI_ADMIN_TOKEN}`)
        return Promise.resolve(new Response(null, { status: 403 }));
      return Promise.resolve(Response.json(this.state.get("evidence-barrier") ?? null));
    }
    return super.fetch(request);
  }
}
export default {
  fetch(request, env) {
    if (new URL(request.url).pathname === "/__integration/model") {
      if (request.headers.get("Authorization") !== `Bearer ${env.FORTIPI_ADMIN_TOKEN}`)
        return new Response(null, { status: 403 });
      return Response.json(defaultModel);
    }
    const release = /^\/__integration\/release-completion\/([A-Za-z0-9_-]+)$/.exec(
      new URL(request.url).pathname,
    );
    if (release) {
      if (
        request.method !== "POST" ||
        request.headers.get("Authorization") !== `Bearer ${env.FORTIPI_ADMIN_TOKEN}`
      )
        return new Response(null, { status: 403 });
      const session = env.AGENT_SESSIONS.getByName(release[1]!) as unknown as Pick<
        TestAgentSession,
        "releaseCompletion"
      >;
      return Promise.resolve(session.releaseCompletion()).then(() =>
        Response.json({ released: true }),
      );
    }
    const workspace = /^\/__integration\/workspace\/([A-Za-z0-9_-]+)\/barrier$/.exec(
      new URL(request.url).pathname,
    );
    if (workspace) {
      const url = new URL(request.url);
      url.pathname = "/__integration/barrier";
      return env.WORKSPACES.getByName(workspace[1]!).fetch(new Request(url, request));
    }
    const actor = /^\/__integration\/actor\/([A-Za-z0-9_-]+)\/control$/.exec(
      new URL(request.url).pathname,
    );
    if (actor) {
      const url = new URL(request.url);
      url.pathname = "/__integration/control";
      return env.AGENT_SESSIONS.getByName(actor[1]!).fetch(new Request(url, request));
    }
    return worker.fetch(request, env);
  },
} satisfies ExportedHandler<Env>;
