/** Compile-only consumers. No fake implementation or claim of runtime persistence. */

import type { Models } from "@earendil-works/pi-ai/models";
import {
  assertUtf8Bytes,
  assignmentDigest,
  canonicalJson,
  incrementSafe,
  localIntentDigest,
  localStageDigest,
  manifestDigest,
  operationDigest,
  publicCommitReceipt,
  validateAssignment,
  validateExecutorTransferLimits,
  validateLocalLease,
  validateLocalStage,
  wireLimits,
  workspaceLeaseDigest,
} from "fortipi-contract";
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
import type {
  StorageSampleInput,
  WorkspaceStorageSample,
  WorkspaceStorageSampleInput,
} from "../infrastructure.js";
import type { JobStore } from "../job-store.js";
import type { WorkspaceObjectRpc } from "../workspace-object.js";

export function storageSamplePorts(lookup: D.StoreLookup): void {
  const authority: WorkspaceStorageSampleInput = {
    kind: "authority",
    sampleId: "authority_sample",
    policyVersion: 1,
  };
  const child: WorkspaceStorageSampleInput = {
    kind: "child",
    sampleId: "child_sample",
    policyVersion: 1,
    lookup,
    registryVersion: 2,
  };
  const observation: WorkspaceStorageSample = {
    kind: "child",
    sampleId: child.sampleId,
    lookup,
    registryVersion: 2,
    bytes: 4096,
    observedAt: 1000,
  };
  // @ts-expect-error A child lookup alone does not bind a registry observation.
  const unversioned: WorkspaceStorageSampleInput = { ...child, registryVersion: undefined };
  // @ts-expect-error Authority sampling cannot select a child through structural assignment.
  const redirected: WorkspaceStorageSampleInput = { ...authority, lookup, registryVersion: 2 };
  // @ts-expect-error A child response must retain its exact lookup/version pair.
  const anonymous: WorkspaceStorageSample = { ...observation, lookup: undefined };
  const incomplete = {
    sampleId: "census_sample",
    policyVersion: 1,
    sampleSeq: 1,
    observedAt: 1000,
    coverage: { kind: "workspace" as const, bytes: 4096 },
    coveredReservationIds: [],
  };
  // @ts-expect-error Workspace coverage requires a completed census identity.
  const census: StorageSampleInput = incomplete;
  void [authority, child, observation, unversioned, redirected, anonymous, census];
}

export function runtimeQuiescencePort(input: D.RuntimeQuiesceRequest): D.RuntimeQuiescence {
  const stopped: D.RuntimeQuiescence = { ...input, stopped: true, observedAt: 1000 };
  // @ts-expect-error A disconnect or pending stop is not evidence that the native runtime stopped.
  const pending: D.RuntimeQuiescence = { ...input, stopped: false, observedAt: 1000 };
  // @ts-expect-error Cleanup cannot select an unbound image or replacement runtime.
  const unbound: D.RuntimeQuiesceRequest = { requestId: input.requestId };
  void [pending, unbound];
  return stopped;
}

