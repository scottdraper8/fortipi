import type { DurableObject } from "cloudflare:workers";
import type { ControlPlaneRpc } from "../../../src/boundary/control-plane.js";
import type * as D from "../../../src/boundary/dto.js";
import type { Env } from "../../../src/boundary/env.js";
import { ControlPlane } from "../../../src/control/control-plane.js";
import { Executors } from "../../../src/control/executors.js";
import { EncryptedCredentialStore } from "../../../src/control/provider-auth-store.js";
import { check, hash, id, outcome } from "../../../src/control/store.js";
import type { TestRecipient } from "./recipients.js";

export { TestRecipient } from "./recipients.js";

export class TestControlPlane extends ControlPlane {
  async capacityUsage(): Promise<string> {
    return JSON.stringify(this.capacity.usage());
  }
  async capacitySettlement(reservationId: string): Promise<string | undefined> {
    const row = this.store.get<{ settlement?: { disposition: string; observedBytes?: number } }>(
      "capacity_reservation",
      reservationId,
    );
    return row?.settlement ? JSON.stringify(row.settlement) : undefined;
  }
  async streamRegistration(envelope: string): Promise<string> {
    const identity: unknown = JSON.parse(envelope);
    check(
      identity &&
        typeof identity === "object" &&
        "registrationId" in identity &&
        typeof identity.registrationId === "string",
      "invalid_request",
      "Missing fixture socket registration",
    );
    return JSON.stringify(
      this.store.get<D.AuthorityRegistration>("recipient", identity.registrationId) ?? null,
    );
  }
  async replaceTicketAgents(ticket: string, agents: string[]): Promise<void> {
    this.ctx.storage.sql.exec(
      "UPDATE cp_records SET value=json_set(value,'$.identity.resources.agentIds',json(?)) WHERE kind='ticket' AND key=?",
      JSON.stringify(agents),
      await hash(ticket),
    );
  }
  async clientStreamTicketExpiry(
    ticket: string,
    mode: "read" | "expire",
  ): Promise<{ expiresAt: number; used: boolean }> {
    check(
      /^[a-f0-9]{64}$/.test(ticket) && (mode === "read" || mode === "expire"),
      "invalid_request",
      "Invalid fixture ticket expiry request",
    );
    const key = await hash(ticket);
    return this.store.tx(() => {
      const read = () =>
        this.ctx.storage.sql
          .exec<{ audience: string; expiresAt: number; used: number }>(
            "SELECT json_extract(value,'$.audience') AS audience,json_extract(value,'$.expiresAt') AS expiresAt,json_extract(value,'$.used') AS used FROM cp_records WHERE kind='ticket' AND key=?",
            key,
          )
          .one();
      const before = read();
      check(
        before.audience === "client-stream" &&
          before.used === 0 &&
          Number.isSafeInteger(before.expiresAt),
        "invalid_request",
        "Fixture requires a retained unused client stream ticket",
      );
      if (mode === "expire")
        this.ctx.storage.sql.exec(
          "UPDATE cp_records SET value=json_set(value,'$.expiresAt',?) WHERE kind='ticket' AND key=?",
          Date.now() - 1,
          key,
        );
      const after = read();
      return { expiresAt: after.expiresAt, used: after.used !== 0 };
    });
  }
  async recoveredPresence(executorId: string, generation: number): Promise<D.Outcome<boolean>> {
    // Reconstruct only the component: use real retained workerd sockets and
    // storage, while its process-local heartbeat map starts empty.
    const recovered = new Executors(this.ctx, this.store, this.identities, this.executors.receive);
    return outcome(id(), async () => {
      recovered.channel(executorId, generation);
      return true;
    });
  }
  private refreshCalls = 0;
  private tokenResponseMode: "valid" | "redirect" | "oversize" = "valid";
  async setTokenResponseMode(mode: "valid" | "redirect" | "oversize"): Promise<void> {
    this.tokenResponseMode = mode;
  }
  constructor(
    ctx: DurableObjectState,
    env: Env,
    wrapTransport: (transport: typeof fetch) => typeof fetch = (transport) => transport,
  ) {
    super(
      ctx,
      env,
      wrapTransport((input, init) => this.#providerRequest(input, init)),
    );
  }
  #providerRequest: typeof fetch = async (input, init) => {
    this.refreshCalls++;
    if (!(input instanceof Request) || input.redirect !== "manual" || init !== undefined)
      throw new Error("Real Worker request must prevent automatic credential forwarding");
    const url = input.url;
    const raw = await input.text();
    let access = "synthetic-refreshed-access";
    if (String(url) === "https://auth.openai.com/api/accounts/oauth/token") {
      if (
        input.headers.get("Content-Type") !== "application/x-www-form-urlencoded" ||
        new URLSearchParams(raw).get("resource") !== "https://api.openai.com/v1" ||
        new URLSearchParams(raw).get("client_id") !== "synthetic-client"
      )
        throw new Error("Wrong OpenAI pinned protocol");
    } else if (String(url) === "https://platform.claude.com/v1/oauth/token") {
      const payload = JSON.parse(raw) as Record<string, unknown>;
      if (
        payload.client_id !== "9d1c250a-e61b-44d9-88ed-5944d1962f5e" ||
        payload.grant_type !== "refresh_token"
      )
        throw new Error("Wrong Anthropic pinned protocol");
    } else if (String(url) === "https://auth.openai.com/oauth/token") {
      if (
        input.headers.get("Content-Type") !== "application/x-www-form-urlencoded" ||
        new URLSearchParams(raw).get("client_id") !== "app_EMoamEEZ73f0CkXaXp7hrann"
      )
        throw new Error("Wrong Codex pinned protocol");
      access = `e30.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).replaceAll("=", "")}.signature`;
    } else throw new Error("Wrong fixed token endpoint");
    if (this.tokenResponseMode === "redirect")
      return new Response(null, {
        status: 302,
        headers: { Location: "https://untrusted.invalid/token" },
      });
    if (this.tokenResponseMode === "oversize")
      return new Response("x".repeat(65537), { headers: { "Content-Type": "application/json" } });
    await new Promise((resolve) => setTimeout(resolve, 25));
    return Response.json({
      access_token: access,
      refresh_token: "synthetic-refreshed-refresh",
      expires_in: 7200,
      scope: "openid chatgpt.tokens.use.direct",
    });
  };
  async deployment(): Promise<string> {
    return this.ctx.id.toString();
  }
  async drainTest(): Promise<void> {
    await this.alarm();
  }
  async canary(value?: string): Promise<string | undefined> {
    if (value) await this.ctx.storage.put("canary", value);
    return this.ctx.storage.get<string>("canary");
  }
  async rowCount(kind: string): Promise<number> {
    return this.ctx.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) n FROM cp_records WHERE kind=?", kind)
      .one().n;
  }
  async repairState(): Promise<string> {
    return JSON.stringify({
      holds: this.store.page("repair_hold", 0, 16).map((row) => row.value),
      due: this.ctx.storage.sql
        .exec(
          "SELECT kind,key,due FROM cp_records WHERE kind IN ('inbox','fanout','fact','binding_request') LIMIT 16",
        )
        .toArray(),
      alarm: await this.ctx.storage.getAlarm(),
    });
  }
  async seedPausedRepair(): Promise<string> {
    const proof = {
      bearer: this.env.FORTIPI_ADMIN_TOKEN,
      deploymentId: this.identities.deploymentId,
      requestId: id(),
      deadline: Date.now() + 30000,
    };
    const auth = await this.authenticate(proof);
    check(auth.ok, "internal", "Fixture bootstrap unavailable");
    const resources: D.ResourceScope = {
      agentIds: [],
      conversationIds: [],
      executorIds: [],
      backendIds: [],
      tools: [],
      workspaceIds: ["paused_workspace"],
      actions: ["workspace.read"],
    };
    const issued = await this.mintCredential(auth.value, {
      operationId: "mintCredential",
      path: {},
      query: {},
      body: {
        requestId: id(),
        role: "client",
        grants: [{ grantId: "paused", version: 1, resources }],
      },
    });
    check(
      issued.ok && issued.value.status === 201 && issued.value.body.state === "issued",
      "internal",
      "Fixture client issuance unavailable",
    );
    const client = await this.authenticate({
      ...proof,
      bearer: issued.value.body.token,
      requestId: id(),
    });
    check(client.ok, "internal", "Fixture client unavailable");
    await this.registerAuthorityRecipient(client.value, {
      credential: issued.value.body.credential,
      recipient: { kind: "workspace", id: "paused_workspace" },
      resources,
    });
    const actor = this.env.WORKSPACES.getByName("paused_workspace") as unknown as Pick<
      TestRecipient,
      "setQuotaFault"
    >;
    await actor.setQuotaFault({
      code: "quota_exceeded",
      message: "Synthetic durable storage refusal",
      requestId: id(),
      retryable: false,
      details: {
        retryAfterMs: 60000,
        pressure: {
          resource: "storage",
          scope: { kind: "object", id: "paused_workspace" },
          source: "provider",
          measurement: "observed",
          reason: "Synthetic storage fault",
          action: "reclaim-storage",
        },
      },
    });
    const revoked = await this.revokeCredential(auth.value, {
      operationId: "revokeCredential",
      path: { id: issued.value.body.credential.credentialId },
      query: {},
      body: { requestId: id(), expectedGeneration: 1 },
    });
    check(revoked.ok, "internal", "Fixture revoke unavailable");
    await this.alarm();
    const backup = await this.mintCredential(auth.value, {
      operationId: "mintCredential",
      path: {},
      query: {},
      body: {
        requestId: id(),
        role: "admin",
        expiresAt: Date.now() + 60000,
        grants: [
          {
            grantId: "repair",
            version: 1,
            resources: { ...resources, actions: ["configuration.write", "credentials.revoke"] },
          },
        ],
      },
    });
    check(
      backup.ok && backup.value.status === 201 && backup.value.body.state === "issued",
      "internal",
      "Fixture repair admin unavailable",
    );
    return backup.value.body.token;
  }
  async resumePausedRepair(token: string): Promise<string> {
    const authenticated = await this.authenticate({
      bearer: token,
      deploymentId: this.identities.deploymentId,
      requestId: id(),
      deadline: Date.now() + 30000,
    });
    check(authenticated.ok, "internal", "Fixture repair authentication failed");
    const actor = this.env.WORKSPACES.getByName("paused_workspace") as unknown as Pick<
      TestRecipient,
      "setQuotaFault"
    >;
    await actor.setQuotaFault(null);
    const config = this.directory.config();
    check("models" in config, "internal", "Fixture config unavailable");
    const configured = await this.handleApi(authenticated.value, {
      operationId: "patchConfiguration",
      path: {},
      query: {},
      body: {
        requestId: id(),
        expectedVersion: config.version,
        configuration: { ...config, version: config.version + 1 },
      },
    });
    check(configured.ok, "internal", "Fixture configuration failed");
    await this.alarm();
    await this.alarm();
    await this.revokeCredential(authenticated.value, {
      operationId: "revokeCredential",
      path: { id: authenticated.value.credentialId },
      query: {},
      body: { requestId: id(), expectedGeneration: authenticated.value.generation },
    });
    return this.repairState();
  }
  async forceDue(): Promise<void> {
    this.ctx.storage.sql.exec(
      "UPDATE cp_records SET due=0 WHERE due IS NOT NULL AND kind NOT IN ('ticket','transfer','presence_check')",
    );
  }
  async receiptTest(revocationId: string): Promise<D.RevocationReceipt> {
    return this.revocations.receipt(revocationId);
  }
  async encryptedRows(): Promise<string> {
    return JSON.stringify(this.ctx.storage.sql.exec("SELECT * FROM cp_provider_auth").toArray());
  }
  async reserved(): Promise<D.CapacityReservation | undefined> {
    return this.store.page<{ reservation: D.CapacityReservation }>("capacity_reservation", 0, 1)[0]
      ?.value.reservation;
  }
  async reservationFor(
    principalId: string,
    operationId: string,
  ): Promise<D.TargetReservation | undefined> {
    return this.store.get("reservation", `${principalId}:${operationId}`);
  }
  async refuseWrites(kind: "capacity" | "issuance" | "ticket" | null): Promise<void> {
    this.ctx.storage.sql.exec("DROP TRIGGER IF EXISTS test_refuse_write");
    const allowed =
      kind === "capacity"
        ? "capacity"
        : kind === "issuance"
          ? "issuance"
          : kind === "ticket"
            ? "ticket"
            : undefined;
    if (allowed)
      this.ctx.storage.sql.exec(
        `CREATE TRIGGER test_refuse_write BEFORE INSERT ON cp_records WHEN NEW.kind='${allowed}' BEGIN SELECT RAISE(ABORT,'synthetic storage refusal'); END`,
      );
  }
  async cryptoProbe(): Promise<{
    wrongKey: boolean;
    wrongKeyDelete: boolean;
    wrongAad: boolean;
    tamper: boolean;
    ciphertextPreserved: boolean;
  }> {
    const before = await this.encryptedRows();
    const rejects = async (fn: () => Promise<unknown>): Promise<boolean> => {
      try {
        await fn();
        return false;
      } catch {
        return true;
      }
    };
    const wrongKey = await rejects(() =>
      new EncryptedCredentialStore(this.store, this.identities.deploymentId, "b2".repeat(32)).read(
        "openai",
      ),
    );
    const wrongKeyDelete = await rejects(() =>
      new EncryptedCredentialStore(
        this.store,
        this.identities.deploymentId,
        "b2".repeat(32),
      ).delete("openai"),
    );
    const wrongAad = await rejects(() =>
      new EncryptedCredentialStore(this.store, "wrong_deployment", "a1".repeat(32)).read("openai"),
    );
    const row = this.ctx.storage.sql
      .exec<{ ciphertext: string }>(
        "SELECT ciphertext FROM cp_provider_auth WHERE provider='openai'",
      )
      .one();
    this.ctx.storage.sql.exec(
      "UPDATE cp_provider_auth SET ciphertext=? WHERE provider='openai'",
      `${row.ciphertext.startsWith("A") ? "B" : "A"}${row.ciphertext.slice(1)}`,
    );
    const tamper = await rejects(() => this.providerAuth.credentials.read("openai"));
    this.ctx.storage.sql.exec(
      "UPDATE cp_provider_auth SET ciphertext=? WHERE provider='openai'",
      row.ciphertext,
    );
    return {
      wrongKey,
      wrongKeyDelete,
      wrongAad,
      tamper,
      ciphertextPreserved: before === (await this.encryptedRows()),
    };
  }
  async storeProbe(): Promise<{
    unchanged: boolean;
    queuedCanceled: boolean;
    independent: boolean;
    order: string[];
    state: string;
  }> {
    const store = this.providerAuth.credentials;
    const before = store.status("openai");
    await store.modify("openai", async () => undefined);
    const unchanged = store.status("openai").version === before.version;
    const order: string[] = [];
    let release: () => void = () => undefined;
    let started: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const active = store.modify("openai", async (current) => {
      order.push("refresh-start");
      started();
      await gate;
      order.push("refresh-persist");
      return current;
    });
    await entered;
    let queuedRan = false;
    const cancel = new AbortController();
    const queued = store
      .modify(
        "openai",
        async (current) => {
          queuedRan = true;
          return current;
        },
        { signal: cancel.signal },
      )
      .catch(() => undefined);
    cancel.abort();
    let independent = false;
    await store.modify("anthropic", async () => {
      independent = true;
      return undefined;
    });
    const removal = store.delete("openai").then(() => {
      order.push("logout");
    });
    release();
    await Promise.all([active, queued, removal]);
    return {
      unchanged,
      queuedCanceled: !queuedRan,
      independent,
      order,
      state: store.status("openai").state,
    };
  }
  async providerProbe(
    ctx: D.ModelResolutionContext,
    input: { providerId: string; modelId: string; expectedGeneration?: number; deadline: number },
  ): Promise<D.Outcome<{ version: number; generation: number; isFresh: boolean; calls: number }>> {
    const before = this.refreshCalls;
    return outcome("provider_probe", async () => {
      const results = await Promise.all([
        this.providerAuth.resolve(ctx, input),
        this.providerAuth.resolve(ctx, input),
        this.providerAuth.resolve(ctx, input),
      ]);
      const result = results[0];
      if (!result) throw new Error("Missing provider resolution");
      return {
        version: result.version,
        generation: result.generation,
        isFresh: results.every((r) =>
          input.providerId === "openai-codex"
            ? r.auth.apiKey?.endsWith(".signature")
            : r.auth.apiKey === "synthetic-refreshed-access",
        ),
        calls: this.refreshCalls - before,
      };
    });
  }
}
export type FixtureControl = DurableObject<Env> &
  ControlPlaneRpc &
  Pick<
    TestControlPlane,
    | "capacityUsage"
    | "capacitySettlement"
    | "deployment"
    | "streamRegistration"
    | "replaceTicketAgents"
    | "clientStreamTicketExpiry"
    | "recoveredPresence"
    | "drainTest"
    | "canary"
    | "rowCount"
    | "repairState"
    | "seedPausedRepair"
    | "resumePausedRepair"
    | "forceDue"
    | "receiptTest"
    | "encryptedRows"
    | "providerProbe"
    | "reserved"
    | "reservationFor"
    | "cryptoProbe"
    | "storeProbe"
    | "refuseWrites"
    | "setTokenResponseMode"
  >;
