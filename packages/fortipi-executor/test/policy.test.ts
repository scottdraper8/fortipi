import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { commitDigest } from "fortipi-contract/executor";
import { privateWrite } from "../dist/config.js";
import { ExecutorRuntime } from "../dist/daemon.js";
import { Guard } from "../dist/ledger.js";
import { approvalKey, disabledPolicy } from "../dist/policy.js";
import { HttpTransport } from "../dist/transport.js";
import {
  assignment,
  authenticateFixture,
  eventually,
  fixture,
  fixtureChild,
  importRoot,
  nodeCommand,
  prepare,
} from "./fixtures/daemon.ts";

async function runtime(f: Awaited<ReturnType<typeof fixture>>) {
  const http = new HttpTransport(f.profile, fetch, true);
  authenticateFixture(http);
  const r = new ExecutorRuntime({
    profile: f.profile,
    ledger: f.ledger,
    directory: f.directory,
    roots: new Map([["root", f.root]]),
    http,
  });
  await r.initialize();
  for (const local of r.locals.values()) await importRoot(local);
  r.connected = true;
  return r;
}
test("remote allow, disabled host, confinement and altered context cannot start; dual approval starts one actual process", async () => {
  const f = await fixture();
  try {
    const marker = join(f.path, "external-effect"),
      a = await assignment(nodeCommand(fixtureChild, "append", marker, "ok")),
      r = await runtime(f);
    await r.locals.get("root")?.request(prepare(a, f.initial.manifestHash));
    await Promise.all([r.assignOnce(a), r.assignOnce(a)]);
    assert.equal(r.children.size, 0);
    await r.receive({
      type: "local_policy.decision",
      requestId: "remote_allow",
      payload: {
        identity: a.identity,
        operationDigest: a.identity.operationDigest,
        decision: "allow",
      },
    });
    assert.equal(f.ledger.get(a.identity.jobId)?.decision, "pending");
    const key = approvalKey(a, f.profile.policy, f.root.key);
    assert.throws(() => r.approvals.decide(a.identity.jobId, "0".repeat(64), "allow"), /context/);
    r.approvals.decide(a.identity.jobId, key, "allow");
    await Promise.all([r.assignOnce(a), r.assignOnce(a), r.tick()]);
    await eventually(() => !!f.ledger.get(a.identity.jobId)?.result, "native result not persisted");
    assert.equal(await readFile(marker, "utf8"), "effect\n");
    assert.equal(f.ledger.get(a.identity.jobId)?.result?.state, "succeeded");
    assert.equal(
      f.ledger.get(a.identity.jobId)?.committed,
      undefined,
      "child exit is not terminal committed",
    );
    const local = f.ledger.local(a.identity.lease.operationId),
      result = f.ledger.get(a.identity.jobId)?.result;
    if (local?.observation.state !== "applied" || !result?.commitId || !result.manifestHash)
      throw new Error("actual local result missing");
    const digest = await commitDigest({
      commitId: result.commitId,
      operationId: a.identity.lease.operationId,
      jobId: a.identity.jobId,
      workspaceId: a.workspaceId,
      baseRevision: a.identity.baseRevision,
      manifestHash: result.manifestHash,
      leaseIdentity: a.identity.lease,
      storage: {
        kind: "local",
        preparationId: local.prepared.preparationId,
        observationSeq: local.observation.observationSeq,
        preManifestHash: local.observation.preManifestHash,
        postManifestHash: local.observation.postManifestHash,
      },
    });
    // Negative authority fixture: changing the provider cannot turn the actual local result into a cloud commit.
    await assert.rejects(
      r.committed({
        identity: a.identity,
        terminalVersion: 1,
        eventSeq: 1,
        evidence: {
          kind: "committed",
          receipt: {
            providerKind: "computer",
            storeRef: { stageId: "unrelated_public_stage" },
            commitId: result.commitId,
            jobId: a.identity.jobId,
            operationId: a.identity.lease.operationId,
            workspaceId: a.workspaceId,
            baseRevision: a.identity.baseRevision,
            manifestHash: result.manifestHash,
            revision: "r1",
            commitDigest: digest,
            sourceFactId: "negative_fixture",
            committedAt: Date.now(),
          },
        },
      }),
      /terminal receipt mismatch/,
    );
    assert.equal(f.ledger.get(a.identity.jobId)?.committed, undefined);
    await r.assignOnce(a);
    assert.equal(await readFile(marker, "utf8"), "effect\n");
    const missing = await assignment("never");
    assert.equal(r.queryExisting(missing.identity).state, "unknown");
    assert.equal(f.ledger.get(missing.identity.jobId), undefined);
    const closed = await r.cancel(missing.identity, "cancel-before-assign");
    assert.equal(closed.state, "not-started");
    await r.assignOnce(missing);
    assert.equal(r.queryExisting(missing.identity).state, "not_started");
  } finally {
    await f.cleanup();
  }
  for (const mode of ["disabled", "confined"] as const) {
    const f = await fixture();
    try {
      f.profile.policy =
        mode === "disabled" ? disabledPolicy : { ...f.profile.policy, requireConfinement: true };
      const r = await runtime(f),
        a = await assignment("never");
      await r.assignOnce(a);
      assert.equal(f.ledger.get(a.identity.jobId)?.state, "closed");
      assert.equal(r.children.size, 0);
    } finally {
      await f.cleanup();
    }
  }
});
test("changed local policy expires approval; canonical digest mismatch rejected before any process", async () => {
  const f = await fixture();
  try {
    const r = await runtime(f),
      a = await assignment("never");
    await r.assignOnce(a);
    const key = approvalKey(a, f.profile.policy, f.root.key);
    r.approvals.decide(a.identity.jobId, key, "allow");
    f.profile.policy.version++;
    await assert.rejects(r.tick(), /approval expired/);
    assert.equal(r.children.size, 0);
    const changed = await assignment("echo original");
    changed.arguments.command = "echo malicious";
    await assert.rejects(r.assignOnce(changed), /digest|approval|correlation/i);
    assert.equal(f.ledger.get(changed.identity.jobId), undefined);
  } finally {
    await f.cleanup();
  }
});
test("actual daemon process death after spawn leaves unknown attempt; reopen/query/reassign adds no external effect", async () => {
  const f = await fixture();
  try {
    const marker = join(f.path, "effect-after-crash"),
      a = await assignment(nodeCommand(fixtureChild, "append-wait", marker)),
      input = join(f.directory, "crash-input.json");
    await privateWrite(
      input,
      JSON.stringify({ profile: f.profile, assignment: a, directory: f.directory, marker }),
    );
    await assert.rejects(
      promisify(execFile)(process.execPath, [
        fileURLToPath(new URL("./fixtures/daemon.ts", import.meta.url)),
        "start-crash",
        input,
      ]),
      { code: 77 },
    );
    assert.equal(await readFile(marker, "utf8"), "effect\n");
    const guard = await Guard.acquire(join(f.directory, "daemon.guard.sqlite"));
    guard.close();
    f.ledger.recover();
    const recovered = await runtime(f);
    assert.equal(recovered.queryExisting(a.identity).state, "unknown");
    await recovered.assignOnce(a);
    await recovered.tick();
    assert.equal(recovered.children.size, 0);
    assert.equal(await readFile(marker, "utf8"), "effect\n");
    assert.equal(f.ledger.rootAvailable(f.root.key), false);
    await new Promise<void>((resolve) => setTimeout(resolve, 2100));
    assert.equal(await readFile(marker, "utf8"), "effect\n");
  } finally {
    await f.cleanup();
  }
});
test("observed signal cancellation persists intent first, reports actual exit and leaves terminal commit separate", async () => {
  const f = await fixture();
  let r: ExecutorRuntime | undefined, a: Awaited<ReturnType<typeof assignment>> | undefined;
  try {
    const marker = join(f.path, "cancel-effect");
    a = await assignment(nodeCommand(fixtureChild, "append-wait", marker));
    r = await runtime(f);
    await r.locals.get("root")?.request(prepare(a, f.initial.manifestHash));
    await r.assignOnce(a);
    const pending = r.approvals.list()[0];
    if (!pending) throw new Error("approval missing");
    r.approvals.decide(a.identity.jobId, pending.digest, "allow");
    await r.tick();
    await eventually(async () => {
      try {
        return (await readFile(marker, "utf8")) === "effect\n";
      } catch {
        return false;
      }
    }, "child effect missing");
    const disposition = await r.cancel(a.identity, "operator cancellation");
    assert.equal(disposition.state, "stopped");
    assert.equal(disposition.possibleExternalEffects, true);
    const id = a.identity.jobId;
    await eventually(() => !!f.ledger.get(id)?.result, "cancel result missing");
    assert.equal(f.ledger.get(id)?.cancelled, true);
    assert.equal(f.ledger.get(id)?.result?.state, "cancelled");
    assert.equal(f.ledger.get(id)?.committed, undefined);
    assert.equal(await readFile(marker, "utf8"), "effect\n");
  } finally {
    if (r && a && r.children.has(a.identity.jobId)) await r.cancel(a.identity, "fixture cleanup");
    await f.cleanup();
  }
});
test("daemon shutdown drains the actual child finalizer before SQLite can close and never replays its effects", async () => {
  const f = await fixture(),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>(),
    cancelled = Promise.withResolvers<void>();
  let r: ExecutorRuntime | undefined, stopping: Promise<void> | undefined;
  try {
    const marker = join(f.path, "shutdown-effect"),
      a = await assignment(nodeCommand(fixtureChild, "append-wait", marker));
    r = await runtime(f);
    const local = r.locals.get("root");
    if (!local) throw new Error("local provider absent");
    await local.request(prepare(a, f.initial.manifestHash));
    await r.assignOnce(a);
    const pending = r.approvals.list()[0];
    if (!pending) throw new Error("approval absent");
    r.approvals.decide(a.identity.jobId, pending.digest, "allow");
    await r.tick();
    await eventually(async () => {
      try {
        return (await readFile(marker, "utf8")) === "effect\n";
      } catch {
        return false;
      }
    }, "native process did not append");
    const finished = local.nativeFinished.bind(local);
    local.nativeFinished = async (...args) => {
      entered.resolve();
      await release.promise;
      return finished(...args);
    };
    const cancel = r.cancel.bind(r);
    r.cancel = async (...args) => {
      try {
        return await cancel(...args);
      } finally {
        cancelled.resolve();
      }
    };
    let stopped = false;
    stopping = r.shutdown().then(() => {
      stopped = true;
    });
    await Promise.race([
      entered.promise,
      stopping.then(() => {
        throw new Error("shutdown returned before the child finalizer");
      }),
    ]);
    await cancelled.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(stopped, false, "shutdown returned before the child finalizer");
    assert.equal(
      f.ledger.get(a.identity.jobId)?.cancelled,
      true,
      "ledger stays open during finalization",
    );
    release.resolve();
    await stopping;
    assert.equal(r.children.size, 0);
    assert.equal(f.ledger.get(a.identity.jobId)?.result?.state, "unknown");
    assert.equal(f.ledger.rootAvailable(f.root.key), false);
    assert.equal(await readFile(marker, "utf8"), "effect\n");
    await assert.rejects(r.assignOnce(a), /stopping/);
    f.ledger.recover();
    assert.equal(
      f.ledger.claim(a.identity.jobId, pending.digest, f.root.key, a.identity.jobId),
      false,
    );
  } finally {
    release.resolve();
    await stopping?.catch(() => {});
    if (r?.children.size) await r.shutdown();
    await f.cleanup();
  }
});
