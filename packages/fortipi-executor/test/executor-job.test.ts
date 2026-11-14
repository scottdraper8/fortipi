import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Assignment, ExecutionObservation, ExecutorFrame } from "fortipi-contract/executor";
import { manifestDigest } from "fortipi-contract/executor";
import { adapter, loadProfile, privateWrite } from "../dist/config.js";
import { ExecutorRuntime } from "../dist/daemon.js";
import { Ledger } from "../dist/ledger.js";
import { approvalKey, hash } from "../dist/policy.js";
import { HttpTransport } from "../dist/transport.js";
import type { Manifest } from "../dist/workspace/manifest.js";
import {
  assignment,
  authenticateFixture,
  eventually,
  fixture,
  fixtureChild,
  importRoot,
  jobRenewals,
  nodeCommand,
  prepare,
} from "./fixtures/daemon.ts";
import { connectExecutor, sessionFixture, snapshotFixture } from "./fixtures/transport.ts";

function nativeRuntime(f: Awaited<ReturnType<typeof fixture>>, ledger = f.ledger) {
  const http = new HttpTransport(f.profile, fetch, true);
  authenticateFixture(http);
  return new ExecutorRuntime({
    profile: f.profile,
    ledger,
    directory: f.directory,
    roots: new Map([["root", f.root]]),
    http,
  });
}
async function query(peer: Awaited<ReturnType<typeof sessionFixture>>, a: Assignment) {
  const requestId = randomUUID();
  peer.send({ type: "job.query", requestId, payload: a.identity });
  await eventually(
    () => peer.received.some((f) => f.type === "job.query_result" && f.requestId === requestId),
    "correlated durable query reply missing",
  );
  const result = peer.received.find(
    (f): f is Extract<ExecutorFrame, { type: "job.query_result" }> =>
      f.type === "job.query_result" && f.requestId === requestId,
  );
  assert.ok(result);
  return result.payload;
}
function approvalObservation(
  observed: ExecutionObservation,
  a: Assignment,
  state: "waiting_for_local_policy" | "preparing",
) {
  assert.equal(observed.state, state);
  assert.deepEqual(Object.keys(observed).sort(), ["identity", "operation", "state"]);
  if (observed.state === state) assert.deepEqual(observed.operation, a.approval);
  assert.equal(observed.identity.executionId, a.identity.executionId);
  assert.equal(observed.identity.assignmentDigest, a.identity.assignmentDigest);
}

test("durable local approval survives 30 real seconds and reconnect despite a lost pending frame; denial starts no child", async () => {
  const f = await fixture(),
    peer = await sessionFixture(f.profile, {
      register: true,
      acknowledge: true,
      dropPending: true,
    });
  let connection: ReturnType<typeof connectExecutor> | undefined,
    renewals: ReturnType<typeof jobRenewals> | undefined;
  try {
    f.profile.origin = peer.origin;
    const runtime = nativeRuntime(f);
    const profilePath = join(f.directory, "synthetic-profile.json");
    await privateWrite(profilePath, JSON.stringify(f.profile));
    runtime.reloadProfile = () => loadProfile(profilePath, adapter(), true);
    await runtime.initialize();
    connection = connectExecutor(runtime.http, runtime);
    await eventually(() => connection?.session.registered === true, "registration missing");
    const marker = join(f.path, "no-unapproved-effect"),
      a = await assignment(nodeCommand(fixtureChild, "append", marker)),
      started = performance.now();
    await runtime.assignOnce(a);
    renewals = jobRenewals(runtime, a);
    for (let n = 0; n < 7; n++) {
      approvalObservation(await query(peer, a), a, "waiting_for_local_policy");
      assert.equal(runtime.children.size, 0);
      assert.equal(f.ledger.get(a.identity.jobId)?.state, "pending");
      await assert.rejects(readFile(marker), { code: "ENOENT" });
      if (n === 2) {
        const epoch: number = connection.session.connectionEpoch;
        peer.disconnect();
        await assert.rejects(connection.connected, /executor session transport failed/);
        assert.throws(() => runtime.http.executorJobQuery(a), /registered assigned-job/);
        connection = connectExecutor(runtime.http, runtime);
        await eventually(() => connection?.session.registered === true, "reconnect missing");
        assert.ok(connection.session.connectionEpoch > epoch);
      }
      if (n < 6) await delay(5000);
    }
    assert.ok(performance.now() - started >= 30000, "real pending interval must cross 30 seconds");
    assert.ok(renewals.observations.length >= 2, "actual lease_update renewals required");
    assert.ok(
      renewals.observations.every((v) => v.leaseVersion > 1 && v.remainingLeaseMs <= 30000),
    );
    assert.equal(
      peer.received.some((f) => f.type === "local_policy.pending"),
      false,
    );
    runtime.approvals.decide(
      a.identity.jobId,
      approvalKey(a, f.profile.policy, f.root.key),
      "deny",
    );
    assert.equal((await query(peer, a)).state, "not_started");
    await runtime.tick();
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    assert.equal(runtime.children.size, 0);
    const stale = await assignment(nodeCommand(fixtureChild, "append", marker));
    await runtime.assignOnce(stale);
    const changed = structuredClone(f.profile);
    changed.policy.version++;
    await privateWrite(profilePath, JSON.stringify(changed));
    assert.equal(
      (await query(peer, stale)).state,
      "unknown",
      "changed protected policy invalidates the old approval",
    );
    assert.equal(runtime.profile.policy.version, changed.policy.version);
    assert.equal(runtime.children.size, 0);
    const authority = runtime.http.authority,
      load = runtime.reloadProfile;
    assert.ok(authority);
    authority.credentialExpiresAt = Date.now() + 100;
    runtime.reloadProfile = async () => {
      const current = await load();
      await delay(150); // Real expiry during a delegated protected-profile read.
      return current;
    };
    await assert.rejects(
      runtime.receive({ type: "job.query", requestId: randomUUID(), payload: stale.identity }),
      { message: "current executor transport authority required" },
    );
  } finally {
    try {
      await renewals?.stop();
    } finally {
      try {
        connection?.controller.abort();
        await connection?.connected;
      } finally {
        await peer.close();
        await f.cleanup();
      }
    }
  }
});

