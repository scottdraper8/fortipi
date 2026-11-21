import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { Approvals } from "../../../../packages/fortipi-executor/dist/index.js";
import { eventually, pause } from "../agent/harness.ts";
import type { TestAgentSession } from "./context-worker.ts";
import { nativeService } from "./native-service.ts";

test("ordinary prompt discovers current scoped Computer coordinates and lists real native snapshot files", {
  timeout: 150000,
}, async () => {
  const n = await nativeService({
    ordinary: true,
    computer: true,
    computerFiles: 2,
    main: resolve("apps/worker/test/execution/context-worker.ts"),
  });
  try {
    const probe = n.probe as unknown as DurableObjectStub<TestAgentSession>;
    const samples = JSON.parse(await probe.samples());
    assert.equal(samples[0].user, "List files in the configured workspace.");
    assert.ok(samples[0].tools.includes("fortipi_context"));
    assert.equal(
      samples[0].argumentContractVisible,
      true,
      "Actual model input includes command/source argument contracts",
    );
    const context = samples.find((s: { context?: unknown }) => s.context)?.context;
    assert.equal(context.workspaces.length, 1);
    assert.equal(context.workspaces[0].workspaceId, n.workspaceId);
    assert.equal(context.workspaces[0].configured, true);
    assert.equal(context.workspaces[0].provider, "computer");
    assert.equal(JSON.stringify(context).includes(n.f.rootPath), false);
    assert.equal(JSON.stringify(context).includes("rootBindingId"), false);
    const dispatched = samples.find((s: { dispatch?: unknown }) => s.dispatch).dispatch;
    assert.equal("target" in dispatched, false);
    assert.equal(dispatched.baseRevision, context.workspaces[0].baseRevision);
    for (let i = 0; i < 1200; i++) {
      const row = n.f.ledger.get(n.job.jobId);
      if (row?.state === "pending" && row.decision === "pending") {
        const approvals = new Approvals(n.f.ledger),
          pending = approvals.list().find((p) => p.jobId === n.job.jobId);
        assert.ok(pending);
        approvals.decide(pending.jobId, pending.digest, "allow");
        await n.runtime.tick();
      }
      if ((await n.state()).jobs[0]?.state === "completed") break;
      await pause(100);
    }
    const completed = await eventually(n.state, (s) => s.jobs[0]?.state === "completed");
    assert.equal(completed.jobs.length, 1);
    const result = n.f.ledger.get(n.job.jobId)?.result;
    assert.ok(result);
    assert.equal(result.state, "succeeded");
    assert.match(result.output.tail, /file-000\.txt/);
    assert.match(result.output.tail, /file-001\.txt/);
    const state = JSON.parse(await probe.routeState());
    assert.deepEqual(state.intents[0].target, context.workspaces[0].targets[0]);
    assert.equal(context.targets[0].argumentFormat, "native-shell");
    assert.match(context.argumentContracts["native-shell"], /command/);
    assert.deepEqual(state.jobs[0].execution.target, state.intents[0].target);
  } finally {
    await n.close();
  }
});
