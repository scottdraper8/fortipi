import { validateBrowserOrigin } from "fortipi-contract";
import type * as D from "../boundary/dto.js";
import { contains, requireGrant } from "./authorization.js";
import type { Identities } from "./identity.js";
import { check, hash, id, json, next, ref, type Store, same } from "./store.js";

interface Ticket {
  identity: D.SocketIdentity;
  audience: D.TicketInput["audience"];
  used: boolean;
  expiresAt: number;
}
export interface ExecutorState {
  generation: number;
  epoch: number;
  status: string;
  description?: D.ExecutorDescription;
  credentialId?: string;
}
export class Tickets {
  readonly store: Store;
  readonly identities: Identities;
  constructor(store: Store, identities: Identities) {
    this.store = store;
    this.identities = identities;
  }
  register(ctx: D.AuthContext, input: D.AuthorityRecipientRequest): D.AuthorityRegistration {
    return this.store.tx(() => {
      this.identities.current(ctx);
      check(same(ref(ctx), input.credential), "unauthorized", "Authority credential mismatch");
      check(
        (input.recipient.kind === "agent"
          ? input.resources.agentIds
          : input.resources.workspaceIds
        ).includes(input.recipient.id),
        "unauthorized",
        "Recipient is outside registered resource scope",
      );
      check(
        ctx.grants.some(
          (g) =>
            (g.expiresAt === undefined || g.expiresAt > Date.now()) &&
            contains(g.resources, input.resources),
        ),
        "unauthorized",
        "Authority exceeds grant",
      );
      if (input.executor) {
        check(
          input.resources.executorIds.includes(input.executor.executorId),
          "unauthorized",
          "Executor is outside registered resource scope",
        );
        const e = this.store.get<ExecutorState>("executor", input.executor.executorId);
        check(
          e && e.status !== "revoked" && e.generation === input.executor.generation,
          "conflict",
          "Executor generation changed",
        );
      }
      const stableKey = json(input);
      const old = this.store.get<D.AuthorityRegistration>("registration_key", stableKey);
      if (old) return old;
      const registrationId = id();
      const record = { ...input, registrationId };
      this.store.put(
        "recipient",
        registrationId,
        record,
        `credential:${ctx.credentialId}`,
        `${input.recipient.kind}:${input.recipient.id}`,
      );
      if (input.executor)
        this.store.put(
          "executor_recipient",
          registrationId,
          record,
          `executor:${input.executor.executorId}`,
          `${input.recipient.kind}:${input.recipient.id}`,
        );
      this.store.put("registration_key", stableKey, record);
      return record;
    });
  }
  async mint(ctx: D.AuthContext, input: D.TicketInput, origin?: string): Promise<D.TicketReceipt> {
    this.identities.current(ctx);
    requireGrant(ctx, "tickets.mint");
    check(
      ctx.grants.some(
        (g) =>
          (g.expiresAt === undefined || g.expiresAt > Date.now()) &&
          contains(g.resources, input.resources),
      ),
      "unauthorized",
      "Ticket scope exceeds grant",
    );
    if (input.originMode.kind === "browser") {
      validateBrowserOrigin(input.originMode.value);
      check(origin === input.originMode.value, "unauthorized", "Origin mismatch");
    } else check(origin === undefined, "unauthorized", "Native ticket must omit Origin");
    const ttl = input.ttlMs ?? 30000;
    check(
      Number.isSafeInteger(ttl) && ttl > 0 && ttl <= 60000,
      "invalid_request",
      "Invalid ticket TTL",
    );
    if (input.audience === "executor-session") {
      const c = this.identities.current(ctx);
      check(
        c.role === "executor" && c.executorId === input.executor.executorId,
        "unauthorized",
        "Executor ticket identity mismatch",
      );
      const e = this.store.get<ExecutorState>("executor", input.executor.executorId);
      check(
        e && e.generation === input.executor.generation && e.status !== "revoked",
        "conflict",
        "Executor generation changed",
      );
    } else check(ctx.role !== "executor", "unauthorized", "Executor cannot acquire client stream");
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (x) =>
      x.toString(16).padStart(2, "0"),
    ).join("");
    const digest = await hash(token);
    const scopeGrant = ctx.grants.find(
      (g) =>
        (g.expiresAt === undefined || g.expiresAt > Date.now()) &&
        contains(g.resources, input.resources),
    );
    check(scopeGrant, "unauthorized", "Ticket scope expired");
    const authorityExpiresAt = Math.min(
      ctx.credentialExpiresAt ?? Number.MAX_SAFE_INTEGER,
      scopeGrant.expiresAt ?? Number.MAX_SAFE_INTEGER,
    );
    const expiresAt = Math.min(Date.now() + ttl, authorityExpiresAt);
    const identity: D.SocketIdentity = {
      ...ref(ctx),
      deploymentId: ctx.deploymentId,
      principalId: ctx.principalId,
      role: ctx.role,
      resources: input.resources,
      originMode: input.originMode,
      registrationId: "pending",
      expiresAt: authorityExpiresAt,
      ...(input.audience === "executor-session" ? { executor: input.executor } : {}),
    };
    await this.store.arm(expiresAt);
    this.store.tx(() => {
      this.identities.current(ctx);
      this.store.put(
        "ticket",
        digest,
        { identity, audience: input.audience, used: false, expiresAt } satisfies Ticket,
        "",
        "",
        expiresAt,
      );
    });
    return {
      ticket: token,
      audience: input.audience,
      expiresAt,
      identity: {
        deploymentId: ctx.deploymentId,
        principalId: ctx.principalId,
        role: ctx.role,
        credential: ref(ctx),
        credentialExpiresAt: ctx.credentialExpiresAt,
      },
    };
  }
  async consume(input: D.TicketRedemption): Promise<D.SocketIdentity> {
    check(
      input.ticket.length === 64 && input.deploymentId === this.identities.deploymentId,
      "unauthenticated",
      "Invalid ticket",
    );
    const digest = await hash(input.ticket);
    return this.store.tx(() => {
      const t = this.store.get<Ticket>("ticket", digest);
      check(t && !t.used && Date.now() < t.expiresAt, "unauthenticated", "Ticket expired or spent");
      check(
        t.audience === input.audience && same(t.identity.originMode, input.origin),
        "unauthorized",
        "Ticket audience or origin mismatch",
      );
      const c = this.store.get<import("./identity.js").CredentialRecord>(
        "credential",
        t.identity.credentialId,
      );
      check(c, "unauthenticated", "Invalid credential");
      const ctx: D.AuthContext = {
        ...t.identity,
        grants: c.grants,
        requestId: id(),
        authenticatedAt: Date.now(),
        credentialExpiresAt: c.expiresAt,
        deadline: Date.now() + 30000,
      };
      this.identities.current(ctx);
      let registrationId: string;
      if (input.audience === "client-stream") {
        check(
          input.destination.kind === "agent" &&
            t.identity.resources.agentIds.includes(input.destination.id),
          "unauthorized",
          "Ticket destination mismatch",
        );
        registrationId = this.register(ctx, {
          credential: ref(ctx),
          recipient: input.destination,
          resources: t.identity.resources,
        }).registrationId;
      } else {
        check(
          input.destination.kind === "control" && t.identity.executor,
          "unauthorized",
          "Ticket destination mismatch",
        );
        const e = this.store.get<ExecutorState>("executor", t.identity.executor.executorId);
        check(
          e && e.generation === t.identity.executor.generation && e.status !== "revoked",
          "unauthenticated",
          "Executor revoked",
        );
        registrationId = id();
      }
      const identity = { ...t.identity, registrationId };
      this.store.put("ticket", digest, { ...t, identity, used: true }, "", "", t.expiresAt);
      return identity;
    });
  }
  epoch(executorId: string): number {
    const e = this.store.get<ExecutorState>("executor", executorId);
    check(e, "not_found", "Executor not registered");
    return next(e.epoch);
  }
}
