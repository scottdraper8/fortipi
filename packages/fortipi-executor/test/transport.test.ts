import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  ErrorBody,
  ExecutorFrame,
  LocalReadRequest,
  TransferDescriptor,
} from "fortipi-contract/executor";
import { commitDigest, validateTransfer } from "fortipi-contract/executor";
import { adapter, privateWrite } from "../dist/config.js";
import { ExecutorRuntime } from "../dist/daemon.js";
import { Guard, Ledger } from "../dist/ledger.js";
import { Output } from "../dist/output.js";
import { hash } from "../dist/policy.js";
import {
  frame,
  HttpFailure,
  HttpTransport,
  readBounded,
  SessionTransport,
} from "../dist/transport.js";
import { inventoryFor, scan } from "../dist/workspace/manifest.js";
import { Staging } from "../dist/workspace/staging.js";
import {
  assignment,
  authenticateFixture,
  credential,
  eventually,
  fixture,
  fixtureChild,
  importRoot,
  nodeCommand,
  prepare,
  receiptScope,
  resources,
} from "./fixtures/daemon.ts";
import { relayFixture, sessionFixture } from "./fixtures/transport.ts";

for (const mode of ["protocol", "binary", "registration", "heartbeat"] as const)
  test(`native WebSocket closes ${mode} failure without escaping cleanup and reconnects`, {
    timeout: 70000,
  }, async () => {
    const f = await fixture();
    const server = await sessionFixture(f.profile, {
      register: mode !== "registration",
      ...(mode === "protocol" || mode === "binary" ? { fault: mode } : {}),
    });
    const controller = new AbortController();
    const watchdog = setTimeout(
      () => controller.abort(),
      mode === "heartbeat" ? 65000 : mode === "registration" ? 20000 : 3000,
    );
    try {
      f.profile.origin = server.origin;
      const http = new HttpTransport(f.profile, fetch, true);
      const frames: ExecutorFrame[] = [];
      let disconnected = 0;
      const session = new SessionTransport(http, {
        async receive(value) {
          frames.push(value);
        },
        async disconnected() {
          disconnected++;
        },
        reconnectFrames() {
          return [];
        },
      });
      const registration: Extract<ExecutorFrame, { type: "executor.register" }> = {
        type: "executor.register",
        requestId: randomUUID(),
        payload: {
          executorId: f.profile.executorId,
          generation: f.profile.executorGeneration,
          protocolVersion: "1.0",
          schemaVersion: "1.0.0",
          capabilities: [],
          platform: process.platform as "linux" | "darwin" | "win32",
          caseBehavior: "sensitive",
          rootBindingIds: [],
          confinement: "host",
          transferLimits: http.transferLimits(),
        },
      };
      const started = Date.now();
      await session.connect(controller.signal, registration);
      clearTimeout(watchdog);
      assert.equal(controller.signal.aborted, false, "actual failure must close before watchdog");
      assert.deepEqual(server.closes, [
        {
          code: { protocol: 4007, binary: 4009, registration: 4008, heartbeat: 4001 }[mode],
          reason: {
            protocol: "invalid executor protocol",
            binary: "frame bound",
            registration: "register timeout",
            heartbeat: "heartbeat timeout",
          }[mode],
        },
      ]);
      assert.equal(disconnected, 1);
      assert.equal(session.registered, false);
      assert.equal(session.queueBytes, 0);
      assert.equal(session.send(registration), false, "closed transport cannot send work");
      assert.equal(server.received[0]?.type, "executor.register");
      assert.equal(frames.length, mode === "registration" ? 0 : 1);
      if (mode === "registration")
        assert.ok(Date.now() - started >= 15000, "real registration deadline");
      if (mode === "heartbeat") assert.ok(Date.now() - started >= 45000, "real heartbeat deadline");
      server.options.register = true;
      delete server.options.fault;
      const reconnect = session.connect(controller.signal, {
        ...registration,
        requestId: randomUUID(),
      });
      await eventually(() => session.registered, "real native reconnect missing");
      controller.abort();
      await reconnect;
      assert.equal(disconnected, 2);
      assert.equal(session.registered, false);
      assert.equal(server.closes[1]?.code, 1000);
      assert.equal(frames.at(-1)?.type, "executor.registered");
    } finally {
      clearTimeout(watchdog);
      controller.abort();
      await server.close();
      await f.cleanup();
    }
  });

