import type * as D from "../../../src/boundary/dto.js";
import { same } from "../../../src/control/store.js";
import { TestRecipient as BaseRecipient } from "./recipients.js";
import type { FixtureControl } from "./worker.js";
import baseWorker, { TestControlPlane as BaseControlPlane } from "./worker.js";

export default {
  async fetch(
    request: Request,
    env: { CONTROL_PLANE: DurableObjectNamespace<ArtifactControl>; FORTIPI_ADMIN_TOKEN: string },
  ): Promise<Response> {
    const path = new URL(request.url).pathname;
    const cp = env.CONTROL_PLANE.getByName("control");
    if (path.startsWith("/fixture/record/"))
      return Response.json(
        (await cp.artifactRecord(path.slice("/fixture/record/".length))) ?? null,
      );
    if (path.startsWith("/fixture/transfer/"))
      return Response.json(
        (await cp.transferRecord(path.slice("/fixture/transfer/".length))) ?? null,
      );
    if (path.startsWith("/fixture/rpc/") && request.method === "POST") {
      const method = path.slice("/fixture/rpc/".length);
      if (method === "authenticate")
        return Response.json(await cp.authenticate((await request.json()) as D.CredentialProof));
      if (method === "mintCredential") {
        const body = (await request.json()) as {
          ctx: D.AuthContext;
          input: D.OperationRequest<"mintCredential">;
        };
        return Response.json(await cp.mintCredential(body.ctx, body.input));
      }
      if (method === "mintTicket") {
        const body = (await request.json()) as {
          ctx: D.AuthContext;
          input: D.OperationRequest<"mintConnectionTicket">;
        };
        return Response.json(await cp.mintTicket(body.ctx, body.input));
      }
      if (method === "reserveTarget") {
        const body = (await request.json()) as { ctx: D.AuthContext; input: D.TargetRequest };
        return Response.json(await cp.reserveTarget(body.ctx, body.input));
      }
      if (method === "recordDispatchIntent") {
        const body = (await request.json()) as { ctx: D.AuthContext; input: D.DispatchIntent };
        return Response.json(await cp.recordDispatchIntent(body.ctx, body.input));
      }
      if (method === "assignOnce") {
        const body = (await request.json()) as { ctx: D.AuthContext; input: D.Assignment };
        return Response.json(await cp.assignOnce(body.ctx, body.input));
      }
      if (method === "registerAuthorityRecipient") {
        const body = (await request.json()) as {
          ctx: D.AuthContext;
          input: D.AuthorityRecipientRequest;
        };
        return Response.json(await cp.registerAuthorityRecipient(body.ctx, body.input));
      }
      if (method === "observeTransfer") {
        const body = (await request.json()) as {
          ctx: D.AuthContext;
          input: { transferId: string; attemptId: string };
        };
        return Response.json(await cp.observeTransfer(body.ctx, body.input));
      }
      if (method === "drain") {
        await cp.forceDue();
        await cp.drainTest();
        return Response.json(true);
      }
    }
    return baseWorker.fetch(request, env);
  },
};
export class TestControlPlane extends BaseControlPlane {
  private epochRelease: (() => void) | undefined;
  private epochEntered = false;
  async gateEpoch(stage: "hash" | "arm" | "drain"): Promise<void> {
    this.epochEntered = false;
    const gate = new Promise<void>((resolve) => {
      this.epochRelease = resolve;
    });
    if (stage === "hash") {
      const original = crypto.subtle.digest.bind(crypto.subtle);
      crypto.subtle.digest = async (algorithm, data) => {
        crypto.subtle.digest = original;
        this.epochEntered = true;
        await gate;
        return original(algorithm, data);
      };
    } else if (stage === "arm") {
      const original = this.store.arm.bind(this.store);
      this.store.arm = async (at) => {
        this.store.arm = original;
        this.epochEntered = true;
        await gate;
        return original(at);
      };
    } else {
      const original = this.delivery.drainCommand.bind(this.delivery);
      this.delivery.drainCommand = async (key, executors) => {
        this.delivery.drainCommand = original;
        this.epochEntered = true;
        await gate;
        return original(key, executors);
      };
    }
  }
  async epochGateEntered(): Promise<boolean> {
    return this.epochEntered;
  }
  async releaseEpochGate(): Promise<void> {
    this.epochRelease?.();
    this.epochRelease = undefined;
  }
  async epochCommands(): Promise<string> {
    return JSON.stringify(this.store.page("command", 0, 16).map((row) => row.value));
  }
  async refuseArtifactInbox(enabled: boolean): Promise<void> {
    this.ctx.storage.sql.exec("DROP TRIGGER IF EXISTS fixture_refuse_artifact_inbox");
    if (enabled)
      this.ctx.storage.sql.exec(
        "CREATE TRIGGER fixture_refuse_artifact_inbox BEFORE INSERT ON cp_records WHEN NEW.kind='inbox' BEGIN SELECT RAISE(ABORT,'synthetic artifact inbox refusal'); END",
      );
  }
  async artifactRecord(id: string): Promise<string | undefined> {
    const value = this.store.get("native_artifact", id);
    return value ? JSON.stringify(value) : undefined;
  }
  async transferRecord(id: string): Promise<string | undefined> {
    const value = this.store.get("transfer", id);
    return value ? JSON.stringify(value) : undefined;
  }
  async advanceFixtureRevision(): Promise<void> {
    await this.ctx.storage.put("fixture-current-revision", "unrelated_new_revision");
  }
  async registrationRecord(id: string): Promise<string | undefined> {
    const value = this.store.get("recipient", id);
    return value ? JSON.stringify(value) : undefined;
  }
  async leaseRecord(id: string): Promise<string | undefined> {
    const value = this.store.get("lease", id);
    return value ? JSON.stringify(value) : undefined;
  }
}
export type ArtifactControl = FixtureControl &
  Pick<
    TestControlPlane,
    | "artifactRecord"
    | "transferRecord"
    | "advanceFixtureRevision"
    | "registrationRecord"
    | "leaseRecord"
    | "refuseArtifactInbox"
    | "gateEpoch"
    | "epochGateEntered"
    | "releaseEpochGate"
    | "epochCommands"
  >;
