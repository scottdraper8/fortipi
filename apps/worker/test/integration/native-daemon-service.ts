import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { observeNativeEvidenceFailure } from "../../../../tests/clients/native-evidence-observation.ts";
import { RoleContext } from "../../../../tests/clients/roles.ts";
import type * as D from "../../src/boundary/dto.js";
import { bootstrap } from "../agent/harness.ts";
import { nativeService } from "../execution/native-service.ts";
import { poll } from "./runtime.ts";

async function observed<T>(phase: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    observeNativeEvidenceFailure(phase, error);
    throw error;
  }
}

/** Trusted local coordinator only. Children receive the one executor profile,
 * never this source fixture, its administrator or another role. */
export async function nativeDaemonService() {
  const n = await observed("service-native-setup", () =>
    nativeService({
      computer: true,
      approve: false,
      localConsent: false,
      reconciliation: true,
    }),
  );
  const { url } = await observed("service-listen", () => n.h.server.listen()),
    endpoint = new URL(url).origin;
  const roles = new RoleContext(endpoint, bootstrap);
  let phase = "service-seed-reject";
  try {
    const first = await n.h.api<D.Approval>(`/v1/approvals/${n.job.approvalId}`);
    assert.equal(first.status, 200);
    assert.equal(
      (
        await n.h.api(`/v1/approvals/${n.job.approvalId}/decisions`, {
          requestId: randomUUID(),
          expectedVersion: first.body.version,
          operationDigest: first.body.operation.operationDigest,
          decision: "reject",
        })
      ).status,
      200,
    );
    phase = "service-seed-settle";
    await n.probe.releaseCompletion();
    await poll(
      async () => (await n.h.api<D.Task>(`/v1/tasks/${n.sent.body.taskId}`)).body,
      (task) => ["completed", "failed", "cancelled"].includes(task.status.state),
    );
    phase = "service-seed-disconnect";
    n.runtime.session?.socket?.close();
    await poll(
      async () => n.runtime.connected,
      (value) => !value,
    );
    phase = "service-seed-shutdown";
    await n.runtime.shutdown();
    // The seed executor generation is already bound to its retained ledger.
    // A fresh installed ledger must enroll a fresh executor identity, rather
    // than try to replace that binding by issuing another credential.
    phase = "service-executor-enroll";
    const executorId = randomUUID();
    const resources = { ...n.f.profile.resources, executorIds: [executorId] };
    const executor = await roles.issue({
      requestId: randomUUID(),
      role: "executor",
      executorId,
      expiresAt: Date.now() + 600000,
      grants: [{ grantId: randomUUID(), version: 1, resources }],
    });
    phase = "service-client-issue";
    const client = await roles.issue({
      requestId: randomUUID(),
      role: "client",
      expiresAt: Date.now() + 600000,
      grants: [
        {
          grantId: randomUUID(),
          version: 1,
          resources: {
            ...resources,
            actions: [
              "messages.submit",
              "conversations.read",
              "tasks.read",
              "tasks.cancel",
              "jobs.dispatch",
              "jobs.read",
              "jobs.reconcile",
              "workspace.read",
              "workspace.write",
              "artifacts.read",
              "approvals.read",
              "approvals.decide",
            ],
          },
        },
      ],
    });
    const job = async (id: string) => {
      const result = await n.h.api<D.Job>(`/v1/jobs/${id}`, undefined, "GET", client.token);
      assert.equal(result.status, 200);
      assert.equal(result.body.jobId, id);
      return result.body;
    };
    const task = async (id: string) => {
      const result = await n.h.api<D.Task>(`/v1/tasks/${id}`, undefined, "GET", client.token);
      assert.equal(result.status, 200);
      assert.equal(result.body.taskId, id);
      assert.equal(result.body.conversationId, n.conversation.conversationId);
      return result.body;
    };
    return {
      endpoint,
      clientToken: client.token,
      profile: {
        ...structuredClone(n.f.profile),
        executorId,
        executorGeneration: 1,
        resources,
        credential: executor.credential,
        token: executor.token,
      },
      async dispatch(command: string) {
        let dispatchPhase = "service-dispatch-binding";
        try {
          const binding = await n.h.api<D.WorkspaceBinding>(`/v1/workspaces/${n.workspaceId}`);
          assert.equal(binding.status, 200);
          const existing = new Set((await n.state()).jobs.map((value) => value.jobId));
          dispatchPhase = "service-dispatch-queue";
          await n.probe.queueTool(
            JSON.stringify({
              tool: "shell",
              arguments: { command },
              workspaceId: n.workspaceId,
              baseRevision: binding.body.revision,
              target: {
                kind: "executor",
                executorId,
                generation: 1,
              },
              capabilities: ["shell"],
            }),
          );
          dispatchPhase = "service-dispatch-submit";
          const sent = await n.h.api<D.AdmissionReceipt>(
            `/v1/conversations/${n.conversation.conversationId}/messages`,
            {
              clientRequestId: randomUUID(),
              content: "seed1010-installed-native-job",
              busyBehavior: "followUp",
            },
            "POST",
            client.token,
          );
          assert.equal(sent.status, 202);
          dispatchPhase = "service-dispatch-approval";
          const state = await poll(n.state, (value) =>
            value.jobs.some((row) => !existing.has(row.jobId) && !!row.approvalId),
          );
          const next = state.jobs.find((row) => !existing.has(row.jobId))!;
          assert.ok(next.approvalId);
          return { jobId: next.jobId, taskId: sent.body.taskId, approvalId: next.approvalId };
        } catch (error) {
          observeNativeEvidenceFailure(dispatchPhase, error);
          throw error;
        }
      },
      async approve(approvalId: string) {
        const result = await n.h.api<D.Approval>(
          `/v1/approvals/${approvalId}`,
          undefined,
          "GET",
          client.token,
        );
        assert.equal(result.status, 200);
        assert.equal(
          (
            await n.h.api(
              `/v1/approvals/${approvalId}/decisions`,
              {
                requestId: randomUUID(),
                expectedVersion: result.body.version,
                operationDigest: result.body.operation.operationDigest,
                decision: "approve",
              },
              "POST",
              client.token,
            )
          ).status,
          200,
        );
      },
      job,
      async online() {
        const page = await n.h.api<D.ExecutorPage>("/v1/executors");
        assert.equal(page.status, 200);
        return page.body.items.some(
          (executor) => executor.executorId === executorId && executor.state === "online",
        );
      },
      async acknowledgeUnknown(jobId: string) {
        const current = await job(jobId);
        const input: D.ReconcileInput = {
          requestId: randomUUID(),
          expectedVersion: current.version,
          reason:
            "Synthetic owned confinement case: preserve unknown disposition without retrying the original job",
          action: { kind: "acknowledge-unknown" },
        };
        const result = await n.h.api<D.ReconcileReceipt>(
          `/v1/jobs/${jobId}/reconcile`,
          input,
          "POST",
          client.token,
        );
        assert.equal(result.status, 202);
        assert.equal(result.body.disposition, "unknown-acknowledged");
      },
      async cancelTask(taskId: string, requestId: string) {
        await task(taskId);
        const input: D.TaskControl = {
          requestId,
          reason: "Settle the refused confinement case without retrying its original job",
        };
        const result = await n.h.api<D.ControlReceipt>(
          `/v1/tasks/${taskId}/cancel`,
          input,
          "POST",
          client.token,
        );
        assert.equal(result.status, 202);
        assert.match(result.body.operationId, /^[A-Za-z0-9_-]{1,128}$/);
        assert.equal(result.body.durableIntent, true);
        assert.ok(["unknown", "already-terminal"].includes(result.body.disposition.state));
        assert.equal(result.body.disposition.possibleExternalEffects, true);
      },
      async settled(taskId: string) {
        return poll(
          () => task(taskId),
          (task) => ["completed", "failed", "cancelled", "interrupted"].includes(task.status.state),
        );
      },
      async close() {
        const cleanup = await observed("service-cleanup-roles", () => roles.cleanup());
        await observed("service-cleanup-runtime", () => n.close());
        assert.ok(
          cleanup.every((row) => row.state === "complete"),
          "Native coordinator ephemeral-role cleanup incomplete",
        );
      },
    };
  } catch (error) {
    observeNativeEvidenceFailure(phase, error);
    await observed("service-cleanup-roles", () => roles.cleanup());
    await observed("service-cleanup-runtime", () => n.close());
    throw error;
  }
}
