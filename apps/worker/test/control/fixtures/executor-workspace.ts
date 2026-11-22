import { createHash } from "node:crypto";
import { manifestDigest } from "fortipi-contract";
import type * as D from "../../../src/boundary/dto.js";
import type { DispatchRecord } from "../../../src/control/dispatch.js";
import { check, same } from "../../../src/control/store.js";
import baseWorker, { type ArtifactControl, TestControlPlane as BaseControl } from "./artifacts.js";
import { TestRecipient as BaseRecipient } from "./recipients.js";

export class TestControlPlane extends BaseControl {
  async seedTransportBinding(): Promise<void> {
    this.store.put("binding", "workspace", {
      workspaceId: "workspace",
      bindingVersion: 1,
      config: { kind: "computer" },
      revision: "original_base",
      availability: "available",
      manifestHash: "a".repeat(64),
    });
  }
  async transportFault(
    executionId: string,
    kind:
      | "cancel"
      | "terminal"
      | "binding"
      | "lease"
      | "registration"
      | "split"
      | "grant"
      | "renew",
  ): Promise<void> {
    const row = this.store.get<DispatchRecord>("dispatch", executionId);
    check(row, "not_found", "Synthetic dispatch missing");
    const reservation = row.intent.reservation;
    const original = row.intent.assignment.identity.lease;
    if (kind === "cancel")
      this.store.put("dispatch", executionId, {
        ...row,
        cancel: { requestId: "fixture_cancel", reason: "cancelled" },
      });
    if (kind === "terminal")
      this.store.put("command", `${executionId}:job.committed:1`, { fixture: true });
    if (kind === "binding")
      this.store.put("binding", "workspace", {
        workspaceId: "workspace",
        bindingVersion: 2,
        config: { kind: "computer" },
      });
    if (kind === "lease")
      this.store.put("lease", original.leaseId, { lease: { ...original, fence: "2" } });
    if (kind === "renew") {
      const current =
        this.store.get<{ lease: D.Lease }>("lease", original.leaseId)?.lease ?? original;
      this.store.put("lease", original.leaseId, {
        lease: {
          ...original,
          leaseVersion: current.leaseVersion + 1,
          expiresAt: Date.now() + 30000,
        },
      });
    }
    if (kind === "registration")
      this.store.remove("recipient", reservation.registrationIds.workspace);
    if (kind === "split" || kind === "grant") {
      const credential = this.identities.current(this.#owner(row));
      this.store.put("credential", credential.credentialId, {
        ...credential,
        grants:
          kind === "split"
            ? ["jobs.dispatch", "workspace.write"].map((action, i) => ({
                grantId: `split${i}`,
                version: 1,
                resources: { ...credential.grants[0]?.resources, actions: [action] },
              }))
            : credential.grants.map((g) => ({ ...g, expiresAt: Date.now() - 1 })),
      });
    }
  }
  #owner(row: DispatchRecord): D.AuthContext {
    const ref = row.intent.reservation.credential;
    const c = this.store.get<import("../../../src/control/identity.js").CredentialRecord>(
      "credential",
      ref.credentialId,
    );
    check(c, "not_found", "Synthetic owner missing");
    return {
      ...ref,
      principalId: c.principalId,
      role: c.role,
      grants: c.grants,
      deploymentId: this.identities.deploymentId,
      requestId: "fixture_owner",
      authenticatedAt: Date.now(),
      credentialExpiresAt: c.expiresAt,
      deadline: Date.now() + 30000,
    };
  }
  async transportRetained(executionId: string): Promise<string> {
    const row = this.store.get<DispatchRecord & { executorUpload?: unknown }>(
      "dispatch",
      executionId,
    );
    return JSON.stringify({
      assignment: row?.intent.assignment,
      upload: row?.executorUpload,
      lease: row
        ? this.store.get<{ lease: D.Lease }>("lease", row.intent.assignment.identity.lease.leaseId)
            ?.lease
        : undefined,
    });
  }
  async transportPeer(mode: string): Promise<string> {
    const response = await this.env.WORKSPACES.getByName("workspace").fetch(
      new Request("https://workspace.internal/fixture/control", { method: "POST", body: mode }),
    );
    return response.text();
  }
}
export type TransportControl = ArtifactControl &
  Pick<
    TestControlPlane,
    "seedTransportBinding" | "transportFault" | "transportRetained" | "transportPeer"
  >;

