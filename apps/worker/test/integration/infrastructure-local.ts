import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { FortiPiClient, FortiPiError } from "../../../../packages/fortipi-client/dist/node.js";
import {
  canonicalJson,
  freeInfrastructurePolicy,
  manifestDigest,
} from "../../../../packages/fortipi-contract/dist/index.js";
import {
  infrastructureLocalOutputLimitations,
  runInfrastructureLocalOutput,
} from "../../../../tests/clients/infrastructure-local-output.ts";
import {
  verifyDefaultComputerDeclarations,
  verifyLocalInfrastructureObservation,
} from "../../../../tests/clients/infrastructure-local-proof.ts";
import { produceLocalRefusalRestoration } from "../../../../tests/clients/infrastructure-local-refusal.ts";
import {
  observeComputerDeclaration,
  seedInfrastructureWorkspace,
} from "../../../../tests/clients/live-infrastructure-controls.ts";
import { RoleContext } from "../../../../tests/clients/roles.ts";
import type * as D from "../../src/boundary/dto.js";
import { assignedJob } from "../control/artifact-job.ts";
import { connected } from "../control/connection.ts";
import type { CompletionControl } from "../control/fixtures/completion.ts";
import { config, harness, request, scope, uuid, value } from "../control/harness.ts";
import { type Runtime, start } from "./runtime.ts";
import { stageWorkspace } from "./workspace-portability.ts";

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** Completes the SAME original LOCAL observation using genuine companion
 * results. This is shared by the runner and its bounded composition check;
 * neither invocation creates a Gate or authenticates an artifact producer. */
export async function completeLocalInfrastructureObservation(prior: {
  observation: Record<string, unknown>;
  retention: unknown;
  retirement: unknown;
  baseBoundsSha256: string;
}) {
  const [details, output, refusalRestoration, defaultComputerDeclarations] = await Promise.all([
    runLocalInfrastructureDetails(),
    runInfrastructureLocalOutput(),
    produceLocalRefusalRestoration(),
    produceDefaultComputerDeclarations(),
  ]);
  const observation = verifyLocalInfrastructureObservation(
    {
      ...prior.observation,
      localInfrastructureDetails: {
        schemaVersion: 1,
        baseBoundsSha256: prior.baseBoundsSha256,
        retention: prior.retention,
        retirement: prior.retirement,
        output,
        refusalRestoration,
        defaultComputerDeclarations,
        ...details,
      },
    },
    prior.baseBoundsSha256,
  );
  return {
    observation,
    limitations: [
      ...infrastructureLocalOutputLimitations,
      ...defaultComputerDeclarations.limitations,
      "Output uses ASCII stdout with artifact capacity equal to output capacity; no independent Unicode/stderr or artifact-clipping boundary claim",
      "Refusal uses real workerd/SQLite INSERT-abort and SIGKILL/same-storage canary recovery; recipient pressure and known120s guidance are synthetic, not observed provider exhaustion or reset discovery",
      "Detailed allocations/faults and registered CP cleanup are LOCAL; they do not certify Cloudflare account ceilings, a native process stop or provider recovery",
    ],
  };
}

/** Public Computer staging/history at schema-valid reduced LOCAL allocations.
 * No actual Cloudflare/account exhaustion or copied private ledger counters. */

