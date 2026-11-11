import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type * as Client from "fortipi-contract/client";
import type * as Executor from "fortipi-contract/executor";
import type { UploadBegin } from "../dist/index.js";
import {
  freeInfrastructurePolicy,
  incrementSafe,
  publicCommitReceipt,
  requireCapability,
  validateBrowserOrigin,
  validateChunkInventory,
  validateExecutorTransferLimits,
  validateLocalLease,
  validateManifest,
  validateProviderAuthPut,
  validateRelativePath,
  validateTransfer,
  validateUploadBlobs,
  validateWorkspaceLeaseSubject,
} from "../dist/index.js";
import {
  credential,
  hash,
  identity,
  lease,
  observation,
  prepared,
  receipt,
  resources,
  scope,
  transfer,
  validators,
} from "./fixtures/wire.ts";

const { get } = validators();
test("admin artifacts retain agent or workspace provenance without inventing workspace identity", () => {
  const agent = {
    artifactId: "export_part",
    sha256: hash,
    size: 0,
    endpoint: "/v1/admin/artifacts/export_part",
    scope: { kind: "agent", agentId: "agent_1", conversationIds: ["conversation_1"] },
  } satisfies Client.AdminArtifactReference;
  const response = {
    status: 200,
    body: { operationId: "export_1", kind: "export", state: "completed", artifacts: [agent] },
  } satisfies Client.OperationResponse<"getAdminOperation">;
  accepted("AdminArtifactReference", agent);
  accepted("AdminArtifactReference", { ...agent, scope: { ...agent.scope, conversationIds: [] } });
  accepted("AdminArtifactReference", {
    ...agent,
    scope: { kind: "workspace", workspaceId: "workspace_1", revision: "revision_1" },
  });
  accepted("AdminOperation", response.body);
  rejected("ByteReference", agent);
  for (const endpoint of [
    "/v1/workspaces/workspace_1/artifacts/export_part",
    "https://example.invalid/v1/admin/artifacts/export_part",
    "/v1/admin/artifacts/../export_part",
    "/v1/admin/artifacts/export_part?owner=other",
  ])
    rejected("AdminArtifactReference", { ...agent, endpoint });
  rejected("AdminArtifactReference", { ...agent, scope: undefined });
  rejected("AdminArtifactReference", { ...agent, size: 16777217 });
  rejected("AdminArtifactReference", { ...agent, scope: { ...agent.scope, workspaceId: "fake" } });
  rejected("AdminArtifactReference", {
    ...agent,
    scope: { ...agent.scope, conversationIds: ["conversation_1", "conversation_1"] },
  });
  rejected("AdminOperation", { ...response.body, artifacts: Array(17).fill(agent) });
});
test("native output artifacts carry actual stream provenance before a server can route bytes", () => {
  const reference = {
    workspaceId: "workspace_1",
    revision: "revision_1",
    artifactId: "artifact_1",
    sha256: hash,
    size: 1,
    endpoint: "/v1/workspaces/workspace_1/artifacts/artifact_1?revision=revision_1",
    owner: { kind: "local", executorId: "executor_1" },
    chunks: { chunkBytes: 1, chunkHashes: [hash] },
    outputSource: { stream: "stdout" },
  } satisfies Client.ByteReference & Executor.ByteReference;
  const valid = get("ByteReference");
  assert.equal(valid(reference), true, JSON.stringify(valid.errors));
  assert.equal(valid({ ...reference, outputSource: { stream: "stderr" } }), true);
  for (const key of ["outputSource", "chunks"] as const) {
    const incomplete: Partial<Client.ByteReference> = { ...reference };
    delete incomplete[key];
    assert.equal(valid(incomplete), false, key);
  }
  assert.equal(valid({ ...reference, owner: { kind: "local" } }), false);
  assert.equal(valid({ ...reference, outputSource: { stream: "combined" } }), false);
  assert.equal(valid({ ...reference, outputSource: { stream: "stdout", offset: 0 } }), false);
  assert.equal(valid({ ...reference, owner: { kind: "cloud" } }), false);
  const { outputSource: _source, artifactId: _artifact, chunks: _chunks, ...file } = reference;
  assert.equal(valid(file), true, "ordinary local file references need no output provenance");
  assert.equal(valid({ ...file, artifactId: "cloud_1", owner: { kind: "cloud" } }), true);
  assert.equal(valid({ ...file, outputSource: { stream: "stdout" } }), false);
});
test("local upload and read metadata announce complete chunk grids before any bytes", () => {
  const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const bytes = Buffer.concat([Buffer.alloc(262144, 65), Buffer.from("tail")]);
  const sha256 = digest(bytes);
  const chunks = {
    chunkBytes: 262144,
    chunkHashes: [digest(bytes.subarray(0, 262144)), digest(bytes.subarray(262144))],
  } satisfies Client.ChunkInventory & Executor.ChunkInventory;
  const plan = { sha256, chunks } satisfies Client.UploadBlobPlan & Executor.UploadBlobPlan;
  const empty = digest(Buffer.alloc(0));
  const removedBytes = Buffer.from("superseded");
  const removed = digest(removedBytes);
  const input = {
    requestId: "request_1",
    operationId: lease.operationId,
    commitId: "commit_1",
    baseRevision: lease.baseRevision,
    lease,
    manifestHash: hash,
    manifest: {
      version: 1,
      entries: [
        { path: "large.bin", type: "file", mode: 420, size: bytes.length, sha256 },
        { path: "empty.txt", type: "file", mode: 420, size: 0, sha256: empty },
      ],
    },
    mutations: [
      { kind: "put", path: "removed.txt", mode: 420, size: removedBytes.length, sha256: removed },
      { kind: "delete", path: "removed.txt" },
      { kind: "put", path: "large.bin", mode: 420, size: bytes.length, sha256 },
      { kind: "put", path: "copy.bin", mode: 420, size: bytes.length, sha256 },
      { kind: "delete", path: "copy.bin" },
      { kind: "put", path: "empty.txt", mode: 420, size: 0, sha256: empty },
    ],
    blobs: [
      plan,
      { sha256: removed, chunks: { chunkBytes: 262144, chunkHashes: [removed] } },
      { sha256: empty, chunks: { chunkBytes: 262144, chunkHashes: [] } },
    ],
  } satisfies UploadBegin & Client.UploadBegin & Executor.UploadBegin;
  accepted("UploadBegin", input);
  validateUploadBlobs(input, { required: true });
  const reference = {
    workspaceId: "workspace_1",
    revision: "revision_1",
    sha256,
    size: bytes.length,
    endpoint: "/v1/workspaces/workspace_1/read",
    owner: { kind: "local", executorId: "executor_1" },
    chunks,
  } satisfies Client.ByteReference & Executor.ByteReference;
  accepted("ByteReference", reference);
  accepted("LocalReadResult", { kind: "read", result: reference });
  validateChunkInventory(reference.chunks, reference.size);
  // A lower negotiated cap changes the announced grid, never the bytes or the final file SHA.
  const smaller = {
    chunkBytes: 131072,
    chunkHashes: [
      digest(bytes.subarray(0, 131072)),
      digest(bytes.subarray(131072, 262144)),
      digest(bytes.subarray(262144)),
    ],
  };
  accepted("ChunkInventory", smaller);
  validateChunkInventory(smaller, bytes.length);
  assert.throws(() => validateChunkInventory(chunks, 262144), /chunk_inventory/);
  assert.throws(
    () =>
      validateChunkInventory({ ...chunks, chunkHashes: chunks.chunkHashes.slice(1) }, bytes.length),
    /chunk_inventory/,
  );
  assert.throws(
    () => validateChunkInventory({ chunkBytes: 1, chunkHashes: Array(257).fill(hash) }, 257),
    /chunk_inventory/,
  );
  rejected("ChunkInventory", { ...chunks, chunkBytes: 262145 });
  rejected("ChunkInventory", { ...chunks, bytes: "forbidden" });
  rejected("UploadBlobPlan", { sha256, chunks, uploadId: "future_id" });
  const { blobs: _blobs, ...legacy } = input;
  accepted("UploadBegin", legacy);
  validateUploadBlobs(legacy, { required: false });
  assert.throws(() => validateUploadBlobs(legacy, { required: true }), /missing_blobs/);
  assert.throws(
    () => validateUploadBlobs({ ...input, blobs: input.blobs.slice(1) }, { required: true }),
    /missing_blobs/,
  );
  assert.throws(
    () =>
      validateUploadBlobs(
        { ...input, blobs: [...(input.blobs ?? []), { sha256, chunks }] },
        { required: true },
      ),
    /unexpected_blob/,
  );
  assert.throws(
    () => validateUploadBlobs({ ...input, blobs: [{ sha256: hash, chunks }] }, { required: true }),
    /unexpected_blob/,
  );
  const inconsistent = {
    ...legacy,
    mutations: [...input.mutations, { kind: "put", path: "bad.bin", mode: 420, sha256, size: 1 }],
  } satisfies UploadBegin;
  accepted("UploadBegin", inconsistent);
  assert.throws(
    () => validateUploadBlobs(inconsistent, { required: false }),
    /inconsistent_file_size/,
  );
  assert.throws(
    () => validateUploadBlobs({ ...inconsistent, blobs: input.blobs }, { required: true }),
    /inconsistent_file_size/,
  );
  validateUploadBlobs(
    { ...input, mutations: [{ kind: "delete", path: "old.txt" }], blobs: [] },
    { required: true },
  );
  const oversized = {
    ...input,
    blobs: Array.from({ length: 64 }, (_, i) => ({
      sha256: i.toString(16).padStart(64, "0"),
      chunks: { chunkBytes: 262144, chunkHashes: Array(256).fill(hash) },
    })),
  };
  assert.throws(() => validateUploadBlobs(oversized, { required: true }), /payload_too_large/);
});
test("ticket receipt carries only redacted authenticated identity with independent credential expiry", () => {
  const identity = {
    deploymentId: "deployment_1",
    principalId: "principal_1",
    role: "client" as const,
    credential,
    credentialExpiresAt: 100000,
  };
  const ticket = {
    ticket: "opaque_single_use",
    audience: "client-stream",
    expiresAt: 30000,
    identity,
  };
  for (const role of ["admin", "client", "executor"])
    for (const credentialExpiresAt of [null, 100000])
      accepted("TicketReceipt", {
        ...ticket,
        identity: { ...identity, role, credentialExpiresAt },
      });
  for (const field of [
    "deploymentId",
    "principalId",
    "role",
    "credential",
    "credentialExpiresAt",
  ]) {
    const incomplete = { ...identity };
    Reflect.deleteProperty(incomplete, field);
    rejected("TicketIdentity", incomplete);
  }
  rejected("TicketReceipt", { ...ticket, identity: undefined });
  for (const extra of [
    { grants: [] },
    { bearer: "synthetic" },
    { tokenHash: "a".repeat(64) },
    { providerSecret: "synthetic" },
    { email: "synthetic@example.test" },
    { childId: "internal_child" },
    { registrationId: "internal_registration" },
  ])
    rejected("TicketReceipt", { ...ticket, identity: { ...identity, ...extra } });
  rejected("TicketIdentity", { ...identity, credential: { ...credential, bearer: "synthetic" } });
  rejected("TicketIdentity", { ...identity, role: "operator" });
  for (const expiry of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "100000", false])
    rejected("TicketIdentity", { ...identity, credentialExpiresAt: expiry });
  accepted("TicketIdentity", { ...identity, credentialExpiresAt: Number.MAX_SAFE_INTEGER });
});
function accepted(name: string, value: unknown) {
  const validate = get(name);
  assert.equal(validate(value), true, `${name}: ${JSON.stringify(validate.errors)}`);
}
function rejected(name: string, value: unknown) {
  assert.equal(get(name)(value), false, name);
}
test("executor job transfer queries cannot select another owner, base or credential", () => {
  const query = { executionId: identity.executionId, assignmentDigest: hash, connectionEpoch: 1 };
  accepted("ExecutorJobQuery", query);
  for (const key of Object.keys(query))
    rejected("ExecutorJobQuery", { ...query, [key]: undefined });
  for (const [key, value] of Object.entries({
    revision: "other_revision",
    workspaceId: "other_workspace",
    credential,
    lease,
    token: "not_a_credential",
  }))
    rejected("ExecutorJobQuery", { ...query, [key]: value });
  for (const connectionEpoch of [0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1])
    rejected("ExecutorJobQuery", { ...query, connectionEpoch });
  const chunk = { ...query, length: 262144, sha256: hash };
  accepted("ExecutorJobChunkQuery", chunk);
  for (const key of Object.keys(chunk))
    rejected("ExecutorJobChunkQuery", { ...chunk, [key]: undefined });
  for (const length of [0, 262145, 1.5, "1"])
    rejected("ExecutorJobChunkQuery", { ...chunk, length });
  rejected("ExecutorJobChunkQuery", { ...chunk, revision: "other_revision" });
});
test("concrete provider, backend and authority configurations", () => {
  for (const c of [
    { kind: "computer" },
    { kind: "local", executorId: "executor_1", rootBindingId: "root_1" },
  ])
    accepted("WorkspaceConfig", c);
  for (const c of [
    {
      kind: "cloud-js",
      backendId: "js",
      modules: ["node:path"],
      egress: ["https://example.test"],
      onInterrupt: "fail",
    },
    {
      kind: "linux",
      backendId: "linux",
      host: "host_1",
      imageDigest: `sha256:${hash}`,
      runtime: { cpuMs: 1000, memoryBytes: 67108864, timeoutMs: 30000 },
    },
    { kind: "native", executorId: "executor_1", trust: "host" },
  ])
    accepted("BackendConfig", c);
  accepted("ModelConfig", {
    providerId: "openai",
    modelId: "selected",
    auth: { kind: "secretRef", secretRef: "OPENAI_API_KEY" },
  });
  accepted("ModelConfig", {
    providerId: "anthropic",
    modelId: "selected",
    auth: { kind: "oauth", providerId: "anthropic" },
  });
  rejected("BackendConfig", { kind: "native", executorId: "executor_1" });
  accepted("InfrastructurePolicy", freeInfrastructurePolicy);
  rejected("InfrastructurePolicy", {
    ...freeInfrastructurePolicy,
    bounds: { ...freeInfrastructurePolicy.bounds, transferConcurrency: 5 },
  });
  assert.equal(requireCapability(freeInfrastructurePolicy, "loader", "deployment_1"), false);
  const paid = {
    ...freeInfrastructurePolicy,
    accountPlan: "paid" as const,
    profile: "verified" as const,
    capabilities: [
      {
        capability: "loader" as const,
        state: "available" as const,
        accountPlan: "paid" as const,
        deploymentId: "deployment_1",
        observedAt: 1,
      },
    ],
  };
  assert.equal(requireCapability(paid, "loader", "deployment_1"), true);
  assert.equal(requireCapability(paid, "containers", "deployment_1"), false);
});
test("tickets, generic floors and OAuth redaction/CAS", () => {
  for (const audience of ["client-stream", "executor-session"])
    accepted("TicketInput", {
      requestId: "request_1",
      audience,
      resources,
      originMode: { kind: "native" },
      ttlMs: 60000,
      ...(audience === "executor-session"
        ? { executor: { executorId: "executor_1", generation: 4 } }
        : {}),
    });
  rejected("TicketInput", {
    requestId: "request_1",
    audience: "client-stream",
    resources,
    originMode: { kind: "native" },
    executor: { executorId: "executor_1", generation: 4 },
  });
  rejected("TicketInput", {
    requestId: "request_1",
    audience: "executor-session",
    resources,
    originMode: { kind: "native" },
  });
  rejected("OriginMode", { kind: "browser", value: "null" });
  rejected("OriginMode", { kind: "browser", value: "https://example.test/path" });
  for (const origin of [
    "https://user:pass@example.test",
    "https://example.test?query",
    "https://example.test#fragment",
    "https://example.test:99999",
  ]) {
    assert.throws(() => validateBrowserOrigin(origin));
    if (!origin.endsWith(":99999")) rejected("OriginMode", { kind: "browser", value: origin });
  }
  assert.doesNotThrow(() => validateBrowserOrigin("https://example.test:8443"));
  for (const subject of [
    { kind: "credential", credentialId: "credential_1", minimumGeneration: 3 },
    { kind: "executor", executorId: "executor_1", minimumGeneration: 5 },
  ]) {
    accepted("Invalidation", { revocationId: "revoke_1", subject });
    accepted("InvalidationAck", {
      revocationId: "revoke_1",
      subject,
      recipient: { kind: "agent", id: "agent_1" },
      persistedFloor: 5,
    });
  }
  rejected("InvalidationAck", {
    revocationId: "revoke_1",
    subject: { kind: "credential", credentialId: "credential_1", minimumGeneration: 3 },
    recipient: { kind: "agent", id: "agent_1" },
  });
  accepted("ProviderAuthPut", {
    requestId: "request_1",
    expectedVersion: null,
    credential: {
      type: "oauth",
      refresh: "synthetic",
      access: "synthetic",
      expires: 100,
      providerFields: { accountId: "synthetic" },
    },
  });
  rejected("ProviderAuthPut", {
    requestId: "request_1",
    expectedVersion: null,
    credential: { type: "oauth", refresh: "x".repeat(16385), access: "synthetic", expires: 100 },
  });
  rejected("ProviderAuthStatus", {
    providerId: "openai",
    version: 1,
    generation: 1,
    state: "configured",
    access: "synthetic",
  });
  accepted("ProviderAuthDelete", { requestId: "request_1", expectedVersion: 1 });
  const oauth = {
    requestId: "request_1",
    expectedVersion: null,
    credential: {
      type: "oauth" as const,
      access: "é".repeat(8192),
      refresh: "synthetic",
      expires: 1,
    },
  };
  accepted("ProviderAuthPut", oauth);
  assert.doesNotThrow(() => validateProviderAuthPut(oauth));
  assert.throws(
    () =>
      validateProviderAuthPut({
        ...oauth,
        credential: { ...oauth.credential, access: "é".repeat(8193) },
      }),
    /payload_too_large/,
  );
  assert.throws(
    () =>
      validateProviderAuthPut({
        ...oauth,
        credential: { ...oauth.credential, providerFields: { extension: "x".repeat(65536) } },
      }),
    /payload_too_large/,
  );
  for (const state of ["configured", "absent", "reauth_required"])
    accepted("ProviderAuthReceipt", { providerId: "openai", version: 2, generation: 2, state });
});
test("local states retain identity; receipts differ from transport acknowledgements", () => {
  assert.doesNotThrow(() => validateLocalLease(scope, "apply", lease.expiresAt - 1));
  for (const phase of ["prepare", "apply", "commit"] as const)
    assert.throws(() => validateLocalLease(scope, phase, lease.expiresAt), /expired_lease/);
  for (const phase of ["observe", "receipt"] as const)
    assert.doesNotThrow(() => validateLocalLease(scope, phase, lease.expiresAt + 1));
  assert.throws(
    () => validateLocalLease({ ...scope, executorGeneration: 5 }, "observe", 1),
    /lease identity/,
  );
  accepted("Lease", lease);
  rejected("Lease", { ...lease, executorGeneration: undefined });
  accepted("LocalPrepare", {
    ...scope,
    kind: "prepare",
    commitId: "commit_1",
    expectedManifestHash: hash,
    mode: {
      kind: "staged-change",
      uploadId: "upload_1",
      stagedDigest: hash,
      postManifestHash: hash,
      manifest: { version: 1, entries: [] },
      mutations: [],
    },
  });
  accepted("LocalPrepared", prepared);
  for (const state of ["prepared", "applying", "applied", "partial", "unknown", "drift"])
    accepted("LocalObservation", { ...observation, state });
  accepted("LocalReceiptAck", {
    ...scope,
    kind: "receipt",
    preparationId: "preparation_1",
    receipt,
  });
  accepted("CommitReceipt", receipt);
  rejected("CommitReceipt", { deliveryId: "delivery_1", sequence: 1, persisted: true });
  rejected("ExecutorFrame", {
    type: "job.query",
    requestId: "request_1",
    payload: { ...identity, arguments: { command: "forbidden" } },
  });
  rejected("ExecutorFrame", { type: "message.submit", requestId: "request_1", payload: {} });
  accepted("ExecutorFrame", {
    type: "workspace.request",
    requestId: "request_1",
    payload: {
      requestId: "request_1",
      correlationId: "correlation_1",
      request: { ...scope, kind: "observe", commitId: "commit_1" },
    },
  });
  rejected("LocalReadRequest", {
    kind: "read",
    operationId: "operation_1",
    workspaceId: "workspace_1",
    bindingVersion: 1,
    rootBindingId: "root_1",
    executorId: "executor_1",
    executorGeneration: 4,
    credential,
    revision: "revision_1",
    deadline: 100,
  });
});
test("only applied local observations may carry the retained complete post-manifest", () => {
  const applied = {
    ...observation,
    postManifest: { version: 1 as const, entries: [] },
  } satisfies Executor.LocalObservation;
  accepted("LocalObservation", observation); // Legacy hash-only observations remain wire-compatible.
  accepted("LocalObservation", applied);
  for (const state of ["prepared", "applying", "partial", "unknown", "drift"])
    rejected("LocalObservation", { ...applied, state });
  rejected("LocalObservation", { ...applied, postManifest: { version: 1 } });
  rejected("LocalObservation", { ...applied, postManifest: { version: 2, entries: [] } });
  rejected("LocalObservation", { ...applied, postManifestHash: undefined });
  const nonApplied: Exclude<Executor.LocalObservation, { state: "applied" }> = {
    ...observation,
    state: "unknown",
    // @ts-expect-error Incomplete or drifted operations cannot attest a post-manifest.
    postManifest: applied.postManifest,
  };
  rejected("LocalObservation", nonApplied);
});
test("explicit approval and reconciliation bind exact operations and new-job authorization", () => {
  accepted("Grant", { grantId: "grant_1", version: 3, resources });
  const operation = {
    operationId: "operation_1",
    operationDigest: hash,
    tool: "shell.exec",
    arguments: { argv: ["echo", "hello"] },
    workspaceId: "workspace_1",
    baseRevision: "revision_1",
    target: identity.target,
    trust: "host",
    capabilities: ["shell"],
    policyVersion: 1,
    grantVersion: 3,
    expiresAt: 30000,
  };
  accepted("Approval", {
    approvalId: "approval_1",
    jobId: "job_1",
    agentId: "agent_1",
    conversationId: "conversation_1",
    requestingPrincipalId: "principal_1",
    operation,
    version: 1,
    state: "pending",
  });
  rejected("ApprovalOperation", { ...operation, baseRevision: undefined });
  const pending = { identity, state: "waiting_for_local_policy", operation };
  accepted("ExecutionObservation", pending);
  accepted("ExecutorFrame", { type: "job.query_result", requestId: "query_1", payload: pending });
  rejected("ExecutionObservation", { ...pending, operation: undefined });
  rejected("ExecutionObservation", { ...pending, proof: { kind: "durable-no-late-start" } });
  rejected("ExecutionObservation", { ...pending, result: { state: "succeeded" } });
  const preparing = { ...pending, state: "preparing" };
  accepted("ExecutionObservation", preparing);
  accepted("ExecutorFrame", { type: "job.query_result", requestId: "query_2", payload: preparing });
  rejected("ExecutionObservation", { ...preparing, operation: undefined });
  rejected("ExecutionObservation", { ...preparing, backendExecutionId: "not_started_yet" });
  rejected("ExecutionObservation", { ...preparing, result: { state: "succeeded" } });
  accepted("ReconcileInput", {
    requestId: "request_1",
    expectedVersion: 4,
    reason: "Operator authorized distinct job",
    action: { kind: "new-job", newJobId: "job_2", authorizationId: "authorization_2" },
  });
  accepted("ReconcileInput", {
    requestId: "request_2",
    expectedVersion: 4,
    reason: "Allocate a fresh opaque server job identifier",
    action: { kind: "new-job", authorizationId: "authorization_3" },
  });
  rejected("ReconcileInput", {
    requestId: "request_1",
    expectedVersion: 4,
    reason: "missing authorization",
    action: { kind: "new-job", newJobId: "job_2" },
  });
  rejected("ReconcileInput", {
    requestId: "request_1",
    expectedVersion: 4,
    reason: "invent success",
    action: { kind: "accept-result" },
  });
  const completed = {
    jobId: "job_1",
    agentId: "agent_1",
    conversationId: "conversation_1",
    taskId: "task_1",
    operationDigest: hash,
    workspaceId: "workspace_1",
    baseRevision: "revision_1",
    state: "completed",
    version: 6,
  };
  rejected("Job", completed);
  accepted("Job", { ...completed, evidence: { kind: "committed", receipt } });
});
test("permanent store lifecycle and exact bounded relay descriptors", () => {
  const allocation = {
    allocationId: "allocation_1",
    childId: "child_1",
    authorityId: "authority_1",
    workspaceId: "workspace_1",
    role: "revision-store",
    uploadId: "upload_1",
    baseRevision: "revision_1",
    generation: 1,
    operationDigest: hash,
    capacityReservationId: "capacity_1",
    reservedBytes: 10,
    deadline: 100,
  };
  accepted("StoreAllocation", allocation);
  for (const state of ["allocated", "writable", "sealed", "retiring", "deleted"])
    accepted("StoreState", {
      allocation,
      source: "registry",
      version: 1,
      state,
      ...(state === "sealed" ? { manifestHash: hash } : {}),
      ...(["retiring", "deleted"].includes(state) ? { tombstoneId: "tombstone_1" } : {}),
    });
  rejected("StoreAllocation", { ...allocation, role: "scratch" });
  rejected("StoreState", { allocation, source: "registry", version: 1, state: "deleted" });
  rejected("StoreAllocation", { ...allocation, role: "authority" });
  rejected("StoreRetirement", {
    allocationId: "allocation_1",
    childId: "child_1",
    authorityId: "authority_1",
    workspaceId: "workspace_1",
  });
  accepted("TransferDescriptor", transfer);
  rejected("TransferDescriptor", { ...transfer, direction: "to-executor" });
  assert.doesNotThrow(() => validateTransfer(transfer, 100));
  for (const d of [
    { ...transfer, chunkHashes: [] },
    { ...transfer, consumer: { ...resources, workspaceIds: [] } },
    { ...transfer, expiresAt: 100 },
  ])
    assert.throws(() => validateTransfer(d, 100));
  assert.throws(() => validateTransfer(transfer, transfer.expiresAt));
  const stage = {
    ...transfer,
    direction: "to-executor" as const,
    purpose: "local-stage" as const,
    jobId: identity.jobId,
    executionId: identity.executionId,
    lease,
    content: { ...transfer.content, uploadId: "upload_1" },
  };
  accepted("TransferDescriptor", stage);
  assert.doesNotThrow(() => validateTransfer(stage, 100));
  for (const changed of [
    { ...stage, lease: { ...lease, workspaceId: "different_workspace" } },
    { ...stage, lease: { ...lease, executorGeneration: 5 } },
    { ...stage, lease: { ...lease, jobId: "different_job" } },
    { ...stage, consumer: { ...resources, executorIds: [] } },
  ])
    assert.throws(() => validateTransfer(changed, 100));
  rejected("TransferChunkQuery", { attemptId: "attempt_1", length: 262145, sha256: hash });
  accepted("TransferChunkQuery", { attemptId: "attempt_1", length: 262144, sha256: hash });
  rejected("TransferQuery", {});
  rejected("TransferChunkQuery", { attemptId: "attempt_1", length: 3, sha256: "bad" });
});
test("public commits use only authority-issued opaque stages", () => {
  const commit = {
    requestId: "request_1",
    stageId: "stage_1",
    commitId: "commit_1",
    uploadId: "upload_1",
    operationId: lease.operationId,
    jobId: lease.jobId,
    workspaceId: lease.workspaceId,
    lease,
    manifestHash: hash,
    baseRevision: lease.baseRevision,
  };
  accepted("UploadCommit", commit);
  rejected("UploadCommit", { ...commit, storeRef: { childId: "caller_chosen_child" } });
  rejected("UploadCommit", { ...commit, stageId: undefined });
  accepted("WorkspaceTransaction", { requestId: "request_1", commit, mutations: [] });
  const seal = {
    stageId: "stage_1",
    allocationId: "allocation_1",
    childId: "child_1",
    authorityId: "authority_1",
    workspaceId: lease.workspaceId,
    uploadId: "upload_1",
    manifestHash: hash,
    sealedAt: 15000,
  };
  accepted("SealedStore", seal);
  const { preparationId: _preparation, observationSeq: _observation, ...common } = receipt;
  const privateReceipt = { ...common, providerKind: "computer" as const, storeRef: seal };
  rejected("CommitReceipt", privateReceipt);
  const publicReceipt = publicCommitReceipt(privateReceipt);
  accepted("CommitReceipt", publicReceipt);
  assert.deepEqual(publicReceipt, {
    ...common,
    providerKind: "computer",
    storeRef: { stageId: "stage_1" },
  });
  assert.equal(JSON.stringify(publicReceipt).includes("child_1"), false);
  accepted("RevocationComplete", {
    operationId: "operation_1",
    revocationId: "revocation_1",
    state: "complete",
    pendingRecipients: [],
  });
  rejected("RevocationComplete", {
    operationId: "operation_1",
    revocationId: "revocation_1",
    state: "pending",
    pendingRecipients: [],
  });
  rejected("RevocationReceipt", {
    operationId: "operation_1",
    revocationId: "revocation_1",
    state: "complete",
    pendingRecipients: [{ kind: "agent", id: "agent_1" }],
  });
});
test("path aliases, exclusions and overflow fail closed", () => {
  for (const path of [
    "../private",
    "/etc/passwd",
    "a\\b",
    "C:secret",
    "foo/.FoRtIpI/x",
    ".ENV.local",
    "a/AUTH.json",
    "a/id.PEM",
    "a/CON.txt",
    "a/COM¹.txt",
    "a/LPT²",
    "a/with?wildcard",
    "a/with*wildcard",
    "a/with|pipe",
    "a/with<angle",
    'a/with"quote',
    "trailing.",
    "a//b",
    "e\u0301.txt",
  ]) {
    assert.throws(() => validateRelativePath(path), path);
    if (path !== "e\u0301.txt") rejected("RelativePath", path);
  }
  assert.doesNotThrow(() => validateRelativePath("src/main.ts"));
  assert.throws(() =>
    validateManifest(
      {
        version: 1,
        entries: [
          { path: "A", type: "directory", mode: 493 },
          { path: "a", type: "directory", mode: 493 },
        ],
      },
      "insensitive",
    ),
  );
  for (const entries of [
    [
      { path: "A", type: "directory" as const, mode: 493 as const },
      { path: "a/child", type: "directory" as const, mode: 493 as const },
    ],
    [
      { path: "A/one", type: "directory" as const, mode: 493 as const },
      { path: "a/two", type: "directory" as const, mode: 493 as const },
    ],
  ])
    assert.throws(() => validateManifest({ version: 1, entries }, "insensitive"), /collision/);
  accepted("Sequence", Number.MAX_SAFE_INTEGER);
  rejected("Sequence", Number.MAX_SAFE_INTEGER + 1);
  assert.throws(() => incrementSafe(Number.MAX_SAFE_INTEGER));
  accepted("PageQuery", { limit: 100 });
  rejected("PageQuery", { limit: 101 });
  accepted("ManifestEntry", {
    path: "large",
    type: "file",
    mode: 420,
    size: 67108864,
    sha256: hash,
  });
  rejected("ManifestEntry", {
    path: "large",
    type: "file",
    mode: 420,
    size: 67108865,
    sha256: hash,
  });
});
test("semantic errors require redacted conflicts, quota pressure and bounded retry details", () => {
  const base = { message: "redacted", requestId: "request_1", retryable: true };
  rejected("ErrorBody", { error: { ...base, code: "unavailable" } });
  accepted("ErrorBody", {
    error: { ...base, code: "unavailable", details: { retryAfterMs: 30000 } },
  });
  rejected("ErrorBody", {
    error: { ...base, code: "rate_limited", details: { retryAfterMs: 86400001 } },
  });
  rejected("ErrorBody", { error: { ...base, code: "workspace.conflict" } });
  accepted("ErrorBody", {
    error: { ...base, code: "workspace.conflict", details: { reason: "local_drift" } },
  });
  rejected("ErrorBody", {
    error: { ...base, code: "quota_paused", details: { retryAfterMs: 30000 } },
  });
  accepted("ErrorBody", {
    error: {
      ...base,
      code: "quota_paused",
      details: {
        retryAfterMs: 30000,
        pressure: {
          resource: "storage",
          scope: { kind: "object", id: "workspace_1" },
          source: "policy",
          measurement: "estimated",
          reason: "capacity held",
          action: "reclaim-storage",
        },
      },
    },
  });
});
test("credential issuance returns a token once and retry/rotation receipts forbid recovery", () => {
  const metadata = { credential, role: "client", expiresAt: 100000 };
  accepted("CredentialReceipt", { ...metadata, state: "issued", token: "synthetic_once" });
  accepted("CredentialReceipt", { ...metadata, state: "already-issued" });
  rejected("CredentialReceipt", { ...metadata, state: "issued" });
  rejected("CredentialReceipt", {
    ...metadata,
    state: "already-issued",
    token: "synthetic_forbidden",
  });
  rejected("CredentialReceipt", { ...metadata, token: "synthetic_legacy" });
  rejected("CredentialReceipt", { ...metadata, state: "already-issued", tokenHash: hash });
  const revocation = {
    operationId: "operation_1",
    revocationId: "revoke_1",
    state: "complete",
    pendingRecipients: [],
  };
  for (const replacement of [
    { ...metadata, state: "issued", token: "synthetic_once" },
    { ...metadata, state: "already-issued" },
  ])
    accepted("RotationReceipt", { replacement, revocation });
  rejected("RotationReceipt", {
    replacement: { ...metadata, state: "already-issued", token: "synthetic_forbidden" },
    revocation,
  });
});
test("public workspace leases exclude jobs and server metadata and correlate path subjects", () => {
  const acquire = {
    requestId: "acquire-business-1",
    operationId: "workspace_operation_1",
    bindingVersion: 1,
    baseRevision: "revision_1",
    deadline: 50000,
  };
  accepted("WorkspaceLeaseAcquire", acquire);
  for (const field of ["requestId", "operationId", "bindingVersion", "baseRevision", "deadline"]) {
    const incomplete = { ...acquire };
    Reflect.deleteProperty(incomplete, field);
    rejected("WorkspaceLeaseAcquire", incomplete);
  }
  for (const extra of [
    { credential },
    { target: identity.target },
    { executorId: "executor_1" },
    { fence: "1" },
    { expiresAt: 30000 },
    { leaseId: "chosen-by-client" },
    { registrationId: "internal" },
    { principalId: "forged-subject" },
    { agentId: "invented" },
    { conversationId: "invented" },
    { jobId: "invented" },
  ])
    rejected("WorkspaceLeaseAcquire", { ...acquire, ...extra });
  const { jobId: _job, ...commonLease } = lease;
  const nonjob = { ...commonLease, ownerKind: "workspace-operation" as const };
  accepted("WorkspaceOperationLease", nonjob);
  rejected("WorkspaceOperationLease", lease);
  rejected("WorkspaceOperationLease", { ...nonjob, jobId: "invented" });
  const path = { workspaceId: nonjob.workspaceId, leaseId: nonjob.leaseId };
  assert.doesNotThrow(() => validateWorkspaceLeaseSubject(path, nonjob));
  assert.throws(
    () => validateWorkspaceLeaseSubject({ ...path, workspaceId: "other_workspace" }, nonjob),
    /lease identity/,
  );
  assert.throws(
    () => validateWorkspaceLeaseSubject({ ...path, leaseId: "other_lease" }, nonjob),
    /lease identity/,
  );
  assert.throws(() => validateWorkspaceLeaseSubject(path, lease), /lease identity/);
  accepted("WorkspaceLeaseRenew", { requestId: "renew-business-1", lease: nonjob });
  rejected("WorkspaceLeaseRenew", { requestId: "renew-business-1", lease });
  rejected("WorkspaceLeaseRenew", {
    requestId: "renew-business-1",
    lease: nonjob,
    expiresAt: 40000,
  });
  rejected("WorkspaceLeaseRenew", { lease: nonjob });
  for (const reason of ["completed", "cancelled"])
    accepted("WorkspaceLeaseRelease", { requestId: "release-business-1", lease: nonjob, reason });
  for (const reason of ["expired", "reconciled"])
    rejected("WorkspaceLeaseRelease", { requestId: "release-business-1", lease: nonjob, reason });
  rejected("WorkspaceLeaseRelease", {
    requestId: "release-business-1",
    lease,
    reason: "completed",
  });
  for (const released of [true, false])
    accepted("WorkspaceLeaseReleaseReceipt", { leaseId: nonjob.leaseId, released });
  rejected("WorkspaceLeaseReleaseReceipt", {
    leaseId: nonjob.leaseId,
    released: true,
    tombstoneId: "internal",
  });
});
test("executor numeric transfer limits are required closed registration observations", () => {
  const limits = {
    chunkBytes: 16384,
    fileBytes: 4194304,
    snapshotBytes: 16777216,
    artifactBytes: 1048576,
    manifestEntries: 512,
  };
  const maxima = {
    chunkBytes: 262144,
    fileBytes: 67108864,
    snapshotBytes: 268435456,
    artifactBytes: 16777216,
    manifestEntries: 4096,
  };
  for (const valid of [limits, maxima]) {
    accepted("ExecutorTransferLimits", valid);
    assert.doesNotThrow(() => validateExecutorTransferLimits(valid));
  }
  for (const field of [
    "chunkBytes",
    "fileBytes",
    "snapshotBytes",
    "artifactBytes",
    "manifestEntries",
  ] as const) {
    const missing = { ...limits };
    Reflect.deleteProperty(missing, field);
    rejected("ExecutorTransferLimits", missing);
    for (const value of [0, -1, 0.5, maxima[field] + 1])
      rejected("ExecutorTransferLimits", { ...limits, [field]: value });
  }
  for (const extra of [{ stageBytes: 1 }, { remainingBytes: 1 }, { headroomFraction: 0.25 }])
    rejected("ExecutorTransferLimits", { ...limits, ...extra });
  for (const incompatible of [
    { ...limits, fileBytes: 4194305 },
    { ...limits, artifactBytes: 4194305 },
  ]) {
    accepted("ExecutorTransferLimits", incompatible);
    assert.throws(() => validateExecutorTransferLimits(incompatible), /executor transfer grid/);
  }
  const payload = {
    executorId: "executor_1",
    generation: 4,
    protocolVersion: "1.0",
    schemaVersion: "1.0.0",
    capabilities: ["workspace"],
    platform: "linux",
    caseBehavior: "sensitive",
    rootBindingIds: ["root_1"],
    confinement: "host",
    transferLimits: limits,
  };
  accepted("ExecutorFrame", { type: "executor.register", requestId: "request_1", payload });
  rejected("ExecutorFrame", {
    type: "executor.register",
    requestId: "request_1",
    payload: { ...payload, transferLimits: undefined },
  });
  const { protocolVersion: _protocol, schemaVersion: _schema, ...description } = payload;
  accepted("ExecutorDescription", { ...description, connectionEpoch: 1, state: "online" });
  rejected("ExecutorDescription", {
    ...description,
    connectionEpoch: 1,
    state: "online",
    transferLimits: null,
  });
});