export async function adminExportPorts(
  agent: AgentSessionRpc,
  workspace: WorkspaceObjectRpc,
  auth: D.AuthContext,
  input: D.ExportRequest,
): Promise<void> {
  await agent.exportData(auth, { ...input, action: "exports.create" });
  const result = await workspace.exportData(auth, { ...input, action: "backups.create" });
  if (result.ok)
    for (const reference of result.value.artifacts) {
      if ("scope" in reference) {
        const admin: D.AdminArtifactReference = reference;
        void admin;
      } else {
        const legacy: D.ByteReference = reference;
        void legacy;
      }
    }
  const { action: _action, ...missingAction } = input;
  // @ts-expect-error A private producer must receive the actual initiating action.
  await agent.exportData(auth, missingAction);
}

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
  operationContext: D.OperationContext,
) {
  if (operationContext.deploymentId !== ctx.deploymentId) throw new Error("Wrong deployment");
  const credential = {
    credentialId: ctx.credentialId,
    generation: ctx.generation,
    grantVersion: ctx.grantVersion,
  };
  const operation: D.OperationDigestInput = {
    ...operationContext,
    tool: "shell.exec",
    arguments: { argv: ["echo", "hello"] },
    workspaceId: "workspace_1",
    baseRevision: "revision_1",
    target,
    grantVersion: credential.grantVersion,
    deadline: 50000,
  };
  const immutableOperationDigest = await operationDigest(operation);
  const registration = value(
    await cp.registerAuthorityRecipient(ctx, {
      credential,
      recipient: { kind: "workspace", id: "workspace_1" },
      resources: {
        ...resources,
        agentIds: [operationContext.agentId],
        conversationIds: [operationContext.conversationId],
      },
      executor: { executorId: "executor_1", generation: 4 },
    }),
  );
  const registered = { ...ctx, registrationId: registration.registrationId };
  const reservation = value(
    await cp.reserveTarget(registered, {
      ownerKind: "job",
      operationId: "operation_1",
      jobId: identity.jobId,
      executionId: identity.executionId,
      operationDigest: immutableOperationDigest,
      agentId: operationContext.agentId,
      conversationId: operationContext.conversationId,
      workspaceId: "workspace_1",
      bindingVersion: 1,
      target,
      actions: ["workspace.write"],
      deadline: 50000,
      expiresAt: 30000,
    }),
  );
  if (reservation.ownerKind !== "job") throw new Error("Expected job reservation");
  if (reservation.executionId !== identity.executionId || reservation.jobId !== identity.jobId)
    throw new Error("Reservation does not match the persisted execution identity");
  const { executionId: _executionId, ...missingExecutionId } = reservation;
  // @ts-expect-error Every job target reservation requires the pre-persisted execution identity.
  await cp.reserveTarget(registered, missingExecutionId);
  const acquired = value(await workspace.acquireLease(registered, reservation));
  if (
    acquired.baseRevision !== operation.baseRevision ||
    acquired.credential.credentialId !== credential.credentialId ||
    acquired.credential.generation !== credential.generation ||
    acquired.credential.grantVersion !== credential.grantVersion
  )
    throw new Error("Lease no longer matches admitted operation");
  const actualIdentity: D.ExecutionIdentity = {
    ...identity,
    lease: acquired,
    operationDigest: immutableOperationDigest,
    assignmentDigest: await assignmentDigest({
      operation,
      executionId: identity.executionId,
      reservationId: reservation.reservationId,
      leaseId: acquired.leaseId,
      fence: acquired.fence,
      executorGeneration: acquired.executorGeneration,
    }),
  };
  const assignment: D.Assignment = {
    operationContext,
    identity: actualIdentity,
    reservationId: reservation.reservationId,
    tool: operation.tool,
    arguments: operation.arguments,
    workspaceId: operation.workspaceId,
    bindingVersion: 1,
    rootBindingId: "root_1",
  };
  await validateAssignment(assignment);
  const executionRequest: D.ExecutionRequest = {
    operationContext: assignment.operationContext,
    reservation,
    identity: assignment.identity,
    tool: assignment.tool,
    arguments: assignment.arguments,
    workspaceId: assignment.workspaceId,
    bindingVersion: assignment.bindingVersion,
    capabilities: ["shell"],
  };
  const { operationContext: _context, ...incompleteRequest } = executionRequest;
  // @ts-expect-error Native and cloud execution requests both require the same operation context.
  const missingContext: D.ExecutionRequest = incompleteRequest;
  void missingContext;
  await cp.recordDispatchIntent(registered, { reservation, assignment, expectedJobVersion: 3 });
  await cp.assignOnce(registered, assignment);
  await cp.queryExecution(registered, actualIdentity);
  const result = value(await workspace.collectResult(registered, actualIdentity));
  const pending = value(
    await jobs.savePreparedResult(registered, {
      identity: actualIdentity,
      sequence: result.sequence,
      result,
      deliveryId: "delivery_1",
    }),
  );
  if (
    pending.state !== "result_pending_commit" ||
    result.state !== "succeeded" ||
    !result.uploadId ||
    !result.commitId ||
    !result.manifestHash
  )
    throw new Error("Result requires observation/reconciliation or unchanged-base verification");
  // Collect returns stage references, never a fabricated seal or canonical success.
  const validation = value(
    await workspace.validateUpload(registered, {
      operationId: "validateUpload",
      path: { workspaceId: reservation.workspaceId, uploadId: result.uploadId },
      query: {},
      body: undefined,
    }),
  );
  if (validation.status !== 200) throw new Error("Stage validation failed");
  const committed = value(
    await workspace.commitUpload(registered, {
      operationId: "commitUpload",
      path: { workspaceId: reservation.workspaceId, uploadId: result.uploadId },
      query: {},
      body: {
        requestId: "request_1",
        stageId: validation.body.stageId,
        commitId: result.commitId,
        uploadId: result.uploadId,
        operationId: acquired.operationId,
        jobId: actualIdentity.jobId,
        workspaceId: reservation.workspaceId,
        lease: acquired,
        baseRevision: acquired.baseRevision,
        manifestHash: validation.body.manifestHash,
      },
    }),
  );
  if (committed.status !== 200) throw new Error("Commit requires recovery/reconciliation");
  const recovered = value(
    await workspace.getReceipt(registered, {
      workspaceId: committed.body.workspaceId,
      commitId: committed.body.commitId,
      commitDigest: committed.body.commitDigest,
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
    const batch = value(
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
    for (const ack of batch.acks) await workspace.ackFacts(registered, ack);
  }
  await jobs.finalize(registered, {
    jobId: pending.jobId,
    expectedVersion: pending.version,
    expectedState: pending.state,
    state: "completed",
    evidence: { kind: "committed", receipt: recovered },
    event: {
      ...event,
      type: "job.state.changed",
      payload: {
        ...pending,
        state: "completed",
        version: incrementSafe(pending.version),
        evidence: { kind: "committed", receipt: publicCommitReceipt(recovered) },
      },
    },
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
    ownerKind: "job",
    operationId: "operation_1",
    jobId: identity.jobId,
    executionId: identity.executionId,
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
  const fromValidatedContext: D.TicketIdentity = {
    deploymentId: ctx.deploymentId,
    principalId: ctx.principalId,
    role: ctx.role,
    credential: {
      credentialId: ctx.credentialId,
      generation: ctx.generation,
      grantVersion: ctx.grantVersion,
    },
    credentialExpiresAt: ctx.credentialExpiresAt,
  };
  void fromValidatedContext;
  const minted = value(
    await cp.mintTicket(ctx, {
      operationId: "mintConnectionTicket",
      path: {},
      query: {},
      body: {
        requestId: ctx.requestId,
        audience: "client-stream",
        resources,
        originMode: { kind: "native" },
      },
    }),
  );
  if (minted.status === 201) {
    const authenticated: D.TicketIdentity = minted.body.identity;
    void [
      authenticated.principalId,
      authenticated.credential.grantVersion,
      authenticated.credentialExpiresAt,
    ];
  }
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
  postManifest: D.Manifest,
  mutations: D.Mutation[],
  now: number,
) {
  const postManifestHash = await manifestDigest(postManifest);
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
  validateLocalLease(scope, "prepare", now);
  const begin = value(
    await workspace.beginUpload(ctx, {
      operationId: "beginUpload",
      path: { workspaceId: scope.workspaceId },
      query: {},
      body: {
        requestId: ctx.requestId,
        baseRevision: scope.baseRevision,
        lease: scope.lease,
        operationId: scope.operationId,
        commitId: "commit_1",
        manifestHash: postManifestHash,
        manifest: postManifest,
        mutations,
      },
    }),
  );
  if (begin.status !== 201) throw new Error("Upload allocation failed");
  const staged = {
    kind: "staged-change" as const,
    uploadId: begin.body.uploadId,
    manifest: postManifest,
    mutations,
    postManifestHash,
    stagedDigest: await localStageDigest({
      uploadId: begin.body.uploadId,
      manifest: postManifest,
      mutations,
    }),
  };
  await validateLocalStage(staged);
  const prepareRequest: D.LocalPrepare = {
    ...scope,
    kind: "prepare",
    commitId: "commit_1",
    expectedManifestHash: hash,
    mode: staged,
  };
  assertUtf8Bytes(canonicalJson(prepareRequest), wireLimits.jsonBytes);
  const preparation = value(await cp.requestLocalWorkspace(ctx, prepareRequest));
  if (!("expiresAt" in preparation)) throw new Error("Expected durable local preparation");
  const intent = value(
    await workspace.prepareLocalCommit(ctx, {
      scope,
      commitId: "commit_1",
      preparation,
      expectedPostManifestHash: postManifestHash,
    }),
  );
  if (intent.intentDigest !== (await localIntentDigest(intent)))
    throw new Error("Wrong pending intent identity");
  await cp.requestLocalWorkspace(ctx, {
    ...scope,
    kind: "apply",
    preparationId: preparation.preparationId,
    commitId: intent.commitId,
  });
  const observation = value(
    await cp.requestLocalWorkspace(ctx, {
      ...scope,
      kind: "observe",
      preparationId: preparation.preparationId,
      commitId: intent.commitId,
    }),
  );
  if (!("observationSeq" in observation) || observation.state !== "applied")
    throw new Error("Local application is uncertain; no metadata commit");
  const receipt = value(
    await workspace.commitLocal(ctx, {
      intent,
      observation,
      manifest: postManifest,
    }),
  );
  const recovered = value(
    await workspace.getReceipt(ctx, {
      workspaceId: "workspace_1",
      commitId: receipt.commitId,
      commitDigest: receipt.commitDigest,
    }),
  );
  await cp.requestLocalWorkspace(ctx, {
    ...scope,
    kind: "receipt",
    preparationId: preparation.preparationId,
    receipt: recovered,
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
      baseRevision: recovered.revision,
      content: {
        kind: "workspace-file",
        path: "src/main.ts",
        manifestHash: recovered.manifestHash,
      },
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
    revision: descriptor.baseRevision,
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
  const workspaceStub: DurableObjectStub<WorkspaceObject> = env.WORKSPACES.getByName("workspace_1");
  const agentStub: DurableObjectStub<AgentSessionObject> = env.AGENT_SESSIONS.getByName("agent");
  const control = controlStub;
  const workspace = workspaceStub;
  const agent = agentStub;
  const contractVersion: "1.0" = await control.contractVersion;
  void contractVersion;
  await workspace.queryExecution(ctx, identity);
  const described = await agent.describeJob(ctx, {
    operationId: "describeJob",
    path: { id: "job_1" },
    query: {},
    body: undefined,
  });
  if (described.ok && described.value.status === 200) {
    const job: D.Job = described.value.body;
    void job;
  }
  const staged = await workspace.validateUpload(ctx, {
    operationId: "validateUpload",
    path: { workspaceId: "workspace_1", uploadId: "upload_1" },
    query: {},
    body: undefined,
  });
  if (staged.ok && staged.value.status === 200) {
    const validation: D.UploadValidation = staged.value.body;
    void validation.stageId;
  }
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

/** A direct workspace operation has no Pi job, task, agent or conversation requirement. */
export async function directWorkspaceAuthority(
  cp: ControlPlaneRpc,
  workspace: WorkspaceObjectRpc,
  ctx: D.AuthContext,
  binding: D.WorkspaceBinding,
  acquisition: D.WorkspaceLeaseAcquire,
  persistedExpiresAt: number,
  persistedRenewalExpiresAt: number,
) {
  const credential = {
    credentialId: ctx.credentialId,
    generation: ctx.generation,
    grantVersion: ctx.grantVersion,
  };
  let byteTarget: D.BackendRef;
  if (binding.config.kind === "computer") {
    byteTarget = {
      kind: "backend",
      backendId: binding.workspaceId,
      generation: binding.bindingVersion,
    };
  } else {
    const executor = value(
      await cp.resolveExecutorGeneration(ctx, {
        workspaceId: binding.workspaceId,
        bindingVersion: binding.bindingVersion,
        executorId: binding.config.executorId,
      }),
    );
    if (executor.transferLimits === null) throw new Error("No validated transfer limits");
    validateExecutorTransferLimits(executor.transferLimits);
    byteTarget = {
      kind: "executor",
      executorId: executor.executorId,
      generation: executor.executorGeneration,
    };
  }
  const registration = value(
    await cp.registerAuthorityRecipient(ctx, {
      credential,
      recipient: { kind: "workspace", id: binding.workspaceId },
      resources: {
        agentIds: [],
        conversationIds: [],
        workspaceIds: [binding.workspaceId],
        actions: ["workspace.write"],
        tools: [],
        executorIds: [],
        backendIds: [],
      },
      ...(byteTarget.kind === "executor"
        ? { executor: { executorId: byteTarget.executorId, generation: byteTarget.generation } }
        : {}),
    }),
  );
  const registered = { ...ctx, registrationId: registration.registrationId };
  const input: D.TargetRequest = {
    ownerKind: "workspace-operation",
    operationId: acquisition.operationId,
    operationDigest: await workspaceLeaseDigest({
      deploymentId: ctx.deploymentId,
      operationId: acquisition.operationId,
      workspaceId: binding.workspaceId,
      bindingVersion: acquisition.bindingVersion,
      baseRevision: acquisition.baseRevision,
      target: byteTarget,
      credential,
      deadline: acquisition.deadline,
    }),
    workspaceId: binding.workspaceId,
    bindingVersion: acquisition.bindingVersion,
    baseRevision: acquisition.baseRevision,
    target: byteTarget,
    actions: ["workspace.write"],
    deadline: acquisition.deadline,
    expiresAt: persistedExpiresAt,
  };
  const reservation = value(await cp.reserveTarget(registered, input));
  const acquired = value(await workspace.acquireLease(registered, reservation));
  if (acquired.ownerKind !== "workspace-operation") throw new Error("Wrong lease ownership");
  // Actor storage must retain this target.kind; a logical backend ID is not an executor revocation subject.
  const privateRecord = { lease: acquired, target: reservation.target };
  void privateRecord.target.kind;
  const renewal: D.LeaseRenewal = {
    requestId: "workspace-renew-business-1",
    lease: acquired,
    expectedLeaseVersion: acquired.leaseVersion,
    expiresAt: persistedRenewalExpiresAt,
  };
  const renewed = value(await workspace.renewLease(registered, renewal));
  const release: D.LeaseRelease = {
    requestId: "workspace-release-business-1",
    lease: renewed,
    reason: "completed",
  };
  await workspace.releaseLease(registered, release);
  const { requestId: _renewalId, ...missingRenewalId } = renewal;
  // @ts-expect-error Stable business requestId is mandatory, not a fresh AuthContext request ID.
  await workspace.renewLease(registered, missingRenewalId);
  const { requestId: _releaseId, ...missingReleaseId } = release;
  // @ts-expect-error Release also requires a stable business requestId.
  await workspace.releaseLease(registered, missingReleaseId);
  const { baseRevision: _base, ...missingBase } = input;
  // @ts-expect-error Non-job reservation must carry the actual requested base revision.
  await cp.reserveTarget(registered, missingBase);
  if (binding.config.kind === "local") {
    const local: D.LocalScope = {
      operationId: acquired.operationId,
      operationDigest: reservation.operationDigest,
      workspaceId: acquired.workspaceId,
      bindingVersion: reservation.bindingVersion,
      rootBindingId: binding.config.rootBindingId,
      executorId: acquired.executorId,
      executorGeneration: acquired.executorGeneration,
      credential: acquired.credential,
      baseRevision: acquired.baseRevision,
      lease: acquired,
      deadline: reservation.deadline,
    };
    // The daemon receives this exact stored reservation digest; metadata alone does not authorize any local effect.
    void local.operationDigest;
  }
  const executorIdentity: D.ExecutorIdentity = {
    ...credential,
    executorId: "executor_1",
    executorGeneration: 4,
    resources,
    deploymentId: ctx.deploymentId,
  };
  // @ts-expect-error Credential generation alone cannot stand for executor execution generation.
  const ambiguous: D.ExecutorIdentity = {
    ...credential,
    executorId: "executor_1",
    resources,
    deploymentId: ctx.deploymentId,
  };
  // @ts-expect-error Workspace-only reservation cannot authorize a job dispatch.
  const jobReservation: Extract<D.TargetReservation, { ownerKind: "job" }> = reservation;
  void [executorIdentity, ambiguous, jobReservation];
}
/** CP stores the stable pending binding request + registration before this RPC; these are signature consumers only. */
export async function bindingAndLocalRead(
  cp: ControlPlaneRpc,
  workspace: WorkspaceObjectRpc,
  ctx: D.AuthContext,
  application: D.WorkspaceBindingApplication,
  imported: D.WorkspaceBindingPatch["import"],
) {
  const registration = value(
    await cp.registerAuthorityRecipient(ctx, {
      credential: {
        credentialId: ctx.credentialId,
        generation: ctx.generation,
        grantVersion: ctx.grantVersion,
      },
      recipient: { kind: "workspace", id: application.binding.workspaceId },
      resources: { ...resources, workspaceIds: [application.binding.workspaceId] },
      ...(application.executor === undefined ? {} : { executor: application.executor }),
    }),
  );
  const registered: D.ResourceAuthContext = { ...ctx, registrationId: registration.registrationId };
  const acknowledged = value(await workspace.applyBinding(registered, application));
  // Publication uses the authority's actual revision/manifest acknowledgment, never CP-invented metadata.
  const published: D.OperationResponse<"createWorkspace"> = { status: 201, body: acknowledged };
  if (acknowledged.config.kind === "local") {
    const generation = value(
      await cp.resolveExecutorGeneration(registered, {
        workspaceId: acknowledged.workspaceId,
        bindingVersion: acknowledged.bindingVersion,
        executorId: acknowledged.config.executorId,
      }),
    );
    if (generation.transferLimits === null) throw new Error("No validated transfer limits");
    validateExecutorTransferLimits(generation.transferLimits);
    if (generation.executorId !== acknowledged.config.executorId) throw new Error("Wrong executor");
    await cp.requestLocalWorkspace(registered, {
      kind: "list",
      operationId: application.requestId,
      workspaceId: acknowledged.workspaceId,
      bindingVersion: acknowledged.bindingVersion,
      rootBindingId: acknowledged.config.rootBindingId,
      executorId: generation.executorId,
      executorGeneration: generation.executorGeneration,
      credential: {
        credentialId: ctx.credentialId,
        generation: ctx.generation,
        grantVersion: ctx.grantVersion,
      },
      revision: acknowledged.revision,
      deadline: ctx.deadline,
    });
  }
  // @ts-expect-error A resource registration is required before applying a binding.
  await workspace.applyBinding(ctx, application);
  // @ts-expect-error Generation resolution requires the authoritative binding version.
  await cp.resolveExecutorGeneration(ctx, {
    workspaceId: acknowledged.workspaceId,
    executorId: "executor_1",
  });
  const first: D.WorkspaceBindingApplication = {
    requestId: ctx.requestId,
    expectedVersion: null,
    binding: { workspaceId: "workspace_1", bindingVersion: 1, config: { kind: "computer" } },
  };
  const rebound: D.WorkspaceBindingApplication = {
    requestId: ctx.requestId,
    expectedVersion: acknowledged.bindingVersion,
    binding: {
      workspaceId: acknowledged.workspaceId,
      bindingVersion: incrementSafe(acknowledged.bindingVersion),
      config: { kind: "local", executorId: "executor_1", rootBindingId: "root_1" },
    },
    import: imported,
    executor: { executorId: "executor_1", generation: 4 },
  };
  const fabricated: D.WorkspaceBindingApplication["binding"] = {
    ...first.binding,
    // @ts-expect-error Only the authority creates canonical revision metadata.
    revision: "invented",
  };
  void [first, rebound, fabricated];
  return published;
}
export async function publicLeasePorts(
  cp: ControlPlaneRpc,
  ctx: D.AuthContext,
  acquire: D.OperationRequest<"acquireWorkspaceLease">,
) {
  const admitted = value(await cp.acquireWorkspaceLease(ctx, acquire));
  if (admitted.status !== 201) return admitted;
  const renewal = value(
    await cp.renewWorkspaceLease(ctx, {
      operationId: "renewWorkspaceLease",
      path: { workspaceId: admitted.body.workspaceId, leaseId: admitted.body.leaseId },
      query: {},
      body: { requestId: "renew-business-1", lease: admitted.body },
    }),
  );
  if (renewal.status !== 200) return renewal;
  return cp.releaseWorkspaceLease(ctx, {
    operationId: "releaseWorkspaceLease",
    path: { workspaceId: renewal.body.workspaceId, leaseId: renewal.body.leaseId },
    query: {},
    body: { requestId: "release-business-1", lease: renewal.body, reason: "completed" },
  });
}
