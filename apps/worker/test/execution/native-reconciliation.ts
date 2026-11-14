import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ToolResultEntry } from "@earendil-works/pi-durable";
import { canonicalJson } from "fortipi-contract";
import type * as D from "../../src/boundary/dto.js";
import { eventually, pause } from "../agent/harness.ts";
import type { NativeRecoveryContext } from "./native-process.ts";

interface Trace {
  query: {
    ok: boolean;
    state?: string;
    sockets: number;
    startedAt: number;
    finishedAt: number;
    attempted: boolean;
  } | null;
  local: {
    kind: string;
    ok: boolean;
    code?: string;
    reason?: string;
    sockets: number;
    startedAt: number;
    finishedAt: number;
    retryAfterMs?: number;
    leaseExpiresAt: number;
  }[];
}
export async function verifyNativeReconciliation(
  c: NativeRecoveryContext,
  mode: "assign-ack" | "result",
) {
  const trace = async () =>
    (
      await c.service.api<Trace>(
        `/__test/dispatch-trace?job=${c.job.jobId}&operation=${c.job.operationId}`,
      )
    ).body;
  let last = await c.view();
  for (let i = 0; i < 900 && last.jobs[0]?.state !== "requires_reconciliation"; i++) {
    await c.native.tick();
    const diagnostic = (
      await c.service.api<{ pressure: { code: string; message: string } | null }>(
        `${c.probe}/job-diagnostics?job=${c.job.jobId}`,
      )
    ).body;
    if (mode === "result" && diagnostic.pressure?.code === "workspace.conflict") break;
    await pause(50);
    last = await c.view();
  }
  const facts = await trace();
  if (mode === "assign-ack") {
    assert.equal(facts.query?.ok, true);
    assert.equal(facts.query?.state, "unknown", "Offline uncertainty is not a closed-ledger proof");
    assert.equal(facts.query?.attempted, true);
    assert.equal(facts.query?.sockets, 0);
    assert.ok(facts.query && facts.query.finishedAt <= c.offlineReleasedAt);
  } else {
    assert.ok(c.offlineReleasedAt > c.identity.lease.expiresAt, "Use real elapsed lease expiry");
    assert.ok(
      facts.local.some((row) => row.kind === "observe" && !row.ok && row.sockets === 0),
      JSON.stringify(facts),
    );
  }
  const terminal = await eventually(
    c.view,
    (value) =>
      value.jobs[0]?.state === "requires_reconciliation" &&
      value.tasks.some((task) => task.kind === "fortipi.dispatch" && task.status === "terminal"),
  );
  const job = await c.service.api<D.Job>(`/v1/jobs/${c.job.jobId}`, undefined, "GET", c.actorToken);
  assert.equal(job.status, 200);
  assert.equal(
    job.body.state,
    "requires_reconciliation",
    "Expired/uncertain effects need an actionable public disposition, not indefinite result_pending_commit",
  );
  assert.equal(job.body.execution?.executionId, c.identity.executionId);
  assert.equal(job.body.operationDigest, c.identity.operationDigest);
  assert.deepEqual(
    terminal.tasks.filter((task) => task.kind === "fortipi.dispatch").map((task) => task.id),
    c.children,
  );
  const before = await eventually(
    async () =>
      (
        await c.service.api<{ entries: { id: number; kind: string; text: string }[] }>(
          `${c.probe}/inspect?cid=${c.cid}`,
        )
      ).body,
    (value) => value.entries.some((entry) => entry.kind === ToolResultEntry.kind),
  );
  assert.equal(before.entries.filter((entry) => entry.kind === "pi.user").length, 1);
  const outcome = before.entries.filter((entry) => entry.kind === ToolResultEntry.kind);
  assert.ok(outcome.length > 0, "The original Pi tool outcome must already be committed");
  const snapshot = await c.service.api<D.ConversationProjection>(
    `/v1/conversations/${c.cid}`,
    undefined,
    "GET",
    c.actorToken,
  );
  const projectedTool = snapshot.body.messages.filter(
    (message) => message.content === outcome[0]!.text,
  );
  assert.equal(projectedTool.length, 1);
  assert.equal(
    projectedTool[0]!.role,
    "tool",
    "A canonical Pi tool result must retain its public tool role",
  );
  const blocked = await c.service.api<D.ErrorBody>(
    `/v1/jobs/${c.job.jobId}/reconcile`,
    {
      requestId: crypto.randomUUID(),
      expectedVersion: job.body.version,
      reason: "A native result is not an unattempted staged upload",
      action: { kind: "discard-staging" },
    } satisfies D.ReconcileInput,
    "POST",
    c.actorToken,
  );
  assert.equal(blocked.status, 501, JSON.stringify(blocked.body));
  assert.equal(blocked.body.error.code, "unsupported");
  const ackInput: D.ReconcileInput = {
    requestId: crypto.randomUUID(),
    expectedVersion: job.body.version,
    reason: "Acknowledge uncertainty without publishing expired native effects",
    action: { kind: "acknowledge-unknown" },
  };
  const ack = await c.service.api<D.ReconcileReceipt>(
    `/v1/jobs/${c.job.jobId}/reconcile`,
    ackInput,
    "POST",
    c.actorToken,
  );
  assert.equal(ack.status, 202, JSON.stringify(ack.body));
  assert.equal(ack.body.disposition, "unknown-acknowledged");
  assert.deepEqual(
    await c.service.api(`/v1/jobs/${c.job.jobId}/reconcile`, ackInput, "POST", c.actorToken),
    ack,
  );
  const afterJob = await c.service.api<D.Job>(
    `/v1/jobs/${c.job.jobId}`,
    undefined,
    "GET",
    c.actorToken,
  );
  assert.equal(afterJob.body.state, job.body.state);
  assert.equal(afterJob.body.version, job.body.version + 1);
  const replay = await c.service.api<D.ReplayPage>(
    `/v1/conversations/${c.cid}/events?after=0`,
    undefined,
    "GET",
    c.actorToken,
  );
  assert.equal(replay.status, 200);
  const reconciled = replay.body.events.filter((event) => event.type === "job.reconciled");
  assert.equal(reconciled.length, 1);
  assert.equal(canonicalJson(reconciled[0]!.payload), canonicalJson(ack.body));
  const localBeforeRepair = (await trace()).local.length;
  for (let i = 0; i < 2; i++) {
    await c.service.api(`${c.probe}/repair`, {});
    await c.native.tick();
  }
  assert.equal(
    (await trace()).local.length,
    localBeforeRepair,
    "Settled uncertain work must not futilely poll the expired publication",
  );
  const after = (await c.service.api<typeof before>(`${c.probe}/inspect?cid=${c.cid}`)).body;
  assert.deepEqual(
    after.entries.filter((entry) => entry.kind === ToolResultEntry.kind),
    outcome,
    "Reconciliation cannot rewrite the consumed Pi outcome",
  );
  assert.equal(after.entries.filter((entry) => entry.kind === "pi.user").length, 1);
  const binding = await c.service.api<D.WorkspaceBinding>(`/v1/workspaces/${c.workspaceId}`);
  assert.equal(binding.body.revision, c.base.revision, "No stale Workspace CAS");
  assert.equal(binding.body.manifestHash, c.base.manifestHash);
  assert.equal(
    c.fixture.ledger.rootAvailable(c.fixture.root.key),
    false,
    "Acknowledgment cannot unblock native root pins",
  );
  assert.equal(c.fixture.ledger.get(c.job.jobId)?.committed, undefined);
  assert.equal((await readFile(c.marker, "utf8")).match(/start/g)?.length, 1);
  assert.deepEqual(
    await c.service.api(`/v1/conversations/${c.cid}/messages`, c.input, "POST", c.actorToken),
    c.admission,
  );
  console.log(
    JSON.stringify({
      mode,
      uncertainty: facts.query ?? null,
      local: facts.local,
      publicDisposition: afterJob.body.state,
      unchangedRevision: binding.body.revision,
      sameChild: true,
      processStarts: 1,
      piOutcomePreserved: true,
      rootStillPinned: true,
    }),
  );
}

/** Healthy replies retain automatic completion; an observed offline unknown needs explicit recovery. */
export async function verifyNaturalLostAck(c: NativeRecoveryContext): Promise<void | "continue"> {
  const trace = (
    await c.service.api<Trace>(
      `/__test/dispatch-trace?job=${c.job.jobId}&operation=${c.job.operationId}`,
    )
  ).body;
  if (trace.query?.ok && trace.query.state === "unknown") {
    await verifyNativeReconciliation(c, "assign-ack");
    return;
  }
  return "continue";
}
