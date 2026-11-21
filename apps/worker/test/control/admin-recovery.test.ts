import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type * as D from "../../src/boundary/dto.ts";
import { dataScope, requestId, value } from "./admin-harness.ts";
import { adminProcess } from "./admin-process.ts";

const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
type State = {
  jobs: {
    id: string;
    state: string;
    copied: number;
    peerIds: string[];
    authenticatedAt: number;
    credentialExpiresAt: number | null;
    parts: { sourceId: string; publicId: string; sha256: string; size: number }[];
  }[];
  chunks: { n: number; bytes: number };
  indexes: number;
};

test("actual persistent CP survives lost reply and partial-copy SIGKILL; wire bytes, zero, current reader and bounded GC", {
  timeout: 60000,
}, async () => {
  const f = await adminProcess();
  try {
    const bytes = Uint8Array.from({ length: 614431 }, (_, i) => (i * 29 + 11) % 251),
      agentId = await f.source(bytes),
      creator = await f.mint(dataScope(agentId, ["backups.create"])),
      reader = await f.mint(dataScope(agentId, ["operations.read", "artifacts.read"]));
    const input: D.OperationRequest<"createBackup"> = {
      operationId: "createBackup",
      path: {},
      query: {},
      body: { requestId: requestId(), resources: dataScope(agentId, []), maxBytes: bytes.length },
    };
    assert.equal(
      (
        await f.raw("/fixture/operation?drop=true", creator.token, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        })
      ).status,
      503,
    );
    const accepted: State = JSON.parse(await (await f.raw("/fixture/inspect")).text());
    assert.equal(accepted.jobs.length, 1);
    const first = accepted.jobs[0];
    assert.ok(first);
    assert.equal(accepted.indexes, 0);
    const retry = value(await f.op(input, creator.token));
    assert.equal(retry.status, 202);
    assert.equal(retry.body.operationId, first.id);
    let partial: State | undefined;
    for (let i = 0; i < 8; i++) {
      const observed: State = JSON.parse(await (await f.raw("/fixture/inspect")).text());
      if (observed.jobs[0]?.copied) {
        partial = observed;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
    assert.ok(partial);
    assert.ok((partial.jobs[0]?.copied ?? 0) < bytes.length);
    assert.equal(partial.indexes, 0);
    assert.ok(partial.chunks.bytes > 0);
    await f.reopen();
    const reopened: State = JSON.parse(await (await f.raw("/fixture/inspect")).text());
    assert.equal(reopened.jobs[0]?.id, first.id);
    assert.deepEqual(reopened.jobs[0]?.peerIds, first.peerIds);
    assert.equal(reopened.jobs[0]?.authenticatedAt, first.authenticatedAt);
    assert.equal(reopened.jobs[0]?.credentialExpiresAt, first.credentialExpiresAt);
    assert.ok(
      reopened.chunks.bytes >= partial.chunks.bytes,
      "Committed BLOB prefix survived process-tree SIGKILL",
    );
    const afterRetry = value(await f.op(input, creator.token));
    assert.equal(afterRetry.status, 202);
    assert.equal(afterRetry.body.operationId, first.id);
    const completed = await f.observe(first.id, reader.token);
    assert.equal(completed.state, "completed", completed.reason ?? "No completed copy");
    const reference = completed.artifacts[0];
    assert.ok(reference);
    assert.equal(reference.sha256, sha(bytes));
    assert.equal(reference.size, bytes.length);
    const retained: State = JSON.parse(await (await f.raw("/fixture/inspect")).text());
    assert.equal(retained.jobs.length, 1);
    assert.equal(retained.indexes, 1);
    assert.equal(retained.chunks.bytes, bytes.length);
    assert.notEqual(
      retained.jobs[0]?.parts[0]?.sourceId,
      reference.artifactId,
      "Public CP identity is independent of source-local identity",
    );
    assert.equal(retained.jobs[0]?.parts[0]?.publicId, reference.artifactId);
    assert.equal((await f.raw(`/fixture/source/${agentId}?mode=offline`)).status, 204);
    assert.equal(
      (
        await f.raw(`/fixture/source/${agentId}`, f.bootstrap, {
          method: "PUT",
          body: new Uint8Array([0]),
        })
      ).status,
      204,
    );
    const response = await f.raw(reference.endpoint, reader.token);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Length"), String(bytes.length));
    assert.equal(response.headers.get("X-Content-SHA256"), sha(bytes));
    assert.equal(sha(new Uint8Array(await response.arrayBuffer())), sha(bytes));
    const range = await f.raw(reference.endpoint, reader.token, {
      headers: { Range: "bytes=31-600030" },
    });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get("Content-Length"), "600000");
    assert.equal(range.headers.get("Content-Range"), `bytes 31-600030/${bytes.length}`);
    const selected = new Uint8Array(await range.arrayBuffer());
    assert.deepEqual(selected, bytes.subarray(31, 600031));
    assert.equal(range.headers.get("X-Content-SHA256"), sha(selected));
    for (const invalid of ["bytes=1-", "bytes=-10", `bytes=0-${bytes.length}`]) {
      const denied = await f.raw(reference.endpoint, reader.token, { headers: { Range: invalid } });
      assert.ok(denied.status >= 400);
      assert.equal(denied.headers.get("Content-Type")?.includes("application/json"), true);
      await denied.arrayBuffer();
    }
    const controller = new AbortController(),
      cancelled = await f.raw(reference.endpoint, reader.token, { signal: controller.signal });
    const stream = cancelled.body?.getReader();
    assert.ok(stream);
    const head = await stream.read();
    assert.equal(head.done, false);
    await stream.cancel();
    controller.abort();
    const zeroAgent = await f.source(new Uint8Array()),
      zeroCreator = await f.mint(dataScope(zeroAgent, ["exports.create"])),
      zeroReader = await f.mint(dataScope(zeroAgent, ["operations.read", "artifacts.read"]));
    const zero = value(
      await f.op(
        {
          operationId: "createExport",
          path: {},
          query: {},
          body: { requestId: requestId(), resources: dataScope(zeroAgent, []), maxBytes: 1 },
        },
        zeroCreator.token,
      ),
    );
    assert.equal(zero.status, 202);
    const zeroDone = await f.observe(zero.body.operationId, zeroReader.token);
    assert.equal(zeroDone.state, "completed", zeroDone.reason ?? "No completed empty copy");
    const zeroRef = zeroDone.artifacts[0];
    assert.ok(zeroRef);
    const empty = await f.raw(zeroRef.endpoint, zeroReader.token);
    assert.equal(empty.status, 200);
    assert.equal(empty.headers.get("Content-Length"), "0");
    assert.equal(empty.headers.get("X-Content-SHA256"), sha(new Uint8Array()));
    assert.equal((await empty.arrayBuffer()).byteLength, 0);
    const revoked = value(
      await f.op({
        operationId: "revokeCredential",
        path: { id: reader.credential.credentialId },
        query: {},
        body: { requestId: requestId(), expectedGeneration: 1 },
      }),
    );
    assert.ok(revoked.status === 200 || revoked.status === 202);
    assert.equal((await f.raw(reference.endpoint, reader.token)).status, 401);
    const legacy = value(
      await f.op({
        operationId: "getAdminOperation",
        path: { id: revoked.body.operationId },
        query: {},
        body: undefined,
      }),
    );
    assert.equal(legacy.status, 200);
    assert.equal(legacy.body.kind, "revocation");
    await f.raw(`/fixture/expire?id=${first.id}`);
    await f.raw(`/fixture/expire?id=${zero.body.operationId}`);
    let cleared: State | undefined;
    for (let i = 0; i < 8; i++) {
      cleared = JSON.parse(await (await f.raw("/fixture/inspect")).text());
      if (cleared?.jobs.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.equal(cleared?.jobs.length, 0);
    assert.equal(cleared?.chunks.n, 0);
    assert.equal(cleared?.indexes, 0);
  } finally {
    await f.close();
  }
});