interface TestEnv {
  CONTROL_PLANE: DurableObjectNamespace<FixtureControl>;
  FORTIPI_ADMIN_TOKEN: string;
}
export default {
  async fetch(request: Request, env: TestEnv): Promise<Response> {
    const cp = env.CONTROL_PLANE.getByName("control");
    const url = new URL(request.url);
    if (url.pathname === "/deployment") return Response.json(await cp.deployment());
    if (url.pathname === "/canary")
      return Response.json(await cp.canary(url.searchParams.get("value") ?? undefined));
    if (url.pathname === "/reserved") return Response.json(await cp.reserved());
    if (url.pathname === "/capacity-usage")
      return new Response(await cp.capacityUsage(), {
        headers: { "Content-Type": "application/json" },
      });
    if (url.pathname === "/capacity-settlement")
      return Response.json(
        JSON.parse((await cp.capacitySettlement(url.searchParams.get("id") ?? "")) ?? "null"),
      );
    if (url.pathname === "/repair-state")
      return new Response(await cp.repairState(), {
        headers: { "Content-Type": "application/json" },
      });
    if (url.pathname === "/seed-paused-repair")
      return Response.json({ token: await cp.seedPausedRepair() });
    if (url.pathname === "/resume-paused-repair")
      return new Response(
        await cp.resumePausedRepair(
          (request.headers.get("Authorization") ?? "").replace(/^Bearer /, ""),
        ),
        { headers: { "Content-Type": "application/json" } },
      );
    if (url.pathname === "/resolve-provider") {
      const deadline = Date.now() + 30000;
      return Response.json(
        await cp.providerProbe(
          {
            kind: "model-resolution",
            action: "resolve-provider-auth",
            deploymentId: await cp.deployment(),
            agentId: "agent",
            factoryId: "factory",
            providerId: "openai",
            modelId: "gpt-5.4",
            deadline,
          },
          { providerId: "openai", modelId: "gpt-5.4", deadline },
        ),
      );
    }
    if (
      ["/auth", "/revoke-bootstrap", "/reserve", "/seed-provider", "/settle-conservative"].includes(
        url.pathname,
      )
    ) {
      const auth = await cp.authenticate({
        bearer: env.FORTIPI_ADMIN_TOKEN,
        deploymentId: await cp.deployment(),
        requestId: crypto.randomUUID().replaceAll("-", ""),
        deadline: Date.now() + 30000,
      });
      if (url.pathname === "/auth" || !auth.ok) return Response.json({ authenticated: auth.ok });
      if (url.pathname === "/settle-conservative") {
        const reserved = await cp.reserveCapacity(auth.value, {
          operationId: "restart_conservative",
          ownerId: "owner",
          policyVersion: 1,
          bytes: 4096,
          admissionSlots: 0,
        });
        if (!reserved.ok) return Response.json(reserved);
        return Response.json(
          await cp.settleCapacity(auth.value, {
            reservationId: reserved.value.reservationId,
            disposition: "consumed",
          }),
        );
      }
      if (url.pathname === "/seed-provider")
        return Response.json(
          await cp.putProviderAuth(auth.value, {
            operationId: "putProviderAuth",
            path: { providerId: "openai" },
            query: {},
            body: {
              requestId: "restart_provider",
              expectedVersion: null,
              credential: {
                type: "oauth",
                access: "synthetic-reopen-access",
                refresh: "synthetic-reopen-refresh",
                expires: 0,
                providerFields: {
                  clientId: "synthetic-client",
                  scopes: ["chatgpt.tokens.use.direct"],
                },
              },
            },
          }),
        );
      if (url.pathname === "/reserve")
        return Response.json(
          await cp.reserveCapacity(auth.value, {
            operationId: "restart_operation",
            ownerId: "owner",
            policyVersion: 1,
            bytes: 8192,
            admissionSlots: 1,
          }),
        );
      return Response.json(
        await cp.revokeCredential(auth.value, {
          operationId: "revokeCredential",
          path: { id: auth.value.credentialId },
          query: {},
          body: { requestId: "restart_revoke", expectedGeneration: auth.value.generation },
        }),
      );
    }
    // Local HTTP is a declared test transport substitution; product CP still requires HTTPS.
    return cp.fetch(
      new Request(`https://fixture.invalid${url.pathname}${url.search}`, {
        ...request,
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: request.signal,
      }),
      { signal: request.signal },
    );
  },
};
