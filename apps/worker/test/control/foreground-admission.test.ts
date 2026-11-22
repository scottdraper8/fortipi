import assert from "node:assert/strict";
import { test } from "node:test";
import { assignedJob } from "./artifact-job.ts";
import { connected } from "./connection.ts";
import type { CompletionControl } from "./fixtures/completion.ts";
import { harness, scope, uuid, value } from "./harness.ts";

test("foreground admission excludes real alarm and unrelated RPC charges while its executor reply is held", {
  timeout: 60000,
}, async () => {
  const h = await harness<CompletionControl>({
    fixturePath: "apps/worker/test/control/fixtures/completion.ts",
  });
  const sockets: WebSocket[] = [];
  try {
    const channel = await connected(h);
    sockets.push(channel.socket);
    const issued = await h.mint({
      requestId: uuid(),
      role: "client",
      grants: [
        { grantId: uuid(), version: 1, resources: scope(["jobs.dispatch", "workspace.write"]) },
      ],
    });
    const raw = await h.auth(issued.token);
    const job = await assignedJob(h, raw);
    const actor = { ...raw, registrationId: job.reservation.registrationIds.agent };
    const pending = h.cp.queryExecutionWithAdmissions(actor, job.identity);
    const query = await channel.wait("job.query");
    assert.equal(query.type, "job.query");
    if (query.type !== "job.query") assert.fail("Missing held actual query");
    assert.deepEqual(query.payload, job.identity);
    const before = await h.cp.admissions();

    // A distinct real executor creates a due-now presence transition. Drain
    // through the existing real alarm seam while the first query awaits ACK.
    const other = await connected(h, { executorId: "other-executor" });
    sockets.push(other.socket);
    await h.cp.forceDue();
    await h.cp.drainTest();
    const after = await h.cp.admissions();
    assert.ok(after.application > before.application, "Unrelated real RPCs were admitted");
    assert.ok(after.repair > before.repair, "Real alarm repair remains charged to total");

    channel.send({
      type: "job.query_result",
      requestId: query.requestId,
      payload: { identity: job.identity, state: "running" },
    });
    const observed = await pending;
    assert.deepEqual(
      observed.admissions,
      { application: 0, repair: 1 },
      "Held foreground query must exclude independent alarm/RPC admissions",
    );
    assert.deepEqual(value(observed.result), { identity: job.identity, state: "running" });
  } finally {
    for (const socket of sockets) socket.close();
    await h.close();
  }
});
