import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RoleContext } from "../../../../tests/clients/roles.ts";
import type * as D from "../../src/boundary/dto.js";
import { bootstrap } from "../agent/harness.ts";
import { nativeService } from "../execution/native-service.ts";
import { poll } from "./runtime.ts";

/** Trusted local coordinator only. Children receive the one executor profile,
 * never this source fixture, its administrator or another role. */
export async function nativeDaemonService() {
  const n = await nativeService({
    computer: true,
    approve: false,
    localConsent: false,
    reconciliation: true,
  });
  const { url } = await n.h.server.listen(),
    endpoint = new URL(url).origin;
  const roles = new RoleContext(endpoint, bootstrap);
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
    await n.probe.releaseCompletion();
    await poll(
      async () => (await n.h.api<D.Task>(`/v1/tasks/${n.sent.body.taskId}`)).body,
      (task) => ["completed", "failed", "cancelled"].includes(task.status.state),
    );
    n.runtime.session?.socket?.close();
    await poll(
      async () => n.runtime.connected,
      (value) => !value,
    );
    await n.runtime.shutdown();
    const executor = await roles.issue({
      requestId: randomUUID(),
      role: "executor",
      executorId: n.f.profile.executorId,
      expiresAt: Date.now() + 600000,
      grants: [{ grantId: randomUUID(), version: 1, resources: n.f.profile.resources }],
    });
    const client = await roles.issue({
      requestId: randomUUID(),
      role: "client",
      expiresAt: Date.now() + 600000,
      grants: [
        {
          grantId: randomUUID(),
          version: 1,
          resources: {
            ...n.f.profile.resources,
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
      return result.body;
    };
    return {
      endpoint,
      clientToken: client.token,
      profile: {
        ...structuredClone(n.f.profile),
        credential: executor.credential,
        token: executor.token,
      },
      async dispatch(command: string) {
        const binding = await n.h.api<D.WorkspaceBinding>(`/v1/workspaces/${n.workspaceId}`);
        assert.equal(binding.status, 200);
        const existing = new Set((await n.state()).jobs.map((value) => value.jobId));
        await n.probe.queueTool(
          JSON.stringify({
            tool: "shell",
            arguments: { command },
            workspaceId: n.workspaceId,
            baseRevision: binding.body.revision,
            target: {
              kind: "executor",
              executorId: n.f.profile.executorId,
              generation: n.f.profile.executorGeneration,
            },
            capabilities: ["shell"],
          }),
        );
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
        const state = await poll(n.state, (value) =>
          value.jobs.some((row) => !existing.has(row.jobId) && !!row.approvalId),
        );
        const next = state.jobs.find((row) => !existing.has(row.jobId))!;
        assert.ok(next.approvalId);
        return { jobId: next.jobId, taskId: sent.body.taskId, approvalId: next.approvalId };
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
          (executor) =>
            executor.executorId === n.f.profile.executorId && executor.state === "online",
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
      async settled(taskId: string) {
        return poll(
          async () =>
            (await n.h.api<D.Task>(`/v1/tasks/${taskId}`, undefined, "GET", client.token)).body,
          (task) => ["completed", "failed", "cancelled", "interrupted"].includes(task.status.state),
        );
      },
      async close() {
        const cleanup = await roles.cleanup();
        await n.close();
        assert.ok(
          cleanup.every((row) => row.state === "complete"),
          "Native coordinator ephemeral-role cleanup incomplete",
        );
      },
    };
  } catch (error) {
    await roles.cleanup();
    await n.close();
    throw error;
  }
}
