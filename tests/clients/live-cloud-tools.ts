import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type {
  Agent,
  BackendRef,
  Configuration,
  DurableEvent,
  Job,
  WorkspaceBinding,
} from "../../packages/fortipi-contract/dist/index.js";
import {
  assertDeployment,
  canonicalJson,
  type DeploymentIdentity,
  sha256,
} from "../../scripts/verify-release-gates.ts";
import type { Installed } from "../distribution/install.ts";
import type { ScenarioEvidence } from "./evidence.ts";
import type { RecoveryWorkspaceCanary } from "./platform-recovery.ts";
import type { RoleContext } from "./roles.ts";

export interface CloudToolInput {
  installed: Pick<Installed, "candidate" | "resolveExport">;
  roles: RoleContext;
  agent: Agent;
  workspace: RecoveryWorkspaceCanary;
  /** Explicit intent generation; the service must accept its actual authority.
   * This is not inferred from a provider version, config version or timestamp. */
  target: Extract<BackendRef, { kind: "backend" }>;
  observe?: (phase: string) => void;
}
const pause = (ms: number) => new Promise<void>((accept) => setTimeout(accept, ms));
async function until(read: () => boolean) {
  const end = Date.now() + 120000;
  while (Date.now() < end) {
    if (read()) return;
    await pause(50);
  }
  throw new Error("Actual public cloud tool did not reach its required committed boundary");
}

/** Public application flow only. Local qualification may supply a synthetic
 * paid capability backed by a real local Loader; that never establishes an
 * actual Paid account/deployment or substitutes for the live wrapper below. */
