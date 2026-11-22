import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { nodeCommand } from "../../../../packages/fortipi-executor/test/fixtures/daemon.ts";
import type { DecisionClientPort } from "../../../../tests/clients/evidence.ts";
import { RoleContext } from "../../../../tests/clients/roles.ts";
import type * as D from "../../src/boundary/dto.js";
import { bootstrap } from "../agent/harness.ts";
import { nativeService } from "../execution/native-service.ts";
import { bytes, hashes } from "./fixture-state.ts";
import { poll } from "./runtime.ts";
import { readWorkspace } from "./workspace-portability.ts";

/** Real CP, Pi child, Computer/local authority and native executor. The model
 * supplies deterministic tool input; it never supplies a scheduler or ledger. */
export async function executionDecisions(
  decideInitial?: (port: DecisionClientPort) => Promise<void>,
) {
  const n = await nativeService({
    approve: false,
    localConsent: false,
    holdCommit: true,
    control: true,
    reconciliation: true,
  });
  const starts = () => readFile(n.marker, "utf8").catch(() => "");
  const job = async (id: string) => {
    const view = await n.h.api<D.Job>(`/v1/jobs/${id}`, undefined, "GET", n.actor.token);
    assert.equal(view.status, 200);
    return view.body;
  };
  try {
    assert.equal(await starts(), "", "Remote consent must precede every actual start");
    const approval = await n.h.api<D.Approval>(
      `/v1/approvals/${n.job.approvalId}`,
      undefined,
      "GET",
      n.actor.token,
    );
    assert.equal(approval.status, 200);
    const decide = (changes: Record<string, unknown>) =>
      n.h.api(
        `/v1/approvals/${n.job.approvalId}/decisions`,
        {
          requestId: randomUUID(),
          expectedVersion: approval.body.version,
          operationDigest: approval.body.operation.operationDigest,
          decision: "approve",
          ...changes,
        },
        "POST",
        n.actor.token,
      );
    assert.equal((await decide({ operationDigest: "f".repeat(64) })).status, 409);
    assert.equal((await decide({ expectedVersion: approval.body.version + 1 })).status, 409);
    assert.equal(await starts(), "");
    const assertRejectedWithoutProcessStart = async () => {
      await poll(
        () => job(n.job.jobId),
        (value) => value.state === "cancelled",
      );
      assert.equal(
        await starts(),
        "",
        "Keyboard/public rejection must leave zero external process starts",
      );
    };
    if (decideInitial) {
      const { url } = await n.h.server.listen();
      const roles = new RoleContext(new URL(url).origin, bootstrap);
      try {
        const role = await roles.issue({
          requestId: randomUUID(),
          role: "client",
          grants: [
            {
              grantId: randomUUID(),
              version: 1,
              resources: {
                agentIds: [n.agent.agentId],
                conversationIds: [n.conversation.conversationId],
                workspaceIds: [n.workspaceId],
                executorIds: [n.f.profile.executorId],
                backendIds: [],
                tools: ["shell"],
                actions: [
                  "agents.list",
                  "agents.read",
                  "conversations.list",
                  "conversations.create",
                  "conversations.read",
                  "messages.submit",
                  "tasks.read",
                  "events.read",
                  "tickets.mint",
                  "jobs.read",
                  "approvals.read",
                  "approvals.decide",
                ],
              },
            },
          ],
        });
        await decideInitial({
          role: {
            endpoint: roles.endpoint,
            token: role.token,
            agentId: n.agent.agentId,
            conversationId: n.conversation.conversationId,
          },
          firstJob: { jobId: n.job.jobId, approvalId: n.job.approvalId! },
          assertRejectedAndSettledWithoutStart: async () => {
            await assertRejectedWithoutProcessStart();
            await n.probe.releaseCompletion();
            await poll(
              async () =>
                (
                  await n.h.api<D.Task>(
                    `/v1/tasks/${n.sent.body.taskId}`,
                    undefined,
                    "GET",
                    n.actor.token,
                  )
                ).body,
              (value) => ["completed", "failed", "cancelled"].includes(value.status.state),
            );
          },
        });
      } finally {
        assert.ok(
          (await roles.cleanup()).every((role) => role.state === "complete"),
          "TUI application role revocation is pending/unknown",
        );
      }
    } else {
      assert.equal((await decide({ decision: "reject" })).status, 200);
      await assertRejectedWithoutProcessStart();
    }
    await n.probe.releaseCompletion();
    await poll(
      async () =>
        (await n.h.api<D.Task>(`/v1/tasks/${n.sent.body.taskId}`, undefined, "GET", n.actor.token))
          .body,
      (value) => ["completed", "failed", "cancelled"].includes(value.status.state),
    );
    const before = await n.state();
    const originalChildren = before.tasks
      .filter((task) => task.kind === "fortipi.dispatch")
      .map((task) => task.id);
    const binding = await n.h.api<D.WorkspaceBinding>(`/v1/workspaces/${n.workspaceId}`);
    assert.equal(binding.status, 200);
    const nonce = randomUUID();
    const command = nodeCommand(
      resolve(import.meta.dirname, "../../../../tests/clients/fixtures/process-marker.ts"),
      n.marker,
      nonce,
      "workspace",
    );
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
    const input: D.MessageSubmit = {
      clientRequestId: randomUUID(),
      content: "seed1010-actual-consent",
      busyBehavior: "followUp",
    };
    const admitted = await n.h.api<D.AdmissionReceipt>(
      `/v1/conversations/${n.conversation.conversationId}/messages`,
      input,
      "POST",
      n.actor.token,
    );
    assert.equal(admitted.status, 202);
    const waiting = await poll(n.state, (value) =>
      value.jobs.some((row) => row.jobId !== n.job.jobId && !!row.approvalId),
    );
    const next = waiting.jobs.find((row) => row.jobId !== n.job.jobId)!;
    assert.ok(next.approvalId);
    const remote = await n.h.api<D.Approval>(
      `/v1/approvals/${next.approvalId}`,
      undefined,
      "GET",
      n.actor.token,
    );
    assert.equal(remote.status, 200);
    assert.equal(await starts(), "");
    const accepted = await n.h.api(
      `/v1/approvals/${next.approvalId}/decisions`,
      {
        requestId: randomUUID(),
        expectedVersion: remote.body.version,
        operationDigest: remote.body.operation.operationDigest,
        decision: "approve",
      },
      "POST",
      n.actor.token,
    );
    assert.equal(accepted.status, 200);
    const pending = await poll(
      async () => n.runtime.approvals.list().find((entry) => entry.jobId === next.jobId),
      Boolean,
    );
    assert.ok(pending);
    assert.equal(
      await starts(),
      "",
      "Actual remote approval alone cannot replace independent native consent",
    );
    assert.throws(() => n.runtime.approvals.decide(next.jobId, "0".repeat(64), "allow"));
    n.runtime.approvals.decide(next.jobId, pending.digest, "allow");
    await n.runtime.tick();
    await poll(starts, (value) => value.includes(nonce));
    const row = n.f.ledger.get(next.jobId);
    assert.ok(row);
    const repeated = await Promise.all([
      n.runtime.assignOnce(row.assignment),
      n.runtime.assignOnce(row.assignment),
    ]);
    assert.equal(repeated.length, 2);
    assert.equal(
      await starts(),
      `${nonce}\n`,
      "Concurrent duplicate assignment must retain one fsynced actual start",
    );
    await poll(
      () => job(next.jobId),
      (value) => value.state === "result_pending_commit",
    );
    assert.equal(
      n.f.ledger.get(next.jobId)?.committed,
      undefined,
      "Prepared native result is not a committed success",
    );
    await n.probe.releaseNativeCommit();
    const completed = await poll(
      () => job(next.jobId),
      (value) => value.state === "completed",
    );
    if (completed.state !== "completed")
      assert.fail("Actual completed job must carry terminal proof");
    assert.equal(
      completed.evidence.kind,
      "committed",
      "Actual generated files require a workspace receipt",
    );
    await poll(
      async () => n.f.ledger.get(next.jobId),
      (value) => !!value?.committed,
    );
    assert.equal(await starts(), `${nonce}\n`);
    const current = await n.h.api<D.WorkspaceBinding>(`/v1/workspaces/${n.workspaceId}`);
    assert.equal(current.status, 200);
    for (const [path, expected] of Object.entries(bytes)) {
      const actual = await readFile(resolve(n.f.rootPath, path));
      assert.equal(actual.byteLength, expected.byteLength);
      assert.equal(createHash("sha256").update(actual).digest("hex"), hashes[path]);
    }
    const { url } = await n.h.server.listen();
    await readWorkspace(
      { endpoint: new URL(url).origin, api: n.h.api },
      current.body,
      n.actor.token,
      bytes,
    );
    const roles = new RoleContext(new URL(url).origin, bootstrap);
    try {
      const denied = await roles.issue({
        requestId: randomUUID(),
        role: "client",
        grants: [
          {
            grantId: randomUUID(),
            version: 1,
            resources: {
              agentIds: [],
              conversationIds: [],
              workspaceIds: [n.workspaceId],
              executorIds: [],
              backendIds: [],
              tools: [],
              actions: ["workspace.write"],
            },
          },
        ],
      });
      const refused = await fetch(
        `${roles.endpoint}/v1/workspaces/${n.workspaceId}/read?${new URLSearchParams({ revision: current.body.revision, path: "binary.bin" })}`,
        {
          headers: { Authorization: `Bearer ${denied.token}` },
          redirect: "error",
          signal: AbortSignal.timeout(20000),
        },
      );
      assert.equal(
        refused.status,
        403,
        "Write-only authority cannot read the actual native owner's bytes",
      );
      await refused.body?.cancel();
    } finally {
      assert.ok((await roles.cleanup()).every((role) => role.state === "complete"));
    }
    assert.deepEqual(
      await n.h.api(
        `/v1/conversations/${n.conversation.conversationId}/messages`,
        input,
        "POST",
        n.actor.token,
      ),
      admitted,
    );
    const children = (await n.state()).tasks
      .filter((task) => task.kind === "fortipi.dispatch")
      .map((task) => task.id);
    assert.equal(
      children.length,
      originalChildren.length + 1,
      "One original tool invocation must attach exactly one supported actual Pi child",
    );
    assert.ok(n.runtime.session?.socket);
    n.runtime.session.socket.close();
    await poll(
      async () => (await n.h.api<D.ExecutorPage>("/v1/executors")).body,
      (page) =>
        page.items.some(
          (executor) =>
            executor.executorId === n.f.profile.executorId && executor.state === "offline",
        ),
    );
    const unavailable = await fetch(
      `${new URL(url).origin}/v1/workspaces/${n.workspaceId}/read?${new URLSearchParams({ revision: current.body.revision, path: "binary.bin" })}`,
      {
        headers: { Authorization: `Bearer ${n.actor.token}` },
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      },
    );
    assert.equal(
      unavailable.status,
      503,
      "Loss of the actual local byte owner must be unavailable, never fabricated bytes",
    );
    const failure = (await unavailable.json()) as D.ErrorBody;
    assert.equal(failure.error.code, "unavailable_executor");
    const retainedConversation = await n.h.api<D.ConversationProjection>(
      `/v1/conversations/${n.conversation.conversationId}`,
      undefined,
      "GET",
      n.actor.token,
    );
    assert.equal(
      retainedConversation.status,
      200,
      "Conversation continuity is independent of the local byte owner",
    );
    return {
      actualPiChildrenAdded: 1,
      originalRemoteRejection: true,
      wrongDigestStatus: 409,
      wrongVersionStatus: 409,
      independentLocalConsent: true,
      noStartBeforeBothConsents: true,
      concurrentAssignments: 2,
      actualFsyncedStarts: 1,
      preparedResultWasNotTerminal: true,
      finalEvidence: completed.evidence.kind,
      scopedRelay: {
        actualNativeOwner: true,
        actualPublicRead: true,
        independentHashes: hashes,
        binaryBytes: bytes["binary.bin"].byteLength,
        multiChunkBytes: bytes["multi.bin"].byteLength,
        writeOnlyReadStatus: 403,
        ownerOfflinePublicState: true,
        ownerLossReadStatus: unavailable.status,
        conversationAfterOwnerLoss: retainedConversation.status,
      },
      originalAdmissionRetained: true,
      platform: process.platform,
      limitations: [
        "Synthetic model; actual native process/service/SQLite",
        "Interruption, reconciliation and device replacement require companion observations",
      ],
    };
  } finally {
    await n.close();
  }
}
