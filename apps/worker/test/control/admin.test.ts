import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type * as D from "../../src/boundary/dto.ts";
import { adminHarness, dataScope, requestId, value } from "./admin-harness.ts";

const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

test("actual CP backup retains immutable Agent-only bytes under one scoped logical grant", {
  timeout: 20000,
}, async () => {
  const f = await adminHarness();
  try {
    const bytes = Uint8Array.from({ length: 196631 }, (_, i) => (i * 17 + 3) % 251),
      agentId = await f.source(bytes),
      creator = await f.mint(dataScope(agentId, ["backups.create"])),
      reader = await f.mint(dataScope(agentId, ["operations.read", "artifacts.read"]));
    const body: D.ExportInput = {
      requestId: requestId(),
      resources: dataScope(agentId, []),
      maxBytes: bytes.length,
    };
    const input: D.OperationRequest<"createBackup"> = {
      operationId: "createBackup",
      path: {},
      query: {},
      body,
    };
    const accepted = value(await f.op(input, creator.token));
    assert.equal(accepted.status, 202);
    const retried = value(await f.op(input, creator.token));
    assert.equal(retried.status, 202);
    assert.equal(retried.body.operationId, accepted.body.operationId);
    const changed = await f.op(
      { ...input, body: { ...body, maxBytes: body.maxBytes + 1 } },
      creator.token,
    );
    assert.equal(changed.ok, false);
    if (changed.ok) assert.fail("Changed request accepted");
    assert.equal(changed.code, "conflict");
    const completed = await f.observe(accepted.body.operationId, reader.token);
    assert.equal(completed.state, "completed", completed.reason ?? "Copy did not complete");
    assert.equal(completed.artifacts.length, 1);
    const reference = completed.artifacts[0];
    assert.ok(reference);
    assert.equal(reference.scope.kind, "agent");
    assert.equal(reference.size, bytes.length);
    assert.equal(reference.sha256, sha(bytes));
    assert.equal("workspaceId" in reference, false);
    assert.equal((await f.raw(reference.endpoint, creator.token)).status, 403);
    value(
      await f.op({
        operationId: "revokeCredential",
        path: { id: creator.credential.credentialId },
        query: {},
        body: { requestId: requestId(), expectedGeneration: 1 },
      }),
    );
    assert.equal(
      (
        await f.raw(`/fixture/source/${agentId}`, f.bootstrap, {
          method: "PUT",
          body: new Uint8Array([9, 8, 7]),
        })
      ).status,
      204,
    );
    const response = await f.raw(reference.endpoint, reader.token);
    assert.equal(response.status, 200);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
    const selected = await f.raw(reference.endpoint, reader.token, {
      headers: { Range: "bytes=31-120030" },
    });
    assert.equal(selected.status, 206);
    const range = new Uint8Array(await selected.arrayBuffer());
    assert.deepEqual(range, bytes.subarray(31, 120031));
    assert.equal(selected.headers.get("X-Content-SHA256"), sha(range));
    const otherReader = await f.mint({
      ...dataScope(agentId, ["artifacts.read"]),
      conversationIds: ["different-conversation"],
    });
    assert.equal((await f.raw(reference.endpoint, otherReader.token)).status, 403);
  } finally {
    await f.close();
  }
});

test("nonadmin and split logical/data grants cannot begin an admin copy", {
  timeout: 10000,
}, async () => {
  const f = await adminHarness();
  try {
    const agentId = await f.source(new Uint8Array([1, 2, 3])),
      resources = dataScope(agentId, []),
      client = await f.mint(dataScope(agentId, ["exports.create"]), "client");
    const split = await f.mint(resources, "admin", [
      { grantId: "data-only", version: 1, resources: { ...resources, actions: [] } },
      {
        grantId: "action-only",
        version: 1,
        resources: { ...resources, agentIds: [], conversationIds: [], actions: ["exports.create"] },
      },
    ]);
    const input: D.OperationRequest<"createExport"> = {
      operationId: "createExport",
      path: {},
      query: {},
      body: { requestId: requestId(), resources, maxBytes: 1024 },
    };
    const deniedClient = await f.op(input, client.token),
      deniedSplit = await f.op(
        { ...input, body: { ...input.body, requestId: requestId() } },
        split.token,
      );
    assert.equal(deniedClient.ok, false);
    assert.equal(deniedSplit.ok, false);
    const state: { jobs: unknown[]; indexes: number; chunks: { n: number } } = JSON.parse(
      await (await f.raw("/fixture/inspect")).text(),
    );
    assert.equal(state.jobs.length, 0);
    assert.equal(state.indexes, 0);
    assert.equal(state.chunks.n, 0);
  } finally {
    await f.close();
  }
});