async function privateWorkspace(runtime: Runtime, roles: RoleContext) {
  const binding = await roles.call({
    operationId: "createWorkspace",
    path: {},
    query: {},
    body: { requestId: randomUUID(), config: { kind: "computer" } },
  });
  const role = await roles.issue({
    requestId: randomUUID(),
    role: "client",
    grants: [
      {
        grantId: randomUUID(),
        version: 1,
        resources: {
          agentIds: [],
          conversationIds: [],
          workspaceIds: [binding.workspaceId],
          executorIds: [],
          backendIds: [],
          tools: [],
          actions: ["workspace.read", "workspace.write", "workspaces.read"],
        },
      },
    ],
  });
  const files = { "notes.txt": Buffer.from("old-v1\n") };
  const stage = await stageWorkspace(runtime, binding, role.token, files);
  const committed = await stage.commit();
  assert.equal(committed.status, 200);
  await confirmedRelease(stage);
  return {
    binding: {
      ...binding,
      revision: committed.body.revision,
      manifestHash: committed.body.manifestHash,
    },
    token: role.token,
    files,
    initialRevision: binding.revision,
  };
}
async function canonical(runtime: Runtime, binding: D.WorkspaceBinding, token: string) {
  const response = await fetch(
    `${runtime.endpoint}/v1/workspaces/${binding.workspaceId}/read?${new URLSearchParams({ revision: binding.revision, path: "notes.txt" })}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    },
  );
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(bytes, Buffer.from("old-v1\n"));
  return hash(bytes);
}
async function confirmedRelease(stage: Awaited<ReturnType<typeof stageWorkspace>>) {
  const response = await stage.release();
  assert.equal(response.status, 200);
  assert.ok(
    response.body &&
      typeof response.body === "object" &&
      "released" in response.body &&
      response.body.released === true,
  );
  assert.ok("leaseId" in response.body && response.body.leaseId === stage.lease.leaseId);
  return { leaseId: stage.lease.leaseId, released: true };
}
async function confirmedAbort(
  runtime: Runtime,
  workspaceId: string,
  token: string,
  stage: Awaited<ReturnType<typeof stageWorkspace>>,
) {
  const response = await stage.abort();
  if (response.status !== 204) {
    assert.equal(response.status, 409);
    const outcome = (await response.json()) as D.ErrorBody;
    assert.equal(
      outcome.error.code,
      "interrupted",
      "Only the public recover-existing-identity disposition can use a status recovery",
    );
  }
  const after = await runtime.api<D.UploadStatus>(
    `/v1/workspaces/${workspaceId}/uploads/${stage.uploadId}`,
    undefined,
    "GET",
    token,
  );
  assert.equal(after.status, 200);
  assert.equal(after.body.state, "aborted", "Unknown/committed staging cannot be called cleaned");
  return {
    replyStatus: response.status,
    knownState: after.body.state,
    acknowledgment: response.status === 204 ? "direct" : "recovered-by-current-scoped-status",
  };
}
export async function localStagingAndHistory() {
  const runtime = await start({
      testBounds: { stagingBytesPerWorkspace: 8192, retainedVersions: 3 },
    }),
    roles = new RoleContext(runtime.endpoint, runtime.admin);
  try {
    const staged = await privateWorkspace(runtime, roles);
    const canonicalHashBefore = await canonical(runtime, staged.binding, staged.token);
    const stagedEdges = [];
    for (const attempted of [8191, 8192]) {
      const files = { ...staged.files, "edge.bin": Buffer.alloc(attempted - 7, 101) };
      const stage = await stageWorkspace(runtime, staged.binding, staged.token, files);
      try {
        const status = await runtime.api<D.UploadStatus>(
          `/v1/workspaces/${staged.binding.workspaceId}/uploads/${stage.uploadId}`,
          undefined,
          "GET",
          staged.token,
        );
        assert.equal(status.status, 200);
        assert.equal(status.body.state, "validated");
        stagedEdges.push({
          attempted,
          accepted: Object.values(files).reduce((n, bytes) => n + bytes.length, 0),
          status: status.status,
        });
      } finally {
        try {
          await confirmedAbort(runtime, staged.binding.workspaceId, staged.token, stage);
        } finally {
          await confirmedRelease(stage);
        }
      }
    }
    const workspaceId = staged.binding.workspaceId,
      operationId = randomUUID();
    const acquired = await runtime.api<D.WorkspaceOperationLease>(
      `/v1/workspaces/${workspaceId}/leases`,
      {
        requestId: randomUUID(),
        operationId,
        bindingVersion: staged.binding.bindingVersion,
        baseRevision: staged.binding.revision,
        deadline: Date.now() + 120000,
      },
      "POST",
      staged.token,
    );
    assert.equal(acquired.status, 201);
    try {
      const files = { ...staged.files, "edge.bin": Buffer.alloc(8193 - 7, 102) };
      const manifest: D.Manifest = {
        version: 1,
        entries: Object.entries(files)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([path, bytes]) => ({
            path,
            type: "file",
            mode: 420,
            size: bytes.length,
            sha256: hash(bytes),
          })),
      };
      const body: D.UploadBegin = {
        requestId: randomUUID(),
        operationId,
        commitId: randomUUID(),
        lease: acquired.body,
        baseRevision: staged.binding.revision,
        manifest,
        manifestHash: await manifestDigest(manifest),
        mutations: manifest.entries.map((entry) => {
          assert.ok(entry.type === "file");
          return {
            kind: "put",
            path: entry.path,
            mode: entry.mode,
            size: entry.size,
            sha256: entry.sha256,
          };
        }),
      };
      const refused = await runtime.api<D.ErrorBody>(
        `/v1/workspaces/${workspaceId}/uploads`,
        body,
        "POST",
        staged.token,
      );
      assert.equal(refused.status, 429);
      assert.equal(refused.body.error.code, "quota_exceeded");
      stagedEdges.push({ attempted: 8193, accepted: 0, status: refused.status });
    } finally {
      const released = await runtime.api<D.WorkspaceLeaseReleaseReceipt>(
        `/v1/workspaces/${workspaceId}/leases/${acquired.body.leaseId}/release`,
        { requestId: randomUUID(), lease: acquired.body, reason: "cancelled" },
        "POST",
        staged.token,
      );
      assert.equal(released.status, 200);
      assert.equal(released.body.released, true);
      assert.equal(released.body.leaseId, acquired.body.leaseId);
    }
    const afterStaging = await canonical(runtime, staged.binding, staged.token);
    assert.equal(afterStaging, canonicalHashBefore);
    const history = await privateWorkspace(runtime, roles);
    const revisions = new Set([history.initialRevision, history.binding.revision]);
    const historyBefore = await canonical(runtime, history.binding, history.token);
    const below = { attempted: 2, accepted: revisions.size, status: 200 };
    const next = await stageWorkspace(runtime, history.binding, history.token, history.files);
    const committed = await next.commit();
    assert.equal(committed.status, 200);
    await confirmedRelease(next);
    history.binding = {
      ...history.binding,
      revision: committed.body.revision,
      manifestHash: committed.body.manifestHash,
    };
    revisions.add(committed.body.revision);
    const at = { attempted: 3, accepted: revisions.size, status: committed.status };
    assert.equal(revisions.size, 3);
    const aboveStage = await stageWorkspace(runtime, history.binding, history.token, history.files);
    let above: { attempted: number; accepted: number; status: number } | undefined;
    try {
      const refused = await aboveStage.commit();
      assert.equal(refused.status, 429);
      above = { attempted: 4, accepted: revisions.size, status: refused.status };
    } finally {
      try {
        await confirmedAbort(runtime, history.binding.workspaceId, history.token, aboveStage);
      } finally {
        await confirmedRelease(aboveStage);
      }
    }
    assert.ok(above);
    const afterHistory = await canonical(runtime, history.binding, history.token);
    assert.equal(afterHistory, historyBefore);
    // Independent returned revision IDs remain publicly readable; the initial
    // empty revision is checked by its own manifest rather than guessed bytes.
    for (const revision of revisions) {
      const manifest = await runtime.api<D.ManifestResponse>(
        `/v1/workspaces/${history.binding.workspaceId}/manifest?${new URLSearchParams({ revision })}`,
        undefined,
        "GET",
        history.token,
      );
      assert.equal(manifest.status, 200);
      if (revision === history.initialRevision)
        assert.deepEqual(manifest.body.manifest.entries, []);
      else
        assert.equal(
          await canonical(runtime, { ...history.binding, revision }, history.token),
          historyBefore,
        );
    }
    return [
      {
        resource: "stagingBytesPerWorkspace",
        configuredLimit: 8192,
        below: stagedEdges[0],
        at: stagedEdges[1],
        above: stagedEdges[2],
        canonicalHashBefore,
        canonicalHashAfter: afterStaging,
        scope: "local-schema-valid-allocation",
      },
      {
        resource: "retainedVersions",
        configuredLimit: 3,
        below,
        at,
        above,
        canonicalHashBefore: historyBefore,
        canonicalHashAfter: afterHistory,
        scope: "local-schema-valid-allocation",
      },
    ];
  } finally {
    try {
      const cleanup = await roles.cleanup();
      assert.ok(cleanup.every((row) => row.state === "complete"));
    } finally {
      await runtime.dispose();
    }
  }
}
/** Existing CP reservation/repair seam, actual default30/120 meter. Only
 * LOCAL requests are exhausted; no account/provider work is invoked. */
export async function localCompletionHeadroom() {
  const h = await harness();
  try {
    const left = 60000 - (Date.now() % 60000);
    if (left < 10000) await new Promise<void>((accept) => setTimeout(accept, left + 50));
    const admin = await h.auth();
    const created = value(
      await h.cp.createAgent(
        admin,
        request("createAgent", {
          requestId: uuid(),
          name: "LOCAL headroom",
          model: { providerId: "cloudflare", modelId: "fixture" },
        }),
      ),
    );
    assert.equal(created.status, 201);
    if (created.status !== 201) throw new Error("Local headroom actor missing");
    const agentId = created.body.agentId;
    const resources: D.ResourceScope = {
      agentIds: [agentId],
      conversationIds: [],
      workspaceIds: [],
      executorIds: [],
      backendIds: [],
      tools: [],
      actions: ["conversations.create"],
    };
    const actors: D.AuthContext[] = [];
    const issued = [];
    for (let i = 0; i < 3; i++)
      issued.push(
        await h.mint({
          requestId: uuid(),
          role: "client",
          grants: [{ grantId: "local-headroom", version: 1, resources }],
        }),
      );
    for (const credential of issued) {
      const auth = await h.auth(credential.token);
      const registration = value(
        await h.cp.registerAuthorityRecipient(auth, {
          credential: credential.credential,
          recipient: { kind: "agent", id: agentId },
          resources,
        }),
      );
      const actor = { ...auth, registrationId: registration.registrationId };
      await h.env.AGENT_SESSIONS.getByName(agentId).reportStorage(actor, "agent");
      actors.push(actor);
    }
    const owner = actors[0];
    assert.ok(owner);
    const reservation = value(
      await h.cp.reserveCapacity(owner, {
        operationId: uuid(),
        ownerId: agentId,
        policyVersion: 1,
        bytes: 4096,
        admissionSlots: 0,
      }),
    );
    const applicationLimit = 90,
      repairLimit = 30;
    assert.equal(config.infrastructure.bounds.requestsPerInstallMinute, 120);
    assert.equal(config.infrastructure.bounds.headroomFraction, 0.25);
    const counts = [8, 4, 3, 3],
      principals = [admin, ...actors];
    let applicationSuccesses = 18;
    for (const [index, actor] of principals.entries()) {
      while ((counts[index] ?? 0) < 30 && applicationSuccesses < applicationLimit) {
        value(await h.cp.listAgents(actor, request("listAgents", undefined)));
        counts[index] = (counts[index] ?? 0) + 1;
        applicationSuccesses++;
      }
    }
    assert.equal(applicationSuccesses, applicationLimit);
    const unknown = await h.cp.settleCapacity(owner, {
      reservationId: uuid(),
      disposition: "unused",
      observedBytes: 0,
    });
    assert.ok(!unknown.ok);
    assert.equal(unknown.code, "rate_limited");
    const denied = await h.cp.listAgents(owner, request("listAgents", undefined));
    assert.ok(!denied.ok);
    assert.equal(denied.code, "rate_limited");
    const body = { reservationId: reservation.reservationId, disposition: "consumed" as const };
    let completionSuccesses = 0;
    for (let i = 0; i < repairLimit - 1; i++) {
      const settled: D.CapacityReservation = value(await h.cp.settleCapacity(owner, body));
      assert.equal(settled.state, "settled");
      completionSuccesses++;
    }
    const race = await Promise.all([
      h.cp.settleCapacity(owner, body),
      h.cp.settleCapacity(owner, body),
    ]);
    const winners = race.filter((row) => row.ok).length;
    assert.equal(winners, 1);
    completionSuccesses += winners;
    const refused = race.find((row) => !row.ok);
    assert.ok(refused && !refused.ok);
    assert.equal(refused.code, "rate_limited");
    const after = await h.cp.settleCapacity(owner, body);
    assert.ok(!after.ok);
    assert.equal(after.code, "rate_limited");
    const reservationRows = await h.cp.rowCount("capacity_reservation");
    assert.equal(reservationRows, 1);
    return {
      scope: "LOCAL actual CP/SQLite default request meter",
      applicationLimit,
      repairLimit,
      applicationSuccesses,
      newAdmissionCode: denied.code,
      unknownReservationCode: unknown.code,
      completionSuccesses,
      finalContenders: 2,
      finalAccepted: winners,
      nextRetryCode: after.code,
      reservationRows,
      originalReservationId: reservation.reservationId,
      limitation:
        "Retained settlement path; retainedCleanup separately records CP query/cancel with synthetic executor replies. Revocation and full-runtime/native behavior remain independently gated, not a shared-account exhaustion claim",
    };
  } finally {
    await h.close();
  }
}
export async function runLocalInfrastructureDetails() {
  const [stagingAndHistory, headroom, retainedCleanup] = await Promise.all([
    localStagingAndHistory(),
    localCompletionHeadroom(),
    localRetainedCleanupHeadroom(),
  ]);
  return { stagingAndHistory, headroom: { ...headroom, retainedCleanup } };
}

/** Existing registered-owner/real CP/SQLite exchange seam. Synthetic executor
 * replies preserve possible effects; this never claims a native process stop. */
export async function localRetainedCleanupHeadroom() {
  const h = await harness<CompletionControl>({
    fixturePath: "apps/worker/test/control/fixtures/completion.ts",
  });
  let channel: Awaited<ReturnType<typeof connected>> | undefined;
  try {
    const left = 60000 - (Date.now() % 60000);
    if (left < 12000) await new Promise<void>((done) => setTimeout(done, left + 50));
    channel = await connected(h);
    const issued = await h.mint({
      requestId: uuid(),
      role: "client",
      grants: [
        { grantId: uuid(), version: 1, resources: scope(["jobs.dispatch", "workspace.write"]) },
      ],
    });
    const raw = await h.auth(issued.token);
    const job = await assignedJob(h, raw);
    const actor = { ...raw, registrationId: job.reservation.registrationIds.agent };
    const cancel: D.CancelRequest = {
      identity: job.identity,
      requestId: uuid(),
      reason: "LOCAL retained cleanup headroom",
    };
    const principals = [raw, await h.auth()];
    for (let i = 0; i < 3; i++) {
      const credential = await h.mint({
        requestId: uuid(),
        role: "client",
        grants: [{ grantId: uuid(), version: 1, resources: scope(["agents.list"]) }],
      });
      principals.push(await h.auth(credential.token));
    }
    for (const principal of principals)
      for (let i = 0; i < 31; i++) {
        const response = await h.cp.listAgents(principal, request("listAgents", undefined));
        if (!response.ok) {
          assert.equal(response.code, "rate_limited");
          break;
        }
      }
    const before = await h.cp.admissions();
    assert.equal(before.application, 90);
    const unknownQuery = await h.cp.queryExecution(raw, job.identity);
    const unknownCancel = await h.cp.cancelExecution(raw, cancel);
    assert.ok(!unknownQuery.ok && !unknownCancel.ok);
    assert.equal(unknownQuery.code, "rate_limited");
    assert.equal(unknownCancel.code, "rate_limited");
    assert.equal((await h.cp.admissions()).repair, before.repair);
    assert.equal(channel.frames.filter((frame) => frame.type === "job.query").length, 0);
    assert.equal(channel.frames.filter((frame) => frame.type === "job.cancel").length, 0);

    const queryPending = h.cp.queryExecution(actor, job.identity);
    const query = await channel.wait("job.query");
    assert.ok(query.type === "job.query");
    assert.deepEqual(query.payload, job.identity);
    channel.send({
      type: "job.query_result",
      requestId: query.requestId,
      payload: { identity: job.identity, state: "running" },
    });
    const observation = value(await queryPending);
    assert.deepEqual(observation.identity, job.identity);
    assert.equal(observation.state, "running");
    const afterQuery = await h.cp.admissions();
    assert.equal(afterQuery.application, before.application);
    assert.equal(afterQuery.repair, before.repair + 1);

    const cancelPending = h.cp.cancelExecution(actor, cancel);
    const cancelled = await channel.wait("job.cancel");
    assert.ok(cancelled.type === "job.cancel");
    assert.equal(cancelled.requestId, cancel.requestId);
    assert.deepEqual(cancelled.payload.identity, job.identity);
    const disposition: D.CancelDisposition = { state: "stopped", possibleExternalEffects: true };
    channel.send({
      type: "job.cancel_ack",
      requestId: cancelled.requestId,
      payload: { identity: job.identity, disposition },
    });
    assert.deepEqual(value(await cancelPending), disposition);
    const afterCancel = await h.cp.admissions();
    assert.equal(afterCancel.application, before.application);
    assert.equal(afterCancel.repair, afterQuery.repair + 1);
    const assignmentFrames = channel.frames.filter((frame) => frame.type === "job.assign").length;
    const queryFrames = channel.frames.filter((frame) => frame.type === "job.query").length;
    const cancelFrames = channel.frames.filter((frame) => frame.type === "job.cancel").length;
    assert.equal(assignmentFrames, 1);
    assert.equal(queryFrames, 1);
    assert.equal(cancelFrames, 1);
    return {
      scope: "LOCAL registered-owner CP/SQLite; synthetic executor replies",
      originalExecutionId: job.identity.executionId,
      originalJobId: job.identity.jobId,
      applicationBefore: before.application,
      applicationAfter: afterCancel.application,
      repairBefore: before.repair,
      repairAfterQuery: afterQuery.repair,
      repairAfterCancel: afterCancel.repair,
      unregisteredQueryCode: unknownQuery.code,
      unregisteredCancelCode: unknownCancel.code,
      queryState: observation.state,
      cancelState: disposition.state,
      possibleExternalEffects: disposition.possibleExternalEffects,
      assignmentFrames,
      queryFrames,
      cancelFrames,
      sameOriginalIdentity: true,
      limitation:
        "Real CP metering/current registration and transport exchange; synthetic executor attestations, no native-process stop, provider quota or new-ingress revocation bypass claim",
    };
  } finally {
    channel?.socket.close();
    await h.close();
  }
}

/** Fixed local-only fixture port; no job authority or credentials in results. */
export async function localDeclarationProbe(
  runtime: Runtime,
  roles: RoleContext,
  resource: "file" | "snapshot" | "entries",
  delta: -1 | 0 | 1,
  transport: typeof fetch = fetch,
) {
  const binding = await roles.call({
    operationId: "createWorkspace",
    path: {},
    query: {},
    body: { requestId: randomUUID(), config: { kind: "computer" } },
  });
  const role = await roles.issue({
    requestId: randomUUID(),
    role: "client",
    grants: [
      {
        grantId: randomUUID(),
        version: 1,
        resources: {
          agentIds: [],
          conversationIds: [],
          workspaceIds: [binding.workspaceId],
          executorIds: [],
          backendIds: [],
          tools: [],
          actions: ["workspace.read", "workspace.write", "workspaces.read"],
        },
      },
    ],
  });
  const client = new FortiPiClient({
    endpoint: runtime.endpoint,
    credentials: async () => role.token,
    allowLoopbackHttp: true,
    fetch: transport,
  });
  const context = {
    client,
    errorType: FortiPiError,
    request: <T>(operation: () => Promise<T>) => operation(),
  };
  const canary = await seedInfrastructureWorkspace(context, binding);
  return { ...context, canary, resource, delta, credentialId: role.credential.credentialId };
}

/** All nine cases are REQUIRED LOCAL data, on separate genuine workerd
 * installations per resource. No test registration, synthetic facts or scope
 * substitution is used by the normal evidence runner. */
export async function produceDefaultComputerDeclarations() {
  const cases: Record<string, unknown>[] = [];
  const installations: {
    resource: string;
    applicationId: string;
    storagePathSha256: string;
    credentialCleanup: Awaited<ReturnType<RoleContext["cleanup"]>>;
  }[] = [];
  const fixturePolicy = structuredClone(freeInfrastructurePolicy);
  fixturePolicy.bounds.requestsPerPrincipalMinute = 10000;
  fixturePolicy.bounds.requestsPerInstallMinute = 10000;
  let fixturePolicySha256: string | undefined;
  for (const resource of ["file", "snapshot", "entries"] as const) {
    const runtime = await start(),
      roles = new RoleContext(runtime.endpoint, runtime.admin);
    let applicationId: string | undefined;
    try {
      const protocol = await runtime.api<D.Protocol>("/v1/protocol");
      assert.equal(protocol.status, 200);
      assert.deepEqual(
        protocol.body.infrastructure,
        fixturePolicy,
        "Only LOCAL request cadence differs; allocation/headroom defaults remain exact",
      );
      applicationId = protocol.body.deploymentId;
      const observedPolicyHash = hash(canonicalJson(protocol.body.infrastructure));
      if (fixturePolicySha256) assert.equal(fixturePolicySha256, observedPolicyHash);
      else fixturePolicySha256 = observedPolicyHash;
      for (const delta of [-1, 0, 1] as const) {
        const probe = await localDeclarationProbe(runtime, roles, resource, delta);
        const observation = await observeComputerDeclaration(probe);
        roles.assertSanitized(observation);
        cases.push({
          ...observation,
          applicationId,
          storagePathSha256: hash(runtime.directory),
          credentialId: probe.credentialId,
        });
      }
    } finally {
      try {
        const credentialCleanup = await roles.cleanup();
        assert.ok(
          credentialCleanup.every((row) => row.state === "complete" && row.pendingRecipients === 0),
          "Unknown/pending LOCAL credential cleanup blocks details",
        );
        if (applicationId)
          installations.push({
            resource,
            applicationId,
            storagePathSha256: hash(runtime.directory),
            credentialCleanup,
          });
      } finally {
        await runtime.dispose();
      }
    }
  }
  assert.ok(fixturePolicySha256);
  const observed = {
    schemaVersion: 1,
    scope: "LOCAL separate installations per resource",
    defaultPolicySha256: hash(canonicalJson(freeInfrastructurePolicy)),
    fixturePolicySha256,
    cadence: { requestsPerPrincipalMinute: 10000, requestsPerInstallMinute: 10000 },
    installations,
    cases,
    limitations: [
      "Actual public SDK/workerd/Computer/SQLite on separate LOCAL installations per resource, with10000 fixture request cadence and unchanged default allocation/headroom bounds",
      "Fixture logical application IDs may repeat; storage-root hashes correlate actual independent temporary roots, not provider identity or artifact authority",
      "Descriptor allocation and same-workspace recovery only; no maximum snapshot transfer, one-installation schedule, actual Free-account headroom or provider exhaustion claim",
    ],
  };
  verifyDefaultComputerDeclarations(observed);
  return observed;
}
