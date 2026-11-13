import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { ResourceScope } from "../../packages/fortipi-contract/dist/index.js";
import type { Installed } from "../distribution/install.ts";
import type { RoleContext } from "./roles.ts";

/** Public operations/default native transports only. The same oracle may be
 * engineered against a local service; only an actual deployment gives live proof. */
export async function publicAccess(
  installed: Installed,
  roles: RoleContext,
  input: { agentId: string; conversationId: string; excludedConversationId: string },
) {
  const module = (await import(
    pathToFileURL(installed.resolveExport(`@${installed.candidate.scope}/fortipi-client/node`)).href
  )) as typeof import("../../packages/fortipi-client/dist/node.js");
  const resources: ResourceScope = {
    agentIds: [input.agentId],
    conversationIds: [input.conversationId],
    workspaceIds: [],
    executorIds: [],
    backendIds: [],
    tools: [],
    actions: ["conversations.read", "events.read", "tickets.mint"],
  };
  const issued = await roles.issue({
    requestId: randomUUID(),
    role: "client",
    expiresAt: Date.now() + 300000,
    grants: [{ grantId: randomUUID(), version: 1, resources }],
  });
  const client = new module.FortiPiClient({
    endpoint: roles.endpoint,
    credentials: async () => issued.token,
    allowLoopbackHttp: new URL(roles.endpoint).protocol === "http:",
  });
  const protocol = await client.negotiate();
  const firstTicket = await client.tickets.mint(input.agentId, input.conversationId);
  assert.equal(firstTicket.identity.credential.credentialId, issued.credential.credentialId);
  const upgrade = (ticket: string) =>
    client.operations.getClientStream({ path: {}, query: { ticket }, body: undefined });
  const first = await upgrade(firstTicket.ticket);
  first.close();
  const handshakeDenied = (error: unknown) =>
    error instanceof module.FortiPiError && error.code === "handshake_failed";
  await assert.rejects(
    () => upgrade(firstTicket.ticket),
    handshakeDenied,
    "One used real ticket cannot upgrade twice",
  );
  await assert.rejects(
    () => client.conversations.get(input.excludedConversationId),
    (error: unknown) => error instanceof module.FortiPiError && error.status === 403,
    "Application scope must exclude the other real conversation",
  );
  const wrongAudience = {
    requestId: randomUUID(),
    audience: "executor-session" as const,
    resources,
    originMode: { kind: "native" as const },
    executor: { executorId: randomUUID(), generation: 1 },
  };
  await assert.rejects(
    () => client.operations.mintConnectionTicket({ path: {}, query: {}, body: wrongAudience }),
    (error: unknown) => error instanceof module.FortiPiError && error.status === 403,
    "A client role cannot exchange itself for executor-session authority",
  );
  const expired = await client.tickets.mint(input.agentId, input.conversationId),
    waitedFrom = Date.now();
  assert.ok(
    expired.expiresAt > waitedFrom && expired.expiresAt - waitedFrom <= protocol.limits.ticketTtlMs,
  );
  while (Date.now() <= expired.expiresAt)
    await new Promise<void>((accept) =>
      setTimeout(accept, Math.min(1000, expired.expiresAt - Date.now() + 1)),
    );
  await assert.rejects(
    () => upgrade(expired.ticket),
    handshakeDenied,
    "Real elapsed ticket expiry must reject before a new native upgrade",
  );
  const positive = await client.tickets.mint(input.agentId, input.conversationId),
    afterExpiry = await upgrade(positive.ticket);
  afterExpiry.close();
  let identityObserved = false,
    closed = false;
  const subscription = client.conversations.subscribe(input.conversationId, {
    agentId: input.agentId,
    maxReconnects: 0,
    onSnapshot() {},
    onEvent() {},
    onIdentity(identity) {
      assert.equal(identity.credential.credentialId, issued.credential.credentialId);
      assert.equal(identity.credential.generation, issued.credential.generation);
      identityObserved = true;
    },
  });
  void subscription.done.then(
    () => {
      closed = true;
    },
    () => {
      closed = true;
    },
  );
  try {
    await subscription.ready;
    assert.equal(identityObserved, true);
    const unusedBeforeRevoke = await client.tickets.mint(input.agentId, input.conversationId);
    const receipt = await roles.revokeAndWait(issued.credential.credentialId);
    assert.equal(receipt.state, "complete");
    const end = Date.now() + 15000;
    while (!closed && Date.now() < end) await new Promise<void>((accept) => setTimeout(accept, 25));
    assert.equal(
      closed,
      true,
      "An acknowledged cached recipient must close access on completed invalidation",
    );
    await assert.rejects(
      () => client.conversations.get(input.conversationId),
      (error: unknown) => error instanceof module.FortiPiError && error.status === 401,
    );
    await assert.rejects(
      () => client.tickets.mint(input.agentId, input.conversationId),
      (error: unknown) => error instanceof module.FortiPiError && error.status === 401,
    );
    await assert.rejects(
      () => upgrade(unusedBeforeRevoke.ticket),
      handshakeDenied,
      "Pre-revocation unused ticket cannot bypass current generation authority",
    );
    const observation = {
      defaultNativeFetchAndWebSocket: true,
      firstTicketUpgraded: true,
      reusedTicketRejected: true,
      excludedConversationStatus: 403,
      wrongAudienceStatus: 403,
      expiredTicketRejectedAfterRealElapsedTime: true,
      actualExpiryWaitMs: Date.now() - waitedFrom,
      freshUpgradeAfterExpiryNegative: true,
      acknowledgedRecipientCredential: issued.credential,
      completePublicRevocation: true,
      cachedRecipientAccessClosed: true,
      newReadAndTicketStatus: 401,
      staleUnusedTicketRejected: true,
      limitation:
        "Live transport/generation propagation; controlled already-allowed CP call fencing is separately measured by the same-source integrated oracle",
    };
    roles.assertSanitized(observation);
    return observation;
  } finally {
    subscription.close();
    await subscription.done.catch(() => {});
  }
}
