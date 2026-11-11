import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { manifestDigest } from "fortipi-contract";
import type * as D from "../../src/boundary/dto.js";
import { chunk, inventory } from "./bytes.ts";
import { connected, localBinding } from "./connection.ts";
import { harness, request, uuid, value } from "./harness.ts";

test("local stage relay carries every declared put on its real grid, including superseded and empty files", async () => {
  const h = await harness();
  let socket: WebSocket | undefined;
  try {
    let channel = await connected(h);
    socket = channel.socket;
    const binding = await localBinding(
      h,
      channel,
      { version: 1, entries: [] },
      "retained_empty_before_write",
    );
    channel = binding.channel;
    socket = channel.socket;
    const writer = await h.auth();
    const acquired = value(
      await h.cp.acquireWorkspaceLease(
        writer,
        request(
          "acquireWorkspaceLease",
          {
            requestId: uuid(),
            operationId: uuid(),
            bindingVersion: 2,
            baseRevision: binding.revision,
            deadline: Date.now() + 60000,
          },
          { workspaceId: binding.workspaceId },
        ),
      ),
    );
    if (acquired.status !== 201) assert.fail("No actual non-job lease");
    const lease = acquired.body;
    const reservation = await h.cp.reservationFor(writer.principalId, lease.operationId);
    assert.ok(reservation);
    const ctx = { ...writer, registrationId: reservation.registrationIds.workspace };
    const oldPath = join(h.directory, "superseded.bin");
    const newPath = join(h.directory, "proposed.bin");
    const emptyPath = join(h.directory, "empty.bin");
    const oldBytes = new Uint8Array(65536 + 19);
    oldBytes.fill(31);
    const newBytes = new Uint8Array(600 * 1024 + 17);
    for (let n = 0; n < newBytes.length; n++) newBytes[n] = (n * 13) % 251;
    await writeFile(oldPath, oldBytes);
    await writeFile(newPath, newBytes);
    await writeFile(emptyPath, new Uint8Array());
    const plans = await Promise.all([
      inventory(oldPath, oldBytes.length, 65536),
      inventory(newPath, newBytes.length, 65536),
      inventory(emptyPath, 0, 65536),
    ]);
    const old = plans[0],
      current = plans[1],
      empty = plans[2];
    assert.ok(old && current && empty);
    const manifest: D.Manifest = {
      version: 1,
      entries: [
        { type: "file", path: "empty.bin", size: 0, sha256: empty.sha256, mode: 420 },
        {
          type: "file",
          path: "file.bin",
          size: newBytes.length,
          sha256: current.sha256,
          mode: 420,
        },
      ],
    };
    const mutations: D.Mutation[] = [
      { kind: "put", path: "file.bin", size: oldBytes.length, sha256: old.sha256, mode: 420 },
      { kind: "delete", path: "file.bin" },
      { kind: "put", path: "file.bin", size: newBytes.length, sha256: current.sha256, mode: 420 },
      { kind: "put", path: "empty.bin", size: 0, sha256: empty.sha256, mode: 420 },
    ];
    const manifestHash = await manifestDigest(manifest);
    const stageInput: D.UploadBegin = {
      requestId: uuid(),
      baseRevision: binding.revision,
      lease,
      operationId: lease.operationId,
      commitId: uuid(),
      manifestHash,
      manifest,
      mutations,
      blobs: plans.map((plan) => ({ sha256: plan.sha256, chunks: plan.chunks })),
    };
    const actor = h.env.WORKSPACES.getByName(binding.workspaceId);
    await assert.rejects(
      () =>
        actor.allocateStage({
          ...stageInput,
          blobs: plans.slice(1).map((plan) => ({ sha256: plan.sha256, chunks: plan.chunks })),
        }),
      "superseded puts still require a plan before allocation",
    );
    const uploadId = await actor.allocateStage(stageInput);
    const { url: listenUrl } = await h.server.listen();
    const base = new URL(listenUrl);
    base.protocol = "http:";
    const files = [
      { path: oldPath, relative: "file.bin", size: oldBytes.length, plan: old },
      { path: newPath, relative: "file.bin", size: newBytes.length, plan: current },
      { path: emptyPath, relative: "empty.bin", size: 0, plan: empty },
    ];
    let last: D.TransferDescriptor | undefined;
    for (const [fileIndex, file] of files.entries()) {
      const descriptor: D.TransferDescriptor = value(
        await h.cp.openTransfer(ctx, {
          deploymentId: h.deploymentId,
          direction: "to-executor",
          purpose: "local-stage",
          workspaceId: binding.workspaceId,
          bindingVersion: 2,
          operationId: lease.operationId,
          operationDigest: reservation.operationDigest,
          executorId: "executor",
          executorGeneration: 1,
          credential: lease.credential,
          consumer: binding.resources,
          baseRevision: binding.revision,
          lease,
          content: { kind: "workspace-file", path: file.relative, manifestHash, uploadId },
          fileSha256: file.plan.sha256,
          size: file.size,
          chunkBytes: file.plan.chunks.chunkBytes,
          chunkHashes: file.plan.chunks.chunkHashes,
          expiresAt: Date.now() + 20000,
          deadline: reservation.deadline,
        }),
      );
      last = descriptor;
      const receivedPath = join(h.directory, `receiver-${fileIndex}.bin`);
      const recipient = await open(receivedPath, "w+");
      try {
        if (file.size === 0) {
          assert.equal(descriptor.chunkHashes.length, 0);
          assert.equal(
            value(
              await h.cp.observeTransfer(ctx, {
                transferId: descriptor.transferId,
                attemptId: descriptor.attemptId,
              }),
            ).state,
            "verified",
          );
          assert.equal(
            (
              await fetch(
                new URL(
                  `/v1/executor/transfers/${descriptor.transferId}/input/chunks/0?attemptId=${descriptor.attemptId}`,
                  base,
                ),
                { headers: { Authorization: `Bearer ${channel.issued.token}` } },
              )
            ).status,
            400,
            "empty files have no byte request",
          );
        }
        for (let index = 0; index < descriptor.chunkHashes.length; index++) {
          const length = Math.min(descriptor.chunkBytes, file.size - index * descriptor.chunkBytes);
          const query = `attemptId=${descriptor.attemptId}&length=${length}&sha256=${descriptor.chunkHashes[index]}`;
          const consumer: Promise<Response> = fetch(
            new URL(
              `/v1/executor/transfers/${descriptor.transferId}/input/chunks/${index}?attemptId=${descriptor.attemptId}`,
              base,
            ),
            { headers: { Authorization: `Bearer ${channel.issued.token}` } },
          );
          const producer: Promise<Response> = fetch(
            new URL(
              `/internal/transfers/${descriptor.transferId}/peer/chunks/${index}?${query}`,
              base,
            ),
            {
              method: "PUT",
              headers: { "X-Fortipi-Context": JSON.stringify(ctx) },
              body: await chunk(file.path, index, descriptor.chunkBytes, file.size),
            },
          );
          // Keep a failed consumer assertion primary while cleanup cancels its
          // still-waiting peer; successful flow still awaits this producer below.
          void producer.catch(() => undefined);
          const response: Response = await consumer;
          assert.equal(
            response.status,
            200,
            "canonical executor input GET requires only attemptId",
          );
          const bytes = new Uint8Array(await response.arrayBuffer());
          assert.equal(
            createHash("sha256").update(bytes).digest("hex"),
            descriptor.chunkHashes[index],
          );
          await recipient.write(bytes, 0, bytes.length, index * descriptor.chunkBytes);
          assert.equal((await producer).status, 204);
        }
      } finally {
        await recipient.close();
      }
      assert.equal(
        (await inventory(receivedPath, file.size, 65536)).sha256,
        file.plan.sha256,
        "recipient verifies the complete file independently",
      );
    }
    assert.ok(last);
    const closed = new Promise<void>((resolve) =>
      channel.socket.addEventListener("close", () => resolve(), { once: true }),
    );
    channel.socket.close();
    await closed;
    channel = await connected(h, {
      workspaceIds: [binding.workspaceId],
      transferLimits: {
        chunkBytes: 32768,
        fileBytes: 4194304,
        snapshotBytes: 16777216,
        artifactBytes: 1048576,
        manifestEntries: 512,
      },
    });
    socket = channel.socket;
    const { transferId: _transfer, attemptId: _attempt, ...oldGrid } = last;
    assert.equal(
      (await h.cp.openTransfer(ctx, oldGrid)).ok,
      false,
      "a changed numeric observation is checked before transfer.open",
    );
  } finally {
    socket?.close();
    await h.close();
  }
});
