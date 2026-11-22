import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { freeInfrastructurePolicy } from "fortipi-contract";
import type * as D from "../../src/boundary/dto.js";
import type { ToolContext } from "../../src/execution/context.js";
import { eventually, pause } from "../agent/harness.ts";
import { computerBase } from "./computer-base.ts";
import type { TestAgentSession } from "./context-worker.ts";
import { nativeService } from "./native-service.ts";
import { routingPeer } from "./routing-peer.ts";

test("current configured preferences select between two real eligible daemons; override and stale authority stay fenced", {
  timeout: 180000,
}, async () => {
  const n = await nativeService({
    computer: true,
    approve: false,
    main: resolve("apps/worker/test/execution/context-worker.ts"),
  });
  let peer: Awaited<ReturnType<typeof routingPeer>> | undefined;
  try {
    const probe = n.probe as unknown as DurableObjectStub<TestAgentSession>;
    const bindingResponse = await n.h.api<D.WorkspaceBinding>(`/v1/workspaces/${n.workspaceId}`);
    assert.equal(bindingResponse.status, 200);
    let binding = bindingResponse.body;
    peer = await routingPeer(n.h, binding, n.agent.agentId, n.conversation.conversationId);
    const a = n.f.profile.executorId,
      b = peer.executorId;
    let configVersion = 1;
    const configure = async (routing: D.Configuration["routing"]) => {
      // This fixture isolates routing from cadence using bounded numeric headroom.
      // It adds no paid capabilities or cloud bindings and proves no Paid execution.
      const infrastructure = structuredClone(freeInfrastructurePolicy);
      infrastructure.profile = "verified";
      infrastructure.accountPlan = "paid";
      infrastructure.bounds.requestsPerPrincipalMinute = 1000;
      infrastructure.bounds.requestsPerInstallMinute = 1000;
      infrastructure.bounds.sqlPageRows = 1;
      const changed = await n.h.api(
        "/v1/admin/configuration",
        {
          requestId: crypto.randomUUID(),
          expectedVersion: configVersion,
          configuration: {
            version: ++configVersion,
            workspace: { kind: "computer" },
            execution: { kind: "native", executorId: a, trust: "host" },
            routing,
            models: [{ providerId: "cloudflare", modelId: "@cf/zai-org/glm-5.3-flash" }],
            infrastructure,
          },
        },
        "PATCH",
      );
      assert.equal(changed.status, 200, JSON.stringify(changed.body));
    };
    await configure({ kind: "prefer-local", targetIds: [a, b] });
    const reject = async (jobId: string) => {
      const state = await eventually(
        n.state,
        (s) => s.jobs.find((j) => j.jobId === jobId)?.approvalId != null,
      );
      const approvalId = state.jobs.find((j) => j.jobId === jobId)!.approvalId;
      const approval = await n.h.api<D.Approval>(`/v1/approvals/${approvalId}`);
      assert.equal(approval.status, 200);
      const result = await n.h.api(`/v1/approvals/${approvalId}/decisions`, {
        requestId: crypto.randomUUID(),
        expectedVersion: approval.body.version,
        operationDigest: approval.body.operation.operationDigest,
        decision: "reject",
      });
      assert.equal(result.status, 200);
      await eventually(
        n.state,
        (s) => s.jobs.find((j) => j.jobId === jobId)?.state === "cancelled",
      );
      for (let i = 0; i < 300; i++) {
        if ((await n.state()).tasks.every((t) => t.status === "terminal")) {
          await n.probe.runRepair();
          return;
        }
        await pause(20);
      }
      assert.fail("Previous Pi run did not settle");
    };
    await reject(n.job.jobId);
    const issue = async (ids = [a, b]) => {
      const minted = await n.h.api<D.CredentialReceipt>("/v1/admin/credentials", {
        requestId: crypto.randomUUID(),
        role: "client",
        expiresAt: Date.now() + 240000,
        grants: [
          {
            grantId: crypto.randomUUID(),
            version: 1,
            resources: {
              agentIds: [n.agent.agentId],
              conversationIds: [n.conversation.conversationId],
              workspaceIds: [n.workspaceId],
              executorIds: ids,
              backendIds: [],
              tools: ["shell"],
              actions: [
                "messages.submit",
                "conversations.read",
                "tasks.read",
                "jobs.dispatch",
                "workspace.write",
              ],
            },
          },
        ],
      });
      assert.equal(minted.status, 201);
      if (minted.body.state !== "issued") assert.fail("Expected scoped fixture credential");
      return minted.body;
    };
    const submit = async (actor: Awaited<ReturnType<typeof issue>>) => {
      await probe.queueTool("context");
      const input = {
        clientRequestId: crypto.randomUUID(),
        content: "List files in the configured workspace.",
        busyBehavior: "followUp",
      };
      const receipt = await eventually(
        async () => {
          await n.probe.runRepair();
          return n.h.api(
            `/v1/conversations/${n.conversation.conversationId}/messages`,
            input,
            "POST",
            actor.token,
          );
        },
        (response) => response.status !== 429,
      );
      assert.equal(receipt.status, 202, JSON.stringify(receipt.body));
    };
    const routes = async () =>
      JSON.parse(await probe.routeState()) as {
        jobs: { jobId: string; operation: D.ApprovalOperation; state: D.JobState }[];
      };
    const latestContext = async () => {
      const samples = JSON.parse(await probe.samples()) as { context?: ToolContext }[];
      return samples.filter((s) => s.context).at(-1)!.context!;
    };
    const selected = async (target: string, override?: D.BackendRef, ids?: string[]) => {
      const before = new Set((await routes()).jobs.map((j) => j.jobId));
      await probe.explicitTarget(override);
      await submit(await issue(ids));
      const result = await eventually(routes, (s) => s.jobs.length === before.size + 1);
      const job = result.jobs.find((j) => !before.has(j.jobId))!;
      assert.deepEqual(job.operation.target, {
        kind: "executor",
        executorId: target,
        generation: 1,
      });
      return job;
    };
    const first = await selected(a);
    assert.equal(
      (JSON.parse(await probe.topologyPages(first.jobId)) as D.BackendRef[]).length,
      2,
      "Both independently enrolled daemons are actually eligible",
    );
    assert.equal(
      (await latestContext()).workspaces[0]?.targets.length,
      1,
      "The selector continues beyond the first target page",
    );
    await reject(first.jobId);
    await configure({ kind: "prefer-local", targetIds: [b, a] });
    const second = await selected(b);
    assert.equal((JSON.parse(await probe.topologyPages(second.jobId)) as D.BackendRef[]).length, 2);
    await reject(second.jobId);
    const override = await selected(a, { kind: "executor", executorId: a, generation: 1 });
    await reject(override.jobId);
    const scoped = await selected(a, undefined, [a]);
    assert.equal(
      (await latestContext()).workspaces[0]?.targets.length,
      1,
      "Preferred but ungranted B stays invisible",
    );
    await reject(scoped.jobId);

    // Read actual context, then invalidate each independent dispatch prerequisite.
    for (const fault of ["revision", "generation", "grant"] as const) {
      const actor = await issue(),
        before = (await routes()).jobs.length;
      const sampleCount = (JSON.parse(await probe.samples()) as unknown[]).length;
      await probe.holdContext();
      await probe.explicitTarget(
        fault === "generation" ? { kind: "executor", executorId: b, generation: 1 } : undefined,
      );
      await submit(actor);
      await eventually(
        async () => JSON.parse(await probe.samples()) as { context?: ToolContext }[],
        (samples) => samples.slice(sampleCount).some((s) => s.context),
      );
      if (fault === "revision") {
        const writer = await n.h.api<D.CredentialReceipt>("/v1/admin/credentials", {
          requestId: crypto.randomUUID(),
          role: "client",
          grants: [
            {
              grantId: crypto.randomUUID(),
              version: 1,
              resources: {
                agentIds: [],
                conversationIds: [],
                workspaceIds: [n.workspaceId],
                executorIds: [],
                backendIds: [n.workspaceId],
                tools: [],
                actions: ["workspace.write"],
              },
            },
          ],
        });
        assert.equal(writer.status, 201);
        if (writer.body.state !== "issued") assert.fail("Fixture writer credential required");
        binding = await computerBase(n.h, binding, writer.body.token, 1);
      }
      if (fault === "grant") {
        const revoked = await n.h.api(
          `/v1/admin/credentials/${actor.credential.credentialId}/revoke`,
          { requestId: crypto.randomUUID(), expectedGeneration: 1 },
        );
        assert.ok([200, 202].includes(revoked.status));
      }
      if (fault === "generation") {
        const revoked = await n.h.api(`/v1/admin/executors/${b}/revoke`, {
          requestId: crypto.randomUUID(),
          expectedGeneration: 1,
        });
        assert.ok([200, 202].includes(revoked.status));
      }
      await probe.releaseContext();
      await eventually(n.state, (s) => s.tasks.every((t) => t.status === "terminal"));
      assert.equal(
        (await routes()).jobs.length,
        before,
        `${fault} changed after discovery must prevent a new dispatch job`,
      );
    }
    assert.equal(n.f.ledger.identities().length, 0);
    assert.equal(peer.f.ledger.identities().length, 0);
  } finally {
    await peer?.close();
    await n.close();
  }
});