test("current revocation after a delayed peer response prevents copying or publishing", {
  timeout: 15000,
}, async () => {
  const f = await adminHarness();
  try {
    const agentId = await f.source(new Uint8Array(65537)),
      creator = await f.mint(dataScope(agentId, ["backups.create"])),
      reader = await f.mint(dataScope(agentId, ["operations.read"]));
    await f.raw(`/fixture/source/${agentId}?mode=hold`);
    const accepted = value(
      await f.op(
        {
          operationId: "createBackup",
          path: {},
          query: {},
          body: { requestId: requestId(), resources: dataScope(agentId, []), maxBytes: 65537 },
        },
        creator.token,
      ),
    );
    let waiting = false;
    for (let i = 0; i < 8; i++) {
      const peer: { waiting: number } = JSON.parse(
        await (await f.raw(`/fixture/source/${agentId}`)).text(),
      );
      if (peer.waiting) {
        waiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
    assert.equal(waiting, true, "Actual peer GET must be in flight before revocation");
    value(
      await f.op({
        operationId: "revokeCredential",
        path: { id: creator.credential.credentialId },
        query: {},
        body: { requestId: requestId(), expectedGeneration: 1 },
      }),
    );
    await f.raw(`/fixture/source/${agentId}?mode=normal`);
    assert.equal(accepted.status, 202);
    const completed = await f.observe(accepted.body.operationId, reader.token);
    assert.equal(completed.state, "unavailable");
    assert.deepEqual(completed.artifacts, []);
    const state: { chunks: { n: number }; indexes: number } = JSON.parse(
      await (await f.raw("/fixture/inspect")).text(),
    );
    assert.equal(state.chunks.n, 0);
    assert.equal(state.indexes, 0);
  } finally {
    await f.close();
  }
});

test("actual whole-SHA corruption and oversized descriptors never publish completed copies", {
  timeout: 20000,
}, async () => {
  for (const mode of ["corrupt", "overclaim"]) {
    const f = await adminHarness();
    try {
      const bytes = Uint8Array.from({ length: 65537 }, (_, i) => i % 251),
        agentId = await f.source(bytes),
        creator = await f.mint(dataScope(agentId, ["exports.create"])),
        reader = await f.mint(dataScope(agentId, ["operations.read"]));
      await f.raw(`/fixture/source/${agentId}?mode=${mode}`);
      const accepted = value(
        await f.op(
          {
            operationId: "createExport",
            path: {},
            query: {},
            body: {
              requestId: requestId(),
              resources: dataScope(agentId, []),
              maxBytes: mode === "overclaim" ? 65536 : bytes.length,
            },
          },
          creator.token,
        ),
      );
      assert.equal(accepted.status, 202);
      const result = await f.observe(accepted.body.operationId, reader.token);
      assert.equal(result.state, "unavailable", mode);
      assert.deepEqual(result.artifacts, []);
      const state: { chunks: { bytes: number }; indexes: number } = JSON.parse(
        await (await f.raw("/fixture/inspect")).text(),
      );
      assert.equal(state.indexes, 0);
      assert.equal(
        state.chunks.bytes,
        mode === "corrupt" ? 65536 : 0,
        "Final byte/progress transaction must roll back on whole-SHA failure",
      );
    } finally {
      await f.close();
    }
  }
});

test("near-full reserved install rejects the next real copy chunk and preserves its existing pending prefix", {
  timeout: 15000,
}, async () => {
  const f = await adminHarness();
  try {
    const bytes = Uint8Array.from({ length: 131073 }, (_, i) => i % 239),
      agentId = await f.source(bytes),
      creator = await f.mint(dataScope(agentId, ["backups.create"])),
      reader = await f.mint(dataScope(agentId, ["operations.read"]));
    await f.raw(`/fixture/source/${agentId}?mode=hold-tail`);
    const accepted = value(
      await f.op(
        {
          operationId: "createBackup",
          path: {},
          query: {},
          body: {
            requestId: requestId(),
            resources: dataScope(agentId, []),
            maxBytes: bytes.length,
          },
        },
        creator.token,
      ),
    );
    let waiting = false;
    for (let i = 0; i < 8; i++) {
      const peer: { waiting: number } = JSON.parse(
        await (await f.raw(`/fixture/source/${agentId}`)).text(),
      );
      if (peer.waiting) {
        waiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
    assert.equal(waiting, true);
    const before: { chunks: { bytes: number }; physical: number; blobHash: string } = JSON.parse(
      await (await f.raw("/fixture/inspect")).text(),
    );
    assert.equal(before.chunks.bytes, 65536);
    assert.equal(before.blobHash, sha(bytes.subarray(0, 65536)));
    const reserved: {
      usage: { reserved: number; consumed: number; slots: number };
      physical: number;
    } = JSON.parse(await (await f.raw("/fixture/near-full")).text());
    await f.raw(`/fixture/source/${agentId}?mode=normal`);
    assert.equal(accepted.status, 202);
    const result = await f.observe(accepted.body.operationId, reader.token);
    assert.equal(result.state, "unavailable");
    assert.match(result.reason ?? "", /object\/install storage bounds/);
    assert.deepEqual(result.artifacts, []);
    const after: {
      usage: typeof reserved.usage;
      chunks: { bytes: number };
      physical: number;
      indexes: number;
      blobHash: string;
    } = JSON.parse(await (await f.raw("/fixture/inspect")).text());
    assert.deepEqual(after.usage, reserved.usage);
    assert.equal(after.chunks.bytes, before.chunks.bytes);
    assert.equal(after.blobHash, before.blobHash);
    assert.equal(after.indexes, 0);
    assert.ok(
      after.physical <= reserved.physical + 16384,
      "Rejected copy preserves physical repair slack",
    );
  } finally {
    await f.close();
  }
});