test("allowed Computer materialization answers preparing before its winning claim and executes exactly once after real bytes arrive", async () => {
  const f = await fixture();
  let peer: Awaited<ReturnType<typeof snapshotFixture>> | undefined,
    connection: ReturnType<typeof connectExecutor> | undefined,
    runtime: ExecutorRuntime | undefined,
    ticking: Promise<void> | undefined;
  try {
    const binding = f.profile.bindings[0];
    assert.ok(binding);
    binding.providerKind = "computer";
    const bytes = Buffer.from("assigned immutable base"),
      sha = hash(bytes),
      manifest: Manifest = {
        version: 1,
        entries: [{ path: "base.txt", type: "file", mode: 420, size: bytes.length, sha256: sha }],
      },
      marker = join(f.path, "one-effect"),
      a = await assignment(nodeCommand(fixtureChild, "append", marker));
    peer = await snapshotFixture(
      f.profile,
      a,
      manifest,
      await manifestDigest(manifest),
      new Map([[sha, bytes]]),
    );
    peer.setDrop(undefined);
    peer.holdManifest();
    f.profile.origin = peer.origin;
    runtime = nativeRuntime(f);
    await runtime.initialize();
    connection = connectExecutor(runtime.http, runtime);
    await eventually(() => connection?.session.registered === true, "registration missing");
    await runtime.assignOnce(a);
    approvalObservation(await query(peer, a), a, "waiting_for_local_policy");
    runtime.approvals.decide(
      a.identity.jobId,
      approvalKey(a, f.profile.policy, f.root.key),
      "allow",
    );
    ticking = runtime.tick();
    void ticking.catch(() => {});
    await eventually(
      () => peer?.requests.some((r) => r.endsWith("/manifest")) === true,
      "manifest read not started",
    );
    for (let n = 0; n < 3; n++) {
      approvalObservation(await query(peer, a), a, "preparing");
      assert.equal(runtime.children.size, 0);
      assert.equal(f.ledger.get(a.identity.jobId)?.state, "pending");
      await assert.rejects(readFile(marker), { code: "ENOENT" });
      await delay(100);
    }
    peer.releaseManifest();
    await ticking;
    await eventually(
      () => !!f.ledger.get(a.identity.jobId)?.result,
      "actual native result missing",
    );
    assert.equal(await readFile(marker, "utf8"), "effect\n");
    assert.equal(f.ledger.get(a.identity.jobId)?.result?.state, "succeeded");
    assert.equal((await query(peer, a)).state, "pending_sync");
    await runtime.assignOnce(a);
    await runtime.tick();
    assert.equal(await readFile(marker, "utf8"), "effect\n");
    assert.equal(
      (await readFile(join(f.directory, "scratch", a.identity.executionId, "base.txt"))).toString(),
      bytes.toString(),
    );
    await assert.rejects(readFile(join(f.rootPath, "base.txt")), { code: "ENOENT" });
    assert.ok(peer.requests.every((p) => p.includes(`/v1/executor/jobs/${a.identity.jobId}/`)));
  } finally {
    peer?.releaseManifest();
    await ticking?.catch(() => {});
    connection?.controller.abort();
    await connection?.connected;
    await runtime?.shutdown();
    await peer?.close();
    await f.cleanup();
  }
});

