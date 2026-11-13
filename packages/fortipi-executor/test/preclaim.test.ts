import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { manifestDigest } from "fortipi-contract/executor";
import { adapter, loadProfile, privateWrite, secureDirectory } from "../dist/config.js";
import { ExecutorRuntime } from "../dist/daemon.js";
import { approvalKey, hash } from "../dist/policy.js";
import { HttpTransport } from "../dist/transport.js";
import type { Manifest } from "../dist/workspace/manifest.js";
import { scan } from "../dist/workspace/manifest.js";
import { SafeRoot } from "../dist/workspace/paths.js";
import {
  assignment,
  eventually,
  fixture,
  fixtureChild,
  jobRenewals,
  nodeCommand,
} from "./fixtures/daemon.ts";
import { connectExecutor, snapshotFixture } from "./fixtures/transport.ts";

async function preparation(
  count = 1,
  options: { same?: boolean; empty?: boolean; mismatchedSize?: boolean; deadlineMs?: number } = {},
) {
  const f = await fixture(),
    marker = join(f.path, "actual-start"),
    a = await assignment(
      nodeCommand(fixtureChild, "append", marker),
      undefined,
      undefined,
      options.deadlineMs,
    ),
    files = new Map<string, Buffer>(),
    manifest: Manifest = { version: 1, entries: [] };
  for (let i = 0; i < count; i++) {
    const bytes = options.empty
        ? Buffer.alloc(0)
        : Buffer.from(options.same ? "repeated immutable base" : `distinct immutable base ${i}`),
      sha = hash(bytes);
    files.set(sha, bytes);
    manifest.entries.push({
      path: `base-${i.toString().padStart(2, "0")}`,
      type: "file",
      mode: options.same && i % 2 ? 493 : 420,
      size: bytes.length + (options.mismatchedSize && i === 1 ? 1 : 0),
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

/** Keep actual native writes/permissions; inject a change only after the first durable destination. */
function afterFirstWrite(
  h: Preparation,
  change: (data: Uint8Array, root: SafeRoot) => Promise<void>,
) {
  const original = SafeRoot.prototype.write;
  SafeRoot.prototype.write = async function (path, data, mode) {
    await original.call(this, path, data, mode);
    if (
      path === "base-00" &&
      this.identity.path === join(h.f.directory, "scratch", h.a.identity.executionId)
    )
      await change(data, this);
  };
  return () => {
    SafeRoot.prototype.write = original;
  };
}

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
  // This positive case includes 31 real native writes/permission checks plus
  // a 31-second retry. Declare its whole budget before hashing the assignment;
  // the runtime must still retain that exact deadline and renewable lease.
  const h = await preparation(31, { deadlineMs: 180000 }),
    fault = readFault(h, "typed", 14, 31000),
    initialLeaseExpiry = h.a.identity.lease.expiresAt,
    deadline = h.a.identity.deadline,
    renewals = jobRenewals(h.runtime, h.a);
  let pending: Promise<void> | undefined;
  try {
    pending = h.runtime.start(h.row);
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await eventually(
      () => {
        if (fault.reads.some((r) => r.status === 429)) return true;
        assert.equal(settled, false, "Preparation ended before the actual typed429");
        return false;
      },
      "typed429 not observed within the original job deadline",
      Math.max(1, deadline - Date.now()),
    );
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

test("typed429 retry reloads consent, revocation, epoch, root and cancellation instead of starting a child", async (t) => {
  for (const change of ["consent", "revoke", "epoch", "root", "cancel", "stop", "abort"] as const) {
    const h = await preparation(),
      fault = readFault(h, "typed", 1, 3000),
      caller = new AbortController();
    let profileAccess = Promise.resolve();
    const withProfile = <T>(operation: () => Promise<T>): Promise<T> => {
      const result = profileAccess.then(operation);
      profileAccess = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    };
    if (change === "consent") {
      // Revalidation must read the completed fixture policy publication. Keep
      // actual native protection/read checks, including replacement refusal.
      const reloadProfile = h.runtime.reloadProfile;
      assert.ok(reloadProfile);
      h.runtime.reloadProfile = () => withProfile(reloadProfile);
    }
    let pending: Promise<void> | undefined;
    try {
      const deadline = h.a.identity.deadline;
      let settled = false;
      pending = h.runtime.start(h.row, caller.signal);
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      // Native preparation precedes the first blob GET. Observe its typed429
      // within the already-hashed job deadline, not an unrelated 10s cutoff.
      await eventually(
        () => {
          assert.equal(settled, false, `Preparation ended before typed429 (${change})`);
          return fault.reads.length === 1 && fault.reads[0]?.status === 429;
        },
        `retry wait not reached before the original job deadline (${change})`,
        Math.max(1, deadline - Date.now()),
      );
      t.diagnostic(
        JSON.stringify({
          change,
          retryAt: fault.retryAt,
          observedAt: Date.now(),
          deadline,
          leaseExpiresAt: h.a.identity.lease.expiresAt,
        }),
      );
      await preparing(h);
      if (change === "consent") {
        const profile = structuredClone(h.f.profile);
        profile.policy.trustedHost = false;
        await withProfile(() => privateWrite(h.path, JSON.stringify(profile)));
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
      assert.equal(h.a.identity.deadline, deadline);
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

test("31 repeated snapshot destinations fetch one verified blob, preserve all bytes and modes, and never share a cache with another job", async (t) => {
  for (const { count, empty } of [
    { count: 31, empty: false },
    { count: 2, empty: false },
    { count: 2, empty: true },
  ]) {
    const h = await preparation(count, { same: true, empty }),
      renewals = jobRenewals(h.runtime, h.a);
    let actualRoot: SafeRoot | undefined, pending: Promise<void> | undefined;
    const restore = afterFirstWrite(h, async (_bytes, root) => {
      actualRoot = root;
      await renewals.renew();
    });
    const started = performance.now();
    try {
      pending = h.runtime.start(h.row);
      await pending;
      await eventually(() => !!h.f.ledger.get(h.a.identity.jobId)?.result, "native result missing");
      assert.equal(h.f.ledger.get(h.a.identity.jobId)?.result?.state, "succeeded");
      assert.equal(await readFile(h.marker, "utf8"), "effect\n");
      assert.equal(
        h.peer.requests.filter((r) => r.startsWith("GET ") && r.includes("/blobs/")).length,
        1,
        "one HTTP read per distinct SHA in each new materialization",
      );
      assert.ok(actualRoot);
      assert.deepEqual((await scan(actualRoot, h.runtime.http.limits)).manifest, h.manifest);
      for (const entry of h.manifest.entries) {
        assert.equal(entry.type, "file");
        if (entry.type === "file") {
          const bytes: Buffer = await readFile(join(actualRoot.identity.path, entry.path));
          assert.equal(bytes.length, entry.size);
          assert.equal(hash(bytes), entry.sha256);
        }
      }
      assert.ok(renewals.observations.some((r) => r.leaseVersion > 1));
      await h.runtime.assignOnce(h.a);
      assert.equal(await readFile(h.marker, "utf8"), "effect\n");
      t.diagnostic(
        JSON.stringify({
          files: count,
          empty,
          blobGETs: 1,
          leaseVersions: renewals.observations.map((r) => r.leaseVersion),
          processStarts: 1,
          elapsedMs: performance.now() - started,
        }),
      );
    } finally {
      restore();
      await renewals.stop();
      await h.close(pending);
    }
  }
});
test("cached snapshot destinations fail closed on mid-write authority, epoch, real lease expiry, root or bounds changes", async () => {
  for (const change of [
    "consent",
    "revoke",
    "epoch",
    "lease",
    "root",
    "policy-version",
    "credential-version",
    "limits",
    "stop",
    "abort",
  ] as const) {
    const h = await preparation(3, { same: true }),
      caller = new AbortController();
    let pending: Promise<void> | undefined,
      stopping: Promise<void> | undefined,
      reconnected: ReturnType<typeof connectExecutor> | undefined;
    const restore = afterFirstWrite(h, async () => {
      if (change === "consent" || change === "policy-version" || change === "credential-version") {
        const profile = structuredClone(h.f.profile);
        if (change === "consent") profile.policy.trustedHost = false;
        else if (change === "policy-version") profile.policy.version++;
        else profile.credential.generation++;
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
        reconnected = connectExecutor(h.runtime.http, h.runtime);
        await eventually(
          () => reconnected?.session.registered === true,
          "new epoch not registered",
        );
        assert.ok(reconnected.session.connectionEpoch > h.connection.session.connectionEpoch);
      } else if (change === "lease") {
        const row = h.f.ledger.existing(h.a.identity);
        assert.ok(row);
        await delay(Math.max(0, row.assignment.identity.lease.expiresAt - Date.now()) + 10);
      } else if (change === "root") {
        await rename(h.f.rootPath, `${h.f.rootPath}-previous`);
        await secureDirectory(h.f.rootPath);
      } else if (change === "limits") h.runtime.http.limits.snapshotBytes--;
      else if (change === "stop") stopping = h.runtime.shutdown(pending?.catch(() => {}));
      else caller.abort(new Error("explicit cached write abort"));
    });
    try {
      pending = h.runtime.start(h.row, caller.signal);
      void pending.catch(() => {});
      const expected =
        change === "consent"
          ? /disabled|trusted|host/
          : change === "policy-version"
            ? /approval expired/
            : change === "credential-version"
              ? /profile identity changed/
              : change === "lease"
                ? /expired authority|expired assigned-job/
                : change === "epoch"
                  ? /registered assigned-job/
                  : change === "root"
                    ? /workspace root identity changed/
                    : change === "limits"
                      ? /snapshot limits changed/
                      : change === "stop"
                        ? /executor stopping/
                        : change === "abort"
                          ? /explicit cached write abort/
                          : /preparation authority/;
      await assert.rejects(pending, expected);
      await stopping;
      assert.equal(
        h.peer.requests.filter((r) => r.startsWith("GET ") && r.includes("/blobs/")).length,
        1,
        "invalid context cannot fall back to HTTP",
      );
      await assert.rejects(
        readFile(join(h.f.directory, "scratch", h.a.identity.executionId, "base-01")),
        { code: "ENOENT" },
        "authority loss must leave the next cached destination unwritten",
      );
      await assert.rejects(readFile(h.marker), { code: "ENOENT" });
      assert.equal(h.runtime.children.size, 0);
      assert.equal(h.f.ledger.get(h.a.identity.jobId)?.state, "closed");
      await assert.rejects(h.runtime.snapshots.materialize(h.a), /query-only/);
    } finally {
      restore();
      reconnected?.controller.abort();
      await reconnected?.connected;
      await h.close(pending);
    }
  }
});

test("snapshot cache rejects conflicting declared sizes, corrupt wire bytes and changed retained bytes without fallback or child", async () => {
  for (const fault of ["size", "wire", "retained"] as const) {
    const h = await preparation(2, { same: true, mismatchedSize: fault === "size" });
    let pending: Promise<void> | undefined;
    if (fault === "wire") h.peer.setCorrupt(true);
    const restore = afterFirstWrite(h, async (bytes) => {
      if (fault === "retained") bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    });
    try {
      pending = h.runtime.start(h.row);
      await assert.rejects(pending, /snapshot file integrity/);
      assert.equal(
        h.peer.requests.filter((r) => r.startsWith("GET ") && r.includes("/blobs/")).length,
        1,
      );
      await assert.rejects(
        readFile(join(h.f.directory, "scratch", h.a.identity.executionId, "base-01")),
        { code: "ENOENT" },
      );
      await assert.rejects(readFile(h.marker), { code: "ENOENT" });
      assert.equal(h.runtime.children.size, 0);
      await assert.rejects(h.runtime.snapshots.materialize(h.a), /query-only/);
    } finally {
      restore();
      await h.close(pending);
    }
  }
});