for (const mode of ["assignment", "workspace", "authority", "ack"] as const)
  test(`native WebSocket daemon ${mode} rejection closes without a detached failure`, async () => {
    const f = await fixture();
    const a = await assignment("must never start");
    let retainedDelivery: string | undefined;
    if (mode === "ack") {
      f.ledger.admit(a, "approval");
      new Output(f.ledger, a.identity, f.ledger.limits).append("stdout", Buffer.from("retained"));
      retainedDelivery = f.ledger.outbox()[0]?.requestId;
      assert.ok(retainedDelivery);
    }
    const pending: ExecutorFrame[] =
      mode === "assignment"
        ? [
            {
              type: "job.assign",
              requestId: randomUUID(),
              payload: { ...a, identity: { ...a.identity, assignmentDigest: "0".repeat(64) } },
            },
          ]
        : mode === "workspace"
          ? [
              {
                type: "workspace.request",
                requestId: randomUUID(),
                payload: {
                  requestId: randomUUID(),
                  correlationId: randomUUID(),
                  request: { ...prepare(a, f.initial.manifestHash), rootBindingId: "unregistered" },
                },
              },
            ]
          : mode === "ack"
            ? [
                {
                  type: "job.output_ack",
                  requestId: retainedDelivery ?? "missing",
                  payload: { deliveryId: "unrelated_cp_delivery", sequence: 1, persisted: true },
                },
              ]
            : [];
    const server = await sessionFixture(f.profile, { register: true, afterRegister: pending });
    const controller = new AbortController();
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let runtime: ExecutorRuntime | undefined;
    try {
      f.profile.origin = server.origin;
      const http = new HttpTransport(f.profile, fetch, true);
      runtime = new ExecutorRuntime({
        profile: f.profile,
        ledger: f.ledger,
        directory: f.directory,
        roots: new Map([["root", f.root]]),
        http,
      });
      await runtime.initialize();
      watchdog = setTimeout(() => controller.abort(), 3000);
      const session = new SessionTransport(http, runtime);
      runtime.session = session;
      const connected = session.connect(controller.signal, {
        type: "executor.register",
        requestId: randomUUID(),
        payload: {
          executorId: f.profile.executorId,
          generation: f.profile.executorGeneration,
          protocolVersion: "1.0",
          schemaVersion: "1.0.0",
          capabilities: [],
          platform: process.platform as "linux" | "darwin" | "win32",
          caseBehavior: "sensitive",
          rootBindingIds: ["root"],
          confinement: "host",
          transferLimits: http.transferLimits(),
        },
      });
      if (mode === "authority") {
        await eventually(
          () => session.registered && runtime?.connected === true,
          "actual daemon registration missing",
        );
        http.revoked = true;
        await runtime.tick();
      }
      await connected;
      clearTimeout(watchdog);
      assert.equal(
        controller.signal.aborted,
        false,
        "daemon error path must settle before watchdog",
      );
      assert.equal(session.registered, false);
      assert.equal(runtime.connected, false);
      assert.deepEqual(server.closes, [
        {
          code: mode === "ack" ? 4007 : 4008,
          reason: {
            assignment: "assignment rejected",
            workspace: "workspace request identity conflict",
            authority: "executor authority expired",
            ack: "invalid executor protocol",
          }[mode],
        },
      ]);
      assert.equal(runtime.children.size, 0);
      if (mode === "ack")
        assert.ok(
          f.ledger.outbox().some((value) => value.requestId === retainedDelivery),
          "wrong wire delivery id cannot acknowledge native output",
        );
    } finally {
      clearTimeout(watchdog);
      controller.abort();
      await runtime?.shutdown();
      await server.close();
      await f.cleanup();
    }
  });

