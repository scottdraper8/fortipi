import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { eventually } from "../agent/harness.ts";
import { nativeService } from "./native-service.ts";

test("fresh native business jobs require current credential and executor authority", {
  timeout: 40000,
}, async () => {
  const n = await nativeService({ approve: false });
  try {
    assert.ok(n.job.approvalId);
    const approval = await n.h.api<D.Approval>(`/v1/approvals/${n.job.approvalId}`);
    assert.equal(approval.status, 200);
    assert.equal(
      (
        await n.h.api(
          `/v1/approvals/${n.job.approvalId}/decisions`,
          {
            requestId: crypto.randomUUID(),
            expectedVersion: approval.body.version,
            operationDigest: approval.body.operation.operationDigest,
            decision: "reject",
          },
          "POST",
          n.actor.token,
        )
      ).status,
      200,
    );
    await eventually(n.state, (view) => view.jobs[0]?.state === "cancelled");
    const current = await n.h.api<D.Job>(`/v1/jobs/${n.job.jobId}`),
      executorId = n.f.profile.executorId;
    const creator = await n.h.api<D.CredentialReceipt>("/v1/admin/credentials", {
      requestId: crypto.randomUUID(),
      role: "client",
      expiresAt: Date.now() + 180000,
      grants: [
        {
          grantId: "fresh-native-business-authority",
          version: 1,
          resources: {
            agentIds: [n.agent.agentId],
            conversationIds: [n.conversation.conversationId],
            workspaceIds: [n.workspaceId],
            executorIds: [executorId],
            backendIds: [],
            tools: ["shell"],
            actions: ["jobs.reconcile", "jobs.dispatch", "workspace.write"],
          },
        },
      ],
    });
    assert.equal(creator.status, 201);
    if (creator.body.state !== "issued") assert.fail("Actual scoped business credential required");
    const input: D.ReconcileInput = {
      requestId: crypto.randomUUID(),
      expectedVersion: current.body.version,
      reason: "Create one fresh native job",
      action: { kind: "new-job", authorizationId: crypto.randomUUID() },
    };
    const accepted = await n.h.api<D.ReconcileReceipt>(
      `/v1/jobs/${n.job.jobId}/reconcile`,
      input,
      "POST",
      creator.body.token,
    );
    assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
    const waiting = await eventually(n.state, (view) =>
      view.jobs.some(
        (job) => job.jobId === accepted.body.newJobId && job.state === "awaiting_approval",
      ),
    );
    assert.equal(waiting.tasks.filter((task) => task.kind === "fortipi.dispatch").length, 2);
    const revoked = await n.h.api(
      `/v1/admin/credentials/${creator.body.credential.credentialId}/revoke`,
      { requestId: crypto.randomUUID(), expectedGeneration: creator.body.credential.generation },
    );
    assert.ok([200, 202].includes(revoked.status));
    const retry = await n.h.api(
      `/v1/jobs/${n.job.jobId}/reconcile`,
      input,
      "POST",
      creator.body.token,
    );
    assert.ok(
      [401, 403].includes(retry.status),
      "A business authorization ID grants nothing after credential revocation",
    );
    assert.equal(
      (await n.state()).tasks.filter((task) => task.kind === "fortipi.dispatch").length,
      2,
    );
    const revokeExecutor = await n.h.api(`/v1/admin/executors/${executorId}/revoke`, {
      requestId: crypto.randomUUID(),
      expectedGeneration: n.f.profile.executorGeneration,
    });
    assert.ok([200, 202].includes(revokeExecutor.status));
    const executor = await n.h.api<D.ExecutorDescription>(`/v1/executors/${executorId}`);
    assert.ok(
      executor.status === 404 ||
        (executor.status === 200 &&
          (executor.body.generation > 1 || executor.body.state === "revoking")),
      "Revoked executors may be absent from the public current directory",
    );
    const original = await n.h.api<D.Job>(`/v1/jobs/${n.job.jobId}`);
    const changedGeneration = await n.h.api<{ error: D.ProtocolError }>(
      `/v1/jobs/${n.job.jobId}/reconcile`,
      {
        requestId: crypto.randomUUID(),
        expectedVersion: original.body.version,
        reason: "Do not guess a replacement executor generation",
        action: { kind: "new-job", authorizationId: crypto.randomUUID() },
      },
    );
    assert.ok(
      (changedGeneration.status === 409 && changedGeneration.body.error.code === "conflict") ||
        (changedGeneration.status === 503 &&
          changedGeneration.body.error.code === "unavailable_executor"),
      "Current local generation floor or authoritative revoked-target lookup must reject the retained target",
    );
    assert.equal(
      (await n.state()).jobs.length,
      2,
      "No replacement job is seeded for the stale selected target",
    );
    assert.equal(
      n.f.ledger.identities().length,
      0,
      "No remote assignment before fresh approval or after authority drift",
    );
    assert.equal(await readFile(n.marker, "utf8").catch(() => ""), "");
    console.log(
      JSON.stringify({
        revokedBusinessRetry: retry.status,
        publicExecutorStatus: executor.status,
        ...(executor.status === 200
          ? {
              actualExecutorGeneration: executor.body.generation,
              actualExecutorState: executor.body.state,
            }
          : {}),
        staleGenerationRequest: changedGeneration.status,
        actualDispatchChildren: 2,
        actualProcessStarts: 0,
      }),
    );
  } finally {
    await n.close();
  }
});
