import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import type { ExecutorFrame, TransferDescriptor } from "fortipi-contract/executor";
import { validateTransfer } from "fortipi-contract/executor";
import { Output } from "../dist/output.js";
import { hash } from "../dist/policy.js";
import { frame, HttpTransport, readBounded } from "../dist/transport.js";
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
