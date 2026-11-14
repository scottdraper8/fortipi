import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { routingPeer } from "../execution/routing-peer.ts";
import type { TestAgentSession } from "./enforcer-current-internal-expiry-worker.js";
import { eventually, harness, pause, setup } from "./harness.ts";

// Publication requires current authority when the final asynchronous check
// returns, including credential expiry during its own real metadata reads.
test("private job publication rejects credential expiry inside the final authority metadata await", {
  timeout: 20000,
}, async () => {
  const h = await harness({
    main: resolve("apps/worker/test/agent/enforcer-current-internal-expiry-worker.ts"),
    traffic: "free",
  });
  let probe: DurableObjectStub<TestAgentSession> | undefined;
  let pending: Promise<{ status: number; body: D.Job | D.ErrorBody }> | undefined;
  let native: Awaited<ReturnType<typeof routingPeer>> | undefined;
  try {
    const { agent, conversation } = await setup(h);
    probe = h.env.AGENT_SESSIONS.getByName(
      agent.agentId,
    ) as unknown as DurableObjectStub<TestAgentSession>;
    const workspace = await h.api<D.WorkspaceBinding>("/v1/workspaces", {
      requestId: crypto.randomUUID(),
      config: { kind: "computer" },
    });
    assert.equal(workspace.status, 201);
    native = await routingPeer(h, workspace.body, agent.agentId, conversation.conversationId);
    await probe.queueTool(
      JSON.stringify({
        tool: "shell",
        arguments: { command: "echo awaiting-approval" },
        workspaceId: workspace.body.workspaceId,
        baseRevision: workspace.body.revision,
        target: { kind: "executor", executorId: native.executorId, generation: 1 },
        capabilities: ["shell"],
      }),
    );
    assert.equal(
      (
        await h.api<D.AdmissionReceipt>(
          `/v1/conversations/${conversation.conversationId}/messages`,
          {
            clientRequestId: crypto.randomUUID(),
            content: "prepare one private job awaiting approval",
            busyBehavior: "followUp",
          },
        )
      ).status,
      202,
    );
    const observer = probe;
    const waiting = await eventually(
      async () =>
        JSON.parse(await observer.toolStateJson(conversation.conversationId)) as {
          jobs: { jobId: string; state: D.JobState; hasExecution: boolean }[];
        },
      (state) => state.jobs[0]?.state === "awaiting_approval",
    );
    assert.equal(waiting.jobs.length, 1);
    const job = waiting.jobs[0];
    assert.ok(job);
    assert.equal(job.hasExecution, false);
    const expiresAt = Date.now() + 5000;
    const issued = await h.api<D.CredentialReceipt>("/v1/admin/credentials", {
      requestId: crypto.randomUUID(),
      role: "client",
      expiresAt,
      grants: [
        {
          grantId: "permanent-private-job-read",
          version: 1,
          resources: {
            agentIds: [agent.agentId],
            conversationIds: [conversation.conversationId],
            workspaceIds: [],
            executorIds: [],
            backendIds: [],
            tools: [],
            actions: ["jobs.read"],
          },
        },
      ],
    });
    assert.equal(issued.status, 201);
    if (issued.body.state !== "issued") assert.fail("Actual scoped synthetic credential required");
    const path = `/v1/jobs/${job.jobId}`;
    const positive = await h.api<D.Job>(path, undefined, "GET", issued.body.token);
    assert.equal(positive.status, 200, "The same credential must first read the known private job");
    assert.equal(positive.body.jobId, job.jobId);
    await probe.armCurrentExpiry(job.jobId, issued.body.credential.credentialId);
    let settled = false;
    pending = h
      .api<D.Job | D.ErrorBody>(path, undefined, "GET", issued.body.token)
      .then((result) => {
        settled = true;
        return result;
      });
    const held = await eventually(
      () => observer.currentExpiryGate(),
      (gate) => gate.entered,
    );
    assert.ok(
      held.authorizedAt !== null &&
        held.selectedAt !== null &&
        held.currentEnteredAt !== null &&
        held.floorReadAt !== null &&
        held.metadataReadAt !== null,
      "Actual authorize, payload selection and both final authority reads must be observed",
    );
    assert.ok(
      held.authorizedAt <= held.selectedAt &&
        held.selectedAt <= held.currentEnteredAt &&
        held.currentEnteredAt <= held.floorReadAt &&
        held.floorReadAt <= held.metadataReadAt &&
        held.metadataReadAt < expiresAt,
      "The real final authority metadata return must be held while the credential is valid",
    );
    assert.equal(held.credentialExpiresAt, expiresAt);
    assert.ok(held.deadline !== null && held.deadline > expiresAt);
    assert.equal(held.registered, true);
    assert.equal(held.permanentGrants, true, "No resource grant may expire in this case");
    assert.equal(
      await probe.queuedJobRead(job.jobId),
      job.jobId,
      "A second real queued read must finish while the internal metadata return is held",
    );
    assert.equal((await probe.currentExpiryGate()).currentFinishedAt, null);
    assert.equal(settled, false, "The public request must still be inside its final current check");
    await pause(Math.max(0, expiresAt - Date.now() + 30));
    const releasedAt = Date.now();
    assert.ok(releasedAt > expiresAt && releasedAt < held.deadline);
    const fresh = await h.api<D.ErrorBody>(path, undefined, "GET", issued.body.token);
    // CP authentication's documented unauthenticated result is HTTP401;
    // an already-authenticated Agent current-authority denial is HTTP403.
    assert.equal(
      fresh.status,
      401,
      "Actual fresh authentication must reject the expired credential",
    );
    assert.equal(fresh.body.error.code, "unauthenticated");
    await probe.releaseCurrentExpiry();
    const response = await pending;
    const completed = await probe.currentExpiryGate();
    const containsJob = "jobId" in response.body;
    console.log({
      positiveStatus: positive.status,
      actualAuthoritySucceededBeforeSelection: true,
      finalCurrentEnteredBeforeExpiry: held.currentEnteredAt < expiresAt,
      realMetadataReturnedBeforeExpiry: held.metadataReadAt < expiresAt,
      grantsPermanent: held.permanentGrants,
      gateEntered: held.entered,
      queueAvailableWhileHeld: true,
      requestStillInsideCurrentWhileHeld: true,
      expiredForMsBeforeRelease: releasedAt - expiresAt,
      freshExpiredStatus: fresh.status,
      finalCurrentReturnedAfterExpiry:
        completed.currentFinishedAt !== null && completed.currentFinishedAt > expiresAt,
      finalCurrentSucceeded: completed.currentSucceeded,
      heldResponseStatus: response.status,
      heldPayloadContainsPrivateJob: containsJob,
    });
    assert.equal(
      response.status,
      403,
      "Private job payload published after credential expired during final authority metadata await",
    );
    assert.equal(containsJob, false);
  } finally {
    await probe?.releaseCurrentExpiry();
    await pending?.catch(() => {});
    await native?.close();
    await h.close();
  }
});
