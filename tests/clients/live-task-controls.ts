import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { DurableEvent } from "../../packages/fortipi-contract/dist/index.js";
import {
  assertDeployment,
  canonicalJson,
  type DeploymentIdentity,
  sha256,
} from "../../scripts/verify-release-gates.ts";
import type { ScenarioEvidence } from "./evidence.ts";
import { openRecoveryCanary } from "./platform-recovery.ts";

type Input = Parameters<typeof openRecoveryCanary>[0];

async function until(read: () => boolean) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (read()) return;
    await new Promise<void>((accept) => setTimeout(accept, 50));
  }
  throw new Error("Public task control did not reach its required durable boundary");
}

/** The same public model-driven approval wait used by the recovery canary.
 * No executor is online and no backend is invoked. Local qualification queues
 * faux model input outside this port; live uses the unchanged real model. */
export async function openPublicTaskControls(input: Input) {
  const pending = await openRecoveryCanary(input);
  return {
    dispatch: pending.dispatch,
    async run(): Promise<ScenarioEvidence> {
      const before = await pending.seed();
      const module = (await import(
        pathToFileURL(
          input.installed.resolveExport(`@${input.installed.candidate.scope}/fortipi-client/node`),
        ).href
      )) as typeof import("../../packages/fortipi-client/dist/node.js");
      const role = await input.roles.issue({
        requestId: randomUUID(),
        role: "client",
        expiresAt: Date.now() + 900000,
        grants: [
          {
            grantId: randomUUID(),
            version: 1,
            resources: {
              agentIds: [input.agentId],
              conversationIds: [before.conversationId],
              workspaceIds: [],
              executorIds: [],
              backendIds: [],
              tools: [],
              actions: ["tasks.cancel"],
            },
          },
        ],
      });
      const controller = new module.FortiPiClient({
        endpoint: input.roles.endpoint,
        credentials: async () => role.token,
        allowLoopbackHttp: new URL(input.roles.endpoint).protocol === "http:",
      });
      const client = pending.client;
      const control = { requestId: randomUUID(), reason: "seed1010-cancel-before-assignment" };
      await assert.rejects(
        () => client.tasks.cancel(before.admission.taskId, control),
        (error: unknown) => error instanceof module.FortiPiError && error.status === 403,
        "The existing read/submit/approval role has no task cancellation grant",
      );
      const untouched = await client.jobs.get(before.jobId);
      assert.equal(untouched.state, "awaiting_approval");
      assert.equal(untouched.execution, undefined);
      const events: DurableEvent[] = [];
      const stream = client.conversations.subscribe(before.conversationId, {
        agentId: input.agentId,
        maxReconnects: 0,
        onSnapshot() {},
        onEvent(event) {
          if (event.durability === "durable") events.push(event);
        },
      });
      try {
        await stream.ready;
        const [cancelled, duplicate] = await Promise.all([
          controller.tasks.cancel(before.admission.taskId, control),
          controller.tasks.cancel(before.admission.taskId, control),
        ]);
        assert.deepEqual(duplicate, cancelled);
        assert.equal(cancelled.durableIntent, true);
        assert.deepEqual(cancelled.disposition, {
          state: "unknown",
          possibleExternalEffects: true,
        });
        await until(() =>
          events.some(
            (event) =>
              event.type === "task.interrupted" && event.taskId === before.admission.taskId,
          ),
        );
        const task = await client.tasks.get(before.admission.taskId);
        assert.equal(task.status.state, "cancelled");
        const job = await client.jobs.get(before.jobId);
        assert.equal(job.state, "cancelled");
        assert.equal(job.execution, undefined);
        assert.equal(job.receipt, undefined);

        // A new terminal control may report already-terminal; the acknowledged
        // earlier receipt remains immutable, including its possible effects.
        const terminal = await controller.tasks.cancel(before.admission.taskId, {
          requestId: randomUUID(),
          reason: "seed1010-current-terminal-observation",
        });
        assert.deepEqual(terminal.disposition, {
          state: "already-terminal",
          possibleExternalEffects: true,
        });
        assert.notEqual(terminal.operationId, cancelled.operationId);
        assert.deepEqual(
          await controller.tasks.cancel(before.admission.taskId, control),
          cancelled,
        );

        const approved = await client.approvals.decide(before.approval.approvalId, {
          requestId: randomUUID(),
          expectedVersion: before.approval.version,
          operationDigest: before.approval.operation.operationDigest,
          decision: "approve",
        });
        assert.equal(approved.state, "approved");
        const retained = await client.jobs.get(before.jobId);
        assert.equal(retained.state, "cancelled");
        assert.equal(retained.execution, undefined);
        assert.equal((await client.tasks.get(before.admission.taskId)).status.state, "cancelled");
        assert.deepEqual(
          await client.workspaces.get(input.workspace.binding.workspaceId),
          input.workspace.binding,
        );
        for (const file of input.workspace.files) {
          const bytes = await client.workspaces.read(input.workspace.binding.workspaceId, {
            revision: input.workspace.binding.revision,
            path: file.path,
          });
          assert.equal(bytes.byteLength, file.size);
          assert.equal(sha256(bytes), file.sha256);
        }
        const evidence: ScenarioEvidence = {
          observation: {
            taskId: before.admission.taskId,
            jobId: before.jobId,
            approvalId: before.approval.approvalId,
            deniedWithoutCancelGrant: 403,
            originalControl: cancelled,
            terminalControl: terminal,
            originalControlRetained: true,
            lateApprovalRecorded: approved.state,
            jobRemainsCancelled: true,
            executionIdentityAbsent: true,
            originalWorkspaceHashesRetained: input.workspace.files,
          },
          oracle:
            "Actual pending model dispatch has no assignment before approval; unauthorized cancellation cannot alter it, authorized cancellation persists one immutable receipt, and a later approval cannot resurrect the cancelled job or publish workspace effects",
          sensitivity: [
            "Public cancellation without tasks.cancel refuses403 and preserves the real pending job",
          ],
          limitations: [
            "Supported human-approval wait before assignment; no running executor, physical start/termination, runtime loss or separate-host claim",
            "Conservative possibleExternalEffects is retained even when this job never acquired an execution identity",
            "Actual deployed model/provider proof requires the live wrapper on its authenticated unchanged target",
          ],
        };
        input.roles.assertSanitized(evidence);
        return evidence;
      } finally {
        stream.close();
        await stream.done.catch(() => {});
      }
    },
  };
}

export async function runLiveTaskControls(input: Input & { deployment: DeploymentIdentity }) {
  assertDeployment(input.deployment);
  assert.equal(input.roles.endpoint, input.deployment.origin);
  const configuration = await input.roles.call({
    operationId: "getConfiguration",
    path: {},
    query: {},
    body: undefined,
  });
  assert.equal(sha256(canonicalJson(configuration)), input.deployment.runtimeConfigSha256);
  return (await openPublicTaskControls(input)).run();
}
