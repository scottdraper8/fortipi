import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { assignedJob } from "./artifact-job.ts";
import { chunk, inventory } from "./bytes.ts";
import { connected } from "./connection.ts";
import type { ArtifactControl } from "./fixtures/artifacts.ts";
import { harness, request, scope, uuid, value } from "./harness.ts";

test("native artifact index is atomic and immutable; a different reader streams real retained bytes and bounded ranges after job authority expires", async () => {
  const h = await harness<ArtifactControl>({
    fixturePath: "apps/worker/test/control/fixtures/artifacts.ts",
  });
  let socket: WebSocket | undefined;
  const tasks: Promise<void>[] = [];
  try {
    const channel = await connected(h);
    socket = channel.socket;
    const owner = await h.mint({
      requestId: uuid(),
      role: "client",
      grants: [
        { grantId: uuid(), version: 1, resources: scope(["jobs.dispatch", "workspace.write"]) },
      ],
    });
    const job = await assignedJob(h, await h.auth(owner.token), {
      leaseExpiresAt: Date.now() + 4000,
    });
    const bytes = new Uint8Array(600 * 1024 + 31);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 43 + 17) % 251;
    const ownerPath = join(h.directory, "actual-private-stdout.bin");
    await writeFile(ownerPath, bytes);
    const emptyPath = join(h.directory, "actual-private-empty.bin");
    await writeFile(emptyPath, new Uint8Array());
    const badWholePath = join(h.directory, "actual-private-bad-whole.bin");
    await writeFile(badWholePath, bytes.subarray(0, 37));
    const plan = await inventory(ownerPath, bytes.length, 65536);
    const empty = await inventory(emptyPath, 0, 65536);
    const badWhole = await inventory(badWholePath, 37, 65536);
    const artifactId = uuid();
    const emptyId = uuid();
    const badWholeId = uuid();
    const reference = (id: string, p: typeof plan, size: number): D.ByteReference => ({
      artifactId: id,
      workspaceId: "workspace",
      revision: job.identity.baseRevision,
      endpoint: `/v1/workspaces/workspace/artifacts/${id}`,
      sha256: p.sha256,
      size,
      owner: { kind: "local", executorId: "executor" },
      chunks: p.chunks,
      outputSource: { stream: "stdout" },
    });
    const result: D.PreparedResult = {
      identity: job.identity,
      sequence: 1,
      state: "succeeded",
      possibleExternalEffects: false,
      output: {
        tail: "",
        artifacts: [
          reference(artifactId, plan, bytes.length),
          reference(emptyId, empty, 0),
          { ...reference(badWholeId, badWhole, 37), sha256: "b".repeat(64) },
        ],
        truncated: false,
      },
    };
    const frame: D.ExecutorFrame = {
      type: "job.prepared_result",
      requestId: uuid(),
      payload: result,
    };
    channel.send(frame);
    await channel.wait("job.result_ack");
    assert.ok(
      await h.cp.artifactRecord(artifactId),
      "result transport ack must follow the durable index transaction",
    );
    const deliver = (f: D.ExecutorFrame) =>
      h.cp.deliverExecutorFrame(channel.executor, {
        executorId: "executor",
        generation: 1,
        connectionEpoch: channel.epoch,
        frame: f,
      });
    const duplicate = value(await deliver(frame));
    assert.equal(duplicate.persisted, true);
    const changed = structuredClone(result);
    if (changed.output.artifacts[0]?.outputSource)
      changed.output.artifacts[0].outputSource.stream = "stderr";
    assert.equal(
      (await deliver({ ...frame, payload: changed })).ok,
      false,
      "same result sequence cannot change an artifact stream",
    );
    const changedSequence = { ...changed, sequence: 2 };
    assert.equal(
      (await deliver({ ...frame, requestId: uuid(), payload: changedSequence })).ok,
      false,
      "new sequence cannot replace immutable indexed metadata",
    );
    const other = await assignedJob(h, await h.auth(owner.token));
    assert.equal(
      (
        await deliver({
          ...frame,
          requestId: uuid(),
          payload: { ...result, identity: other.identity },
        })
      ).ok,
      false,
      "artifact IDs cannot be reused by a different job",
    );
    await h.cp.forceDue();
    await h.cp.drainTest();
    assert.equal(await h.cp.rowCount("inbox"), 0);
    assert.ok(
      await h.cp.artifactRecord(artifactId),
      "the native index survives inbox delivery acknowledgment",
    );
    const issued = await h.mint({
      requestId: uuid(),
      role: "client",
      grants: [{ grantId: uuid(), version: 1, resources: scope(["artifacts.read"]) }],
    });
    const current = await h.auth(issued.token);
    const resources: D.ResourceScope = {
      agentIds: [],
      conversationIds: [],
      workspaceIds: ["workspace"],
      executorIds: [],
      backendIds: [],
      tools: [],
      actions: ["artifacts.read"],
    };
    const registration = value(
      await h.cp.registerAuthorityRecipient(current, {
        credential: issued.credential,
        recipient: { kind: "workspace", id: "workspace" },
        resources,
      }),
    );
    let reader: D.AuthContext = { ...current, registrationId: registration.registrationId };
    value(
      await h.cp.revokeCredential(
        await h.auth(),
        request(
          "revokeCredential",
          { requestId: uuid(), expectedGeneration: 1 },
          { id: owner.credential.credentialId },
        ),
      ),
    );
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, job.identity.lease.expiresAt - Date.now() + 10)),
    );
    assert.deepEqual(
      value(await deliver(frame)),
      duplicate,
      "an exact result retry after original authority revocation preserves its actual persisted transport receipt",
    );
    await h.cp.advanceFixtureRevision();
    const { url } = await h.server.listen();
    const base = new URL(url);
    base.protocol = "http:";
    const network = (path: string, init?: RequestInit) => fetch(new URL(path, base), init);
    const get = (id = artifactId, headers: HeadersInit = {}, query = "") =>
      network(`/internal/artifacts/workspace/${id}${query}`, {
        headers: { "X-Fortipi-Context": JSON.stringify(reader), ...headers },
      });
    const opens: Extract<D.ExecutorFrame, { type: "transfer.open" }>[] = [];
    let mode: "normal" | "hold" | "corrupt" | "missing" = "hold";
    const producerErrors: string[] = [];
    const produce = async (open: Extract<D.ExecutorFrame, { type: "transfer.open" }>) => {
      const d = open.payload;
      const content = d.content;
      assert.equal(d.purpose, "output");
      assert.equal("lease" in d, false);
      assert.deepEqual(d.credential, issued.credential);
      assert.equal(d.baseRevision, job.identity.baseRevision);
      assert.equal(d.operationDigest, job.identity.operationDigest);
      assert.equal(content.kind, "job-output");
      if (content.kind !== "job-output") return;
      const path =
        content.artifactId === emptyId
          ? emptyPath
          : content.artifactId === badWholeId
            ? badWholePath
            : ownerPath;
      const actual = await inventory(path, d.size, d.chunkBytes);
      if (
        mode === "missing" ||
        (content.artifactId !== badWholeId && actual.sha256 !== d.fileSha256) ||
        content.stream !== "stdout"
      ) {
        channel.send({
          type: "transfer.status",
          requestId: open.requestId,
          payload: {
            transferId: d.transferId,
            attemptId: d.attemptId,
            state: "interrupted",
            verifiedChunks: [],
            bytes: 0,
            reason: "Synthetic missing private source",
          },
        });
        return;
      }
      const verifiedChunks: number[] = [];
      let delivered = 0;
      for (let index = 0; index < d.chunkHashes.length; index++) {
        const part = await chunk(path, index, d.chunkBytes, d.size);
        if (mode === "corrupt") part[0] = (part[0] ?? 0) ^ 1;
        const response = await network(
          `/v1/executor/transfers/${d.transferId}/output/chunks/${index}?attemptId=${d.attemptId}&length=${part.length}&sha256=${d.chunkHashes[index]}`,
          {
            method: "PUT",
            headers: { Authorization: `Bearer ${channel.issued.token}` },
            body: part,
          },
        );
        if (response.status !== 204) {
          channel.send({
            type: "transfer.status",
            requestId: open.requestId,
            payload: {
              transferId: d.transferId,
              attemptId: d.attemptId,
              state: "interrupted",
              verifiedChunks,
              bytes: delivered,
              reason: "Synthetic interrupted bytes",
            },
          });
          return;
        }
        verifiedChunks.push(index);
        delivered += part.length;
      }
      channel.send({
        type: "transfer.status",
        requestId: open.requestId,
        payload: {
          transferId: d.transferId,
          attemptId: d.attemptId,
          state: content.artifactId === badWholeId ? "interrupted" : "verified",
          verifiedChunks,
          bytes: delivered,
        },
      });
    };
    socket.addEventListener("message", (event) => {
      const f = JSON.parse(String(event.data)) as D.ExecutorFrame;
      if (f.type !== "transfer.open") return;
      opens.push(f);
      if (mode !== "hold")
        tasks.push(
          produce(f).catch((error) => {
            producerErrors.push(String(error));
          }),
        );
    });
    const waitOpen = async (count: number) => {
      for (let i = 0; i < 300 && opens.length < count; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(opens.length >= count);
      return opens[count - 1] ?? assert.fail("No transfer open");
    };
    const first = get();
    const open = await waitOpen(1);
    const d = open.payload;
    assert.equal(
      (
        await deliver({
          type: "transfer.status",
          requestId: open.requestId,
          payload: {
            transferId: d.transferId,
            attemptId: d.attemptId,
            state: "verified",
            verifiedChunks: d.chunkHashes.map((_, i) => i),
            bytes: d.size,
          },
        })
      ).ok,
      false,
      "producer status cannot forge real HTTP chunk receipts",
    );
    mode = "normal";
    tasks.push(produce(open));
    let response = await first;
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-Content-Sha256"), plan.sha256);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
    const narrowed = JSON.parse((await h.cp.transferRecord(d.transferId)) ?? "null") as {
      registrationId: string;
    };
    assert.notEqual(
      narrowed.registrationId,
      registration.registrationId,
      "a minimal incoming workspace registration is narrowed after actual indexed grant authorization",
    );
    const exact = JSON.parse(
      (await h.cp.registrationRecord(narrowed.registrationId)) ?? "null",
    ) as D.AuthorityRegistration;
    assert.deepEqual(exact.credential, issued.credential);
    assert.deepEqual(exact.resources.agentIds, ["agent"]);
    assert.deepEqual(exact.resources.conversationIds, ["conversation"]);
    assert.deepEqual(exact.resources.executorIds, ["executor"]);
    assert.deepEqual(exact.resources.actions, ["artifacts.read"]);
    const recipientCount = await h.cp.rowCount("recipient");
    const beforeRange = opens.length;
    response = await get(
      artifactId,
      { Range: "bytes=12345-600005" },
      `?revision=${job.identity.baseRevision}&range[start]=12345&range[end]=600005`,
    );
    assert.equal(response.status, 206);
    const expected = bytes.subarray(12345, 600006);
    assert.equal(response.headers.get("Content-Length"), String(expected.length));
    assert.equal(response.headers.get("Content-Range"), `bytes 12345-600005/${bytes.length}`);
    assert.equal(
      response.headers.get("X-Content-Sha256"),
      createHash("sha256").update(expected).digest("hex"),
    );
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), expected);
    assert.equal(
      opens.length - beforeRange,
      2,
      "a partial response verifies a full source pass then drains a fresh full descriptor without adding an offset",
    );
    assert.equal(
      await h.cp.rowCount("recipient"),
      recipientCount,
      "repeated artifact scopes reuse the exact registration",
    );
    assert.equal(
      (await get(uuid())).status,
      404,
      "an unindexed zero artifact cannot fabricate empty success",
    );
    assert.equal(
      await h.cp.rowCount("recipient"),
      recipientCount,
      "a missing index cannot register guessed authority",
    );
    assert.equal(
      (await get(artifactId, {}, "?revision=unrelated_new_revision")).status,
      409,
      "artifact query binds original retained revision rather than current pointer",
    );
    assert.equal(
      (
        await get(
          artifactId,
          {},
          `?revision=${job.identity.baseRevision}&revision=${job.identity.baseRevision}`,
        )
      ).status,
      400,
      "duplicate revision/range query keys cannot be silently collapsed",
    );
    assert.equal(
      (await get(badWholeId)).status,
      409,
      "valid chunk hashes cannot substitute for actual whole-file checksum verification",
    );
    mode = "hold";
    const count = opens.length;
    let settled = false;
    const zero = get(emptyId).then((r) => {
      settled = true;
      return r;
    });
    const zeroOpen = await waitOpen(count + 1);
    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.equal(
      settled,
      false,
      "zero-byte output remains waiting without the producer's actual proof",
    );
    const zeroStatus: D.TransferStatus = {
      transferId: zeroOpen.payload.transferId,
      attemptId: zeroOpen.payload.attemptId,
      state: "verified",
      verifiedChunks: [],
      bytes: 0,
    };
    assert.equal(
      (await deliver({ type: "transfer.status", requestId: uuid(), payload: zeroStatus })).ok,
      false,
      "wrong outer request correlation cannot complete zero output",
    );
    mode = "normal";
    await produce(zeroOpen);
    response = await zero;
    assert.equal(response.status, 200);
    assert.equal((await response.arrayBuffer()).byteLength, 0);
    mode = "missing";
    assert.equal(
      (await get(emptyId)).status,
      409,
      "actual producer interruption prevents empty success",
    );
    mode = "hold";
    const beforeTimeout = opens.length;
    const started = Date.now();
    const stalled = get(emptyId);
    const stalledOpen = await waitOpen(beforeTimeout + 1);
    assert.equal(
      (await stalled).status,
      409,
      "zero output without producer proof settles at its bounded deadline",
    );
    assert.ok(Date.now() - started >= 9000 && Date.now() - started < 13000);
    assert.equal(
      (
        await deliver({
          type: "transfer.status",
          requestId: stalledOpen.requestId,
          payload: {
            transferId: stalledOpen.payload.transferId,
            attemptId: stalledOpen.payload.attemptId,
            state: "verified",
            verifiedChunks: [],
            bytes: 0,
          },
        })
      ).ok,
      false,
      "late zero proof cannot revive an interrupted attempt",
    );
    mode = "corrupt";
    response = await get();
    assert.equal(response.status, 409, "corrupt first chunk exposes no artifact body");
    mode = "normal";
    const template = { ...d };
    const { transferId: _transfer, attemptId: _attempt, ...input } = template;
    assert.equal(
      (
        await h.cp.openTransfer(reader, {
          ...input,
          content: { kind: "job-output", artifactId, stream: "stderr" },
          expiresAt: Date.now() + 5000,
          deadline: Date.now() + 5000,
        })
      ).ok,
      false,
      "the indexed stream is exact",
    );
    const wrong = await h.mint({
      requestId: uuid(),
      role: "client",
      grants: [
        {
          grantId: uuid(),
          version: 1,
          resources: { ...scope(["artifacts.read"]), agentIds: ["other_agent"] },
        },
      ],
    });
    const saved = reader;
    const wrongCtx = await h.auth(wrong.token);
    const wrongRegistration = value(
      await h.cp.registerAuthorityRecipient(wrongCtx, {
        credential: wrong.credential,
        recipient: { kind: "workspace", id: "workspace" },
        resources,
      }),
    );
    reader = { ...wrongCtx, registrationId: wrongRegistration.registrationId };
    assert.equal(
      (await get()).status,
      403,
      "artifact lookup checks actual job owner scopes before metadata disclosure",
    );
    const noExecutor = await h.mint({
      requestId: uuid(),
      role: "client",
      grants: [
        {
          grantId: uuid(),
          version: 1,
          resources: { ...scope(["artifacts.read"]), executorIds: ["other_executor"] },
        },
      ],
    });
    const noExecutorCtx = await h.auth(noExecutor.token);
    const noExecutorRegistration = value(
      await h.cp.registerAuthorityRecipient(noExecutorCtx, {
        credential: noExecutor.credential,
        recipient: { kind: "workspace", id: "workspace" },
        resources,
      }),
    );
    reader = { ...noExecutorCtx, registrationId: noExecutorRegistration.registrationId };
    assert.equal((await get()).status, 403, "CP narrowing cannot add a missing executor grant");
    reader = saved;
    await Promise.all(tasks);
    const closed = new Promise<void>((resolve) =>
      channel.socket.addEventListener("close", () => resolve(), { once: true }),
    );
    channel.socket.close();
    await closed;
    const reduced = await connected(h, {
      transferLimits: {
        chunkBytes: 32768,
        fileBytes: 4194304,
        snapshotBytes: 16777216,
        artifactBytes: 1048576,
        manifestEntries: 512,
      },
    });
    socket = reduced.socket;
    const transfersBefore = await h.cp.rowCount("transfer");
    assert.equal(
      (await get()).status,
      413,
      "a newly registered smaller chunk cap rejects retained metadata before opening bytes",
    );
    assert.equal(await h.cp.rowCount("transfer"), transfersBefore);
    value(
      await h.cp.revokeExecutor(
        await h.auth(),
        request("revokeExecutor", { requestId: uuid(), expectedGeneration: 1 }, { id: "executor" }),
      ),
    );
    assert.equal(
      (await get()).status,
      409,
      "current executor floors reject retained output independently of its original job lease",
    );
    value(
      await h.cp.revokeCredential(
        await h.auth(),
        request(
          "revokeCredential",
          { requestId: uuid(), expectedGeneration: 1 },
          { id: issued.credential.credentialId },
        ),
      ),
    );
    assert.equal(
      (await get()).status,
      401,
      "the current reader floor is enforced independently of historical job authority",
    );
    await Promise.all(tasks);
    assert.deepEqual(producerErrors, []);
    assert.equal(
      channel.frames.filter((f) => f.type === "job.assign").length,
      2,
      "reads and retries never assign or replay a process",
    );
  } finally {
    socket?.close();
    await Promise.allSettled(tasks);
    await h.close();
  }
});
