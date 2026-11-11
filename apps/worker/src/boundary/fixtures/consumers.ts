/** Compile-only consumers. No fake implementation or claim of runtime persistence. */

import type { Models } from "@earendil-works/pi-ai/models";
import type { AgentSessionRpc } from "../agent-session.js";
import type { ControlPlaneRpc } from "../control-plane.js";
import type * as D from "../dto.js";
import type {
  AgentSessionObject,
  ControlPlaneObject,
  Env,
  ExecutionBackendFactory,
  FactoryDependencies,
  ModelsFactory,
  WorkspaceObject,
  WorkspaceProviderFactory,
} from "../env.js";
import type { ExecutionBackend } from "../execution-backend.js";
import type { JobStore } from "../job-store.js";
import type { WorkspaceObjectRpc } from "../workspace-object.js";

function value<T>(outcome: D.Outcome<T>): T {
  if (!outcome.ok) throw new Error(outcome.code);
  return outcome.value;
}
const hash = "a".repeat(64);
const credential = { credentialId: "credential_1", generation: 2, grantVersion: 3 };
const resources: D.ResourceScope = {
  agentIds: ["agent_1"],
  conversationIds: ["conversation_1"],
  workspaceIds: ["workspace_1"],
  actions: ["workspace.read", "workspace.write"],
  tools: ["shell.exec"],
  executorIds: ["executor_1"],
  backendIds: ["backend_1"],
};
const target: D.BackendRef = { kind: "executor", executorId: "executor_1", generation: 4 };
const lease: D.Lease = {
  leaseId: "lease_1",
  operationId: "operation_1",
  ownerKind: "job",
  jobId: "job_1",
  credential,
  registrationId: "workspace_registration",
  leaseVersion: 1,
  workspaceId: "workspace_1",
  executorId: "executor_1",
  executorGeneration: 4,
  fence: "7",
  baseRevision: "revision_1",
  expiresAt: 30000,
};
const identity: D.ExecutionIdentity = {
  jobId: "job_1",
  executionId: "execution_1",
  operationDigest: hash,
  assignmentDigest: hash,
  target,
  lease,
  baseRevision: "revision_1",
  deadline: 50000,
};
const event: D.EventDraft = {
  protocolVersion: "1.0",
  schemaVersion: "1.0.0",
  deploymentId: "deployment_1",
  conversationId: "conversation_1",
  durability: "durable",
  type: "job.state.changed",
  payload: {
    jobId: "job_1",
    agentId: "agent_1",
    conversationId: "conversation_1",
    taskId: "task_1",
    operationDigest: hash,
    workspaceId: "workspace_1",
    baseRevision: "revision_1",
    state: "created",
    version: 0,
  },
};
export async function executionFlow(
  cp: ControlPlaneRpc,
  workspace: WorkspaceObjectRpc,
  agent: AgentSessionRpc,
  jobs: JobStore,
  ctx: D.AuthContext,
) {
  const registration = value(
    await cp.registerAuthorityRecipient(ctx, {
      credential,
      recipient: { kind: "workspace", id: "workspace_1" },
      resources,
      executor: { executorId: "executor_1", generation: 4 },
    }),
  );
  const registered = { ...ctx, registrationId: registration.registrationId };
  const reservation = value(
    await cp.reserveTarget(registered, {
      jobId: "job_1",
      operationDigest: hash,
      agentId: "agent_1",
      conversationId: "conversation_1",
      workspaceId: "workspace_1",
      bindingVersion: 1,
      target,
      actions: ["workspace.write"],
      deadline: 50000,
      expiresAt: 30000,
    }),
  );
  const acquired = value(await workspace.acquireLease(registered, reservation));
  const actualIdentity = { ...identity, lease: acquired };
  const assignment: D.Assignment = {
    identity: actualIdentity,
    reservationId: reservation.reservationId,
    tool: "shell.exec",
    arguments: { argv: ["echo", "hello"] },
    workspaceId: "workspace_1",
    bindingVersion: 1,
    rootBindingId: "root_1",
  };
  await cp.recordDispatchIntent(registered, { reservation, assignment, expectedJobVersion: 3 });
  await cp.assignOnce(registered, assignment);
  await cp.queryExecution(registered, actualIdentity);
  const result = value(await workspace.collectResult(registered, actualIdentity));
  await jobs.savePreparedResult(registered, {
    identity: actualIdentity,
    sequence: 1,
    result,
    deliveryId: "delivery_1",
  });
  const upload = await workspace.beginUpload(registered, {
    operationId: "beginUpload",
    path: { workspaceId: "workspace_1" },
    query: {},
    body: {
      requestId: "request_1",
      baseRevision: "revision_1",
      lease: acquired,
      operationId: "operation_1",
      commitId: "commit_1",
      manifestHash: hash,
      manifest: { version: 1, entries: [] },
      mutations: [],
    },
  });
  void upload;
  await workspace.validateUpload(registered, {
    operationId: "validateUpload",
    path: { workspaceId: "workspace_1", uploadId: "upload_1" },
    query: {},
    body: undefined,
  });
  const store = value(
    await workspace.sealStore(registered, {
      allocationId: "allocation_1",
      childId: "child_1",
      authorityId: "authority_1",
      workspaceId: "workspace_1",
      uploadId: "upload_1",
      manifestHash: hash,
      expectedVersion: 1,
    }),
  );
  const receipt = value(
    await workspace.commit(registered, {
      commitId: "commit_1",
      uploadId: "upload_1",
      operationId: "operation_1",
      jobId: "job_1",
      workspaceId: "workspace_1",
      commitDigest: hash,
      lease: acquired,
      manifestHash: hash,
      baseRevision: "revision_1",
      providerKind: "computer",
      storeRef: store,
    }),
  );
  const recovered = value(
    await workspace.getReceipt(registered, {
      workspaceId: "workspace_1",
      commitId: receipt.commitId,
      commitDigest: receipt.commitDigest,
    }),
  );
  const facts = value(
    await workspace.pageFacts(registered, {
      recipient: { kind: "agent", id: "agent_1" },
      limit: 100,
    }),
  );
  const fact = facts.items[0];
  if (fact) {
    const ack = value(
      await agent.ingestFacts(
        {
          kind: "fact-delivery",
          deploymentId: ctx.deploymentId,
          source: { kind: "workspace", id: "workspace_1" },
          recipient: { kind: "agent", id: "agent_1" },
          actions: ["ingest-facts"],
          deadline: 30000,
        },
        { facts: [fact], recipient: { kind: "agent", id: "agent_1" } },
      ),
    );
    await workspace.ackFacts(registered, {
      factId: ack.factId,
      recipient: ack.recipient,
      eventId: "event_1",
      eventSeq: 1,
    });
  }
  await jobs.finalize(registered, {
    jobId: "job_1",
    expectedVersion: 5,
    expectedState: "result_pending_commit",
    state: "completed",
    evidence: { kind: "committed", receipt: recovered },
    event,
  });
  // @ts-expect-error Final success requires receipt or unchanged-base evidence.
  await jobs.finalize(registered, {
    jobId: "job_1",
    expectedVersion: 5,
    expectedState: "result_pending_commit",
    state: "completed",
    event,
  });
  // @ts-expect-error Query cannot authorize a new assignment.
  await cp.queryExecution(registered, assignment);
  // @ts-expect-error A query identity cannot include tool arguments authorizing a new start.
  await cp.queryExecution(registered, { ...identity, arguments: { command: "do not start" } });
  // @ts-expect-error Complete execution identity requires a base revision.
  await cp.queryExecution(registered, {
    jobId: "job_1",
    executionId: "execution_1",
    operationDigest: hash,
    assignmentDigest: hash,
    target,
    lease,
    deadline: 50000,
  });
  await cp.reserveTarget(registered, {
    jobId: "job_1",
    operationDigest: hash,
    agentId: "agent_1",
    conversationId: "conversation_1",
    workspaceId: "workspace_1",
    bindingVersion: 1,
    // @ts-expect-error Target execution generation is required.
    target: { kind: "executor", executorId: "executor_1" },
    actions: [],
    deadline: 50000,
    expiresAt: 30000,
  });
}
export async function ticketAndRevocation(
  cp: ControlPlaneRpc,
  workspace: WorkspaceObjectRpc,
  agent: AgentSessionRpc,
  ctx: D.AuthContext,
) {
  const identity = value(
    await cp.consumeTicket({
      ticket: "opaque_single_use",
      deploymentId: "deployment_1",
      audience: "client-stream",
      origin: { kind: "browser", value: "https://app.example.test" },
      destination: { kind: "agent", id: "agent_1" },
    }),
  );
  void identity.registrationId;
  for (const subject of [
    { kind: "credential" as const, credentialId: "credential_1", minimumGeneration: 3 },
    { kind: "executor" as const, executorId: "executor_1", minimumGeneration: 5 },
  ]) {
    const invalidation: D.Invalidation = { revocationId: "revoke_1", subject };
    const recovery: D.RecoveryContext = {
      kind: "control-recovery",
      deploymentId: "deployment_1",
      revocationId: "revoke_1",
      recipient: { kind: "workspace", id: "workspace_1" },
      actions: ["invalidate"],
      deadline: 30000,
    };
    const ack = value(await workspace.invalidateGeneration(recovery, invalidation));
    void ack.persistedFloor;
    await agent.invalidateGeneration(
      { ...recovery, recipient: { kind: "agent", id: "agent_1" } },
      invalidation,
    );
  }
  // @ts-expect-error Redemption authenticates solely by ticket, not an AuthContext argument.
  await cp.consumeTicket(ctx, { ticket: "opaque_single_use" });
  // @ts-expect-error A revoked user is not internal recovery authority.
  await workspace.invalidateGeneration(ctx, {
    revocationId: "revoke_1",
    subject: { kind: "executor", executorId: "executor_1", minimumGeneration: 5 },
  });
}
export async function localFlow(
  cp: ControlPlaneRpc,
  workspace: WorkspaceObjectRpc,
  ctx: D.AuthContext,
) {
  const scope: D.LocalScope = {
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
  const preparation: D.LocalPrepared = {
    preparationId: "preparation_1",
    operationId: "operation_1",
    operationDigest: hash,
    preManifestHash: hash,
    expiresAt: 30000,
    state: "prepared",
  };
  await cp.requestLocalWorkspace(ctx, {
    ...scope,
    kind: "prepare",
    commitId: "commit_1",
    expectedManifestHash: hash,
    mode: {
      kind: "staged-change",
      uploadId: "upload_1",
      stagedDigest: hash,
      postManifestHash: hash,
    },
  });
  const intent = value(
    await workspace.prepareLocalCommit(ctx, {
      scope,
      commitId: "commit_1",
      preparation,
      expectedPostManifestHash: hash,
    }),
  );
  await cp.requestLocalWorkspace(ctx, {
    ...scope,
    kind: "apply",
    preparationId: preparation.preparationId,
    commitId: intent.commitId,
  });
  await cp.requestLocalWorkspace(ctx, {
    ...scope,
    kind: "observe",
    preparationId: preparation.preparationId,
    commitId: intent.commitId,
  });
  const observation: D.LocalObservation = {
    operationId: "operation_1",
    operationDigest: hash,
    preparationId: preparation.preparationId,
    commitId: intent.commitId,
    observationSeq: 1,
    preManifestHash: hash,
    postManifestHash: hash,
    appliedAt: 15000,
    state: "applied",
  };
  const receipt = value(
    await workspace.commitLocal(ctx, {
      intent,
      observation,
      manifest: { version: 1, entries: [] },
    }),
  );
  await workspace.getReceipt(ctx, {
    workspaceId: "workspace_1",
    commitId: receipt.commitId,
    commitDigest: receipt.commitDigest,
  });
  await cp.requestLocalWorkspace(ctx, {
    ...scope,
    kind: "receipt",
    preparationId: preparation.preparationId,
    receipt,
  });
  const descriptor = value(
    await cp.openTransfer(ctx, {
      deploymentId: "deployment_1",
      direction: "from-executor",
      purpose: "local-read",
      workspaceId: "workspace_1",
      bindingVersion: 1,
      operationId: "operation_1",
      operationDigest: hash,
      executorId: "executor_1",
      executorGeneration: 4,
      credential,
      consumer: resources,
      baseRevision: "revision_1",
      content: { kind: "workspace-file", path: "src/main.ts", manifestHash: hash },
      fileSha256: hash,
      size: 3,
      chunkBytes: 3,
      chunkHashes: [hash],
      expiresAt: 20000,
      deadline: 50000,
    }),
  );
  await cp.observeTransfer(ctx, {
    transferId: descriptor.transferId,
    attemptId: descriptor.attemptId,
  });
  await cp.requestLocalWorkspace(ctx, {
    kind: "read",
    operationId: "read_1",
    workspaceId: "workspace_1",
    bindingVersion: 1,
    rootBindingId: "root_1",
    executorId: "executor_1",
    executorGeneration: 4,
    credential,
    revision: "revision_2",
    deadline: 50000,
    path: "src/main.ts",
    transfers: [descriptor],
  });
  // @ts-expect-error Caller cannot allocate transfer identities.
  await cp.openTransfer(ctx, { ...descriptor, transferId: "caller_chosen" });
  // @ts-expect-error Mutating local request requires full root/binding/generation/lease scope.
  await cp.requestLocalWorkspace(ctx, {
    kind: "apply",
    operationId: "operation_1",
    preparationId: "preparation_1",
    commitId: "commit_1",
  });
}
export async function childLifecycle(
  authority: WorkspaceObjectRpc,
  child: WorkspaceObjectRpc,
  ctx: D.AuthContext,
) {
  const reservation = value(
    await authority.reserveCapacity(ctx, {
      operationId: "operation_1",
      ownerId: "workspace_1",
      policyVersion: 1,
      bytes: 100,
      admissionSlots: 0,
    }),
  );
  const allocation = value(
    await authority.allocateStore(ctx, {
      authorityId: "authority_1",
      workspaceId: "workspace_1",
      role: "revision-store",
      uploadId: "upload_1",
      baseRevision: "revision_1",
      generation: 1,
      operationDigest: hash,
      capacityReservationId: reservation.reservationId,
      reservedBytes: 100,
      deadline: 30000,
    }),
  );
  const registry = value(await authority.describeStore(ctx, allocation));
  void registry.source;
  await child.initializeStore(ctx, allocation);
  await child.sealStore(ctx, {
    ...allocation,
    uploadId: "upload_1",
    manifestHash: hash,
    expectedVersion: 1,
  });
  const retirement = value(await authority.retireStore(ctx, allocation));
  const cleanup = value(await child.deleteStore(ctx, retirement));
  if (cleanup.deallocated)
    await authority.settleCapacity(ctx, {
      reservationId: reservation.reservationId,
      disposition: "unused",
      observedBytes: 0,
    });
  // @ts-expect-error Deletion requires permanent authority tombstone, not a bare child lookup.
  await child.deleteStore(ctx, {
    allocationId: allocation.allocationId,
    childId: allocation.childId,
    authorityId: allocation.authorityId,
    workspaceId: allocation.workspaceId,
  });
}
export async function factories(
  env: Env,
  cp: ControlPlaneRpc,
  modelsFactory: ModelsFactory,
  workspaceFactory: WorkspaceProviderFactory,
  backendFactory: ExecutionBackendFactory,
  deps: FactoryDependencies,
  backend: ExecutionBackend,
  ctx: D.AuthContext,
) {
  const controlStub: DurableObjectStub<ControlPlaneObject> = env.CONTROL_PLANE.getByName("control");
  const workspaceStub: DurableObjectStub<WorkspaceObject> = env.WORKSPACES.getByName("authority");
  const agentStub: DurableObjectStub<AgentSessionObject> = env.AGENT_SESSIONS.getByName("agent");
  const control = controlStub;
  const workspace = workspaceStub;
  const agent = agentStub;
  const contractVersion: "1.0" = await control.contractVersion;
  void contractVersion;
  await workspace.queryExecution(ctx, identity);
  await agent.describeJob(ctx, {
    operationId: "describeJob",
    path: { id: "job_1" },
    query: {},
    body: undefined,
  });
  const models: Models = value(
    await modelsFactory(
      [
        {
          providerId: "openai",
          modelId: "selected",
          auth: { kind: "oauth", providerId: "openai" },
        },
      ],
      env,
    ),
  );
  const resolved = value(
    await cp.resolveProviderAuth(
      {
        kind: "model-resolution",
        deploymentId: "deployment_1",
        agentId: "agent_1",
        factoryId: "factory_1",
        providerId: "openai",
        modelId: "selected",
        action: "resolve-provider-auth",
        deadline: 30000,
      },
      { providerId: "openai", modelId: "selected", deadline: 30000 },
    ),
  );
  void resolved.auth;
  await workspaceFactory(
    { kind: "local", executorId: "executor_1", rootBindingId: "root_1" },
    deps,
  );
  await backendFactory(
    { kind: "cloud-js", backendId: "js_1", modules: [], egress: [], onInterrupt: "fail" },
    deps,
  );
  await backend.queryExisting(ctx, identity);
  // @ts-expect-error A raw workspace object/stub is not factory dependencies.
  await workspaceFactory({ kind: "computer" }, workspace);
  // @ts-expect-error Public credential authority cannot resolve provider secrets.
  await cp.resolveProviderAuth(ctx, { providerId: "openai", modelId: "selected", deadline: 30000 });
  return { models, control, workspace, agent };
}
