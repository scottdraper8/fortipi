import type * as D from "../boundary/dto.js";
import type { Env } from "../boundary/env.js";
import { audit } from "./audit.js";
import { requireGrant } from "./authorization.js";
import type { CredentialRecord, Identities } from "./identity.js";
import { postponeRepair, repairAccepted } from "./repair.js";
import { check, id, next, type Store, same, within } from "./store.js";
import type { ExecutorState } from "./tickets.js";

interface Revocation {
  operationId: string;
  revocationId: string;
  subject: D.Invalidation["subject"];
  cutoff: number;
  cursor: number;
  enumerated: boolean;
  pending: number;
  complete: boolean;
  sample: D.Recipient[];
}
interface Fanout {
  revocationId: string;
  invalidation: D.Invalidation;
  recipient: D.Recipient;
  attempts: number;
}
export class Revocations {
  readonly store: Store;
  readonly identities: Identities;
  readonly env: Env;
  readonly close: (subject: D.Invalidation["subject"]) => void;
  constructor(
    store: Store,
    identities: Identities,
    env: Env,
    close: (subject: D.Invalidation["subject"]) => void,
  ) {
    this.store = store;
    this.identities = identities;
    this.env = env;
    this.close = close;
  }
  async revoke(
    ctx: D.AuthContext,
    kind: "credential" | "executor",
    subjectId: string,
    input: D.RevocationInput,
  ): Promise<D.RevocationReceipt> {
    this.identities.current(ctx);
    requireGrant(ctx, kind === "credential" ? "credentials.revoke" : "executors.revoke");
    await this.store.arm();
    const rev = this.begin(ctx, kind, subjectId, input);
    this.close(rev.subject);
    await this.enumerate(rev.revocationId);
    return this.receipt(rev.revocationId);
  }
  begin(
    ctx: D.AuthContext,
    kind: "credential" | "executor",
    subjectId: string,
    input: D.RevocationInput,
  ): Revocation {
    const key = `${ctx.principalId}:${kind}:${subjectId}:${input.requestId}`;
    return this.store.tx(() => {
      this.identities.current(ctx);
      const retry = this.store.get<{ input: D.RevocationInput; revocationId: string }>(
        "revoke_request",
        key,
      );
      if (retry) {
        check(same(retry.input, input), "conflict", "Revocation request changed");
        const old = this.store.get<Revocation>("revocation", retry.revocationId);
        check(old, "internal", "Missing revocation");
        return old;
      }
      let minimumGeneration: number;
      if (kind === "credential") {
        const c = this.store.get<CredentialRecord>("credential", subjectId);
        check(c, "not_found", "Credential unavailable");
        check(
          c.generation === input.expectedGeneration,
          "conflict",
          "Credential generation changed",
        );
        minimumGeneration = this.identities.bump(subjectId).generation;
      } else {
        const e = this.store.get<ExecutorState>("executor", subjectId);
        check(e, "not_found", "Executor unavailable");
        check(e.generation === input.expectedGeneration, "conflict", "Executor generation changed");
        minimumGeneration = next(e.generation);
        const description = e.description
          ? { ...e.description, state: "revoking" as const }
          : undefined;
        this.store.put("executor", subjectId, {
          ...e,
          generation: minimumGeneration,
          status: "revoked",
          ...(description ? { description } : {}),
        });
        if (description)
          this.store.put(
            "presence_transition",
            id(),
            { executorId: subjectId, description, cursor: 0, cutoff: this.store.maxSeq() },
            "",
            "",
            Date.now(),
          );
      }
      const subject: D.Invalidation["subject"] =
        kind === "credential"
          ? { kind, credentialId: subjectId, minimumGeneration }
          : { kind, executorId: subjectId, minimumGeneration };
      const revocationId = id();
      const created: Revocation = {
        operationId: id(),
        revocationId,
        subject,
        cutoff: this.store.maxSeq(),
        cursor: 0,
        enumerated: false,
        pending: 0,
        complete: false,
        sample: [],
      };
      this.store.put("revocation", revocationId, created, "", "", Date.now());
      this.store.put("admin_operation", created.operationId, { revocationId });
      this.store.put("revoke_request", key, { input, revocationId });
      audit(this.store, ctx, `${kind}.revoke`, subjectId, "pending");
      return created;
    });
  }
  async publish(rev: Revocation): Promise<D.RevocationReceipt> {
    this.close(rev.subject);
    await this.enumerate(rev.revocationId);
    return this.receipt(rev.revocationId);
  }
  private subjectKey(subject: D.Invalidation["subject"]): string {
    return subject.kind === "credential"
      ? `credential:${subject.credentialId}`
      : `executor:${subject.executorId}`;
  }
  private async enumerate(revocationId: string): Promise<void> {
    this.store.tx(() => {
      const rev = this.store.get<Revocation>("revocation", revocationId);
      if (!rev || rev.enumerated) return;
      const rows = this.store
        .page<D.AuthorityRegistration>(
          rev.subject.kind === "credential" ? "recipient" : "executor_recipient",
          rev.cursor,
          16,
          { subject: this.subjectKey(rev.subject) },
        )
        .filter((r) => r.seq <= rev.cutoff);
      for (const row of rows) {
        const recipient = row.value.recipient;
        const key = `${revocationId}:${recipient.kind}:${recipient.id}`;
        if (!this.store.get("fanout", key) && !this.store.get("invalidation_ack", key)) {
          this.store.put(
            "fanout",
            key,
            {
              revocationId,
              invalidation: { revocationId, subject: rev.subject },
              recipient,
              attempts: 0,
            } satisfies Fanout,
            revocationId,
            "",
            Date.now(),
          );
          rev.pending++;
          if (rev.sample.length < 100) rev.sample.push(recipient);
        }
        rev.cursor = row.seq;
      }
      rev.enumerated = rows.length < 16;
      rev.complete = rev.enumerated && rev.pending === 0;
      this.store.put(
        "revocation",
        revocationId,
        rev,
        "",
        "",
        rev.enumerated ? null : Date.now() + 250,
      );
    });
  }
  receipt(revocationId: string): D.RevocationReceipt {
    const r = this.store.get<Revocation>("revocation", revocationId);
    check(r, "not_found", "Revocation unavailable");
    if (r.complete)
      return { operationId: r.operationId, revocationId, state: "complete", pendingRecipients: [] };
    // Enumeration processes its first indexed page before a pending receipt can be emitted.
    const pending = this.store
      .page<Fanout>("fanout", 0, 100, { subject: revocationId })
      .map((x) => x.value.recipient);
    return {
      operationId: r.operationId,
      revocationId,
      state: "pending",
      pendingRecipients: pending.length ? pending : r.sample.slice(0, 100),
    };
  }
  async drain(kind: string, key: string): Promise<void> {
    if (kind === "revocation") {
      await this.enumerate(key);
      return;
    }
    const task = this.store.get<Fanout>("fanout", key);
    if (!task) return;
    let ack: D.Outcome<D.InvalidationAck> | undefined;
    try {
      const stub =
        task.recipient.kind === "agent"
          ? this.env.AGENT_SESSIONS.getByName(task.recipient.id)
          : this.env.WORKSPACES.getByName(task.recipient.id);
      check((await stub.contractVersion) === "1.0", "unsupported", "Recipient contract mismatch");
      ack = await within<D.Outcome<D.InvalidationAck>>(
        stub.invalidateGeneration(
          {
            kind: "control-recovery",
            deploymentId: this.identities.deploymentId,
            revocationId: task.revocationId,
            recipient: task.recipient,
            actions: ["invalidate"],
            deadline: Date.now() + 5000,
          },
          task.invalidation,
        ),
      );
    } catch {
      /* A send, timeout or lost response is never a durable floor acknowledgment. */
    }
    this.store.tx(() => {
      if (!this.store.get<Fanout>("fanout", key)) return;
      const rev = this.store.get<Revocation>("revocation", task.revocationId);
      check(rev, "internal", "Missing revocation operation");
      if (
        ack?.ok &&
        same(ack.value.subject, task.invalidation.subject) &&
        same(ack.value.recipient, task.recipient) &&
        ack.value.revocationId === task.revocationId &&
        ack.value.persistedFloor >= task.invalidation.subject.minimumGeneration
      ) {
        this.store.put("invalidation_ack", key, ack.value);
        this.store.remove("fanout", key);
        repairAccepted(this.store, "fanout", key);
        rev.pending--;
        rev.complete = rev.enumerated && rev.pending === 0;
        this.store.put("revocation", rev.revocationId, rev);
        return;
      }
      task.attempts = next(this.store.get<Fanout>("fanout", key)?.attempts ?? task.attempts);
      const delay =
        Math.min(3600000, 1000 * 2 ** Math.min(12, task.attempts)) +
        Math.floor(Math.random() * 250);
      this.store.put("fanout", key, task, task.revocationId, "", Date.now() + delay);
      postponeRepair(this.store, "fanout", key, ack, Date.now() + delay);
    });
  }
}
