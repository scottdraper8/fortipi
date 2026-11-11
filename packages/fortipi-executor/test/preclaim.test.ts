import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { manifestDigest } from "fortipi-contract/executor";
import { adapter, loadProfile, privateWrite } from "../dist/config.js";
import { ExecutorRuntime } from "../dist/daemon.js";
import { approvalKey, hash } from "../dist/policy.js";
import { HttpTransport } from "../dist/transport.js";
import type { Manifest } from "../dist/workspace/manifest.js";
import {
  assignment,
  eventually,
  fixture,
  fixtureChild,
  jobRenewals,
  nodeCommand,
} from "./fixtures/daemon.ts";
import { connectExecutor, snapshotFixture } from "./fixtures/transport.ts";

async function preparation(count = 1) {
  const f = await fixture(),
    marker = join(f.path, "actual-start"),
    a = await assignment(nodeCommand(fixtureChild, "append", marker)),
    files = new Map<string, Buffer>(),
    manifest: Manifest = { version: 1, entries: [] };
  for (let i = 0; i < count; i++) {
    const bytes = Buffer.from(`distinct immutable base ${i}`),
      sha = hash(bytes);
    files.set(sha, bytes);
    manifest.entries.push({
      path: `base-${i.toString().padStart(2, "0")}`,
      type: "file",
      mode: 420,
      size: bytes.length,
      sha256: sha,
    });
  }
  const peer = await snapshotFixture(f.profile, a, manifest, await manifestDigest(manifest), files),
    binding = f.profile.bindings[0];
  assert.ok(binding);
  binding.providerKind = "computer";
  f.profile.origin = peer.origin;
  peer.setDrop(undefined);
  const runtime = new ExecutorRuntime({
      profile: f.profile,
      ledger: f.ledger,
      directory: f.directory,
      roots: new Map([["root", f.root]]),
      http: new HttpTransport(f.profile, fetch, true),
    }),
    path = join(f.directory, "synthetic-profile.json");
  await privateWrite(path, JSON.stringify(f.profile));
  runtime.reloadProfile = () => loadProfile(path, adapter(), true);
  await runtime.initialize();
  const connection = connectExecutor(runtime.http, runtime);
  await eventually(() => connection.session.registered, "registered executor missing");
  await runtime.assignOnce(a);
  runtime.approvals.decide(a.identity.jobId, approvalKey(a, f.profile.policy, f.root.key), "allow");
  const row = f.ledger.existing(a.identity);
  assert.ok(row);
  return {
    f,
    a,
    files,
    manifest,
    peer,
    runtime,
    connection,
    marker,
    path,
    row,
    async close(pending?: Promise<unknown>) {
      try {
        await runtime.shutdown(pending?.catch(() => {}));
      } finally {
        try {
          connection.controller.abort();
          await connection.connected;
        } finally {
          await peer.close();
          await f.cleanup();
        }
      }
    },
  };
}
type Preparation = Awaited<ReturnType<typeof preparation>>;

function readFault(
  h: Preparation,
  kind: "typed" | "untyped" | "nonretryable" | "lost" | "partial" | "deadline",
  after = 1,
  retryAfterMs = 1100,
  deliveryDelayMs = 0,
) {
  const original = h.peer.options.serve;
  assert.ok(original);
  const reads: { path: string; at: number; status: number }[] = [];
  let applied = false,
    retryAt = 0;
  h.peer.options.serve = async (req, res, epoch) => {
    const path = new URL(req.url ?? "/", "http://fixture").pathname;
    if (req.method === "GET" && path.includes("/blobs/")) {
      const entry = { path, at: Date.now(), status: 200 };
      reads.push(entry);
      if (!applied && reads.length === after) {
        applied = true;
        if (kind === "lost") {
          req.socket.destroy();
          return;
        }
        if (kind === "partial") {
          const bytes = h.files.get(path.split("/").at(-1) ?? "");
          assert.ok(bytes);
          res.writeHead(200, { "Content-Length": bytes.length, "X-Content-SHA256": hash(bytes) });
          res.write(bytes.subarray(0, 1));
          setImmediate(() => res.destroy());
          return;
        }
        await delay(deliveryDelayMs);
        const wait = kind === "deadline" ? h.a.identity.deadline - Date.now() + 1000 : retryAfterMs;
        retryAt = Date.now() + wait;
        entry.status = 429;
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(
          kind === "untyped"
            ? "unstructured"
            : JSON.stringify({
                error: {
                  code: "rate_limited",
                  message: "Synthetic physical GET pressure",
                  requestId: randomUUID(),
                  retryable: kind !== "nonretryable",
                  details: { retryAfterMs: wait },
                },
              }),
        );
        return;
      }
    }
    await original(req, res, epoch);
  };
  return {
    reads,
    get retryAt() {
      return retryAt;
    },
  };
}
async function preparing(h: Preparation) {
  const requestId = randomUUID();
  h.peer.send({ type: "job.query", requestId, payload: h.a.identity });
  await eventually(
    () => h.peer.received.some((f) => f.type === "job.query_result" && f.requestId === requestId),
    "preparing query missing",
  );
  const result = h.peer.received.find(
    (f) => f.type === "job.query_result" && f.requestId === requestId,
  );
  assert.equal(result?.type, "job.query_result");
  if (result?.type === "job.query_result") assert.equal(result.payload.state, "preparing");
  assert.equal(h.runtime.children.size, 0);
  assert.equal(h.f.ledger.get(h.a.identity.jobId)?.state, "pending");
  await assert.rejects(readFile(h.marker), { code: "ENOENT" });
}

