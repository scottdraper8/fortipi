import { check, permits, scope, unwrap } from "../api/common.js";
import type { ControlPlaneRpc } from "../boundary/control-plane.js";
import type * as D from "../boundary/dto.js";
import { PhysicalStorage } from "./physical-storage.js";
import type { Sql, Store } from "./store.js";
export type ControlPort = Pick<
  ControlPlaneRpc,
  | "fetch"
  | "authorize"
  | "reserveCapacity"
  | "settleCapacity"
  | "reserveTarget"
  | "registerAuthorityRecipient"
  | "recordDispatchIntent"
  | "assignOnce"
  | "queryExecution"
  | "cancelExecution"
  | "deliverExecutorFrame"
  | "requestLocalWorkspace"
  | "resolveExecutorGeneration"
>;

export class Authority {
  readonly store: Store;
  readonly control: ControlPort;
  readonly agentId: string;
  readonly physical: PhysicalStorage;
  constructor(store: Store, control: ControlPort, agentId: string) {
    this.store = store;
    this.control = control;
    this.agentId = agentId;
    this.physical = new PhysicalStorage(store, this, control);
  }
  async current(ctx: D.AuthContext, resources: D.ResourceScope, tx?: Sql): Promise<void> {
    const now = Date.now();
    check(
      ctx.registrationId &&
        ctx.deadline > now &&
        (ctx.credentialExpiresAt === null || ctx.credentialExpiresAt > now),
      "unauthorized",
      "Current registered authority required",
    );
    check(
      ctx.generation >=
        ((await this.store.get<number>("credential-floor", ctx.credentialId, tx)) ?? 0),
      "unauthorized",
      "Credential revoked",
    );
    const deployment = await this.store.get<string>("meta", "deployment", tx);
    check(!deployment || deployment === ctx.deploymentId, "unauthorized", "Wrong deployment");
    check(permits(ctx.grants, resources), "unauthorized", "Resource grant required");
  }
  async authorize(
    ctx: D.AuthContext,
    action: string,
    conversationId?: string,
    extra: Partial<D.ResourceScope> = {},
  ): Promise<void> {
    const resources = scope({
      agentIds: [this.agentId],
      conversationIds: conversationId ? [conversationId] : [],
      actions: [action],
      ...extra,
    });
    await this.current(ctx, resources);
    const decision = unwrap(await this.control.authorize({ principal: ctx, resources, action }));
    check(decision.allowed, "unauthorized", "Current resource authority required");
    await this.current(ctx, resources);
  }
  async invalidate(ctx: D.RecoveryContext, input: D.Invalidation): Promise<D.InvalidationAck> {
    check(
      ctx.kind === "control-recovery" &&
        ctx.deadline > Date.now() &&
        ctx.actions.length === 1 &&
        ctx.actions[0] === "invalidate" &&
        ctx.recipient.kind === "agent" &&
        ctx.recipient.id === this.agentId &&
        ctx.revocationId === input.revocationId,
      "unauthorized",
      "Invalid recovery authority",
    );
    return this.store.transaction(async (tx) => {
      const deployment = await this.store.get<string>("meta", "deployment", tx);
      check(!deployment || deployment === ctx.deploymentId, "unauthorized", "Wrong deployment");
      const subject = input.subject;
      const kind = subject.kind === "credential" ? "credential-floor" : "executor-floor";
      const key = subject.kind === "credential" ? subject.credentialId : subject.executorId;
      const floor = Math.max(
        (await this.store.get<number>(kind, key, tx)) ?? 0,
        subject.minimumGeneration,
      );
      await this.store.put(kind, key, floor, tx);
      return {
        revocationId: input.revocationId,
        recipient: ctx.recipient,
        subject,
        persistedFloor: floor,
      };
    });
  }
}