/** Controlled namespace peer, not a claim of real Source3 Computer composition. */
export class TestRecipient extends BaseRecipient {
  #release: (() => void) | undefined;
  #gate: Promise<void> | undefined;
  #entered = false;
  #held = 0;
  #versions = 0;
  override get contractVersion(): "1.0" {
    this.#versions++;
    return "1.0";
  }
  async #wait(): Promise<void> {
    if (this.#gate) {
      this.#entered = true;
      this.#held++;
      try {
        await this.#gate;
      } finally {
        this.#held--;
      }
    }
  }
  async #audit(auth: D.AuthContext, kind: string): Promise<void> {
    check(
      auth.role !== "executor" && auth.registrationId,
      "unauthorized",
      "Peer received executor application role",
    );
    const registration = JSON.parse(
      await this.env.CONTROL_PLANE.getByName("control").streamRegistration(
        JSON.stringify({ registrationId: auth.registrationId }),
      ),
    );
    check(
      registration.recipient.kind === "workspace" &&
        registration.recipient.id === "workspace" &&
        registration.credential.credentialId === auth.credentialId,
      "unauthorized",
      "Peer registration mismatch",
    );
    const counts = (await this.ctx.storage.get<Record<string, number>>("calls")) ?? {};
    counts[kind] = (counts[kind] ?? 0) + 1;
    await this.ctx.storage.put("calls", counts);
    await this.ctx.storage.put("actor", {
      role: auth.role,
      credentialId: auth.credentialId,
      registrationId: auth.registrationId,
      grants: auth.grants,
    });
  }
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/fixture/control") {
      const mode = await request.text();
      if (mode.startsWith("hold")) {
        this.#entered = false;
        this.#gate = new Promise((resolve) => {
          this.#release = resolve;
        });
        if (mode === "holdStream") await this.ctx.storage.put("mode", mode);
      } else if (mode === "release") {
        this.#release?.();
        this.#release = undefined;
        this.#gate = undefined;
      } else if (mode !== "state") await this.ctx.storage.put("mode", mode);
      return Response.json({
        entered: this.#entered,
        held: this.#held,
        versions: this.#versions,
        calls: (await this.ctx.storage.get("calls")) ?? {},
        actor: await this.ctx.storage.get("actor"),
        uploads: (await this.ctx.storage.list({ prefix: "upload:" })).size,
        stages: [...(await this.ctx.storage.list<string>({ prefix: "stage:" })).values()],
        cancelled: (await this.ctx.storage.get<number>("cancelled")) ?? 0,
      });
    }
    if (url.pathname !== "/__fortipi/job-snapshot") return super.fetch(request);
    check(
      request.method === "POST" &&
        !request.headers.has("Authorization") &&
        !request.headers.has("Cookie") &&
        !request.headers.has("X-Fortipi-Context"),
      "unauthorized",
      "Public headers leaked to peer",
    );
    const envelope = JSON.parse(request.headers.get("x-fortipi-workspace-context") ?? "null") as {
      auth: D.AuthContext;
    };
    const access = (await request.json()) as D.ExecutorWorkspaceAccess;
    await this.#audit(envelope.auth, "snapshot");
    check(
      same(access.assignment.identity.lease.credential, {
        credentialId: envelope.auth.credentialId,
        generation: envelope.auth.generation,
        grantVersion: envelope.auth.grantVersion,
      }) && access.lease.registrationId === envelope.auth.registrationId,
      "unauthorized",
      "Private access owner changed",
    );
    await this.ctx.storage.put("access", access);
    const mode = (await this.ctx.storage.get<string>("mode")) ?? "valid";
    if (mode !== "holdStream") await this.#wait();
    const bytes =
      mode === "empty" || mode === "badzero" ? new Uint8Array() : new Uint8Array(587661).fill(31);
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (!url.searchParams.has("sha256")) {
      const manifest: D.Manifest = {
        version: 1,
        entries: [{ type: "file", path: "base.txt", size: bytes.length, sha256: hash, mode: 420 }],
      };
      return Response.json({
        workspaceId: "workspace",
        revision: access.assignment.identity.baseRevision,
        manifest,
        manifestHash: await manifestDigest(manifest),
      });
    }
    const owner = this;
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        if (offset > 0 && mode === "slow") await new Promise((resolve) => setTimeout(resolve, 180));
        if (offset > 0 && mode === "holdStream") await owner.#wait();
        const end = Math.min(bytes.length, offset + 32768);
        const chunk = bytes.slice(offset, end);
        if (mode === "corrupt") chunk[0] = (chunk[0] ?? 0) ^ 1;
        offset = end;
        controller.enqueue(chunk);
      },
      async cancel() {
        await owner.ctx.storage.put(
          "cancelled",
          ((await owner.ctx.storage.get<number>("cancelled")) ?? 0) + 1,
        );
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(mode === "truncated" ? bytes.length + 1 : bytes.length),
        "X-Content-SHA256": mode === "badzero" ? "0".repeat(64) : hash,
      },
    });
  }
  async beginUpload(
    auth: D.AuthContext,
    input: D.OperationRequest<"beginUpload">,
  ): Promise<D.Outcome<D.OperationResponse<"beginUpload">>> {
    await this.#audit(auth, "begin");
    const key = `upload:${input.body.requestId}`;
    const old = await this.ctx.storage.get<D.UploadBegin>(key);
    check(!old || same(old, input.body), "conflict", "Peer upload request changed");
    await this.ctx.storage.put(key, input.body);
    await this.#wait();
    if ((await this.ctx.storage.get("mode")) === "dropBegin") {
      await this.ctx.storage.delete("mode");
      throw new Error("Synthetic lost accepted upload reply");
    }
    return {
      ok: true,
      value: {
        status: 201,
        body: {
          uploadId: input.body.requestId,
          state: "open",
          baseRevision: input.body.baseRevision,
          manifestHash: input.body.manifestHash,
          receivedChunks: [],
          expiresAt: Date.now() + 60000,
        },
      },
    };
  }
  async putChunk(
    auth: D.AuthContext,
    input: D.OperationRequest<"putUploadChunk">,
  ): Promise<D.Outcome<D.OperationResponse<"putUploadChunk">>> {
    await this.#audit(auth, "chunk");
    check(
      await this.ctx.storage.get(`upload:${input.path.uploadId}`),
      "conflict",
      "Unknown peer upload",
    );
    const bytes = new Uint8Array(input.body);
    check(
      bytes.length === input.query.length &&
        createHash("sha256").update(bytes).digest("hex") === input.query.sha256,
      "conflict",
      "Peer chunk corrupted",
    );
    await this.ctx.storage.put(`chunk:${input.path.uploadId}:${input.path.chunkIndex}`, bytes);
    await this.#wait();
    return { ok: true, value: { status: 204, body: undefined } };
  }
  async validateUpload(
    auth: D.AuthContext,
    input: D.OperationRequest<"validateUpload">,
  ): Promise<D.Outcome<D.OperationResponse<"validateUpload">>> {
    await this.#audit(auth, "validate");
    const body = await this.ctx.storage.get<D.UploadBegin>(`upload:${input.path.uploadId}`);
    check(body, "conflict", "Unknown peer upload");
    let stage = await this.ctx.storage.get<string>(`stage:${input.path.uploadId}`);
    stage ??= crypto.randomUUID().replaceAll("-", "");
    await this.ctx.storage.put(`stage:${input.path.uploadId}`, stage);
    await this.#wait();
    if ((await this.ctx.storage.get("mode")) === "dropValidate") {
      await this.ctx.storage.delete("mode");
      throw new Error("Synthetic lost accepted seal reply");
    }
    return {
      ok: true,
      value: {
        status: 200,
        body: {
          uploadId: input.path.uploadId,
          manifestHash: body.manifestHash,
          stageId: stage,
          validated: true,
        },
      },
    };
  }
}

export default {
  async fetch(
    request: Request,
    env: { CONTROL_PLANE: DurableObjectNamespace<TransportControl>; FORTIPI_ADMIN_TOKEN: string },
  ): Promise<Response> {
    const path = new URL(request.url).pathname;
    const cp = env.CONTROL_PLANE.getByName("control");
    if (path === "/fixture/transport/seed") {
      await cp.seedTransportBinding();
      return Response.json(true);
    }
    if (path === "/fixture/transport/retained")
      return new Response(
        await cp.transportRetained(new URL(request.url).searchParams.get("executionId") ?? ""),
      );
    if (path === "/fixture/transport/peer")
      return new Response(await cp.transportPeer(await request.text()));
    return baseWorker.fetch(request, env);
  },
};
