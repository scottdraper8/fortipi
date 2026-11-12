import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RoleContext } from "../../../../tests/clients/roles.ts";
import type * as D from "../../src/boundary/dto.js";
import { provision } from "./fixture-state.ts";
import { poll, type RuntimeOptions, start } from "./runtime.ts";

function openNative(
  endpoint: string,
  ticket: string,
  path = "/v1/stream",
): Promise<WebSocket | undefined> {
  const url = new URL(path, endpoint);
  url.protocol = "ws:";
  url.searchParams.set("ticket", ticket);
  return new Promise((accept) => {
    const socket = new WebSocket(url.href);
    const timer = setTimeout(() => {
      socket.close();
      accept(undefined);
    }, 5000);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        accept(socket);
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        accept(undefined);
      },
      { once: true },
    );
    socket.addEventListener(
      "close",
      () => {
        clearTimeout(timer);
        accept(undefined);
      },
      { once: true },
    );
  });
}
async function ping(socket: WebSocket) {
  const requestId = randomUUID();
  await new Promise<void>((accept, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener("message", receive);
      reject(new Error("Actual active stream did not acknowledge ping"));
    }, 5000);
    const receive = (event: MessageEvent) => {
      const value = JSON.parse(String(event.data)) as {
        type: string;
        requestId?: string;
        operationId?: string;
      };
      if (value.requestId === requestId && value.type === "ack" && value.operationId === "ping") {
        clearTimeout(timer);
        socket.removeEventListener("message", receive);
        accept();
      }
    };
    socket.addEventListener("message", receive);
    socket.send(JSON.stringify({ type: "ping", requestId }));
  });
}
export async function ticketsAndRevoke() {
  const runtime = await start(),
    roles = new RoleContext(runtime.endpoint, runtime.admin);
  const sockets: WebSocket[] = [];
  try {
    const state = await provision(runtime, (input) => roles.issue(input));
    const resources: D.ResourceScope = {
      agentIds: [state.agent.agentId],
      conversationIds: [state.conversations[0]!.conversationId],
      workspaceIds: [],
      executorIds: [],
      backendIds: [],
      tools: [],
      actions: ["events.read"],
    };
    const mint = async (changes: Partial<D.TicketInput> = {}) => {
      const result = await runtime.api<D.TicketReceipt>(
        "/v1/connections/tickets",
        {
          requestId: randomUUID(),
          audience: "client-stream",
          originMode: { kind: "native" },
          resources,
          ...changes,
        },
        "POST",
        state.client.token,
      );
      assert.equal(result.status, 201);
      return result.body;
    };
    const ticket = await mint();
    const race = await Promise.all([
      openNative(runtime.endpoint, ticket.ticket),
      openNative(runtime.endpoint, ticket.ticket),
    ]);
    for (const socket of race) if (socket) sockets.push(socket);
    assert.equal(sockets.length, 1, "One ticket must allow exactly one actual native upgrade");
    await ping(sockets[0]!);
    assert.equal(
      await openNative(runtime.endpoint, ticket.ticket),
      undefined,
      "Consumed ticket must not reopen",
    );
    const wrong = await mint();
    assert.equal(
      await openNative(runtime.endpoint, wrong.ticket, "/v1/executor/session"),
      undefined,
      "Audience cannot be exchanged",
    );
    const expired = await mint({ ttlMs: 1 });
    await poll(
      async () => Date.now(),
      (now) => now > expired.expiresAt,
    );
    assert.equal(
      await openNative(runtime.endpoint, expired.ticket),
      undefined,
      "Expired ticket must not upgrade",
    );
    const foreign = await runtime.api(
      "/v1/connections/tickets",
      {
        requestId: randomUUID(),
        audience: "client-stream",
        resources,
        originMode: { kind: "browser", value: "https://synthetic-untrusted.invalid" },
      },
      "POST",
      state.client.token,
    );
    assert.equal(foreign.status, 403, "Unallowlisted browser Origin cannot mint authority");
    const socket = sockets[0]!;
    const closed = new Promise<void>((accept) =>
      socket.addEventListener("close", () => accept(), { once: true }),
    );
    const revoked = await poll(
      () => roles.revoke(state.client.credential.credentialId),
      (value) => value.state === "complete",
    );
    assert.equal(
      revoked.state,
      "complete",
      "Completion requires all actual registered recipient acknowledgments",
    );
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Actual revoked stream remained open")),
          5000,
        );
        timer.unref();
      }),
    ]);
    const denied = await runtime.api(
      `/v1/conversations/${state.conversations[0]!.conversationId}`,
      undefined,
      "GET",
      state.client.token,
    );
    assert.equal(denied.status, 401, "New work must reject revoked authority immediately");
    return {
      nativeOneUseUpgradeWinners: 1,
      consumedAndExpiredRejected: true,
      audienceRejected: true,
      unallowlistedOriginRejected: true,
      actualActiveStreamClosed: true,
      completedRecipients: true,
      newRevokedRequestStatus: 401,
      limitation:
        "Actual browser-origin/CORS behavior is separately exercised by installed Chromium",
    };
  } finally {
    for (const socket of sockets) socket.close();
    const cleanup = await roles.cleanup();
    await runtime.dispose();
    assert.ok(cleanup.every((role) => role.state === "complete"));
  }
}
export async function fenceGeneration(options: RuntimeOptions = {}) {
  const runtime = await start(options),
    roles = new RoleContext(runtime.endpoint, runtime.admin);
  let control = "";
  try {
    const state = await provision(runtime, (input) => roles.issue(input));
    control = `/__integration/actor/${state.agent.agentId}/control`;
    await runtime.api(control, {
      action: "hold-authority",
      credentialId: state.client.credential.credentialId,
    });
    const pending = runtime.api(
      `/v1/conversations/${state.conversations[0]!.conversationId}`,
      undefined,
      "GET",
      state.client.token,
    );
    const held = await poll(
      async () =>
        (
          await runtime.api<{ authority: { actualControlAllowed: boolean } | null }>(control, {
            action: "state",
          })
        ).body,
      (value) => value.authority?.actualControlAllowed === true,
    );
    assert.ok(
      held.authority?.actualControlAllowed,
      "Actual CP allowed decision must be captured before invalidation",
    );
    const revoked = await poll(
      () => roles.revoke(state.client.credential.credentialId),
      (value) => value.state === "complete",
    );
    assert.equal(revoked.state, "complete");
    await runtime.api(control, { action: "release-authority" });
    const response = await pending;
    assert.equal(
      response.status,
      403,
      "Completed generation invalidation must fence an already-authenticated and CP-authorized operation",
    );
    return {
      actualControlAllowedBeforeHold: true,
      completedInvalidationBeforeRelease: true,
      alreadyAuthenticatedResponse: response.status,
      edgeReauthenticationNotOracle: true,
    };
  } finally {
    if (control) await runtime.api(control, { action: "release-authority" }).catch(() => {});
    const cleanup = await roles.cleanup();
    await runtime.dispose();
    assert.ok(cleanup.every((role) => role.state === "complete"));
  }
}
export async function interruptedRevocation() {
  const runtime = await start(),
    roles = new RoleContext(runtime.endpoint, runtime.admin);
  let control = "";
  try {
    const state = await provision(runtime, (input) => roles.issue(input));
    // Actual read registers the recipient in the real CP before the revoke.
    assert.equal(
      (
        await runtime.api(
          `/v1/conversations/${state.conversations[0]!.conversationId}`,
          undefined,
          "GET",
          state.client.token,
        )
      ).status,
      200,
    );
    control = `/__integration/actor/${state.agent.agentId}/control`;
    await runtime.api(control, { action: "hold-invalidation" });
    const revoke = roles.revoke(state.client.credential.credentialId);
    await poll(
      async () => (await runtime.api<{ invalidation: unknown }>(control, { action: "state" })).body,
      (value) => value.invalidation !== null,
    );
    const before = await revoke;
    assert.equal(before.state, "pending");
    assert.ok(before.pendingRecipients.length > 0);
    const denied = await runtime.api(
      `/v1/conversations/${state.conversations[0]!.conversationId}`,
      undefined,
      "GET",
      state.client.token,
    );
    assert.equal(denied.status, 401, "Pending fanout must still deny new edge work");
    await runtime.stopAbruptly();
    await runtime.reopenSameStorage();
    await runtime.api(control, { action: "release-invalidation" });
    const complete = await poll(
      () => roles.revoke(state.client.credential.credentialId),
      (value) => value.state === "complete",
    );
    assert.equal(complete.operationId, before.operationId);
    assert.equal(complete.revocationId, before.revocationId);
    assert.equal(complete.pendingRecipients.length, 0);
    return {
      pendingRecipientsBeforeDeath: before.pendingRecipients.length,
      pendingNewWorkStatus: 401,
      actualWorkerdKilled: true,
      sameOperationAfterReopen: true,
      persistedRecipientAcknowledgmentsComplete: true,
    };
  } finally {
    if (control) await runtime.api(control, { action: "release-invalidation" }).catch(() => {});
    const cleanup = await roles.cleanup();
    await runtime.dispose();
    assert.ok(cleanup.every((role) => role.state === "complete"));
  }
}
