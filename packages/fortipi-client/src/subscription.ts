import type {
  ClientEvent,
  ConversationProjection,
  ReplayPage,
  TicketIdentity,
  TicketReceipt,
} from "fortipi-contract";
import type { FortiPiClient } from "./client.js";
import { AppliedCursor, cursorScopeKey, GapError } from "./cursor.js";
import { checkAbort, delay, FortiPiError, failure } from "./errors.js";
import { openStream } from "./transport.js";
import type { ConnectionStatus, CursorScope } from "./types.js";

export interface SubscriptionOptions {
  signal?: AbortSignal;
  /** Only supply after together with the corresponding already applied projection. */
  after?: number;
  /** Retained from the subscription whose projection/cursor is being resumed. */
  scope?: CursorScope;
  onSnapshot(snapshot: ConversationProjection): Promise<void> | void;
  onEvent(event: ClientEvent): Promise<void> | void;
  onCursor?(cursor: number): Promise<void> | void;
  onStatus?(status: ConnectionStatus, error?: FortiPiError): void;
  onIdentity?(identity: TicketIdentity): void;
  maxReconnects?: number;
}
export interface Subscription {
  readonly cursor: number;
  readonly scope: CursorScope | undefined;
  readonly ready: Promise<void>;
  readonly done: Promise<void>;
  close(): void;
}
export function subscribe(
  client: FortiPiClient,
  conversationId: string,
  options: SubscriptionOptions,
): Subscription {
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const cursor = new AppliedCursor(options.after ?? 0);
  if (options.after !== undefined && !options.scope)
    throw new FortiPiError("cursor_scope_required");
  if (options.scope) client.http.validation.assert("TicketIdentity", options.scope.identity);
  let scope = options.scope ? structuredClone(options.scope) : undefined;
  let initialized = options.after !== undefined;
  const verifiedPrevious = new Map<number, string>();
  if (scope && (scope.origin !== client.http.origin || scope.conversationId !== conversationId)) {
    initialized = false;
    cursor.replace(0);
    scope = undefined;
  }
  let readyResolve: () => void = () => {};
  let readyReject: (error: unknown) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  void ready.catch(() => {});
  const status = (value: ConnectionStatus, error?: FortiPiError) =>
    options.onStatus?.(value, error);
  async function acceptTicket(ticket: TicketReceipt): Promise<void> {
    if (ticket.audience !== "client-stream" || ticket.expiresAt <= Date.now())
      throw new FortiPiError("invalid_ticket");
    const identity = ticket.identity;
    if (identity.credentialExpiresAt !== null && identity.credentialExpiresAt <= Date.now())
      throw new FortiPiError("unauthenticated");
    if (identity.deploymentId !== client.http.protocol?.deploymentId) {
      client.http.protocol = undefined;
      const protocol = await client.negotiate(signal);
      if (identity.deploymentId !== protocol.deploymentId) throw new FortiPiError("scope_mismatch");
    }
    const next: CursorScope = {
      origin: client.http.origin,
      conversationId,
      identity: structuredClone(identity),
    };
    if (scope && cursorScopeKey(scope) !== cursorScopeKey(next)) {
      initialized = false;
      cursor.replace(0);
      verifiedPrevious.clear();
    }
    scope = next;
    try {
      options.onIdentity?.(structuredClone(identity));
    } catch (error) {
      throw error instanceof FortiPiError ? error : new FortiPiError("handler_failed");
    }
  }
  async function snapshot(): Promise<void> {
    const value = await client.conversations.get(conversationId, { signal });
    if (
      value.conversation.conversationId !== conversationId ||
      value.retainedFloor > value.lastEventSeq
    )
      throw new FortiPiError("invalid_wire");
    await options.onSnapshot(value);
    checkAbort(signal);
    cursor.replace(value.lastEventSeq);
    verifiedPrevious.clear();
    initialized = true;
  }
  async function apply(event: ClientEvent): Promise<void> {
    if (signal.aborted) return;
    if (
      event.conversationId !== conversationId ||
      event.deploymentId !== client.http.protocol?.deploymentId
    )
      throw new FortiPiError("scope_mismatch");
    try {
      await cursor.apply(
        event,
        async (event) => {
          checkAbort(signal);
          try {
            await options.onEvent(event);
          } catch {
            throw new FortiPiError("handler_failed");
          }
          checkAbort(signal);
        },
        options.onCursor
          ? async (value) => {
              try {
                await options.onCursor?.(value);
              } catch {
                throw new FortiPiError("handler_failed");
              }
            }
          : undefined,
        async (received) => {
          if (!verifiedPrevious.has(received.eventSeq)) {
            const through = Math.min(
              cursor.value,
              received.eventSeq + Math.min(100, client.http.protocol?.limits.replayPage ?? 100) - 1,
            );
            const prior = await client.conversations.events(
              conversationId,
              {
                after: received.eventSeq - 1,
                through,
                limit: Math.min(100, client.http.protocol?.limits.replayPage ?? 100),
              },
              { signal },
            );
            if (
              prior.after !== received.eventSeq - 1 ||
              prior.through !== through ||
              !prior.events.length
            )
              throw new FortiPiError("invalid_replay");
            verifiedPrevious.clear();
            let sequence = prior.after;
            for (const event of prior.events) {
              if (
                event.eventSeq !== ++sequence ||
                event.conversationId !== conversationId ||
                event.deploymentId !== client.http.protocol?.deploymentId
              )
                throw new FortiPiError("invalid_replay");
              verifiedPrevious.set(event.eventSeq, event.eventId);
            }
            if (prior.nextAfter !== sequence) throw new FortiPiError("invalid_replay");
          }
          return verifiedPrevious.get(received.eventSeq) === received.eventId;
        },
      );
    } catch (error) {
      if (error instanceof GapError || error instanceof FortiPiError) throw error;
      throw new FortiPiError("handler_failed");
    }
  }
  async function page(value: ReplayPage): Promise<void> {
    const before = cursor.value;
    if (
      value.after > cursor.value ||
      value.nextAfter < value.after ||
      value.nextAfter > value.through ||
      value.through > value.lastEventSeq
    )
      throw new FortiPiError("invalid_replay");
    let sequence = value.after;
    for (const event of value.events) {
      if (event.eventSeq !== ++sequence) throw new FortiPiError("invalid_replay");
      await apply(event);
    }
    if (
      value.nextAfter !== sequence ||
      Math.max(before, value.nextAfter) !== cursor.value ||
      (value.hasMore && !value.events.length)
    )
      throw new FortiPiError("invalid_replay");
  }
  async function replay(barrier?: number): Promise<void> {
    let through: number | undefined = barrier;
    while (!signal.aborted) {
      const value = await client.conversations.events(
        conversationId,
        {
          after: cursor.value,
          limit: Math.min(100, client.http.protocol?.limits.replayPage ?? 100),
          ...(through === undefined ? {} : { through }),
        },
        { signal },
      );
      if (value.after !== cursor.value || (through !== undefined && value.through !== through))
        throw new FortiPiError("invalid_replay");
      through = value.through;
      await page(value);
      if (!value.hasMore) {
        if (cursor.value !== through) throw new GapError();
        return;
      }
    }
  }
  const done = (async () => {
    let retries = 0;
    let onlineSince = 0;
    try {
      while (!signal.aborted) {
        try {
          onlineSince = 0;
          status(retries ? "reconnecting" : "connecting");
          await client.negotiate(signal);
          let liveTicket = await client.tickets.mint(conversationId, { signal });
          for (let refreshes = 0; ; refreshes++) {
            const epoch = client.http.authenticationEpoch;
            await acceptTicket(liveTicket);
            if (!initialized) await snapshot();
            await replay();
            if (
              liveTicket.expiresAt > Date.now() + 1000 &&
              epoch === client.http.authenticationEpoch
            )
              break;
            if (refreshes >= 2) throw new FortiPiError("unstable_credential_scope");
            liveTicket = await client.tickets.mint(conversationId, { signal });
          }
          let requestId = "";
          const connection = openStream(
            client.http,
            liveTicket.ticket,
            signal,
            async (frame) => {
              if ("durability" in frame) {
                await apply(frame);
                return;
              }
              if (frame.type === "error") throw FortiPiError.remote(frame.error);
              if (frame.type === "resync_required")
                throw new FortiPiError(
                  frame.reason === "cursor.expired" ? "cursor.expired" : "resync_required",
                  { retryable: true },
                );
              if (
                frame.type === "ack" &&
                frame.operationId === "replayEvents" &&
                frame.requestId === requestId
              ) {
                await page(frame.receipt);
                if (frame.receipt.hasMore && cursor.value < frame.receipt.through)
                  await replay(frame.receipt.through);
                status("online");
                readyResolve();
                onlineSince = Date.now();
              }
            },
            () => {
              requestId = globalThis.crypto.randomUUID();
              return {
                type: "conversation.subscribe",
                requestId,
                input: {
                  operationId: "replayEvents",
                  path: { id: conversationId },
                  query: { after: cursor.value },
                },
              };
            },
          );
          await connection.done;
          if (!signal.aborted) throw new FortiPiError("disconnected", { retryable: true });
        } catch (error) {
          if (signal.aborted) break;
          const issue = failure(error);
          if (onlineSince && Date.now() - onlineSince >= 30000) retries = 0;
          if (issue.code === "cursor.expired" || issue.code === "resync_required") {
            status("resyncing", issue);
            initialized = false;
          } else if (issue.code === "event_gap" || issue.code === "stream_overflow") {
            status("resyncing", issue);
          } else if (
            [
              "unauthenticated",
              "unauthorized",
              "cursor.invalid",
              "handler_failed",
              "invalid_wire",
              "scope_mismatch",
              "conflicting_event_identity",
              "invalid_replay",
            ].includes(issue.code) ||
            !issue.retryable
          ) {
            status("paused", issue);
            throw issue;
          } else status("offline", issue);
          if (++retries > (options.maxReconnects ?? 8)) throw issue;
          const pressure = issue.details?.pressure;
          if (pressure && pressure.action !== "retry-later") {
            status("paused", issue);
            throw issue;
          }
          const retryAt = pressure?.retryAt;
          const wait = Math.max(
            issue.retryAfterMs ?? issue.details?.retryAfterMs ?? 0,
            retryAt === undefined ? 0 : retryAt - Date.now(),
            Math.min(30000, 250 * 2 ** Math.min(retries - 1, 7)) *
              (0.75 + (client.http.options.random ?? Math.random)() / 2),
          );
          status("reconnecting", issue);
          await delay(Math.min(86400000, wait), signal);
        }
      }
    } catch (error) {
      readyReject(error);
      throw error;
    } finally {
      readyReject(new FortiPiError("closed"));
      status(signal.aborted ? "closed" : "paused");
    }
  })();
  void done.catch(() => {});
  return {
    get cursor() {
      return cursor.value;
    },
    get scope() {
      return scope ? structuredClone(scope) : undefined;
    },
    ready,
    done,
    close() {
      controller.abort();
    },
  };
}