test("actual post-exit collection stays pending_sync only in its owning runtime", async () => {
  const f = await fixture(),
    peer = await sessionFixture(f.profile, { register: true, acknowledge: true }),
    release = Promise.withResolvers<void>();
  let runtime: ExecutorRuntime | undefined,
    connection: ReturnType<typeof connectExecutor> | undefined,
    reopened: Ledger | undefined,
    collecting = false;
  const marker = join(f.path, "one-collected-effect"),
    a = await assignment(nodeCommand(fixtureChild, "append-wait", marker));
  try {
    f.profile.origin = peer.origin;
    runtime = nativeRuntime(f);
    await runtime.initialize();
    const local = runtime.locals.get("root");
    assert.ok(local);
    await importRoot(local);
    await local.request(prepare(a, f.initial.manifestHash));
    const finish = local.nativeFinished.bind(local);
    local.nativeFinished = async (...args) => {
      collecting = true;
      await release.promise;
      return finish(...args);
    };
    connection = connectExecutor(runtime.http, runtime);
    await eventually(() => connection?.session.registered === true, "registration missing");
    await runtime.assignOnce(a);
    runtime.approvals.decide(
      a.identity.jobId,
      approvalKey(a, f.profile.policy, f.root.key),
      "allow",
    );
    await runtime.tick();
    await eventually(async () => {
      try {
        return (await readFile(marker, "utf8")) === "effect\n";
      } catch {
        return false;
      }
    }, "actual child effect missing");
    assert.equal((await query(peer, a)).state, "running");
    await eventually(() => collecting, "actual post-exit collection did not enter its hold");
    assert.equal(runtime.children.get(a.identity.jobId)?.exitCode, 0);
    assert.equal(runtime.active.has(a.identity.jobId), true);
    assert.equal(f.ledger.get(a.identity.jobId)?.state, "running");
    assert.equal(f.ledger.get(a.identity.jobId)?.result, undefined);
    const held = await query(peer, a);
    assert.equal(held.state, "pending_sync", "Owned collection is not a lost execution");
    assert.equal("result" in held, false, "No result exists before durable collection");
    assert.equal(f.ledger.get(a.identity.jobId)?.committed, undefined);
    assert.equal(nativeRuntime(f).queryExisting(a.identity).state, "unknown");
    reopened = await Ledger.open(f.directory, f.profile.ledgerId, f.ledger.limits);
    assert.notEqual(reopened.incarnation, f.ledger.incarnation);
    assert.equal(nativeRuntime(f, reopened).queryExisting(a.identity).state, "unknown");
    reopened.close();
    reopened = undefined;
    await runtime.assignOnce(a);
    assert.equal(await readFile(marker, "utf8"), "effect\n", "Duplicate assign cannot replay");
    release.resolve();
    await eventually(() => !!f.ledger.get(a.identity.jobId)?.result, "durable result missing");
    assert.equal(f.ledger.get(a.identity.jobId)?.result?.state, "succeeded");
    assert.equal((await query(peer, a)).state, "pending_sync");
    assert.equal(await readFile(marker, "utf8"), "effect\n");
  } finally {
    release.resolve();
    if (runtime && collecting)
      await eventually(() => !!f.ledger.get(a.identity.jobId)?.result, "finalizer did not drain");
    connection?.controller.abort();
    await connection?.connected;
    await runtime?.shutdown();
    reopened?.close();
    await peer.close();
    await f.cleanup();
  }
});

