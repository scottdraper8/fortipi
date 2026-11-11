import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AnySchema, ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
export const schemaDirectory = fileURLToPath(new URL("../../schemas/", import.meta.url));
export function validators(directory = schemaDirectory) {
  const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: false });
  for (const file of readdirSync(directory)
    .filter((f) => f.endsWith(".schema.json"))
    .sort())
    ajv.addSchema(JSON.parse(readFileSync(`${directory}/${file}`, "utf8")) as AnySchema);
  return {
    ajv,
    get(name: string): ValidateFunction {
      const definitions = Object.values(ajv.schemas)
        .map((s) => s?.schema)
        .filter((s) => s && typeof s === "object");
      for (const s of definitions) {
        if (
          typeof s === "object" &&
          s &&
          "$defs" in s &&
          (s.$defs as Record<string, unknown>)[name]
        )
          return ajv.compile({ $ref: `${s.$id}#/$defs/${name}` });
      }
      throw new Error(`Missing schema ${name}`);
    },
  };
}
export const hash = "a".repeat(64);
export const credential = { credentialId: "credential_1", generation: 2, grantVersion: 3 };
export const resources = {
  agentIds: ["agent_1"],
  conversationIds: ["conversation_1"],
  workspaceIds: ["workspace_1"],
  actions: ["workspace.read", "workspace.write"],
  tools: ["shell.exec"],
  executorIds: ["executor_1"],
  backendIds: ["backend_1"],
};
export const lease = {
  leaseId: "lease_1",
  operationId: "operation_1",
  ownerKind: "job" as const,
  jobId: "job_1",
  credential,
  registrationId: "registration_1",
  leaseVersion: 1,
  workspaceId: "workspace_1",
  executorId: "executor_1",
  executorGeneration: 4,
  fence: "7",
  baseRevision: "revision_1",
  expiresAt: 30000,
};
export const identity = {
  jobId: "job_1",
  executionId: "execution_1",
  operationDigest: hash,
  assignmentDigest: hash,
  target: { kind: "executor" as const, executorId: "executor_1", generation: 4 },
  lease,
  baseRevision: "revision_1",
  deadline: 50000,
};
export const scope = {
  operationId: "operation_1",
  operationDigest: hash,
  workspaceId: "workspace_1",
  bindingVersion: 1,
  rootBindingId: "root_1",
  executorId: "executor_1",
  executorGeneration: 4,
  credential,
  baseRevision: "revision_1",
  lease,
  deadline: 50000,
};
export const prepared = {
  preparationId: "preparation_1",
  operationId: "operation_1",
  operationDigest: hash,
  preManifestHash: hash,
  expiresAt: 20000,
  state: "prepared" as const,
};
export const observation = {
  operationId: "operation_1",
  operationDigest: hash,
  preparationId: "preparation_1",
  commitId: "commit_1",
  observationSeq: 1,
  preManifestHash: hash,
  postManifestHash: hash,
  appliedAt: 15000,
  state: "applied" as const,
};
export const transfer = {
  transferId: "transfer_1",
  attemptId: "attempt_1",
  deploymentId: "deployment_1",
  direction: "from-executor" as const,
  purpose: "local-read" as const,
  workspaceId: "workspace_1",
  bindingVersion: 1,
  operationId: "operation_1",
  operationDigest: hash,
  executorId: "executor_1",
  executorGeneration: 4,
  credential,
  consumer: resources,
  baseRevision: "revision_1",
  content: { kind: "workspace-file" as const, path: "src/main.ts", manifestHash: hash },
  fileSha256: hash,
  size: 3,
  chunkBytes: 3,
  chunkHashes: [hash],
  expiresAt: 20000,
  deadline: 50000,
};
export const receipt = {
  commitId: "commit_1",
  jobId: "job_1",
  operationId: "operation_1",
  workspaceId: "workspace_1",
  commitDigest: hash,
  baseRevision: "revision_1",
  revision: "revision_2",
  manifestHash: hash,
  sourceFactId: "fact_1",
  committedAt: 16000,
  providerKind: "local" as const,
  preparationId: "preparation_1",
  observationSeq: 1,
};
export const eventBase = {
  protocolVersion: "1.0" as const,
  schemaVersion: "1.0.0" as const,
  deploymentId: "deployment_1",
  conversationId: "conversation_1",
  eventId: "event_1",
  timestamp: 1,
};
export const unknownDurable = {
  ...eventBase,
  durability: "durable" as const,
  eventSeq: 1,
  type: "future.semantic.event",
  payload: { accepted: true },
};
export const messageEvent = {
  ...eventBase,
  durability: "durable" as const,
  eventSeq: 1,
  type: "message.completed" as const,
  payload: { messageId: "message_1", role: "assistant" as const, content: "done", timestamp: 1 },
};