async function openPublicCloudOperation(input: CloudToolInput, cancellation: boolean) {
  const observe = (phase: string) => input.observe?.(phase);
  observe("configuration-capability");
  const { roles, installed, agent, workspace, target } = input;
  const configuration = await roles.call({
    operationId: "getConfiguration",
    path: {},
    query: {},
    body: undefined,
  });
  assert.notEqual(configuration.execution.kind, "native");
  if (configuration.execution.kind === "native")
    throw new Error("A configured actual cloud backend is required");
  const backend = configuration.execution;
  assert.equal(target.backendId, backend.backendId);
  assert.ok(Number.isSafeInteger(target.generation) && target.generation > 0);
  assert.equal(workspace.binding.config.kind, "computer");
  const capability = backend.kind === "cloud-js" ? "loader" : "containers";
  const module = (await import(
    pathToFileURL(installed.resolveExport(`@${installed.candidate.scope}/fortipi-client/node`)).href
  )) as typeof import("../../packages/fortipi-client/dist/node.js");
  const probeRole = await roles.issue({
    requestId: randomUUID(),
    role: "client",
    expiresAt: Date.now() + 900000,
    grants: [
      {
        grantId: randomUUID(),
        version: 1,
        resources: {
          agentIds: [],
          conversationIds: [],
          workspaceIds: [],
          executorIds: [],
          backendIds: [],
          tools: [],
          actions: [],
        },
      },
    ],
  });
  const probe = new module.FortiPiClient({
    endpoint: roles.endpoint,
    credentials: async () => probeRole.token,
    allowLoopbackHttp: new URL(roles.endpoint).protocol === "http:",
  });
  const protocol = await probe.negotiate();
  const advertised = protocol.backends.find((value) => value.kind === backend.kind);
  const verified = configuration.infrastructure.capabilities.find(
    (value) => value.capability === capability,
  );
  assert.ok(
    configuration.infrastructure.accountPlan === "paid" &&
      advertised?.available === true &&
      verified?.state === "available" &&
      verified.accountPlan === "paid" &&
      verified.deploymentId === protocol.deploymentId,
    "Unavailable or unverified paid binding must refuse before conversation/tool invocation",
  );
  const conversation = await roles.call({
    operationId: "createConversation",
    path: { agentId: agent.agentId },
    query: {},
    body: { requestId: randomUUID(), title: `seed1010-${backend.kind}-tool` },
  });
  const tool = backend.kind === "cloud-js" ? "javascript" : "shell";
  const role = await roles.issue({
    requestId: randomUUID(),
    role: "client",
    expiresAt: Date.now() + 900000,
    grants: [
      {
        grantId: randomUUID(),
        version: 1,
        resources: {
          agentIds: [agent.agentId],
          conversationIds: [conversation.conversationId],
          workspaceIds: [workspace.binding.workspaceId],
          executorIds: [],
          backendIds: [target.backendId],
          tools: [tool],
          actions: [
            "conversations.read",
            "messages.submit",
            "events.read",
            "tasks.read",
            "tasks.cancel",
            "tickets.mint",
            "jobs.dispatch",
            "jobs.read",
            "jobs.reconcile",
            "approvals.read",
            "approvals.decide",
            "workspaces.read",
            "workspace.read",
            "workspace.write",
          ],
        },
      },
    ],
  });
  const client = new module.FortiPiClient({
    endpoint: roles.endpoint,
    credentials: async () => role.token,
    allowLoopbackHttp: new URL(roles.endpoint).protocol === "http:",
  });
  const nonce = randomUUID(),
    path = `seed1010-${nonce}.txt`,
    content = `${nonce}\n`;
  const source =
    backend.kind === "cloud-js"
      ? `import {writeFile} from 'node:fs/promises'; export default async function () { await writeFile(${JSON.stringify(`/workspace/${path}`)}, ${JSON.stringify(content)}, {flag:'wx',mode:420}); ${cancellation ? "await new Promise(resolve => setTimeout(resolve, 30000));" : ""} console.log('seed1010-committed-marker'); }`
      : `set -eu\ntest ! -e '/workspace/${path}'\nprintf '%s\\n' '${nonce}' > '/workspace/${path}'\n${cancellation ? "sleep 30\n" : ""}printf 'seed1010-committed-marker\\n'\n`;
  const dispatch = {
    tool,
    arguments: { source },
    workspaceId: workspace.binding.workspaceId,
    baseRevision: workspace.binding.revision,
    target,
    capabilities: [tool],
  };
  return {
    dispatch,
    async run(): Promise<ScenarioEvidence> {
      observe("subscribe");
      const events: DurableEvent[] = [];
      const stream = client.conversations.subscribe(conversation.conversationId, {
        agentId: agent.agentId,
        onSnapshot() {},
        onEvent(event) {
          if (event.durability === "durable") events.push(event);
        },
      });
      try {
        await stream.ready;
        observe("model-dispatch");
        const intent = client.messageIntent(
          conversation.conversationId,
          `Call fortipi_dispatch exactly once with these arguments: ${canonicalJson(dispatch)}. Wait for human approval. After the tool result, report completion without calling any other tool.`,
          "followUp",
        );
        const admission = await intent.send();
        await until(() =>
          events.some(
            (event) => event.type === "approval.requested" && event.taskId === admission.taskId,
          ),
        );
        const requests = events.filter((event) => event.type === "approval.requested");
        observe("original-pending-approval");
        assert.equal(requests.length, 1);
        const approval = requests[0]!
          .payload as unknown as import("../../packages/fortipi-contract/dist/index.js").Approval;
        assert.equal(approval.state, "pending");
        assert.equal(approval.operation.tool, tool);
        assert.deepEqual(approval.operation.arguments, dispatch.arguments);
        assert.deepEqual(approval.operation.target, target);
        assert.equal(approval.operation.workspaceId, workspace.binding.workspaceId);
        assert.equal(approval.operation.baseRevision, workspace.binding.revision);
        const before = await client.jobs.get(approval.jobId);
        assert.equal(before.taskId, admission.taskId);
        assert.equal(before.state, "awaiting_approval");
        assert.equal(before.execution, undefined);
        assert.deepEqual(
          await client.workspaces.get(workspace.binding.workspaceId),
          workspace.binding,
        );
        observe("wrong-digest-refusal");
        await assert.rejects(
          () =>
            client.approvals.decide(approval.approvalId, {
              requestId: randomUUID(),
              expectedVersion: approval.version,
              operationDigest: "0".repeat(64),
              decision: "approve",
            }),
          (error: unknown) => error instanceof module.FortiPiError && error.status === 409,
        );
        assert.equal((await client.jobs.get(approval.jobId)).execution, undefined);
        observe("exact-human-approval");
        await client.approvals.decide(approval.approvalId, {
          requestId: randomUUID(),
          expectedVersion: approval.version,
          operationDigest: approval.operation.operationDigest,
          decision: "approve",
        });
        if (cancellation) {
          // This is a public backend acknowledgement, not an observation of a
          // physical process start. The long body leaves a bounded window for
          // cancellation without adding a production scheduling/fault seam.
          await until(() =>
            events.some(
              (event) =>
                event.type === "job.state.changed" &&
                event.jobId === approval.jobId &&
                (event.payload as unknown as Job).state === "running",
            ),
          );
          const assigned = await client.jobs.get(approval.jobId);
          assert.equal(assigned.state, "running");
          assert.ok(assigned.execution);
          assert.deepEqual(assigned.execution.target, target);
          observe("cancel-acknowledged-assignment");
          const cancel = { requestId: randomUUID(), reason: "seed1010-public-cancellation" };
          const [receipt, duplicate] = await Promise.all([
            client.tasks.cancel(admission.taskId, cancel),
            client.tasks.cancel(admission.taskId, cancel),
          ]);
          assert.deepEqual(duplicate, receipt);
          assert.equal(receipt.durableIntent, true);
          assert.deepEqual(receipt.disposition, {
            state: "unknown",
            possibleExternalEffects: true,
          });
          await until(() =>
            events.some(
              (event) =>
                event.type === "job.state.changed" &&
                event.jobId === approval.jobId &&
                (event.payload as unknown as Job).state === "requires_reconciliation",
            ),
          );
          const uncertain = await client.jobs.get(approval.jobId);
          assert.equal(uncertain.state, "requires_reconciliation");
          assert.deepEqual(uncertain.execution, assigned.execution);
          assert.equal(uncertain.receipt, undefined);
          const acknowledge = {
            requestId: randomUUID(),
            expectedVersion: uncertain.version,
            reason: "Record uncertainty without asserting effects absent or retrying execution",
            action: { kind: "acknowledge-unknown" as const },
          };
          observe("uncertain-effects-cannot-be-relabeled-failed");
          await assert.rejects(
            () =>
              client.jobs.reconcile(uncertain.jobId, {
                ...acknowledge,
                requestId: randomUUID(),
                action: { kind: "acknowledge-failed" },
              }),
            (error: unknown) => error instanceof module.FortiPiError && error.status === 409,
          );
          observe("public-unknown-acknowledgement");
          const reconciliation = await client.jobs.reconcile(uncertain.jobId, acknowledge);
          assert.equal(reconciliation.durableIntent, true);
          assert.equal(reconciliation.disposition, "unknown-acknowledged");
          assert.equal(reconciliation.newJobId, undefined);
          assert.deepEqual(
            await client.jobs.reconcile(uncertain.jobId, acknowledge),
            reconciliation,
          );
          assert.deepEqual(await client.tasks.cancel(admission.taskId, cancel), receipt);
          assert.deepEqual(await intent.send(), admission);
          const retained = await client.jobs.get(uncertain.jobId);
          assert.equal(retained.state, "requires_reconciliation");
          assert.deepEqual(retained.execution, assigned.execution);
          assert.equal(retained.receipt, undefined);
          assert.deepEqual(
            await client.workspaces.get(workspace.binding.workspaceId),
            workspace.binding,
          );
          for (const file of workspace.files) {
            const bytes = await client.workspaces.read(workspace.binding.workspaceId, {
              revision: workspace.binding.revision,
              path: file.path,
            });
            assert.equal(bytes.byteLength, file.size);
            assert.equal(sha256(bytes), file.sha256);
          }
          const evidence: ScenarioEvidence = {
            observation: {
              backend: backend.kind,
              target,
              originalTaskId: admission.taskId,
              originalJobId: assigned.jobId,
              acknowledgedExecution: assigned.execution,
              cancellation: receipt,
              duplicateCancellationRetained: true,
              reconciliation,
              uncertainJobStateRetained: retained.state,
              originalAdmissionRetained: true,
              noNewJobRequested: true,
              failedRelabelStatus: 409,
              canonicalBindingAndOriginalHashesRetained: workspace.files,
              logicalApplicationId: protocol.deploymentId,
            },
            oracle:
              "Cancellation after public backend acknowledgement persists one reusable control receipt with possible effects; uncertain work cannot be relabeled failed, publish success, or acquire a replacement job when the same admission/control/reconciliation is retried",
            sensitivity: [
              "Public acknowledge-failed of the actual uncertain job rejects409; acknowledge-unknown preserves uncertainty and original execution",
            ],
            limitations: [
              "The running acknowledgement does not establish a physical process-start boundary",
              "Unpublished scratch effects remain possible; acknowledgement neither erases them nor authorizes replay",
              "Backend process-tree termination, runtime loss, separate hosts, egress, Linux FUSE/image identity and actual Paid account remain separate required proofs",
            ],
          };
          roles.assertSanitized(evidence);
          return evidence;
        }
        await until(() =>
          events.some(
            (event) => event.type === "task.completed" && event.taskId === admission.taskId,
          ),
        );
        const job: Job = await client.jobs.get(approval.jobId);
        observe("actual-job-result");
        if (job.state !== "completed")
          throw Object.assign(new Error("Actual cloud tool did not commit a completed job"), {
            diagnostic: {
              jobState: job.state,
              hasExecution: !!job.execution,
              hasReceipt: !!job.receipt,
              eventErrors: events
                .filter((event) => event.type === "job.failed")
                .map(
                  (event) =>
                    (event.payload as { error?: { error?: { code?: string } } })?.error?.error
                      ?.code ?? "unclassified",
                ),
            },
          });
        assert.equal(job.state, "completed");
        assert.equal(
          job.evidence.kind,
          "committed",
          "This tool must publish a real changed revision",
        );
        if (job.evidence.kind !== "committed")
          throw new Error("Actual committed publication evidence required");
        const receipt = job.evidence.receipt;
        assert.ok(job.execution);
        assert.deepEqual(job.execution.target, target);
        assert.equal(job.execution.jobId, job.jobId);
        assert.equal(job.execution.operationDigest, approval.operation.operationDigest);
        assert.equal(job.execution.lease.ownerKind, "job");
        if (job.execution.lease.ownerKind === "job")
          assert.equal(job.execution.lease.jobId, job.jobId);
        assert.equal(receipt.operationId, approval.operation.operationId);
        assert.equal(receipt.operationId, job.execution.lease.operationId);
        assert.equal(receipt.workspaceId, workspace.binding.workspaceId);
        assert.equal(receipt.baseRevision, workspace.binding.revision);
        if (receipt.jobId !== undefined) assert.equal(receipt.jobId, job.jobId);
        if (job.receipt) assert.deepEqual(job.receipt, receipt);
        const current: WorkspaceBinding = await client.workspaces.get(
          workspace.binding.workspaceId,
        );
        observe("committed-marker-and-original-bytes");
        assert.equal(current.revision, receipt.revision);
        const marker = await client.workspaces.read(current.workspaceId, {
          revision: current.revision,
          path,
        });
        assert.equal(Buffer.from(marker).toString("utf8"), content);
        for (const file of workspace.files) {
          const actual = await client.workspaces.read(current.workspaceId, {
            revision: current.revision,
            path: file.path,
          });
          assert.equal(actual.byteLength, file.size);
          assert.equal(sha256(actual), file.sha256);
        }
        assert.deepEqual(await intent.send(), admission);
        observe("same-receipt-no-new-publication");
        const retained = await client.jobs.get(job.jobId);
        assert.deepEqual(retained.execution, job.execution);
        assert.equal(retained.state, "completed");
        if (retained.state !== "completed" || retained.evidence.kind !== "committed")
          throw new Error("Original committed job evidence was lost after retry");
        assert.deepEqual(retained.evidence.receipt, receipt);
        const afterRetry = await client.workspaces.get(current.workspaceId);
        assert.equal(afterRetry.revision, current.revision);
        const evidence: ScenarioEvidence = {
          observation: {
            backend: backend.kind,
            target,
            originalTaskId: admission.taskId,
            originalJobId: job.jobId,
            execution: job.execution,
            receipt,
            originalAdmissionRetained: true,
            oneCommittedMarker: { path, size: marker.byteLength, sha256: sha256(marker) },
            originalFilesRetained: workspace.files,
            noAssignmentBeforeExactApproval: true,
            wrongApprovalDigestStatus: 409,
            revisionStableAfterRetry: true,
            logicalApplicationId: protocol.deploymentId,
          },
          oracle:
            "Actual model dispatch waits for exact human approval; stale digest cannot assign; actual selected runtime publishes independently hashed bytes and original receipt/identity survive retry without another publication",
          sensitivity: [
            "Wrong operation digest rejected409 with no execution identity before correct approval",
          ],
          limitations: [
            "One committed marker and stable public identity do not enumerate all physical starts",
            "Cancellation/uncertain-result reconciliation, egress, Linux FUSE/runtime/image identity, separate hosts and account ceilings remain required companion evidence",
          ],
        };
        roles.assertSanitized(evidence);
        return evidence;
      } finally {
        stream.close();
        await stream.done.catch(() => {});
      }
    },
  };
}

