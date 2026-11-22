import type {
  ClientEvent,
  ConversationProjection,
  DurableEvent,
  Protocol,
  ReplayPage,
  TicketIdentity,
  TicketReceipt,
} from "fortipi-contract";
export const identity: TicketIdentity = {
  deploymentId: "deploy_test",
  principalId: "principal_test",
  role: "client",
  credential: { credentialId: "credential_test", generation: 1, grantVersion: 1 },
  credentialExpiresAt: null,
};
export function ticketReceipt(
  ticket = "ticket_1",
  authenticated = identity,
  expiresAt = Date.now() + 30000,
): TicketReceipt {
  return { ticket, audience: "client-stream", expiresAt, identity: authenticated };
}
export const cursorScope = {
  agentId: "agent_1",
  origin: "https://example.test",
  conversationId: "conv_1",
  identity,
};

import { freeInfrastructurePolicy } from "fortipi-contract";

export const protocol: Protocol = {
  protocolVersion: "1.0",
  schemaVersion: "1.0.0",
  deploymentId: "deploy_test",
  supportedVersions: ["1.0"],
  features: [],
  schemas: [],
  models: [],
  infrastructure: freeInfrastructurePolicy,
  limits: {
    jsonBytes: 1048576,
    outputFrameBytes: 16384,
    chunkBytes: 262144,
    uploadTtlMs: 900000,
    ticketTtlMs: 30000,
    rpcDeadlineMs: 30000,
    replayPage: 100,
    socketBufferBytes: 1048576,
    socketBufferFrames: 256,
  },
  retention: { kind: "conversation-lifetime", retainedFloor: 0 },
  backends: [],
};
export const snapshot: ConversationProjection = {
  conversation: {
    conversationId: "conv_1",
    agentId: "agent_1",
    title: "Fixture",
    revision: "revision_0",
    createdAt: 1,
    taskState: { state: "idle" },
  },
  messages: [],
  projectionRevision: "revision_0",
  lastEventSeq: 0,
  retainedFloor: 0,
};
export function event(
  eventSeq: number,
  type = "extension.future",
  conversationId = "conv_1",
): DurableEvent {
  return {
    protocolVersion: "1.0",
    schemaVersion: "1.0.0",
    deploymentId: "deploy_test",
    conversationId,
    durability: "durable",
    eventId: `event_${eventSeq}`,
    eventSeq,
    timestamp: eventSeq,
    type,
    payload: { future: true },
  };
}
export function delta(): ClientEvent {
  return {
    protocolVersion: "1.0",
    schemaVersion: "1.0.0",
    deploymentId: "deploy_test",
    conversationId: "conv_1",
    durability: "volatile",
    eventId: "delta_1",
    timestamp: 1,
    type: "message.delta",
    payload: { messageId: "message_1", text: "uncommitted" },
  };
}
export function replay(
  events: DurableEvent[],
  after: number,
  through = events.at(-1)?.eventSeq ?? after,
): ReplayPage {
  return {
    events,
    after,
    through,
    lastEventSeq: through,
    nextAfter: events.at(-1)?.eventSeq ?? after,
    retainedFloor: 0,
    hasMore: false,
  };
}
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
