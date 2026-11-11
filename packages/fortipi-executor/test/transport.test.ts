import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import type { ErrorBody, ExecutorFrame, TransferDescriptor } from "fortipi-contract/executor";
import { validateTransfer } from "fortipi-contract/executor";
import { Ledger } from "../dist/ledger.js";
import { Output } from "../dist/output.js";
import { hash } from "../dist/policy.js";
import { frame, HttpFailure, HttpTransport, readBounded } from "../dist/transport.js";
import { inventoryFor } from "../dist/workspace/manifest.js";
import { Staging } from "../dist/workspace/staging.js";
import { assignment, credential, fixture, resources } from "./fixtures/daemon.ts";
import { relayFixture } from "./fixtures/transport.ts";

test("real HTTP scoped relay validates length/hash/direction, blocks redirects and coalesces pressure", async () => {
  const f = await fixture(),
    bytes = Buffer.from([0, 255, 1, 128, 4]),
    server = await relayFixture(bytes);
  try {
    f.profile.origin = server.origin;
    const http = new HttpTransport(f.profile, fetch, true),
      staging = new Staging(join(f.directory, "stage"), f.ledger, http);
    await staging.initialize();
    const a = await assignment("never"),
      row = f.ledger.admit(a, "approval");
    assert.equal(row.state, "pending");
    const descriptor: TransferDescriptor = {
      transferId: "transfer",
      attemptId: "attempt",
      deploymentId: "deployment",
      direction: "to-executor",
      purpose: "local-stage",
      workspaceId: "workspace",
      bindingVersion: 1,
      operationId: a.identity.lease.operationId,
      operationDigest: a.identity.operationDigest,
      jobId: a.identity.jobId,
      executionId: a.identity.executionId,
      executorId: "executor",
      executorGeneration: 7,
      credential,
      consumer: resources,
      baseRevision: "r0",
      lease: a.identity.lease,
      content: {
        kind: "workspace-file",
        path: "alpha",
        manifestHash: "a".repeat(64),
        uploadId: "upload",
      },
      fileSha256: hash(bytes),
      size: bytes.length,
      chunkBytes: bytes.length,
      chunkHashes: [hash(bytes)],
      expiresAt: Date.now() + 20000,
      deadline: a.identity.deadline,
    };
    await staging.receive(descriptor);
    assert.deepEqual(await staging.bytes(hash(bytes)), bytes);
    const requestsBeforeLimit = server.requests.length;
    http.limits.fileBytes = bytes.length - 1;
    await assert.rejects(http.chunk(descriptor, 0), /bound/);
    assert.equal(
      server.requests.length,
      requestsBeforeLimit,
      "newly lowered live file cap blocks bytes before network",
    );
    http.limits.fileBytes = 4194304;
    assert.equal(server.requests[0]?.authorization, "Bearer synthetic-executor-token");
    assert.match(server.requests[0]?.path ?? "", /attemptId=attempt/);
    assert.throws(
      () => staging.check({ ...descriptor, executorGeneration: 8 }),
      /executor|lease identity/,
    );
    assert.throws(
      () => validateTransfer({ ...descriptor, expiresAt: Date.now() }, Date.now()),
      /expired/,
    );
    assert.throws(
      () =>
        staging.check({ ...descriptor, consumer: { ...resources, workspaceIds: ["different"] } }),
      /scope/,
    );
    server.setCorrupt(true);
    await assert.rejects(http.chunk(descriptor, 0), /integrity/);
    server.setCorrupt(false);
    server.setRedirect(true);
    await assert.rejects(http.chunk(descriptor, 0));
    server.setRedirect(false);
    assert.equal(
      server.requests.some((r) => r.path.includes("exfiltrate")),
      false,
    );
    await assert.rejects(http.request("//example.com/steal"), /cross-origin/);
    server.setPressure(true);
    const before = server.requests.length;
    await assert.rejects(http.chunk(descriptor, 0), /503/);
    await assert.rejects(http.chunk(descriptor, 0), /503/);
    assert.equal(
      server.requests.length,
      before + 1,
      "pressure retry must not hit server again immediately",
    );
    assert.equal(f.ledger.get(a.identity.jobId)?.bodyHash, row.bodyHash);
    assert.equal(f.ledger.get(a.identity.jobId)?.state, "pending");
  } finally {
    await server.close();
    await f.cleanup();
  }
});
test("persisted output retransmits identical frames; wrong ack fails, result receipt does not imply committed", async () => {
  const f = await fixture();
  try {
    const a = await assignment("never"),
      row = f.ledger.admit(a, "approval"),
      output = new Output(
        f.ledger,
        a.identity,
        { ...f.ledger.limits, outputBytesPerJob: 256, inlineTailBytes: 32, artifactBytes: 64 },
        2200,
      );
    output.append("stdout", Buffer.from("λ".repeat(100)));
    output.append("stderr", Buffer.from("stderr"));
    output.finish();
    const frames = f.ledger.outbox();
    assert.ok(frames.length > 0);
    assert.deepEqual(f.ledger.outbox(), frames);
    const first = frames[0];
    if (first?.type !== "job.output") throw new Error("output missing");
    assert.throws(
      () =>
        f.ledger.ack(
          { deliveryId: first.requestId, sequence: first.payload.sequence + 1, persisted: true },
          "output",
        ),
      /unexpected/,
    );
    f.ledger.ack(
      { deliveryId: first.requestId, sequence: first.payload.sequence, persisted: true },
      "output",
    );
    assert.equal(
      f.ledger.outbox().some((x) => x.requestId === first.requestId),
      false,
    );
    const result = await output.result("succeeded", join(f.directory, "artifacts"), true);
    assert.ok(Buffer.byteLength(result.output.tail) <= 34);
    assert.equal(f.ledger.get(a.identity.jobId)?.committed, undefined);
    assert.equal(row.bodyHash, f.ledger.get(a.identity.jobId)?.bodyHash);
    const invalid: unknown = {
      type: "job.query",
      requestId: randomUUID(),
      payload: { ...a.identity, arguments: { command: "forbidden" } },
    };
    assert.throws(() => frame(invalid), /protocol/);
    const wrongAudience: unknown = { type: "message.submit", requestId: "request", payload: {} };
    assert.throws(() => frame(wrongAudience), /protocol/);
    for (const value of frames) assert.doesNotThrow(() => frame(value as ExecutorFrame));
  } finally {
    await f.cleanup();
  }
});
test("ticket metadata authenticates the executor transport role and credential expiry separately from ticket TTL", async () => {
  const f = await fixture(),
    server = await relayFixture(Buffer.alloc(0));
  try {
    f.profile.origin = server.origin;
    const http = new HttpTransport(f.profile, fetch, true),
      identity = {
        deploymentId: f.profile.deploymentId,
        principalId: "executor_principal",
        role: "executor" as const,
        credential: f.profile.credential,
        credentialExpiresAt: Date.now() + 5000,
      };
    server.setTicketIdentity(identity);
    const ticket = await http.ticket();
    assert.ok(ticket.expiresAt > identity.credentialExpiresAt);
    assert.deepEqual(http.authority, identity);
    assert.notDeepEqual(
      http.authority?.credential,
      credential,
      "originating app credential must remain a different identity",
    );
    for (const role of ["admin", "client"] as const) {
      server.setTicketIdentity({ ...identity, role });
      await assert.rejects(http.ticket(), /executor transport authority/);
      assert.equal(http.authority, undefined);
    }
    server.setTicketIdentity({ ...identity, credential });
    await assert.rejects(http.ticket(), /executor transport authority/);
    server.setTicketIdentity({ ...identity, credentialExpiresAt: Date.now() - 1 });
    await assert.rejects(http.ticket(), /executor transport authority/);
  } finally {
    await server.close();
    await f.cleanup();
  }
});
test("small output deliveries count their stored envelope bytes and preserve ledger repair headroom", async () => {
  const f = await fixture(),
    originalLimits = { ...f.ledger.limits };
  try {
    f.ledger.limits.outputBytesPerJob = 1024;
    const a = await assignment("never"),
      admitted = f.ledger.admit(a, "approval"),
      output = new Output(f.ledger, a.identity, f.ledger.limits),
      used = () => {
        const pages = f.ledger.db.prepare("PRAGMA page_count").get() as { page_count: number };
        const size = f.ledger.db.prepare("PRAGMA page_size").get() as { page_size: number };
        return pages.page_count * size.page_size;
      };
    admitted.decision = "allow";
    f.ledger.put(admitted);
    assert.equal(f.ledger.claim(a.identity.jobId, "approval", f.root.key, a.identity.jobId), true);
    // Leave room for a few envelopes, not the originally reserved maximum output.
    f.ledger.limits.ledgerBytes = used() + 65536;
    let rejected = false;
    for (let i = 0; i < 100; i++) {
      try {
        output.append("stdout", Buffer.from("x"));
      } catch (error) {
        assert.match(String(error), /capacity exhausted/);
        rejected = true;
        break;
      }
    }
    assert.equal(rejected, true, "byte quota alone cannot bound many tiny stored envelopes");
    assert.ok(used() <= f.ledger.limits.ledgerBytes);
    assert.equal(f.ledger.get(a.identity.jobId)?.bodyHash, admitted.bodyHash);
    f.ledger.recover();
    assert.equal(f.ledger.get(a.identity.jobId)?.state, "unknown");
  } finally {
    Object.assign(f.ledger.limits, originalLimits);
    await f.cleanup();
  }
});
test("typed infrastructure pressure survives SQLite reopen without shortening the known retry or changing job identity", async () => {
  const f = await fixture(),
    server = await relayFixture(Buffer.alloc(0));
  try {
    f.profile.origin = server.origin;
    const a = await assignment("never"),
      row = f.ledger.admit(a, "approval"),
      retryAt = Date.now() + 120000,
      resetAt = retryAt + 60000,
      body: ErrorBody = {
        error: {
          code: "quota_paused",
          message: "Account request pressure",
          requestId: "pressure",
          retryable: true,
          details: {
            retryAfterMs: 90000,
            pressure: {
              resource: "requests",
              scope: { kind: "account" },
              source: "provider",
              measurement: "unknown",
              retryAt,
              resetAt,
              reason: "daily request capacity",
              action: "retry-later",
            },
          },
        },
      },
      http = new HttpTransport(f.profile, fetch, true);
    http.bindLedger(f.ledger);
    server.setPressure(body);
    await assert.rejects(http.request("/fixture"), (error: unknown) => {
      assert.ok(error instanceof HttpFailure);
      assert.equal(error.retryAt, resetAt);
      assert.deepEqual(error.pressure, body.error.details?.pressure);
      return true;
    });
    assert.equal(http.pausedUntil, resetAt);
    const reopened = await Ledger.open(f.directory, f.profile.ledgerId, { ...f.ledger.limits });
    try {
      const recovered = new HttpTransport(f.profile, fetch, true);
      recovered.bindLedger(reopened);
      assert.equal(recovered.pausedUntil, resetAt);
      await assert.rejects(recovered.request("/fixture"), HttpFailure);
      assert.equal(server.requests.length, 1, "restart cannot retry before a known reset");
      assert.equal(reopened.get(a.identity.jobId)?.bodyHash, row.bodyHash);
      assert.equal(reopened.get(a.identity.jobId)?.state, "pending");
    } finally {
      reopened.close();
    }
  } finally {
    await server.close();
    await f.cleanup();
  }
});
test("storage with no known reset remains held across reopen until explicit recovery; header delays are not clamped", async () => {
  const f = await fixture(),
    server = await relayFixture(Buffer.alloc(0));
  try {
    f.profile.origin = server.origin;
    const http = new HttpTransport(f.profile, fetch, true),
      pressure = {
        resource: "storage" as const,
        scope: { kind: "object" as const, id: "workspace" },
        source: "provider" as const,
        measurement: "unknown" as const,
        reason: "Storage requires operator recovery",
        action: "reclaim-storage" as const,
      };
    http.bindLedger(f.ledger);
    server.setPressure(
      {
        error: {
          code: "quota_exceeded",
          message: "Storage pressure",
          requestId: "storage_pressure",
          retryable: false,
          details: { retryAfterMs: 5000, pressure },
        },
      },
      429,
    );
    await assert.rejects(http.request("/fixture"), (error: unknown) => {
      assert.ok(error instanceof HttpFailure);
      assert.equal(error.retryAt, undefined, "a backoff hint cannot invent a storage reset");
      assert.deepEqual(error.pressure, pressure);
      return true;
    });
    const reopened = await Ledger.open(f.directory, f.profile.ledgerId, { ...f.ledger.limits });
    try {
      const recovered = new HttpTransport(f.profile, fetch, true);
      recovered.bindLedger(reopened);
      assert.equal(recovered.pressureHeld, true);
      assert.equal(recovered.pressure?.resetAt, undefined);
      assert.equal(recovered.pressure?.retryAt, undefined);
      await assert.rejects(recovered.request("/fixture"), HttpFailure);
      assert.equal(server.requests.length, 1);
      recovered.clearPressure();
      for (const retry of ["7200", new Date(Date.now() + 3600000).toUTCString()]) {
        server.setPressure(true, 503, retry);
        const before = Date.now();
        await assert.rejects(recovered.request("/fixture"), HttpFailure);
        const expected = retry === "7200" ? before + 7200000 : Date.parse(retry);
        assert.ok(recovered.pausedUntil >= expected);
        recovered.clearPressure();
      }
      server.setPressure(false);
      assert.equal((await recovered.request("/fixture")).status, 200);
      const fresh = new HttpTransport(f.profile, fetch, true);
      fresh.bindLedger(reopened);
      assert.equal(fresh.pressureHeld, false);
      assert.equal(fresh.pausedUntil, 0);
    } finally {
      reopened.close();
    }
  } finally {
    await server.close();
    await f.cleanup();
  }
});
test("a delayed pressure response cannot shorten a concurrent known reset or release a storage hold", async () => {
  const f = await fixture(),
    server = await relayFixture(Buffer.alloc(0));
  try {
    f.profile.origin = server.origin;
    for (const resource of ["requests", "storage"] as const) {
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>(),
        resetAt = Date.now() + 180000,
        http = new HttpTransport(
          f.profile,
          async (input, init) => {
            const response = await fetch(input, init);
            if (new URL(String(input)).pathname === "/late") {
              entered.resolve();
              await release.promise;
            }
            return response;
          },
          true,
        );
      http.bindLedger(f.ledger);
      http.clearPressure();
      server.setPressure(true, 503, "1");
      const delayed = assert.rejects(http.request("/late"), HttpFailure);
      try {
        await entered.promise;
        server.setPressure({
          error: {
            code: "quota_paused",
            message: "Infrastructure pressure",
            requestId: "concurrent_pressure",
            retryable: true,
            details: {
              retryAfterMs: 1000,
              pressure: {
                resource,
                scope: { kind: "account" },
                source: "provider",
                measurement: "unknown",
                reason: "Concurrent capacity observation",
                action: resource === "storage" ? "reclaim-storage" : "retry-later",
                ...(resource === "requests" ? { resetAt } : {}),
              },
            },
          },
        });
        await assert.rejects(http.request("/first"), HttpFailure);
      } finally {
        release.resolve();
        await delayed;
      }
      assert.equal(http.pressureHeld, resource === "storage");
      if (resource === "requests") assert.equal(http.pausedUntil, resetAt);
      const recovered = new HttpTransport(f.profile, fetch, true);
      recovered.bindLedger(f.ledger);
      assert.equal(recovered.pressureHeld, http.pressureHeld);
      assert.equal(recovered.pausedUntil, http.pausedUntil);
      assert.deepEqual(recovered.pressure, http.pressure);
    }
  } finally {
    await server.close();
    await f.cleanup();
  }
});
test("real HTTP transfer slots bound concurrency and negotiated grid capacity rejects unrepresentable metadata", async () => {
  const f = await fixture(),
    bytes = Buffer.from("bounded"),
    server = await relayFixture(bytes);
  try {
    f.profile.origin = server.origin;
    f.profile.limits.transferConcurrency = 1;
    f.profile.limits.chunkBytes = 1;
    const http = new HttpTransport(f.profile, fetch, true);
    server.setDelay(100);
    assert.equal(http.limits.fileBytes, 256);
    assert.equal(http.limits.artifactBytes, 256);
    assert.deepEqual(http.transferLimits(), {
      chunkBytes: 1,
      fileBytes: 256,
      snapshotBytes: http.limits.snapshotBytes,
      artifactBytes: 256,
      manifestEntries: http.limits.manifestEntries,
    });
    assert.throws(() => inventoryFor(Buffer.alloc(257), http.chunkBytes), /negotiated chunk grid/);
    assert.equal(server.requests.length, 0);
    const read = () =>
      http.withTransfer(async () => readBounded(await http.request("/fixture"), bytes.length));
    const [first, second] = await Promise.allSettled([read(), read()]);
    assert.equal(first.status, "fulfilled");
    if (first.status === "fulfilled") assert.deepEqual(Buffer.from(first.value), bytes);
    assert.equal(second.status, "rejected");
    if (second.status === "rejected") assert.match(String(second.reason), /concurrency/);
    assert.equal(server.requests.length, 1);
    await read();
    assert.equal(server.requests.length, 2, "slot is released after the actual body completes");
  } finally {
    await server.close();
    await f.cleanup();
  }
});
