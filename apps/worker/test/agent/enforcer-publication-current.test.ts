import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import type { TestAgentSession } from "./enforcer-publication-current-worker.js";
import { eventually, harness, pause, setup } from "./harness.ts";

// Current authority must still cover private payload publication after an
// asynchronous owner read; an earlier successful check is not an enduring grant.
test("public job read cannot publish captured data after its actual credential expires", {
  timeout: 20000,
}, async () => {
  const h = await harness({
    main: resolve("apps/worker/test/agent/enforcer-publication-current-worker.ts"),
    traffic: "free",
  });
  let probe: DurableObjectStub<TestAgentSession> | undefined;
  let pending: Promise<{ status: number; body: D.Job | D.ErrorBody }> | undefined;
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
    await probe.queueTool(
      JSON.stringify({
        tool: "javascript",
        arguments: { code: "return 42" },
        workspaceId: workspace.body.workspaceId,
        baseRevision: workspace.body.revision,
        target: { kind: "backend", backendId: "cloud", generation: 1 },
        capabilities: ["javascript"],
      }),
    );
    assert.equal(
      (
        await h.api<D.AdmissionReceipt>(
          `/v1/conversations/${conversation.conversationId}/messages`,
          {
            clientRequestId: crypto.randomUUID(),
            content: "read a job awaiting approval",
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
          grantId: "only-this-conversation-job-read",
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
    assert.equal(issued.body.state, "issued");
    if (issued.body.state !== "issued") assert.fail("Actual scoped synthetic credential required");
    const path = `/v1/jobs/${job.jobId}`;
    const positive = await h.api<D.Job>(path, undefined, "GET", issued.body.token);
    assert.equal(positive.status, 200, "The same scoped credential must first read the known job");
    assert.equal(positive.body.jobId, job.jobId);
    await probe.armJobRead(job.jobId, issued.body.credential.credentialId);
    pending = h.api<D.Job | D.ErrorBody>(path, undefined, "GET", issued.body.token);
    const held = await eventually(
      () => observer.jobReadGate(),
      (gate) => gate.entered,
    );
    assert.ok(held.authorizedAt !== null && held.readAt !== null);
    assert.ok(held.authorizedAt <= held.readAt && held.readAt < expiresAt);
    assert.equal(held.credentialExpiresAt, expiresAt);
    assert.equal(
      await probe.queuedJobRead(job.jobId),
      job.jobId,
      "A real second queued read must finish while the payload gate is held",
    );
    await pause(Math.max(0, expiresAt - Date.now() + 30));
    const releasedAt = Date.now();
    assert.ok(releasedAt > expiresAt, "Actual credential expiry must elapse before release");
    const fresh = await h.api<D.ErrorBody>(path, undefined, "GET", issued.body.token);
    assert.ok(
      [401, 403].includes(fresh.status),
      "Actual authentication now rejects this credential",
    );
    await probe.releaseJobRead();
    const response = await pending;
    console.log({
      positiveStatus: positive.status,
      authoritySucceededBeforeRead: held.authorizedAt <= held.readAt,
      gateEntered: held.entered,
      queueAvailableWhileHeld: true,
      expiredForMs: releasedAt - expiresAt,
      freshExpiredStatus: fresh.status,
      heldResponseStatus: response.status,
      heldPayloadContainsJob: "jobId" in response.body,
    });
    assert.ok(
      [401, 403].includes(response.status),
      "Public job read published captured private payload after actual credential expiry",
    );
    assert.equal("jobId" in response.body, false);
  } finally {
    await probe?.releaseJobRead();
    await pending?.catch(() => {});
    await h.close();
  }
});
