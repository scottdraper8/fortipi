import type { ClientEvent, DurableEvent } from "fortipi-contract";
import { canonicalJson } from "fortipi-contract";
import { FortiPiError } from "./errors.js";
import type { CursorScope } from "./types.js";
/** Ticket TTL and credential expiry are observations, not a different authority scope. */
export function cursorScopeKey(scope: CursorScope): string {
  const identity = scope.identity;
  return canonicalJson({
    origin: scope.origin,
    agentId: scope.agentId,
    conversationId: scope.conversationId,
    deploymentId: identity.deploymentId,
    principalId: identity.principalId,
    role: identity.role,
    credential: {
      credentialId: identity.credential.credentialId,
      generation: identity.credential.generation,
      grantVersion: identity.credential.grantVersion,
    },
  });
}

export class GapError extends FortiPiError {
  constructor() {
    super("event_gap", { retryable: true });
  }
}
/** Cursor and recent identities change only after the consumer has applied an event. */
export class AppliedCursor {
  private readonly recent = new Map<number, string>();
  private readonly ids = new Map<string, number>();
  value: number;
  private readonly maximum: number;
  constructor(after = 0, maximum = 256) {
    this.maximum = maximum;
    if (!Number.isSafeInteger(after) || after < 0) throw new FortiPiError("cursor.invalid");
    this.value = after;
  }
  replace(after: number): void {
    if (!Number.isSafeInteger(after) || after < 0) throw new FortiPiError("cursor.invalid");
    this.value = after;
    this.recent.clear();
    this.ids.clear();
  }
  async apply(
    event: ClientEvent,
    handler: (event: ClientEvent) => Promise<void> | void,
    save?: (cursor: number) => Promise<void> | void,
    verifyPrevious?: (event: DurableEvent) => Promise<boolean>,
  ): Promise<boolean> {
    if (event.durability === "volatile") {
      await handler(event);
      return false;
    }
    if (
      (this.recent.has(event.eventSeq) && this.recent.get(event.eventSeq) !== event.eventId) ||
      (this.ids.has(event.eventId) && this.ids.get(event.eventId) !== event.eventSeq)
    )
      throw new FortiPiError("conflicting_event_identity");
    if (event.eventSeq <= this.value) {
      if (!this.recent.has(event.eventSeq) && (!verifyPrevious || !(await verifyPrevious(event))))
        throw new FortiPiError("conflicting_event_identity");
      return false;
    }
    if (event.eventSeq !== this.value + 1) throw new GapError();
    await handler(event);
    // A persistence callback must atomically persist its projection with this cursor.
    if (save) await save(event.eventSeq);
    this.record(event);
    return true;
  }
  private record(event: DurableEvent): void {
    this.value = event.eventSeq;
    this.recent.set(event.eventSeq, event.eventId);
    this.ids.set(event.eventId, event.eventSeq);
    while (this.recent.size > this.maximum) {
      const first = this.recent.entries().next().value;
      if (!first) break;
      this.recent.delete(first[0]);
      this.ids.delete(first[1]);
    }
  }
}