test("31 distinct snapshot blobs survive typed429 in one ongoing preparation across real lease renewals and start once", async (t) => {
  const h = await preparation(31),
    fault = readFault(h, "typed", 14, 31000),
    initialLeaseExpiry = h.a.identity.lease.expiresAt,
    deadline = h.a.identity.deadline,
    renewals = jobRenewals(h.runtime, h.a);
  let pending: Promise<void> | undefined;
  try {
    pending = h.runtime.start(h.row);
    void pending.catch(() => {});
    await eventually(() => fault.reads.some((r) => r.status === 429), "typed429 not observed");
    await preparing(h);
    const scratch = h.f.ledger.record<{ path: string }>(
      "stages",
      `scratch_${h.a.identity.executionId}`,
    );
    assert.ok(scratch);
    assert.equal(
      (await readFile(join(scratch.path, "base-00"))).toString(),
      "distinct immutable base 0",
    );
    await h.runtime.tick(); // The active owner must not reenter materialize.
    await pending;
    await eventually(() => !!h.f.ledger.get(h.a.identity.jobId)?.result, "native result missing");
    assert.equal(await readFile(h.marker, "utf8"), "effect\n");
    assert.ok(
      Date.now() > initialLeaseExpiry,
      "actual preparation must cross the original lease expiry",
    );
    assert.equal(h.a.identity.deadline, deadline);
    assert.ok(renewals.observations.length >= 3);
    assert.ok(
      renewals.observations.every((r) => r.leaseVersion > 1 && r.remainingLeaseMs <= 30000),
    );
    assert.equal(fault.reads.length, 32);
    assert.equal(new Set(fault.reads.map((r) => r.path)).size, 31);
    assert.ok(
      fault.reads[14] && fault.reads[14].at >= fault.retryAt,
      "no GET before the actual retry bound",
    );
    assert.equal(fault.reads[13]?.path, fault.reads[14]?.path, "only the rejected GET is retried");
    for (const entry of h.manifest.entries) {
      assert.equal(entry.type, "file");
      if (entry.type === "file")
        assert.equal(hash(await readFile(join(scratch.path, entry.path))), entry.sha256);
    }
    await h.runtime.assignOnce(h.a);
    assert.equal(await readFile(h.marker, "utf8"), "effect\n");
    t.diagnostic(
      JSON.stringify({
        distinctBlobs: 31,
        physicalBlobGETs: fault.reads.length,
        retryAt: fault.retryAt,
        retryObservedAt: fault.reads[14]?.at,
        leaseVersions: renewals.observations.map((r) => r.leaseVersion),
        unchangedDeadline: true,
        processStarts: 1,
      }),
    );
  } finally {
    await renewals.stop();
    await h.close(pending);
  }
});