export function openPublicCloudTool(input: CloudToolInput) {
  return openPublicCloudOperation(input, false);
}

/** Shared public dispatch/approval oracle; no fixture endpoint is called here. */
export function openPublicCloudCancellation(input: CloudToolInput) {
  return openPublicCloudOperation(input, true);
}

export async function runPublicCloudTool(input: CloudToolInput): Promise<ScenarioEvidence> {
  return (await openPublicCloudTool(input)).run();
}

/** Never called locally with a fabricated deployment receipt. */
async function assertLiveCloudInput(input: CloudToolInput & { deployment: DeploymentIdentity }) {
  assertDeployment(input.deployment);
  assert.equal(input.deployment.origin, input.roles.endpoint);
  assert.notEqual(
    input.deployment.backend,
    "free",
    "Free target must not invoke Loader/Containers",
  );
  assert.equal(input.deployment.capabilities.plan, "paid");
  const configuration: Configuration = await input.roles.call({
    operationId: "getConfiguration",
    path: {},
    query: {},
    body: undefined,
  });
  assert.equal(sha256(canonicalJson(configuration)), input.deployment.runtimeConfigSha256);
  assert.equal(configuration.execution.kind, input.deployment.backend);
  if (configuration.execution.kind === "linux") {
    assert.equal(input.deployment.capabilities.containers, true);
    assert.equal(configuration.execution.imageDigest, input.deployment.imageDigest);
    assert.equal(input.deployment.imageDigest, input.installed.candidate.image.builtManifestDigest);
  } else assert.equal(input.deployment.capabilities.loaders, true);
}

async function liveCloudEvidence(
  input: CloudToolInput & { deployment: DeploymentIdentity },
  cancellation: boolean,
): Promise<ScenarioEvidence> {
  await assertLiveCloudInput(input);
  const evidence = await (await openPublicCloudOperation(input, cancellation)).run();
  return {
    ...evidence,
    observation: {
      ...evidence.observation,
      providerDeploymentId: input.deployment.deploymentId,
      authenticatedRuntimeConfigSha256: input.deployment.runtimeConfigSha256,
    },
  };
}

export function runLiveCloudTools(input: CloudToolInput & { deployment: DeploymentIdentity }) {
  return liveCloudEvidence(input, false);
}

export function runLiveCloudCancellation(
  input: CloudToolInput & { deployment: DeploymentIdentity },
) {
  return liveCloudEvidence(input, true);
}
