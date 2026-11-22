import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import type * as D from "../../src/boundary/dto.js";
import type { Runtime } from "./runtime.ts";

export const seed = 1010;
export const bytes: Record<"notes.txt" | "binary.bin" | "multi.bin", Uint8Array> = {
  "notes.txt": Buffer.from("old-v1\n"),
  "binary.bin": Buffer.from([0, 255, 13, 10, 128, 1]),
  "multi.bin": Buffer.from(
    Array.from({ length: 2 * 1024 * 1024 }, (_, i) => (i * 31 + seed) % 256),
  ),
};
// Independent fixture bytes and expected hashes: no product digest/manifests.
export const hashes = Object.fromEntries(
  Object.entries(bytes).map(([name, data]) => [
    name,
    createHash("sha256").update(data).digest("hex"),
  ]),
);
export async function provision(
  runtime: Runtime,
  issue?: (input: D.CredentialMint) => Promise<Extract<D.CredentialReceipt, { state: "issued" }>>,
) {
  const model = await runtime.api<D.ModelConfig>("/__integration/model");
  assert.equal(model.status, 200);
  const agent = await runtime.api<D.Agent>("/v1/agents", {
    requestId: randomUUID(),
    name: "evidence-1010",
    model: model.body,
  });
  assert.equal(agent.status, 201, "Actual public agent creation must succeed");
  const conversations = [] as D.Conversation[];
  for (let i = 0; i < 2; i++) {
    const result = await runtime.api<D.Conversation>(
      `/v1/agents/${agent.body.agentId}/conversations`,
      {
        requestId: randomUUID(),
        title: `evidence-1010-${i}`,
      },
    );
    assert.equal(result.status, 201, "Actual public conversation creation must succeed");
    conversations.push(result.body);
  }
  const input: D.CredentialMint = {
    requestId: randomUUID(),
    role: "client",
    grants: [
      {
        grantId: randomUUID(),
        version: 1,
        resources: {
          agentIds: [agent.body.agentId],
          conversationIds: conversations.map((c) => c.conversationId),
          workspaceIds: [],
          executorIds: [],
          backendIds: [],
          tools: [],
          actions: [
            "agents.list",
            "agents.read",
            "conversations.list",
            "conversations.create",
            "conversations.read",
            "conversations.fork",
            "messages.submit",
            "events.read",
            "tasks.read",
            "tasks.cancel",
            "tickets.mint",
          ],
        },
      },
    ],
  };
  if (issue)
    return {
      agent: agent.body,
      conversations,
      clientResources: input.grants[0]!.resources,
      client: await issue(input),
    };
  const receipt = await runtime.api<D.CredentialReceipt>("/v1/admin/credentials", input);
  assert.equal(
    receipt.status,
    201,
    "Synthetic client issuance must succeed through actual authority",
  );
  assert.equal(receipt.body.state, "issued");
  if (receipt.body.state !== "issued") throw new Error("Client issuance unavailable");
  return {
    agent: agent.body,
    conversations,
    clientResources: input.grants[0]!.resources,
    client: receipt.body,
  };
}
