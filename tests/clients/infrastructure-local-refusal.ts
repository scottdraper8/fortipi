import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { start } from "../../apps/worker/test/integration/runtime.ts";

function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function count(value: unknown): number {
  assert.ok(typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
  return value;
}
function reservation(value: unknown): string {
  const outcome = object(value);
  assert.equal(outcome.ok, true, "Actual capacity admission must succeed after fault removal");
  const id = object(outcome.value).reservationId;
  assert.ok(typeof id === "string" && id.length > 0);
  return id;
}

/** LOCAL reduced fixture only: actual workerd/SQLite transactions and process
 * loss. Provider pressure is injected through the existing disposable recipient
 * fixture; no account exhaustion, reset discovery or live-provider proof. */
export async function produceLocalRefusalRestoration() {
  const directory = await mkdtemp(resolve(tmpdir(), "fortipi-local-refusal-"));
  const source = resolve(directory, "fixture.ts");
  const fixtures = resolve(import.meta.dirname, "../../apps/worker/test/control/fixtures");
  // Only a disposable test bridge. The CP, budget, trigger, recipient and repair
  // implementation are the existing real fixture/product modules, not copies.
  await writeFile(
    source,
    `
import baseWorker, { TestControlPlane, TestRecipient } from ${JSON.stringify(resolve(fixtures, "storage-budget.ts"))};
import { check, id } from ${JSON.stringify(resolve(fixtures, "../../../src/control/store.ts"))};
export { TestRecipient as TestAgentSession, TestRecipient as WorkspaceObject };
export class ControlPlane extends TestControlPlane {
  async knownRetry() {
    const auth = await this.authenticate({bearer:this.env.FORTIPI_ADMIN_TOKEN,
      deploymentId:await this.deployment(),requestId:id(),deadline:Date.now()+30000});
    check(auth.ok,"internal","Local authentication unavailable");
    const resources={agentIds:[],conversationIds:[],executorIds:[],backendIds:[],tools:[],
      workspaceIds:["known_retry_workspace"],actions:["workspace.read"]};
    const issued=await this.mintCredential(auth.value,{operationId:"mintCredential",path:{},query:{},
      body:{requestId:id(),role:"client",grants:[{grantId:"retry",version:1,resources}]}});
    check(issued.ok&&issued.value.status===201&&issued.value.body.state==="issued","internal","Local role unavailable");
    const actor=await this.authenticate({bearer:issued.value.body.token,
      deploymentId:await this.deployment(),requestId:id(),deadline:Date.now()+30000});
    check(actor.ok,"internal","Local actor unavailable");
    const registered=await this.registerAuthorityRecipient(actor.value,{
      credential:issued.value.body.credential,recipient:{kind:"workspace",id:"known_retry_workspace"},resources});
    check(registered.ok,"internal","Local recipient unavailable");
    await this.env.WORKSPACES.getByName("known_retry_workspace").setQuotaFault({
      code:"quota_paused",message:"Disposable local known SQL retry",requestId:id(),retryable:true,
      details:{retryAfterMs:120000,pressure:{resource:"sql",scope:{kind:"account"},source:"provider",
        measurement:"observed",resetAt:Date.now()+120000,reason:"Local typed retry fixture",action:"retry-later"}}});
    const revoked=await this.revokeCredential(auth.value,{operationId:"revokeCredential",
      path:{id:issued.value.body.credential.credentialId},query:{},body:{requestId:id(),expectedGeneration:1}});
    check(revoked.ok,"internal","Local revocation unavailable");
    await this.alarm();
    return JSON.parse(await this.repairState());
  }
}
export default {async fetch(request,env){
  const path=new URL(request.url).pathname,cp=env.CONTROL_PLANE.getByName("control");
  if(path==="/health")return Response.json({local:true});
  if(path==="/local/fault"){await cp.refuseWrites("capacity");return Response.json({installed:true});}
  if(path==="/local/restore"){await cp.refuseWrites(null);return Response.json({removed:true});}
  if(path==="/local/counts")return Response.json({reservations:await cp.rowCount("capacity_reservation"),
    requests:await cp.rowCount("capacity_request")});
  if(path==="/local/unknown"){await cp.seedPausedRepair();return Response.json({seeded:true});}
  if(path==="/local/known")return Response.json(await cp.knownRetry());
  return baseWorker.fetch(request,env);
}};
`,
    { flag: "wx", mode: 0o600 },
  );
  let runtime: Awaited<ReturnType<typeof start>> | undefined;
  try {
    // Retain the ordinary Free traffic policy; this scenario needs no quota raise.
    runtime = await start({ directory, main: source, traffic: "free" });
    const read = async (path: string) => {
      const response = await runtime?.api<unknown>(path);
      assert.ok(response && response.status === 200, "Local fixture request failed");
      return response.body;
    };
    const before = object(await read("/local/counts"));
    const rowsBefore = count(before.reservations);
    assert.equal(rowsBefore, 0);
    assert.equal(count(before.requests), 0);
    await read("/local/fault");
    const refused = object(await read("/reserve"));
    assert.equal(refused.ok, false, "Real SQLite INSERT abort must refuse the operation");
    const after = object(await read("/local/counts"));
    const rowsAfterRefusal = count(after.reservations);
    const requestRowsAfterRefusal = count(after.requests);
    assert.equal(
      rowsAfterRefusal,
      0,
      "Capacity reservation must roll back with refused counter write",
    );
    assert.equal(
      requestRowsAfterRefusal,
      0,
      "Idempotency request row must roll back in the same transaction",
    );
    await read("/local/restore");
    const restoredReservationId = reservation(await read("/reserve"));
    assert.equal(reservation(await read("/reserve")), restoredReservationId);
    await read("/local/unknown");
    await read("/local/known");
    const holds = (value: unknown) => {
      const rows = object(value).holds;
      assert.ok(Array.isArray(rows));
      const parsed = rows.map(object);
      const storage = parsed.find((row) => object(row.pressure).resource === "storage");
      const retry = parsed.find((row) => object(row.pressure).resource === "sql");
      assert.ok(storage && retry, "Both actual durable pressure holds must exist");
      assert.equal(storage.notBefore, undefined, "Unknown storage has no invented reset");
      assert.equal(object(storage.pressure).resetAt, undefined);
      const known = count(retry.notBefore);
      assert.ok(known > Date.now(), "Known retry remains a future durable deadline");
      return { storage, retry, known };
    };
    const observed = holds(await read("/repair-state"));
    const knownRetryAt = observed.known;
    const unknownStorageReset = object(observed.storage.pressure).resetAt ?? null;
    assert.ok(unknownStorageReset === null);
    const canary = `committed-${restoredReservationId}`;
    assert.equal(await read(`/canary?value=${encodeURIComponent(canary)}`), canary);
    await runtime.stopAbruptly();
    await runtime.reopenSameStorage();
    assert.equal(await read("/canary"), canary, "Committed canary must survive real process loss");
    const retained = holds(await read("/repair-state"));
    assert.deepEqual(retained.storage, observed.storage);
    assert.deepEqual(retained.retry, observed.retry);
    const retainedRetryAtAfterReopen = retained.known;
    assert.equal(retainedRetryAtAfterReopen, knownRetryAt);
    const retryReservationId = reservation(await read("/reserve"));
    assert.equal(
      retryReservationId,
      restoredReservationId,
      "Same operation must retain its reservation after reopen",
    );
    const final = object(await read("/local/counts"));
    assert.equal(count(final.reservations), 1);
    assert.equal(count(final.requests), 1);
    return {
      fault: "local-sqlite-capacity-insert-abort" as const,
      rowsBefore,
      rowsAfterRefusal,
      requestRowsAfterRefusal,
      restoredReservationId,
      retryReservationId,
      unknownStorageReset,
      knownRetryAt,
      retainedRetryAtAfterReopen,
    };
  } finally {
    if (runtime) await runtime.dispose();
    else await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