test("typed429 retry reloads consent, revocation, epoch, root and cancellation instead of starting a child", async () => {
  for (const change of ["consent", "revoke", "epoch", "root", "cancel", "stop", "abort"] as const) {
    const h = await preparation(),
      fault = readFault(h, "typed", 1, 3000),
      caller = new AbortController();
    let pending: Promise<void> | undefined;
    try {
      pending = h.runtime.start(h.row, caller.signal);
      void pending.catch(() => {});
      await eventually(() => fault.reads.length === 1, "retry wait not reached");
      await preparing(h);
      if (change === "consent") {
        const profile = structuredClone(h.f.profile);
        profile.policy.trustedHost = false;
        await privateWrite(h.path, JSON.stringify(profile));
      } else if (change === "revoke") {
        await h.runtime.receive({
          type: "executor.presence",
          requestId: randomUUID(),
          payload: {
            executorId: h.f.profile.executorId,
            generation: h.f.profile.executorGeneration,
            connectionEpoch: h.connection.session.connectionEpoch,
            state: "revoking",
            platform: h.connection.registration.payload.platform,
            capabilities: [],
            caseBehavior: "sensitive",
            confinement: "host",
            rootBindingIds: ["root"],
            transferLimits: h.runtime.http.transferLimits(),
          },
        });
      } else if (change === "epoch") {
        h.connection.controller.abort();
        await h.connection.connected;
      } else if (change === "root") {
        h.runtime.roots.delete("root");
      } else if (change === "cancel") {
        assert.equal(
          (await h.runtime.cancel(h.a.identity, "explicit cancel")).state,
          "not-started",
        );
      } else if (change === "stop") await h.runtime.shutdown(pending.catch(() => {}));
      else caller.abort(new Error("caller stopped preparation"));
      const expected =
        change === "consent"
          ? /host|trust|disabled/
          : change === "epoch"
            ? /registered assigned-job|preparation authority/
            : change === "root"
              ? /approval expired/
              : change === "abort"
                ? /caller stopped preparation/
                : change === "stop"
                  ? /executor stopping/
                  : /preparation authority/;
      await assert.rejects(pending, expected);
      assert.equal(fault.reads.length, 1, "authority loss forbids another GET");
      assert.equal(h.runtime.children.size, 0);
      await assert.rejects(readFile(h.marker), { code: "ENOENT" });
      assert.equal(h.f.ledger.get(h.a.identity.jobId)?.state, "closed");
      await assert.rejects(h.runtime.snapshots.materialize(h.a), /query-only/);
    } finally {
      await h.close(pending);
    }
  }
});

test("preclaim reads never retry untyped or terminal429, lost or partial bodies, or a retry beyond the job deadline", async () => {
  for (const kind of ["untyped", "nonretryable", "lost", "partial", "deadline"] as const) {
    const h = await preparation(),
      fault = readFault(h, kind);
    let pending: Promise<void> | undefined;
    try {
      pending = h.runtime.start(h.row);
      await assert.rejects(
        pending,
        kind === "lost" || kind === "partial"
          ? /fetch failed|terminated/
          : /executor HTTPS request failed \(429\)/,
      );
      assert.equal(fault.reads.length, 1);
      assert.equal(h.runtime.children.size, 0);
      await assert.rejects(readFile(h.marker), { code: "ENOENT" });
      assert.equal(h.f.ledger.get(h.a.identity.jobId)?.state, "closed");
      await assert.rejects(h.runtime.snapshots.materialize(h.a), /query-only/);
    } finally {
      await h.close(pending);
    }
  }
});

test("caller abort cancels the actual in-flight snapshot HTTP body and a fresh runtime remains usable", async () => {
  const h = await preparation(),
    original = h.peer.options.serve;
  assert.ok(original);
  const observed = Promise.withResolvers<void>(),
    closed = Promise.withResolvers<void>(),
    caller = new AbortController();
  h.peer.options.serve = async (req, res, epoch) => {
    if (req.url?.includes("/blobs/")) {
      res.once("close", () => {
        assert.equal(res.writableFinished, false, "the held HTTP body must actually be canceled");
        closed.resolve();
      });
      res.writeHead(200, { "Content-Length": 100 });
      res.write("x");
      observed.resolve();
      return;
    }
    await original(req, res, epoch);
  };
  let pending: Promise<void> | undefined;
  try {
    pending = h.runtime.start(h.row, caller.signal);
    void pending.catch(() => {});
    await observed.promise;
    const abortStarted = performance.now();
    caller.abort(new Error("stop actual HTTP"));
    await assert.rejects(pending, { message: "stop actual HTTP" });
    await closed.promise;
    assert.ok(
      performance.now() - abortStarted < 2000,
      "actual caller abort must cancel before the HTTP timeout",
    );
    assert.equal(h.runtime.children.size, 0);
    await assert.rejects(readFile(h.marker), { code: "ENOENT" });
  } finally {
    await h.close(pending);
  }
  const fresh = await preparation(),
    freshPressure = readFault(fresh, "typed", 1, 1100, 200);
  let pendingFresh: Promise<void> | undefined;
  try {
    pendingFresh = fresh.runtime.start(fresh.row);
    await pendingFresh;
    await eventually(
      () => !!fresh.f.ledger.get(fresh.a.identity.jobId)?.result,
      "fresh runtime start failed",
    );
    assert.equal(await readFile(fresh.marker, "utf8"), "effect\n");
    assert.equal(freshPressure.reads.length, 2);
    assert.ok(
      freshPressure.reads[1] && freshPressure.reads[1].at >= freshPressure.retryAt,
      "relative retry bound starts at response receipt, not the earlier request",
    );
  } finally {
    await fresh.close(pendingFresh);
  }
});