test("owned post-exit collection loses certainty at real lease expiry and revocation", async () => {
  const f = await fixture(),
    release = Promise.withResolvers<void>();
  let runtime: ExecutorRuntime | undefined,
    stopping: Promise<void> | undefined,
    collecting = false;
  try {
    const marker = join(f.path, "one-expiring-effect"),
      a = await assignment(nodeCommand(fixtureChild, "append-wait", marker));
    a.identity.lease.expiresAt = Date.now() + 5000;
    runtime = nativeRuntime(f);
    await runtime.initialize();
    const local = runtime.locals.get("root");
    assert.ok(local);
    await importRoot(local);
    await local.request(prepare(a, f.initial.manifestHash));
    const finish = local.nativeFinished.bind(local);
    local.nativeFinished = async (...args) => {
      collecting = true;
      await release.promise;
      return finish(...args);
    };
    runtime.connected = true;
    await runtime.assignOnce(a);
    runtime.approvals.decide(
      a.identity.jobId,
      approvalKey(a, f.profile.policy, f.root.key),
      "allow",
    );
    await runtime.tick();
    await eventually(() => collecting, "actual post-exit collection did not enter its hold");
    assert.equal(runtime.children.get(a.identity.jobId)?.exitCode, 0);
    assert.equal(runtime.queryExisting(a.identity).state, "pending_sync");
    await delay(Math.max(0, a.identity.lease.expiresAt - Date.now() + 1));
    assert.ok(Date.now() >= a.identity.lease.expiresAt);
    assert.equal(runtime.queryExisting(a.identity).state, "unknown");
    stopping = runtime.shutdown();
    assert.equal(runtime.revoked, true);
    assert.throws(() => runtime?.queryExisting(a.identity), {
      message: "executor execution authority mismatch",
    });
    release.resolve();
    await stopping;
    assert.equal(f.ledger.get(a.identity.jobId)?.result?.state, "unknown");
    assert.equal(f.ledger.get(a.identity.jobId)?.committed, undefined);
    assert.equal(await readFile(marker, "utf8"), "effect\n");
  } finally {
    release.resolve();
    await stopping;
    await runtime?.shutdown();
    await f.cleanup();
  }
});

test("old-incarnation pending and claimed rows never report preparing or restart a process", async () => {
  const f = await fixture();
  let reopened: Ledger | undefined;
  try {
    const runtime = nativeRuntime(f),
      pending = await assignment("must never run"),
      claimed = await assignment("must never replay");
    await runtime.assignOnce(pending);
    await runtime.assignOnce(claimed);
    for (const a of [pending, claimed])
      runtime.approvals.decide(
        a.identity.jobId,
        approvalKey(a, f.profile.policy, f.root.key),
        "allow",
      );
    approvalObservation(runtime.queryExisting(pending.identity), pending, "preparing");
    f.profile.policy.version++;
    assert.equal(
      runtime.queryExisting(pending.identity).state,
      "unknown",
      "old approval cannot report preparing under a changed policy",
    );
    f.profile.policy.version--;
    assert.ok(
      f.ledger.claim(
        claimed.identity.jobId,
        approvalKey(claimed, f.profile.policy, f.root.key),
        f.root.key,
        claimed.identity.jobId,
      ),
    );
    assert.equal(
      runtime.queryExisting(claimed.identity).state,
      "unknown",
      "a claim without a live child is uncertain",
    );
    reopened = await Ledger.open(f.directory, f.profile.ledgerId, f.ledger.limits);
    const recovered = nativeRuntime(f, reopened);
    assert.equal(
      recovered.queryExisting(pending.identity).state,
      "unknown",
      "old pending is never a new-incarnation preparation",
    );
    reopened.recover();
    assert.equal(recovered.queryExisting(pending.identity).state, "not_started");
    assert.equal(recovered.queryExisting(claimed.identity).state, "unknown");
    const absent = await assignment("absent is uncertain");
    assert.equal(recovered.queryExisting(absent.identity).state, "unknown");
    recovered.connected = true;
    await recovered.assignOnce(pending);
    await recovered.assignOnce(claimed);
    await recovered.tick();
    assert.equal(recovered.children.size, 0);
    assert.equal(reopened.get(claimed.identity.jobId)?.state, "unknown");
  } finally {
    reopened?.close();
    await f.cleanup();
  }
});

