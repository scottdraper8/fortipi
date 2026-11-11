import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { canonicalJson } from "fortipi-contract";
import type * as D from "../../src/boundary/dto.js";
import { chunk, inventory } from "./bytes.ts";
import { connected, localBinding } from "./connection.ts";
import { harness, request, uuid, value } from "./harness.ts";

const query = (descriptor: D.TransferDescriptor, index: number): string =>
  `attemptId=${descriptor.attemptId}&length=${Math.min(descriptor.chunkBytes, descriptor.size - index * descriptor.chunkBytes)}&sha256=${descriptor.chunkHashes[index]}`;

test("actual two-phase retained local read uses real owner-byte inventory and multiple verified HTTP chunks", async () => {
  const h = await harness();
  const { url: listenUrl } = await h.server.listen();
  const networkUrl = new URL(listenUrl);
  networkUrl.protocol = "http:";
  const networkFetch = (url: string, init?: RequestInit): Promise<Response> => {
    const incoming = new URL(url);
    return fetch(new URL(incoming.pathname + incoming.search, networkUrl), init);
  };
  let socket: WebSocket | undefined;
  try {
    let channel = await connected(h);
    socket = channel.socket;
    const owner = join(h.directory, "local-owner");
    await mkdir(owner);
    const path = join(owner, "data.bin");
    const bytes = new Uint8Array(65536 * 3 + 17);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) % 251;
    await writeFile(path, bytes);
    const plan = await inventory(path, bytes.length, 65536);
    const manifest: D.Manifest = {
      version: 1,
      entries: [
        { path: "data.bin", type: "file", mode: 420, size: bytes.length, sha256: plan.sha256 },
      ],
    };
    const binding = await localBinding(h, channel, manifest, "retained_real_owner_bytes");
    channel = binding.channel;
    socket = channel.socket;
    const read: D.LocalReadRequest = {
      kind: "read",
      operationId: uuid(),
      workspaceId: binding.workspaceId,
      bindingVersion: 2,
      rootBindingId: "root",
      executorId: "executor",
      executorGeneration: 1,
      credential: binding.credential,
      revision: binding.revision,
      path: "data.bin",
      deadline: Date.now() + 30000,
    };
    const pending = h.cp.requestLocalWorkspace(binding.ctx, read);
    let frame = await channel.wait("workspace.request");
    if (frame.type !== "workspace.request") assert.fail("No metadata read");
    assert.equal(
      "transfers" in frame.payload.request,
      false,
      "metadata cannot begin a byte producer",
    );
    const reference: D.ByteReference = {
      workspaceId: binding.workspaceId,
      revision: binding.revision,
      sha256: plan.sha256,
      size: bytes.length,
      endpoint: `/v1/workspaces/${binding.workspaceId}/read`,
      owner: { kind: "local", executorId: "executor" },
      chunks: plan.chunks,
    };
    const respond = (f: Extract<D.ExecutorFrame, { type: "workspace.request" }>): void =>
      channel.send({
        type: "workspace.response",
        requestId: f.requestId,
        payload: {
          requestId: f.payload.requestId,
          correlationId: f.payload.correlationId,
          response: { kind: "read", result: reference },
        },
      });
    respond(frame);
    const metadata = value(await pending);
    assert.equal("kind" in metadata ? metadata.kind : undefined, "read");
    channel.frames.splice(0);
    const operationDigest = createHash("sha256").update(canonicalJson(read)).digest("hex");
    const descriptor = value(
      await h.cp.openTransfer(binding.ctx, {
        deploymentId: h.deploymentId,
        direction: "from-executor",
        purpose: "local-read",
        workspaceId: binding.workspaceId,
        bindingVersion: 2,
        operationId: read.operationId,
        operationDigest,
        executorId: "executor",
        executorGeneration: 1,
        credential: binding.credential,
        consumer: binding.resources,
        baseRevision: binding.revision,
        content: { kind: "workspace-file", path: "data.bin", manifestHash: binding.manifestHash },
        fileSha256: reference.sha256,
        size: reference.size,
        chunkBytes: plan.chunks.chunkBytes,
        chunkHashes: plan.chunks.chunkHashes,
        expiresAt: Date.now() + 20000,
        deadline: read.deadline,
      }),
    );
    assert.equal(descriptor.chunkBytes, 65536);
    const producing = h.cp.requestLocalWorkspace(binding.ctx, { ...read, transfers: [descriptor] });
    frame = await channel.wait("workspace.request");
    if (frame.type !== "workspace.request") assert.fail("No producer read");
    const productionRequest = frame;
    assert.notEqual(productionRequest.payload.correlationId, read.operationId);
    assert.equal(productionRequest.payload.request.operationId, read.operationId);
    const replica = await open(join(owner, "replica.bin"), "w+");
    try {
      for (let index = 0; index < plan.chunks.chunkHashes.length; index++) {
        let producerCompleted = false;
        const producer = networkFetch(
          `https://control.internal/v1/executor/transfers/${descriptor.transferId}/output/chunks/${index}?${query(descriptor, index)}`,
          {
            method: "PUT",
            headers: { Authorization: `Bearer ${channel.issued.token}` },
            body: await chunk(path, index, descriptor.chunkBytes, descriptor.size),
          },
        );
        producer.then(() => {
          producerCompleted = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.equal(
          producerCompleted,
          false,
          "unmatched producers cannot acknowledge a durable byte queue",
        );
        const consumer = networkFetch(
          `https://control.internal/internal/transfers/${descriptor.transferId}/peer/chunks/${index}?${query(descriptor, index)}`,
          { headers: { "X-Fortipi-Context": JSON.stringify(binding.ctx) } },
        );
        const response = await consumer;
        assert.equal(response.status, 200);
        const delivered = new Uint8Array(await response.arrayBuffer());
        assert.equal(
          createHash("sha256").update(delivered).digest("hex"),
          plan.chunks.chunkHashes[index],
        );
        await replica.write(delivered, 0, delivered.length, index * descriptor.chunkBytes);
        assert.equal((await producer).status, 204);
      }
    } finally {
      await replica.close();
    }
    respond(productionRequest);
    value(await producing);
    const copied = await inventory(join(owner, "replica.bin"), bytes.length, 65536);
    assert.equal(copied.sha256, plan.sha256, "recipient verifies full file independently");
    const status = value(
      await h.cp.observeTransfer(binding.ctx, {
        transferId: descriptor.transferId,
        attemptId: descriptor.attemptId,
      }),
    );
    assert.equal(status.state, "verified");
    assert.equal(status.bytes, bytes.length);
    assert.equal(
      (
        await networkFetch(
          `https://control.internal/internal/transfers/${descriptor.transferId}/peer/chunks/0?${query(descriptor, 0)}`,
          { headers: { "X-Fortipi-Context": JSON.stringify(binding.ctx) } },
        )
      ).status,
      409,
      "completed GET cannot replay vanished RAM",
    );
    assert.equal(
      (
        await networkFetch(
          `https://control.internal/v1/executor/transfers/${descriptor.transferId}/output/chunks/0?${query(descriptor, 0)}`,
          {
            method: "PUT",
            headers: { Authorization: `Bearer ${channel.issued.token}` },
            body: await chunk(path, 0, descriptor.chunkBytes, descriptor.size),
          },
        )
      ).status,
      204,
      "completed PUT observes its durable metadata receipt",
    );
    assert.equal(await h.cp.rowCount("chunk_receipt"), plan.chunks.chunkHashes.length);
    assert.equal(
      (
        await h.cp.requestLocalWorkspace(binding.ctx, {
          ...read,
          transfers: [{ ...descriptor, chunkBytes: 32768 }],
        })
      ).ok,
      false,
      "second-phase grid cannot drift from persisted descriptor",
    );
    const { transferId: _id, attemptId: _attempt, ...template } = descriptor;
    const before = await h.cp.rowCount("recipient");
    const oversized = { ...template, padding: "x".repeat(1048576) };
    assert.equal((await h.cp.openTransfer(binding.ctx, oversized)).ok, false);
    assert.equal(
      await h.cp.rowCount("recipient"),
      before,
      "body bound precedes authority registration",
    );
    assert.equal(
      (await h.cp.openTransfer(binding.ctx, { ...template, chunkBytes: 32768 })).ok,
      false,
      "metadata grid cannot change before allocation",
    );

    const bad = value(await h.cp.openTransfer(binding.ctx, template));
    const badConsumer = networkFetch(
      `https://control.internal/internal/transfers/${bad.transferId}/peer/chunks/0?${query(bad, 0)}`,
      { headers: { "X-Fortipi-Context": JSON.stringify(binding.ctx) } },
    );
    const corrupt = new Uint8Array(await chunk(path, 0, bad.chunkBytes, bad.size));
    corrupt[0] = (corrupt[0] ?? 0) ^ 1;
    const badProducer = networkFetch(
      `https://control.internal/v1/executor/transfers/${bad.transferId}/output/chunks/0?${query(bad, 0)}`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${channel.issued.token}` },
        body: corrupt,
      },
    );
    assert.equal((await badConsumer).status, 409, "unverified bytes never become a response body");
    assert.equal((await badProducer).status, 409);
    assert.equal(await h.cp.rowCount("chunk_receipt"), plan.chunks.chunkHashes.length);

    const cancelled = value(await h.cp.openTransfer(binding.ctx, template));
    channel.frames.splice(0);
    const unsettledProducer = h.cp.requestLocalWorkspace(binding.ctx, {
      ...read,
      transfers: [cancelled],
    });
    const producerFrame = await channel.wait("workspace.request");
    if (producerFrame.type !== "workspace.request")
      assert.fail("No transfer-bearing producer request");
    assert.equal(producerFrame.payload.request.operationId, read.operationId);
    const controls = [new AbortController(), new AbortController()];
    const waiting = controls.map((controller, index) =>
      h.server
        .fetch(
          `https://control.internal/internal/transfers/${cancelled.transferId}/peer/chunks/${index}?${query(cancelled, index)}`,
          {
            headers: { "X-Fortipi-Context": JSON.stringify(binding.ctx) },
            signal: controller.signal,
          },
        )
        .catch(() => undefined),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    const pressured = await networkFetch(
      `https://control.internal/internal/transfers/${cancelled.transferId}/peer/chunks/2?${query(cancelled, 2)}`,
      { headers: { "X-Fortipi-Context": JSON.stringify(binding.ctx) } },
    );
    assert.equal(pressured.status, 503, "unmatched claims also consume bounded RAM admission");
    assert.ok(pressured.headers.has("Retry-After"));
    controls[0]?.abort();
    await new Promise((resolve) => setTimeout(resolve, 10100));
    assert.equal(
      value(
        await h.cp.observeTransfer(binding.ctx, {
          transferId: cancelled.transferId,
          attemptId: cancelled.attemptId,
        }),
      ).state,
      "interrupted",
      "disconnected peers settle by the bounded rendezvous deadline even when the local proxy drops abort notification",
    );
    controls[1]?.abort();
    await Promise.all(waiting);
    const settledProducer = await unsettledProducer;
    assert.equal(
      settledProducer.ok,
      false,
      "the rendezvous bound must also settle the correlated producer RPC",
    );
    if (!settledProducer.ok) assert.equal(settledProducer.code, "unavailable_executor");
    assert.equal(
      (await h.cp.requestLocalWorkspace(binding.ctx, { ...read, transfers: [cancelled] })).ok,
      false,
      "interrupted descriptor cannot launch a producer",
    );
    const fenced = value(await h.cp.openTransfer(binding.ctx, template));
    const fencedConsumer = networkFetch(
      `https://control.internal/internal/transfers/${fenced.transferId}/peer/chunks/0?${query(fenced, 0)}`,
      { headers: { "X-Fortipi-Context": JSON.stringify(binding.ctx) } },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    value(
      await h.cp.revokeExecutor(
        binding.ctx,
        request("revokeExecutor", { requestId: uuid(), expectedGeneration: 1 }, { id: "executor" }),
      ),
    );
    assert.equal(
      (await fencedConsumer).status,
      409,
      "durable executor floor aborts an already waiting peer",
    );
    const denied = await networkFetch(
      `https://control.internal/v1/executor/transfers/${fenced.transferId}/output/chunks/0?${query(fenced, 0)}`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${channel.issued.token}` },
        body: await chunk(path, 0, fenced.chunkBytes, fenced.size),
      },
    );
    assert.equal(
      denied.status,
      401,
      "an old executor generation cannot forward bytes after its floor changes",
    );
    assert.equal(await h.cp.rowCount("chunk_receipt"), plan.chunks.chunkHashes.length);
  } finally {
    socket?.close();
    await h.close();
  }
});