test("local-stage status waits for actual empty or multichunk durable consumer proof and current authority", async () => {
  for (const mode of ["empty", "multichunk", "revoked", "fenced"] as const) {
    const f = await fixture();
    const bytes = mode === "empty" ? Buffer.alloc(0) : Buffer.alloc(393217, 0x71);
    const server = await relayFixture(bytes);
    const release = Promise.withResolvers<void>(),
      entered = Promise.withResolvers<void>();
    let runtime: ExecutorRuntime | undefined, pending: Promise<void> | undefined;
    try {
      f.profile.origin = server.origin;
      const http = new HttpTransport(f.profile, fetch, true);
      authenticateFixture(http);
      http.chunkBytes = 65536;
      server.setGrid(http.chunkBytes);
      runtime = new ExecutorRuntime({
        profile: f.profile,
        ledger: f.ledger,
        directory: f.directory,
        roots: new Map([["root", f.root]]),
        http,
      });
      await runtime.initialize();
      const a = await assignment("must never start"),
        row = f.ledger.admit(a, "approval");
      const sha = createHash("sha256").update(bytes).digest("hex");
      const chunkHashes: string[] = [];
      for (let offset = 0; offset < bytes.length; offset += http.chunkBytes)
        chunkHashes.push(
          createHash("sha256")
            .update(bytes.subarray(offset, offset + http.chunkBytes))
            .digest("hex"),
        );
      const descriptor: Extract<TransferDescriptor, { purpose: "local-stage" }> = {
        transferId: `input_${mode}`,
        attemptId: "actual_attempt",
        deploymentId: f.profile.deploymentId,
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
          path: "payload",
          manifestHash: f.initial.manifestHash,
          uploadId: `upload_${mode}`,
        },
        fileSha256: sha,
        size: bytes.length,
        chunkBytes: http.chunkBytes,
        chunkHashes,
        expiresAt: Date.now() + 20000,
        deadline: a.identity.deadline,
      };
      const captured: ExecutorFrame[] = [],
        session = new SessionTransport(http, runtime);
      session.send = (value) => {
        captured.push(frame(value));
        return true;
      };
      runtime.session = session;
      const receive = runtime.staging.receive.bind(runtime.staging),
        chunk = http.chunk.bind(http);
      let delayed = true;
      if (mode === "empty")
        runtime.staging.receive = async (value) => {
          if (delayed) {
            entered.resolve();
            await release.promise;
          }
          await receive(value);
        };
      else
        http.chunk = async (value, index, data) => {
          const result = await chunk(value, index, data);
          // Actual HTTP body has completed, but the consumer has not returned to persist bytes/proof.
          if (delayed && index === chunkHashes.length - 1) {
            entered.resolve();
            await release.promise;
          }
          return result;
        };
      pending = runtime.transfer(descriptor, "same_open_request");
      const unexpected = pending.then(() => {
        throw new Error("consumer completed before actual barrier");
      });
      await Promise.race([entered.promise, unexpected]);
      const proofKey = `verified_blob_${descriptor.content.uploadId}_${sha}`;
      assert.equal(f.ledger.record("stages", proofKey), undefined);
      assert.equal(captured.length, 0, "no acknowledgment before actual consumer persistence");
      await assert.rejects(readFile(join(runtime.staging.directory, sha)), { code: "ENOENT" });
      assert.equal(server.requests.length, chunkHashes.length);
      if (mode === "revoked") http.revoked = true;
      if (mode === "fenced")
        f.ledger.db.prepare("INSERT INTO meta(key,value) VALUES('fence_root_1','2')").run();
      delayed = false;
      release.resolve();
      if (mode === "revoked" || mode === "fenced")
        await assert.rejects(
          pending,
          mode === "revoked" ? /current executor transport authority required/ : /stale_fence/,
        );
      else await pending;
      const status = captured[0];
      if (status?.type !== "transfer.status") throw new Error("durable consumer receipt missing");
      assert.equal(status.requestId, "same_open_request");
      assert.equal(status.payload.transferId, descriptor.transferId);
      assert.equal(status.payload.attemptId, descriptor.attemptId);
      if (mode === "revoked" || mode === "fenced") {
        assert.equal(status.payload.state, "interrupted");
        assert.deepEqual(status.payload.verifiedChunks, []);
        assert.equal(status.payload.bytes, 0);
      } else {
        assert.equal(status.payload.state, "verified");
        assert.deepEqual(
          status.payload.verifiedChunks,
          chunkHashes.map((_, i) => i),
        );
        assert.equal(status.payload.bytes, bytes.length);
        const reopened = await Ledger.open(f.directory, "ledger", f.ledger.limits);
        try {
          assert.ok(
            reopened.record("stages", proofKey),
            "receipt requires independently reopened durable proof",
          );
        } finally {
          reopened.close();
        }
        const path = join(runtime.staging.directory, sha),
          before = await stat(path);
        assert.equal(
          createHash("sha256")
            .update(await readFile(path))
            .digest("hex"),
          sha,
        );
        await runtime.transfer(descriptor, "same_open_request");
        assert.deepEqual(captured[1], status, "exact retry retains correlated immutable receipt");
        const after = await stat(path);
        assert.equal(after.ino, before.ino);
        assert.equal(after.mtimeMs, before.mtimeMs);
        const wrong = { ...descriptor, attemptId: "wrong_whole_hash", fileSha256: "0".repeat(64) };
        await assert.rejects(runtime.transfer(wrong, "bad_open"), /file integrity/);
        const rejected = captured.at(-1);
        assert.equal(rejected?.type, "transfer.status");
        if (rejected?.type === "transfer.status") {
          assert.equal(rejected.payload.state, "interrupted");
          assert.equal(rejected.payload.bytes, 0);
        }
      }
      assert.equal(runtime.children.size, 0);
      assert.equal(f.ledger.get(a.identity.jobId)?.state, "pending");
      assert.equal(f.ledger.get(a.identity.jobId)?.bodyHash, row.bodyHash);
      assert.equal(f.profile.bindings[0]?.revision, "r0");
    } finally {
      release.resolve();
      await pending?.catch(() => {});
      await runtime?.shutdown();
      await server.close();
      await f.cleanup();
    }
  }
});

