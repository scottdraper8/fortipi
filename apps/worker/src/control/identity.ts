import { timingSafeEqual } from "node:crypto";
import type * as D from "../boundary/dto.js";
import { delegation, emptyScope, requireGrant } from "./authorization.js";
import { check, hash, id, json, next, ref, type Store } from "./store.js";

export interface CredentialRecord {
  credentialId: string;
  verifier: string;
  principalId: string;
  role: D.AuthContext["role"];
  grants: D.Grant[];
  generation: number;
  grantVersion: number;
  expiresAt: number | null;
  status: "active" | "revoked";
  executorId?: string;
}
export class Identities {
  readonly store: Store;
  readonly deploymentId: string;
  constructor(store: Store, deploymentId: string) {
    this.store = store;
    this.deploymentId = deploymentId;
  }
  async bootstrap(token: string): Promise<void> {
    check(
      token.length >= 32 && token.length <= 1024,
      "invalid_request",
      "Bootstrap token must have sufficient entropy",
    );
    const verifier = await hash(token);
    const key = `bootstrap_${verifier.slice(0, 32)}`;
    this.store.tx(() => {
      if (this.store.get("credential", key)) return;
      const scope = emptyScope();
      for (const k of Object.keys(scope) as (keyof D.ResourceScope)[]) scope[k] = ["*"];
      this.store.put("credential", key, {
        credentialId: key,
        verifier,
        principalId: key,
        role: "admin",
        grants: [{ grantId: "bootstrap", version: 1, resources: scope }],
        generation: 1,
        grantVersion: 1,
        expiresAt: null,
        status: "active",
      } satisfies CredentialRecord);
    });
  }
  current(ctx: D.AuthContext): CredentialRecord {
    const c = this.store.get<CredentialRecord>("credential", ctx.credentialId);
    check(
      c &&
        ctx.deploymentId === this.deploymentId &&
        c.status === "active" &&
        c.generation === ctx.generation &&
        c.grantVersion === ctx.grantVersion &&
        c.principalId === ctx.principalId &&
        c.role === ctx.role &&
        c.expiresAt === ctx.credentialExpiresAt &&
        json(c.grants) === json(ctx.grants),
      "unauthenticated",
      "Credential is no longer current",
    );
    check(
      c.expiresAt === null || Date.now() < c.expiresAt,
      "unauthenticated",
      "Credential expired",
    );
    check(
      Date.now() < ctx.deadline && ctx.deadline <= Date.now() + 30000,
      "unauthenticated",
      "RPC deadline expired or invalid",
    );
    return c;
  }
  async authenticate(input: D.CredentialProof): Promise<D.AuthContext> {
    check(
      input.deploymentId === this.deploymentId && input.bearer.length <= 1024,
      "unauthenticated",
      "Invalid credential",
    );
    const verifier = await hash(input.bearer);
    const match = /^fp_(admin|client|executor)_([a-f0-9]{32})_[A-Za-z0-9_-]{43}$/.exec(
      input.bearer,
    );
    const key = match?.[2] ?? `bootstrap_${verifier.slice(0, 32)}`;
    const c = this.store.get<CredentialRecord>("credential", key);
    const bytes = (s: string): Uint8Array =>
      Uint8Array.from(s.match(/../g) ?? [], (x) => Number.parseInt(x, 16));
    const valid = timingSafeEqual(bytes(verifier), bytes(c?.verifier ?? "0".repeat(64)));
    check(valid && c && (!match || match[1] === c.role), "unauthenticated", "Invalid credential");
    const ctx: D.AuthContext = {
      ...ref(c),
      principalId: c.principalId,
      role: c.role,
      grants: c.grants,
      deploymentId: this.deploymentId,
      requestId: input.requestId,
      authenticatedAt: Date.now(),
      credentialExpiresAt: c.expiresAt,
      deadline: input.deadline,
    };
    this.current(ctx);
    return ctx;
  }
  async mint(
    ctx: D.AuthContext,
    body: D.CredentialMint,
    publish?: () => void,
    namespace = "mint",
  ): Promise<D.CredentialReceipt> {
    this.current(ctx);
    requireGrant(ctx, "credentials.mint");
    delegation(ctx, body.grants, body.expiresAt);
    check(
      body.expiresAt === undefined || body.expiresAt > Date.now(),
      "invalid_request",
      "Credential expiry is in the past",
    );
    if (body.role === "executor")
      check(
        body.grants.every((g) => g.resources.executorIds.every((x) => x === body.executorId)),
        "unauthorized",
        "Executor scope exceeds identity",
      );
    const digest = await hash(json(body));
    const issuanceKey = `${ctx.principalId}:${namespace}:${body.requestId}`;
    const key = id();
    const random = crypto.getRandomValues(new Uint8Array(32));
    const secret = btoa(String.fromCharCode(...random))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    const token = `fp_${body.role}_${key}_${secret}`;
    const verifier = await hash(token);
    const record: CredentialRecord = {
      credentialId: key,
      verifier,
      principalId: key,
      role: body.role,
      grants: body.grants,
      generation: 1,
      grantVersion: 1,
      expiresAt: body.expiresAt ?? null,
      status: "active",
      ...(body.role === "executor" ? { executorId: body.executorId } : {}),
    };
    return this.store.tx(() => {
      this.current(ctx);
      const previous = this.store.get<{
        digest: string;
        credential: D.CredentialRef;
        role: D.AuthContext["role"];
        expiresAt?: number;
      }>("issuance", issuanceKey);
      if (previous) {
        check(previous.digest === digest, "conflict", "Issuance request changed");
        return {
          credential: previous.credential,
          role: previous.role,
          state: "already-issued",
          ...(previous.expiresAt === undefined ? {} : { expiresAt: previous.expiresAt }),
        };
      }
      this.store.put("credential", key, record);
      this.store.put("issuance", issuanceKey, {
        digest,
        credential: ref(record),
        role: body.role,
        ...(body.expiresAt === undefined ? {} : { expiresAt: body.expiresAt }),
      });
      if (body.role === "executor") {
        const e = this.store.get<import("./tickets.js").ExecutorState>("executor", body.executorId);
        if (!e)
          this.store.put("executor", body.executorId, {
            generation: 1,
            epoch: 0,
            status: "offline",
            ledger: { kind: "unbound" },
          });
        else if (e.status === "revoked")
          this.store.put("executor", body.executorId, { ...e, status: "offline" });
      }
      publish?.();
      return {
        credential: ref(record),
        token,
        state: "issued",
        role: body.role,
        ...(body.expiresAt === undefined ? {} : { expiresAt: body.expiresAt }),
      };
    });
  }
  bump(key: string): CredentialRecord {
    const c = this.store.get<CredentialRecord>("credential", key);
    check(c, "not_found", "Credential not found");
    const updated = { ...c, generation: next(c.generation), status: "revoked" as const };
    this.store.put("credential", key, updated);
    return updated;
  }
}
