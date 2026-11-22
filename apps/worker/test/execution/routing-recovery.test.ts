import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { Approvals } from "../../../../packages/fortipi-executor/dist/index.js";
import type * as D from "../../src/boundary/dto.js";
import { eventually, pause } from "../agent/harness.ts";
import type { TestAgentSession } from "./context-worker.ts";
import { nativeService } from "./native-service.ts";
import { routingPeer } from "./routing-peer.ts";

test("resolved automatic target and actual Pi child remain bound after disconnect, uncertainty, preference change and Pi reopen", {
  timeout: 90000,
}, async () => {
  const n = await nativeService({
    computer: true,
    automatic: true,
    routingFixtureHeadroom: true,
    main: resolve("apps/worker/test/execution/context-worker.ts"),
  });
  let peer: Awaited<ReturnType<typeof routingPeer>> | undefined;
  try {
    const probe = n.probe as unknown as DurableObjectStub<TestAgentSession>;
    for (let i = 0; i < 300 && !(await readFile(n.marker, "utf8").catch(() => "")); i++) {
      const row = n.f.ledger.get(n.job.jobId);
      if (row?.state === "pending" && row.decision === "pending") {
        const approvals = new Approvals(n.f.ledger),
          pending = approvals.list().find((p) => p.jobId === n.job.jobId);
        assert.ok(pending);
        approvals.decide(pending.jobId, pending.digest, "allow");
        await n.runtime.tick();
      }
      await pause(100);
    }
    assert.equal(await readFile(n.marker, "utf8"), "start\n");
    const view = await n.state();
    const children = view.tasks.filter((t) => t.kind === "fortipi.dispatch").map((t) => t.id);
    assert.equal(children.length, 1);
    const before = JSON.parse(await probe.routeState());
    const binding = await n.h.api<D.WorkspaceBinding>(`/v1/workspaces/${n.workspaceId}`);
    assert.equal(binding.status, 200);
    peer = await routingPeer(n.h, binding.body, n.agent.agentId, n.conversation.conversationId);
    const config = await n.h.api<D.Configuration>("/v1/admin/configuration");
    assert.equal(config.status, 200);
    const changed = await n.h.api(
      "/v1/admin/configuration",
      {
        requestId: crypto.randomUUID(),
        expectedVersion: config.body.version,
        configuration: {
          ...config.body,
          version: config.body.version + 1,
          routing: { kind: "prefer-local", targetIds: [peer.executorId, n.f.profile.executorId] },
        },
      },
      "PATCH",
    );
    assert.equal(changed.status, 200);
    await n.disconnect();
    // An explicit uncertainty cut after a real spawn. This is not a physical host-loss or dropped-ACK proof.
    await n.probe.interruptForReconciliation(n.job.jobId);
    await n.probe.disposePi();
    await eventually(n.state, (s) => s.jobs[0]?.state === "requires_reconciliation");
    await n.probe.disposePi();
    const afterView = await n.state(),
      after = JSON.parse(await probe.routeState());
    assert.deepEqual(
      afterView.tasks.filter((t) => t.kind === "fortipi.dispatch").map((t) => t.id),
      children,
    );
    assert.equal(after.jobs.length, 1);
    assert.deepEqual(after.intents[0].target, before.intents[0].target);
    assert.deepEqual(after.jobs[0].execution, before.jobs[0].execution);
    assert.deepEqual(after.jobs[0].operation.target, {
      kind: "executor",
      executorId: n.f.profile.executorId,
      generation: 1,
    });
    assert.equal(
      peer.f.ledger.identities().length,
      0,
      "The new preferred daemon must receive no fresh assignment",
    );
    assert.equal((await readFile(n.marker, "utf8")).match(/start/g)?.length, 1);
  } finally {
    await peer?.close();
    await n.close();
  }
});