/** Controlled durable proof authorities. They assert the private transport contract, not source3/5 enforcement. */
export class TestRecipient extends BaseRecipient {
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/fixture/proof") {
      if (request.method === "POST") await this.ctx.storage.put("proof", await request.json());
      return Response.json({
        proof: await this.ctx.storage.get("proof"),
        last: await this.ctx.storage.get("proof-last"),
      });
    }
    if (path === "/fixture/mode") {
      await this.ctx.storage.put("proof-mode", await request.text());
      return new Response(null, { status: 204 });
    }
    const workspace = path === "/__fortipi/terminal-proof";
    const agent = /^\/__fortipi\/terminal-proof\/[A-Za-z0-9_-]+$/.test(path);
    if (request.method !== "POST" || (!workspace && !agent))
      return new Response(null, { status: 404 });
    const header = request.headers.get(
      workspace ? "x-fortipi-workspace-context" : "X-Fortipi-Context",
    );
    if (!header) return new Response(null, { status: 401 });
    const envelope = JSON.parse(header) as D.AuthContext | { auth: D.AuthContext };
    const auth = "auth" in envelope ? envelope.auth : envelope;
    const body = await request.text();
    await this.ctx.storage.put("proof-last", { path, auth, body });
    const payload = JSON.parse(body) as D.JobCommitted;
    const authorized = await this.env.CONTROL_PLANE.getByName("control").authorize({
      principal: auth,
      action: workspace
        ? auth.grants.some(
            (g) =>
              g.resources.actions.includes("workspace.write") || g.resources.actions.includes("*"),
          )
          ? "workspace.write"
          : "workspace.read"
        : "jobs.dispatch",
      resources: {
        agentIds: ["agent"],
        conversationIds: ["conversation"],
        workspaceIds: ["workspace"],
        executorIds: ["executor"],
        backendIds: [],
        tools: [],
        actions: [],
      },
    });
    if (
      !authorized.ok ||
      !authorized.value.allowed ||
      new TextEncoder().encode(body).length > 65536 ||
      !auth.registrationId ||
      (agent && path !== `/__fortipi/terminal-proof/${payload.identity.jobId}`)
    )
      return new Response(null, { status: 403 });
    const mode = await this.ctx.storage.get<string>("proof-mode");
    if (mode === "oversize")
      return new Response(" ".repeat(65537), { headers: { "Cache-Control": "no-store" } });
    if (mode === "hold") await new Promise((resolve) => setTimeout(resolve, 800));
    if (mode === "hold-grant") await new Promise((resolve) => setTimeout(resolve, 2500));
    const stored = await this.ctx.storage.get<D.JobCommitted>("proof");
    if (mode === "wrong-event" && stored)
      return Response.json(
        { ...stored, eventSeq: stored.eventSeq + 1 },
        { headers: { "Cache-Control": "no-store" } },
      );
    if (!same(payload, stored))
      return Response.json(
        {
          error: {
            code: "conflict",
            message: "Synthetic authoritative proof mismatch",
            requestId: auth.requestId,
            retryable: false,
            details: { reason: "digest_mismatch" },
          },
        },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    return Response.json(stored, { headers: { "Cache-Control": "no-store" } });
  }
}