test("zero local-read open proves the actual retained owner file, rejecting a missing owner despite empty metadata", async () => {
  const f = await fixture(),
    server = await relayFixture(Buffer.alloc(0));
  let runtime: ExecutorRuntime | undefined;
  try {
    await f.root.write("empty.bin", Buffer.alloc(0), 420);
    const actual = await scan(f.root, f.ledger.limits),
      binding = f.profile.bindings[0];
    if (!binding) throw new Error("binding missing");
    binding.manifestHash = actual.manifestHash;
    f.profile.origin = server.origin;
    const http = new HttpTransport(f.profile, fetch, true);
    authenticateFixture(http);
    runtime = new ExecutorRuntime({
      profile: f.profile,
      ledger: f.ledger,
      directory: f.directory,
      roots: new Map([["root", f.root]]),
      http,
    });
    await runtime.initialize();
    const local = runtime.locals.get("root");
    if (!local) throw new Error("local missing");
    await importRoot(local);
    const request: Extract<LocalReadRequest, { kind: "read" }> = {
      kind: "read",
      operationId: "read_empty",
      workspaceId: "workspace",
      bindingVersion: 1,
      rootBindingId: "root",
      executorId: f.profile.executorId,
      executorGeneration: f.profile.executorGeneration,
      credential,
      revision: "r0",
      deadline: Date.now() + 60000,
      path: "empty.bin",
    };
    const metadata = await runtime.handleWorkspaceFrame({
      type: "workspace.request",
      requestId: "read_metadata_outer",
      payload: { requestId: "read_metadata", correlationId: "read_metadata_corr", request },
    });
    const response = metadata.payload.response;
    assert.ok("kind" in response && response.kind === "read");
    assert.equal(response.result.size, 0);
    assert.ok(response.result.chunks);
    assert.deepEqual(response.result.chunks.chunkHashes, []);
    const descriptor: TransferDescriptor = {
      transferId: "zero_read",
      attemptId: "owner_attempt",
      deploymentId: f.profile.deploymentId,
      direction: "from-executor",
      purpose: "local-read",
      workspaceId: "workspace",
      bindingVersion: 1,
      operationId: request.operationId,
      operationDigest: "a".repeat(64),
      executorId: f.profile.executorId,
      executorGeneration: f.profile.executorGeneration,
      credential,
      consumer: f.profile.resources,
      baseRevision: "r0",
      content: { kind: "workspace-file", path: request.path, manifestHash: actual.manifestHash },
      fileSha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
      size: 0,
      chunkBytes: response.result.chunks.chunkBytes,
      chunkHashes: [],
      expiresAt: Date.now() + 20000,
      deadline: request.deadline,
    };
    const captured: ExecutorFrame[] = [],
      session = new SessionTransport(http, runtime);
    session.send = (value) => {
      captured.push(frame(value));
      return true;
    };
    runtime.session = session;
    await rm(join(f.rootPath, request.path));
    await assert.rejects(runtime.transfer(descriptor, "missing_owner_open"), /local_drift/);
    const missing = captured.at(-1);
    assert.equal(missing?.type, "transfer.status");
    if (missing?.type === "transfer.status") {
      assert.equal(missing.requestId, "missing_owner_open");
      assert.equal(missing.payload.state, "interrupted");
      assert.equal(missing.payload.bytes, 0);
      assert.deepEqual(missing.payload.verifiedChunks, []);
    }
    await f.root.write(request.path, Buffer.alloc(0), 420);
    await runtime.transfer(descriptor, "actual_owner_open");
    const verified = captured.at(-1);
    assert.equal(verified?.type, "transfer.status");
    if (verified?.type === "transfer.status") {
      assert.equal(verified.requestId, "actual_owner_open");
      assert.equal(verified.payload.state, "verified");
      assert.equal(verified.payload.bytes, 0);
      assert.deepEqual(verified.payload.verifiedChunks, []);
    }
    const producerKey = `producer_${descriptor.transferId}_${descriptor.attemptId}`;
    const reopened = await Ledger.open(f.directory, "ledger", f.ledger.limits);
    try {
      const proof = reopened.db.prepare("SELECT value FROM meta WHERE key=?").get(producerKey) as {
        value: string;
      };
      assert.equal(JSON.parse(proof.value).state, "done");
    } finally {
      reopened.close();
    }
    const produced = await runtime.handleWorkspaceFrame({
      type: "workspace.request",
      requestId: "later_produce_outer",
      payload: {
        requestId: "later_produce",
        correlationId: "later_produce_corr",
        request: { ...request, transfers: [descriptor] },
      },
    });
    assert.ok("kind" in produced.payload.response && produced.payload.response.kind === "read");
    assert.equal(server.requests.length, 0, "zero proof needs no invented HTTP chunk");
    assert.equal(runtime.children.size, 0);
    assert.equal(binding.revision, "r0");
  } finally {
    await runtime?.shutdown();
    await server.close();
    await f.cleanup();
  }
});

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
    const different = { credentialId: "different_reader", generation: 9, grantVersion: 3 };
    await assert.rejects(
      staging.receive({
        ...descriptor,
        credential: different,
        lease: { ...descriptor.lease, credential: different },
      }),
      /transfer execution mismatch/,
    );
    assert.equal(
      server.requests.length,
      0,
      "mutable staging must keep its original job credential",
    );
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
test("full job history refuses new admission while the admitted job retains output and recovery capacity", async () => {
  const f = await fixture(),
    historyRows = f.ledger.limits.historyRows;
  try {
    f.ledger.limits.historyRows = 1;
    const a = await assignment("admitted"),
      row = f.ledger.admit(a, "approval"),
      output = new Output(f.ledger, a.identity, f.ledger.limits);
    row.decision = "allow";
    f.ledger.put(row);
    assert.equal(f.ledger.claim(a.identity.jobId, "approval", f.root.key, a.identity.jobId), true);
    const next = await assignment("new admission");
    assert.throws(() => f.ledger.admit(next, "approval"), /capacity exhausted/);
    output.append("stdout", Buffer.from("admitted output"));
    const delivery = f.ledger.outbox()[0];
    assert.ok(delivery?.type === "job.output");
    assert.equal(delivery.payload.text, "admitted output");
    f.ledger.recover();
    assert.equal(f.ledger.get(a.identity.jobId)?.state, "unknown");
    assert.equal(f.ledger.claim(a.identity.jobId, "approval", f.root.key, a.identity.jobId), false);
  } finally {
    f.ledger.limits.historyRows = historyRows;
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
test("local CLI clears a storage hold only explicitly with the daemon stopped and retains uncertain job identity", async () => {
  const f = await fixture(),
    server = await relayFixture(Buffer.alloc(0)),
    directory = join(f.path, "ledger"),
    profilePath = join(f.path, "profile.json"),
    marker = join(f.path, "must-not-replay"),
    binary = fileURLToPath(new URL("../dist/bin.js", import.meta.url)),
    execute = promisify(execFile);
  let seed: Ledger | undefined, guard: Guard | undefined;
  try {
    f.profile.origin = server.origin;
    f.profile.bindings = [];
    await adapter().protect(f.path, true);
    await privateWrite(profilePath, JSON.stringify(f.profile));
    seed = await Ledger.provision(directory, "ledger", { ...f.ledger.limits });
    const a = await assignment(nodeCommand(fixtureChild, "append", marker)),
      row = seed.admit(a, "approval");
    row.decision = "allow";
    seed.put(row);
    assert.equal(
      seed.claim(a.identity.jobId, "approval", "uncertain-root", a.identity.jobId),
      true,
    );
    const http = new HttpTransport(f.profile, fetch, true);
    http.bindLedger(seed);
    server.setPressure({
      error: {
        code: "quota_exceeded",
        message: "Storage pressure",
        requestId: "cli_storage_pressure",
        retryable: false,
        details: {
          retryAfterMs: 5000,
          pressure: {
            resource: "storage",
            scope: { kind: "object" },
            source: "provider",
            measurement: "unknown",
            reason: "Operator must reclaim storage",
            action: "reclaim-storage",
          },
        },
      },
    });
    await assert.rejects(http.request("/fixture"), HttpFailure);
    seed.close();
    seed = undefined;
    const cli = (command: string) =>
      execute(process.execPath, [binary, command, "--profile", profilePath, "--local-test"], {
        timeout: 30000,
      });
    const before = JSON.parse((await cli("status")).stdout) as {
      infrastructure: { held: boolean };
    };
    assert.equal(before.infrastructure.held, true, "status must never clear the hold");
    guard = await Guard.acquire(join(directory, "daemon.guard.sqlite"));
    await assert.rejects(cli("resume-infrastructure"), (error: unknown) => {
      assert.match((error as { stderr: string }).stderr, /already locked/);
      return true;
    });
    assert.equal(
      (JSON.parse((await cli("status")).stdout) as typeof before).infrastructure.held,
      true,
    );
    guard.close();
    guard = undefined;
    assert.match((await cli("resume-infrastructure")).stdout, /pause cleared/);
    seed = await Ledger.open(directory, "ledger", { ...f.ledger.limits });
    const reopened = new HttpTransport(f.profile, fetch, true);
    reopened.bindLedger(seed);
    assert.equal(reopened.pressureHeld, false);
    assert.equal(reopened.pausedUntil, 0);
    assert.equal(seed.get(a.identity.jobId)?.bodyHash, row.bodyHash);
    assert.equal(seed.get(a.identity.jobId)?.state, "start_intent");
    seed.recover();
    assert.equal(seed.get(a.identity.jobId)?.state, "unknown");
    assert.equal(
      seed.claim(a.identity.jobId, "approval", "uncertain-root", a.identity.jobId),
      false,
    );
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    assert.equal(server.requests.length, 1, "local recovery must not dispatch network work");
  } finally {
    guard?.close();
    seed?.close();
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
test("native artifact producer verifies retained bytes before correlated status and never replays the native command", async () => {
  const f = await fixture(),
    server = await relayFixture(Buffer.alloc(0));
  let runtime: ExecutorRuntime | undefined;
  let interruptAfterPut = false;
  try {
    f.profile.origin = server.origin;
    f.profile.limits.chunkBytes = 3;
    const http = new HttpTransport(
      f.profile,
      async (input, init) => {
        const response = await fetch(input, init);
        if (interruptAfterPut && init?.method === "PUT" && response.status === 204) {
          interruptAfterPut = false;
          server.setPressure(true);
        }
        return response;
      },
      true,
    );
    authenticateFixture(http);
    runtime = new ExecutorRuntime({
      profile: f.profile,
      ledger: f.ledger,
      directory: f.directory,
      roots: new Map([["root", f.root]]),
      http,
    });
    await runtime.initialize();
    const local = runtime.locals.get("root");
    if (!local) throw new Error("local provider absent");
    await importRoot(local);
    runtime.connected = true;
    const marker = join(f.path, "artifact-original-effect"),
      text = "retained native output",
      a = await assignment(nodeCommand(fixtureChild, "append", marker, text));
    a.identity.lease.expiresAt = Date.now() + 20000;
    const preparation = prepare(a, f.initial.manifestHash);
    await local.request(preparation);
    await runtime.assignOnce(a);
    const pending = runtime.approvals.list()[0];
    if (!pending) throw new Error("approval absent");
    runtime.approvals.decide(a.identity.jobId, pending.digest, "allow");
    await runtime.tick();
    await eventually(
      () => !!f.ledger.get(a.identity.jobId)?.result,
      "native output was not persisted",
    );
    const row = f.ledger.get(a.identity.jobId),
      reference = row?.result?.output.artifacts[0];
    if (!row || !reference?.artifactId || !reference.chunks)
      throw new Error("actual native artifact absent");
    assert.deepEqual(reference.outputSource, { stream: "stdout" });
    assert.equal(reference.sha256, createHash("sha256").update(text).digest("hex"));
    const nativeGrid = reference.chunks.chunkBytes;
    assert.deepEqual(
      reference.chunks.chunkHashes,
      Array.from({ length: Math.ceil(Buffer.byteLength(text) / nativeGrid) }, (_, i) =>
        createHash("sha256")
          .update(Buffer.from(text).subarray(i * nativeGrid, (i + 1) * nativeGrid))
          .digest("hex"),
      ),
    );
    frame({
      type: "job.prepared_result",
      requestId: "actual_artifact_metadata",
      payload: row.result,
    });
    assert.equal(await readFile(marker, "utf8"), "effect\n");
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.max(0, row.assignment.identity.lease.expiresAt - Date.now() + 20)),
    );
    assert.ok(
      Date.now() >= row.assignment.identity.lease.expiresAt,
      "historical job lease must actually expire",
    );
    const journal = f.ledger.local(a.identity.lease.operationId);
    if (journal?.observation.state !== "applied")
      throw new Error("actual local observation absent");
    const observation = journal.observation,
      digest = await commitDigest({
        commitId: preparation.commitId,
        operationId: preparation.operationId,
        jobId: a.identity.jobId,
        workspaceId: a.workspaceId,
        baseRevision: a.identity.baseRevision,
        manifestHash: observation.postManifestHash,
        leaseIdentity: preparation.lease,
        storage: {
          kind: "local",
          preparationId: observation.preparationId,
          observationSeq: observation.observationSeq,
          preManifestHash: observation.preManifestHash,
          postManifestHash: observation.postManifestHash,
        },
      });
    await local.request({
      ...receiptScope(preparation),
      kind: "receipt",
      preparationId: observation.preparationId,
      receipt: {
        providerKind: "local",
        commitId: preparation.commitId,
        operationId: preparation.operationId,
        jobId: a.identity.jobId,
        workspaceId: a.workspaceId,
        baseRevision: a.identity.baseRevision,
        revision: "r1",
        manifestHash: observation.postManifestHash,
        sourceFactId: "artifact_revision_fact",
        committedAt: Date.now(),
        preparationId: observation.preparationId,
        observationSeq: observation.observationSeq,
        commitDigest: digest,
      },
    });
    assert.equal(local.binding.revision, "r1");
    const captured: ExecutorFrame[] = [],
      session = new SessionTransport(http, runtime);
    session.send = (value) => {
      captured.push(frame(value));
      return true;
    };
    runtime.session = session; // Synthetic channel only; file bytes use the actual HTTP relay.
    const descriptor: Extract<TransferDescriptor, { purpose: "output" }> = {
      transferId: "artifact_transfer",
      attemptId: "artifact_attempt",
      deploymentId: f.profile.deploymentId,
      direction: "from-executor",
      purpose: "output",
      workspaceId: a.workspaceId,
      bindingVersion: a.bindingVersion,
      operationId: a.identity.lease.operationId,
      operationDigest: a.identity.operationDigest,
      jobId: a.identity.jobId,
      executionId: a.identity.executionId,
      executorId: f.profile.executorId,
      executorGeneration: f.profile.executorGeneration,
      credential: { credentialId: "current_artifact_reader", generation: 9, grantVersion: 2 },
      consumer: { ...f.profile.resources, actions: ["artifacts.read"], tools: [] },
      baseRevision: a.identity.baseRevision,
      content: { kind: "job-output", artifactId: reference.artifactId, stream: "stdout" },
      fileSha256: reference.sha256,
      size: reference.size,
      chunkBytes: reference.chunks.chunkBytes,
      chunkHashes: reference.chunks.chunkHashes,
      expiresAt: Date.now() + 20000,
      deadline: Date.now() + 30000,
    };
    assert.notDeepEqual(descriptor.credential, row.assignment.identity.lease.credential);
    const open = async (requestId: string, transfer: typeof descriptor) => {
      await runtime?.receive({
        type: "transfer.open",
        requestId,
        payload: { ...transfer, expiresAt: Date.now() + 10000, deadline: Date.now() + 30000 },
      });
      await eventually(
        () => captured.some((f) => f.type === "transfer.status" && f.requestId === requestId),
        "producer status absent",
      );
      const status = captured.find(
        (f) => f.type === "transfer.status" && f.requestId === requestId,
      );
      if (status?.type !== "transfer.status") throw new Error("status absent");
      return status.payload;
    };
    const status = await open("output_open", descriptor);
    assert.equal(status.state, "verified");
    assert.equal(status.transferId, descriptor.transferId);
    assert.equal(status.attemptId, descriptor.attemptId);
    assert.deepEqual(
      status.verifiedChunks,
      descriptor.chunkHashes.map((_, i) => i),
    );
    assert.equal(status.bytes, Buffer.byteLength(text));
    assert.equal(Buffer.concat(server.requests.map((r) => r.bytes)).toString(), text);
    const rangeStart = 2,
      rangeEnd = 13,
      beforeRange = server.requests.length;
    const rangeStatus = await open("range_consumer_open", {
      ...descriptor,
      attemptId: "range_attempt",
    });
    const whole = Buffer.concat(server.requests.slice(beforeRange).map((r) => r.bytes));
    assert.equal(rangeStatus.state, "verified");
    assert.equal(whole.length, reference.size);
    assert.equal(
      createHash("sha256").update(whole).digest("hex"),
      reference.sha256,
      "range consumers still receive the full native descriptor",
    );
    assert.equal(
      whole.subarray(rangeStart, rangeEnd + 1).toString(),
      text.slice(rangeStart, rangeEnd + 1),
    );
    // This is the native full-source proof; CP4 owns actual HTTP Range parsing/drain/slicing.
    const requests = server.requests.length;
    const invalid: (typeof descriptor)[] = [
      { ...descriptor, content: { ...descriptor.content, stream: "stderr" } },
      { ...descriptor, content: { ...descriptor.content, artifactId: "not_an_artifact_member" } },
      { ...descriptor, jobId: "other_job" },
      { ...descriptor, executionId: "other_execution" },
      { ...descriptor, operationId: "other_operation" },
      { ...descriptor, operationDigest: "f".repeat(64) },
      { ...descriptor, bindingVersion: descriptor.bindingVersion + 1 },
      { ...descriptor, baseRevision: "r1" },
      { ...descriptor, chunkHashes: ["f".repeat(64), ...descriptor.chunkHashes.slice(1)] },
    ];
    for (const [i, invalidDescriptor] of invalid.entries()) {
      const rejected = await open(`invalid_artifact_${i}`, invalidDescriptor);
      assert.equal(
        rejected.state,
        "interrupted",
        "wrong retained artifact scope must stop before bytes",
      );
      assert.deepEqual(rejected.verifiedChunks, []);
      assert.equal(rejected.bytes, 0);
      assert.equal(
        server.requests.length,
        requests,
        "wrong immutable member scope must fail before bytes",
      );
    }
    const artifactCap = http.limits.artifactBytes;
    http.limits.artifactBytes = reference.size - 1;
    assert.equal((await open("lowered_artifact_cap", descriptor)).state, "interrupted");
    assert.equal(server.requests.length, requests);
    http.limits.artifactBytes = artifactCap;
    const missingMetadata = f.ledger.get(a.identity.jobId);
    if (!missingMetadata?.result?.output.artifacts[0]) throw new Error("artifact absent");
    delete missingMetadata.result.output.artifacts[0].outputSource;
    f.ledger.put(missingMetadata);
    assert.equal((await open("missing_source_metadata", descriptor)).state, "interrupted");
    assert.equal(server.requests.length, requests);
    f.ledger.put(row);
    await privateWrite(
      join(f.directory, "artifacts", reference.artifactId),
      Buffer.alloc(reference.size, 0x5a),
    );
    const corrupt = await open("corrupt_open", { ...descriptor, attemptId: "corrupt_attempt" });
    assert.equal(corrupt.state, "interrupted");
    assert.deepEqual(corrupt.verifiedChunks, []);
    assert.equal(corrupt.bytes, 0);
    assert.equal(server.requests.length, requests, "corrupt source must fail before network bytes");
    await rm(join(f.directory, "artifacts", reference.artifactId));
    assert.equal((await open("missing_artifact_file", descriptor)).state, "interrupted");
    assert.equal(server.requests.length, requests);
    await privateWrite(join(f.directory, "artifacts", reference.artifactId), text);
    interruptAfterPut = true;
    const partial = await open("partial_open", { ...descriptor, attemptId: "partial_attempt" });
    assert.equal(partial.state, "interrupted");
    assert.deepEqual(partial.verifiedChunks, [0], "only the actual acknowledged chunk is verified");
    assert.equal(partial.bytes, descriptor.chunkBytes);
    server.setPressure(false);
    http.clearPressure();
    server.setPressure(true, 403);
    const denied = await open("reader_denied_by_authority", descriptor);
    assert.equal(denied.state, "interrupted");
    assert.deepEqual(denied.verifiedChunks, []);
    assert.equal(denied.bytes, 0);
    assert.equal(await readFile(marker, "utf8"), "effect\n");
    assert.equal(runtime.children.size, 0);
    assert.equal(f.ledger.get(a.identity.jobId)?.bodyHash, row.bodyHash);
  } finally {
    await runtime?.shutdown();
    await server.close();
    await f.cleanup();
  }
});
test("zero artifact status requires a real private empty file and its whole hash, not only retained metadata", async () => {
  const f = await fixture(),
    server = await relayFixture(Buffer.alloc(0));
  let runtime: ExecutorRuntime | undefined;
  try {
    f.profile.origin = server.origin;
    const http = new HttpTransport(f.profile, fetch, true);
    authenticateFixture(http);
    runtime = new ExecutorRuntime({
      profile: f.profile,
      ledger: f.ledger,
      directory: f.directory,
      roots: new Map([["root", f.root]]),
      http,
    });
    await runtime.initialize();
    const a = await assignment("must never be started"),
      row = f.ledger.admit(a, "approval"),
      result = await new Output(f.ledger, a.identity, http.limits).result(
        "failed",
        join(f.directory, "artifacts"),
        false,
      ),
      artifactId = "retained_empty_artifact",
      path = join(f.directory, "artifacts", artifactId),
      empty = Buffer.alloc(0),
      emptyHash = createHash("sha256").update(empty).digest("hex");
    // Valid retained metadata is a fixture here. The actual collector omits empty streams.
    result.output.artifacts.push({
      workspaceId: a.workspaceId,
      revision: a.identity.baseRevision,
      artifactId,
      outputSource: { stream: "stdout" },
      owner: { kind: "local", executorId: f.profile.executorId },
      sha256: emptyHash,
      size: 0,
      chunks: inventoryFor(empty, http.chunkBytes),
      endpoint: `/v1/workspaces/${a.workspaceId}/artifacts/${artifactId}?revision=${a.identity.baseRevision}`,
    });
    frame({ type: "job.prepared_result", requestId: "retained_zero_metadata", payload: result });
    row.result = result;
    row.state = "result";
    row.sequence = result.sequence;
    f.ledger.put(row);
    const captured: ExecutorFrame[] = [],
      session = new SessionTransport(http, runtime);
    session.send = (value) => {
      captured.push(frame(value));
      return true;
    };
    runtime.session = session;
    const descriptor: Extract<TransferDescriptor, { purpose: "output" }> = {
      transferId: "zero_transfer",
      attemptId: "zero_attempt",
      deploymentId: f.profile.deploymentId,
      direction: "from-executor",
      purpose: "output",
      workspaceId: a.workspaceId,
      bindingVersion: a.bindingVersion,
      operationId: a.identity.lease.operationId,
      operationDigest: a.identity.operationDigest,
      jobId: a.identity.jobId,
      executionId: a.identity.executionId,
      executorId: f.profile.executorId,
      executorGeneration: f.profile.executorGeneration,
      credential: { credentialId: "current_empty_reader", generation: 3, grantVersion: 1 },
      consumer: { ...f.profile.resources, actions: ["artifacts.read"], tools: [] },
      baseRevision: a.identity.baseRevision,
      content: { kind: "job-output", artifactId, stream: "stdout" },
      fileSha256: emptyHash,
      size: 0,
      chunkBytes: http.chunkBytes,
      chunkHashes: [],
      expiresAt: Date.now() + 10000,
      deadline: Date.now() + 30000,
    };
    const open = async (requestId: string, value = descriptor) => {
      await runtime?.receive({
        type: "transfer.open",
        requestId,
        payload: { ...value, expiresAt: Date.now() + 10000, deadline: Date.now() + 30000 },
      });
      await eventually(
        () => captured.some((f) => f.type === "transfer.status" && f.requestId === requestId),
        "zero producer acknowledgment absent",
      );
      const reply = captured.find((f) => f.type === "transfer.status" && f.requestId === requestId);
      if (reply?.type !== "transfer.status") throw new Error("zero status absent");
      assert.deepEqual(reply.payload.verifiedChunks, []);
      assert.equal(reply.payload.bytes, 0);
      return reply.payload;
    };
    assert.equal(
      (await open("missing_empty_file")).state,
      "interrupted",
      "zero metadata must not fabricate file presence",
    );
    await privateWrite(path, empty, undefined, true);
    assert.equal((await open("actual_empty_file")).state, "verified");
    const wrongHash = "f".repeat(64),
      corruptMetadata = f.ledger.get(a.identity.jobId),
      corruptReference = corruptMetadata?.result?.output.artifacts[0];
    if (!corruptMetadata || !corruptReference) throw new Error("zero metadata absent");
    corruptReference.sha256 = wrongHash;
    f.ledger.put(corruptMetadata);
    assert.equal(
      (await open("wrong_whole_empty_hash", { ...descriptor, fileSha256: wrongHash })).state,
      "interrupted",
      "whole-file hash must bind an empty artifact too",
    );
    f.ledger.put(row);
    await privateWrite(path, "nonempty");
    assert.equal((await open("false_empty_file")).state, "interrupted");
    assert.equal(server.requests.length, 0, "zero transfers must not PUT or fabricate relay bytes");
    assert.equal(runtime.children.size, 0);
    assert.equal(f.ledger.get(a.identity.jobId)?.bodyHash, row.bodyHash);
  } finally {
    await runtime?.shutdown();
    await server.close();
    await f.cleanup();
  }
});
