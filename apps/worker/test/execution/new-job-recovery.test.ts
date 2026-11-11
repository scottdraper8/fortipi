import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import type * as D from "../../src/boundary/dto.js";
import { eventually, pause } from "../agent/harness.ts";
import { processHarness } from "../agent/process-harness.ts";

interface View {
  tasks: { id: number; kind: string; status: string }[];
  jobs: { jobId: string; state: D.JobState; approvalId: string | null; hasExecution: boolean }[];
}
test("fresh business authorization recovers the same actual Pi child after SIGKILL between Pi commit and application acknowledgment", {
  timeout: 90000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "fortipi-fresh-child-")),
    main = join(directory, "worker.js");
  let h: Awaited<ReturnType<typeof processHarness>> | undefined;
  try {
    let inserted = 0;
    await build({
      entryPoints: [resolve("apps/worker/test/agent/runtime-worker.ts")],
      outfile: main,
      bundle: true,
      format: "esm",
      platform: "neutral",
      mainFields: ["browser", "module", "main"],
      target: "es2024",
      conditions: ["workerd", "worker", "browser"],
      external: ["cloudflare:*", "node:*", ...builtinModules],
      loader: { ".yaml": "json" },
      logLevel: "silent",
      plugins: [
        {
          name: "owned-fresh-child-barrier",
          setup(builder) {
            builder.onLoad({ filter: /src\/execution\/new-job\.ts$/ }, async (args) => {
              const source = await readFile(args.path, "utf8"),
                needle =
                  "      await this.#current(auth, record, old);\n      await store.transaction";
              assert.equal(source.split(needle).length, 2);
              inserted++;
              return {
                loader: "ts",
                contents: source.replace(
                  needle,
                  `
            if(await store.get("fixture","fault")==="after-fresh-child") {
              await store.transaction(async tx=>{await store.remove("fixture","fault",tx);await store.put("fixture","barrier","after-fresh-child",tx);});
              await new Promise(accept=>setTimeout(accept,300000));
            }
          ${needle}`,
                ),
              };
            });
          },
        },
      ],
    });
    assert.equal(inserted, 1);
    h = await processHarness(main);
    const agent = await h.api<D.Agent>("/v1/agents", {
      requestId: crypto.randomUUID(),
      name: "fresh-recovery",
      model: { providerId: "cloudflare", modelId: "@cf/zai-org/glm-5.3-flash" },
    });
    assert.equal(agent.status, 201);
    const conversation = await h.api<D.Conversation>(
      `/v1/agents/${agent.body.agentId}/conversations`,
      { requestId: crypto.randomUUID() },
    );
    assert.equal(conversation.status, 201);
    const probe = `/__test/agents/${agent.body.agentId}`,
      cid = conversation.body.conversationId,
      canary = { nonce: crypto.randomUUID() };
    assert.deepEqual((await h.api(`${probe}/canary`, canary, "PUT")).body, canary);
    const workspace = await h.api<D.WorkspaceBinding>("/v1/workspaces", {
      requestId: crypto.randomUUID(),
      config: { kind: "computer" },
    });
    assert.equal(workspace.status, 201);
    await h.api(`${probe}/tool`, {
      tool: "javascript",
      arguments: { code: "return 42" },
      workspaceId: workspace.body.workspaceId,
      baseRevision: workspace.body.revision,
      target: { kind: "backend", backendId: "cloud", generation: 1 },
      capabilities: ["javascript"],
    });
    assert.equal(
      (
        await h.api(`/v1/conversations/${cid}/messages`, {
          clientRequestId: crypto.randomUUID(),
          content: "one rejected tool",
          busyBehavior: "followUp",
        })
      ).status,
      202,
    );
    const view = async () => (await h!.api<View>(`${probe}/tool-state?cid=${cid}`)).body;
    const waiting = await eventually(view, (s) => !!s.jobs[0]?.approvalId),
      oldId = waiting.jobs[0]!.jobId,
      approval = await h.api<D.Approval>(`/v1/approvals/${waiting.jobs[0]!.approvalId}`);
    assert.equal(approval.status, 200);
    assert.equal(
      (
        await h.api(`/v1/approvals/${approval.body.approvalId}/decisions`, {
          requestId: crypto.randomUUID(),
          expectedVersion: approval.body.version,
          operationDigest: approval.body.operation.operationDigest,
          decision: "reject",
        })
      ).status,
      200,
    );
    await eventually(view, (s) => s.jobs[0]?.state === "cancelled");
    const old = await h.api<D.Job>(`/v1/jobs/${oldId}`),
      input: D.ReconcileInput = {
        requestId: crypto.randomUUID(),
        expectedVersion: old.body.version,
        reason: "A separate explicitly authorized operation",
        action: { kind: "new-job", authorizationId: crypto.randomUUID() },
      };
    await h.api(`${probe}/fault`, "after-fresh-child");
    const lost = h.api(`/v1/jobs/${oldId}/reconcile`, input).catch(() => undefined);
    await eventually(
      async () => (await h!.api<{ barrier: string | null }>(`${probe}/state`)).body,
      (s) => s.barrier === "after-fresh-child",
    );
    const before = await view(),
      children = before.tasks
        .filter((t) => t.kind === "fortipi.dispatch")
        .map((t) => t.id)
        .sort();
    assert.equal(children.length, 2, "Actual initial and fresh persisted Pi children before crash");
    const newId = before.jobs.find((job) => job.jobId !== oldId)?.jobId;
    assert.ok(newId, "Server identity must exist durably before the reply/crash");
    await h.crash();
    await lost;
    await h.start();
    assert.deepEqual(
      (await h.api(`${probe}/canary`)).body,
      canary,
      "Same persisted SQLite state after real SIGKILL",
    );
    const retry = await h.api<D.ReconcileReceipt>(`/v1/jobs/${oldId}/reconcile`, input);
    assert.equal(retry.status, 202, JSON.stringify(retry.body));
    assert.equal(retry.body.newJobId, newId);
    let after = await view();
    for (
      let i = 0;
      i < 300 && !after.jobs.find((j) => j.jobId === newId && j.state === "awaiting_approval");
      i++
    ) {
      await pause(20);
      after = await view();
    }
    assert.deepEqual(
      after.tasks
        .filter((t) => t.kind === "fortipi.dispatch")
        .map((t) => t.id)
        .sort(),
      children,
      "Recover the exact child reference, never allocate a second fresh child",
    );
    assert.equal(after.jobs.find((j) => j.jobId === newId)?.state, "awaiting_approval");
    assert.equal(after.jobs.find((j) => j.jobId === newId)?.hasExecution, false);
    assert.equal(after.jobs.find((j) => j.jobId === oldId)?.state, "cancelled");
    assert.deepEqual(await h.api(`/v1/jobs/${oldId}/reconcile`, input), retry);
    console.log(
      JSON.stringify({
        realSigkill: true,
        canaryRetained: true,
        actualDispatchChildren: children.length,
        sameFreshJob: true,
        actualExecutionStarted: false,
      }),
    );
  } finally {
    await h?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