test("executor snapshot reads fail closed on reconnect, corrupt bytes and revoked authority without application fallback", async () => {
  for (const fault of ["epoch", "corrupt", "revoked"] as const) {
    const f = await fixture(),
      a = await assignment("no native child"),
      bytes = Buffer.from("actual blob"),
      sha = hash(bytes),
      manifest: Manifest = {
        version: 1,
        entries: [{ path: "input", type: "file", mode: 420, size: bytes.length, sha256: sha }],
      },
      peer = await snapshotFixture(
        f.profile,
        a,
        manifest,
        await manifestDigest(manifest),
        new Map([[sha, bytes]]),
      );
    let connection: ReturnType<typeof connectExecutor> | undefined,
      reading: Promise<unknown> | undefined;
    try {
      f.profile.origin = peer.origin;
      const runtime = nativeRuntime(f);
      await runtime.initialize();
      await runtime.assignOnce(a);
      assert.throws(() => runtime.http.executorJobQuery(a), /registered assigned-job|credential/);
      connection = connectExecutor(runtime.http, runtime);
      await eventually(() => connection?.session.registered === true, "registration missing");
      if (fault === "corrupt") peer.setCorrupt(true);
      else peer.holdManifest();
      reading = runtime.snapshots.materialize(a);
      void reading.catch(() => {});
      await eventually(
        () => peer.requests.some((r) => r.endsWith("/manifest")),
        "manifest not requested",
      );
      if (fault === "epoch") {
        peer.disconnect();
        await assert.rejects(connection.connected, /executor session transport failed/);
        connection = connectExecutor(runtime.http, runtime);
        await eventually(() => connection?.session.registered === true, "reconnect missing");
        peer.releaseManifest();
        await assert.rejects(reading, /registered assigned-job/);
        const scratch = await runtime.snapshots.materialize(a);
        assert.equal((await scratch.read("input", 100)).toString(), bytes.toString());
        assert.deepEqual([...new Set(peer.queries.map((q) => q.epoch))], [1, 2]);
      } else if (fault === "revoked") {
        // Same current executor revocation operation exercised by the real frame handler.
        await runtime.receive({
          type: "executor.presence",
          requestId: randomUUID(),
          payload: {
            executorId: f.profile.executorId,
            generation: f.profile.executorGeneration,
            ledgerId: f.ledger.ledgerId,
            ledgerInstanceId: f.ledger.ledgerInstanceId,
            state: "revoking",
            platform: connection.registration.payload.platform,
            capabilities: [],
            connectionEpoch: connection.session.connectionEpoch,
            caseBehavior: "sensitive",
            confinement: "host",
            rootBindingIds: ["root"],
            transferLimits: runtime.http.transferLimits(),
          },
        });
        peer.releaseManifest();
        assert.equal(runtime.revoked, true);
        assert.equal(runtime.http.revoked, true);
        await assert.rejects(reading, { message: "current executor transport authority required" });
        assert.throws(() => runtime.queryExisting(a.identity), {
          message: "executor execution authority mismatch",
        });
      } else {
        await assert.rejects(reading, /snapshot file integrity/);
        await assert.rejects(runtime.snapshots.materialize(a), /query-only/);
      }
      assert.equal(runtime.children.size, 0);
      assert.equal(
        peer.requests.some((p) => p.includes("/v1/workspaces/")),
        false,
      );
    } finally {
      peer.releaseManifest();
      await reading?.catch(() => {});
      connection?.controller.abort();
      await connection?.connected;
      await peer.close();
      await f.cleanup();
    }
  }
});

test("lost upload allocation and seal replies retain one immutable executor intent and never write after validation", async () => {
  for (const fault of ["begin", "validate"] as const) {
    const f = await fixture(),
      a = await assignment("no child"),
      peer = await snapshotFixture(
        f.profile,
        a,
        { version: 1, entries: [] },
        f.initial.manifestHash,
        new Map(),
      );
    let connection: ReturnType<typeof connectExecutor> | undefined;
    try {
      f.profile.origin = peer.origin;
      const runtime = nativeRuntime(f);
      await runtime.initialize();
      await runtime.assignOnce(a);
      connection = connectExecutor(runtime.http, runtime);
      await eventually(() => connection?.session.registered === true, "registration missing");
      peer.setDrop(fault);
      const root = await runtime.snapshots.materialize(a);
      await root.write("changed", Buffer.alloc(262145, 0x63), 420);
      const requestId = randomUUID(),
        commitId = randomUUID();
      await assert.rejects(runtime.snapshots.stage(a, root, requestId, commitId));
      const puts = peer.requests.filter((p) => p.startsWith("PUT")).length;
      const result = await runtime.snapshots.stage(a, root, randomUUID(), randomUUID());
      assert.equal(result.commitId, commitId);
      assert.equal(result.stageId, "public_stage");
      assert.deepEqual(peer.begins[0], peer.begins[1]);
      if (fault === "validate")
        assert.equal(peer.requests.filter((p) => p.startsWith("PUT")).length, puts);
      assert.equal(
        f.ledger.record<{ requestId: string }>("stages", `upload_intent_${a.identity.executionId}`)
          ?.requestId,
        requestId,
      );
      assert.equal(runtime.children.size, 0);
    } finally {
      connection?.controller.abort();
      await connection?.connected;
      await peer.close();
      await f.cleanup();
    }
  }
});
