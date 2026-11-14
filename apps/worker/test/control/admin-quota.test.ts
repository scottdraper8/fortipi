import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { freeInfrastructurePolicy } from "fortipi-contract";
import type * as D from "../../src/boundary/dto.ts";
import { adminHarness, dataScope, requestId, value } from "./admin-harness.ts";
import { adminProcess } from "./admin-process.ts";

type State = {
  jobs: {
    id: string;
    state: string;
    attempts: number;
    due: number | null;
    copyUntil: number;
    requestDue: number | null;
    peerIds: string[];
    authenticatedAt: number;
    credentialExpiresAt: number | null;
  }[];
  holds: { kind: string; key: string; notBefore?: number }[];
  indexes: number;
  chunks: { n: number };
};
type ReadFixture = { raw(path: string, token?: string): Promise<{ text(): Promise<string> }> };
async function inspect(f: ReadFixture, token?: string): Promise<State> {
  return JSON.parse(await (await f.raw("/fixture/inspect", token)).text());
}
async function held(f: ReadFixture, operationId: string, token?: string): Promise<State> {
  for (let n = 0; n < 8; n++) {
    const state = await inspect(f, token);
    if (state.holds.some((hold) => hold.kind === "admin_job" && hold.key === operationId))
      return state;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.fail("Actual admin receiver refusal did not retain a hold");
}
const configuration = (version: number): D.Configuration => ({
  version,
  workspace: { kind: "local", executorId: "unused-executor", rootBindingId: "root" },
  execution: { kind: "native", executorId: "unused-executor", trust: "host" },
  routing: { kind: "explicit", targetIds: ["unused-executor"] },
  models: [{ providerId: "cloudflare", modelId: "unused-model" }],
  infrastructure: freeInfrastructurePolicy,
});

test("admin copy retains known receiver quota timing instead of shortening it to ordinary backoff", {
  timeout: 10000,
}, async () => {
  const f = await adminHarness();
  try {
    const agentId = await f.source(new Uint8Array([1, 2, 3]));
    const creator = await f.mint(dataScope(agentId, ["backups.create"]));
    await f.raw(`/fixture/source/${agentId}?mode=quota-describe`);
    const accepted = value(
      await f.op(
        {
          operationId: "createBackup",
          path: {},
          query: {},
          body: {
            requestId: requestId(),
            resources: dataScope(agentId, []),
            maxBytes: 3,
          },
        },
        creator.token,
      ),
    );
    assert.equal(accepted.status, 202);
    let state: State | undefined;
    let quota: { calls: number; retryAt: number } | undefined;
    for (let n = 0; n < 8; n++) {
      state = JSON.parse(await (await f.raw("/fixture/inspect")).text());
      const peer: { quota?: typeof quota } = JSON.parse(
        await (await f.raw(`/fixture/source/${agentId}`)).text(),
      );
      quota = peer.quota;
      if (
        state &&
        quota &&
        (state.holds.length || state.jobs[0]?.attempts || state.jobs[0]?.state === "unavailable")
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.ok(state && quota);
    const hold = state.holds.find(
      (row) => row.kind === "admin_job" && row.key === accepted.body.operationId,
    );
    assert.ok(hold, "admin copy must retain receiver quota timing instead of a short retry");
    assert.ok(hold.notBefore !== undefined && hold.notBefore >= quota.retryAt);
    assert.equal(state.jobs[0]?.due, hold.notBefore);
    assert.equal(quota.calls, 1);
    assert.equal(state.indexes, 0);
    assert.equal(state.chunks.n, 0);
  } finally {
    await f.close();
  }
});

test("typed HTTP quota and its known deadline survive actual process-tree kill without an early receiver retry", {
  timeout: 35000,
}, async () => {
  const f = await adminProcess();
  try {
    const bytes = Uint8Array.from({ length: 65537 }, (_, i) => i % 239);
    const agentId = await f.source(bytes);
    const creator = await f.mint(dataScope(agentId, ["backups.create"]));
    const reader = await f.mint(dataScope(agentId, ["operations.read", "artifacts.read"]));
    await f.raw(`/fixture/source/${agentId}?mode=quota-fetch`);
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
    assert.equal(accepted.status, 202);
    const before = await held(f, accepted.body.operationId);
    const hold = before.holds[0];
    assert.ok(hold && hold.notBefore !== undefined);
    const notBefore = hold.notBefore;
    const job = before.jobs[0];
    assert.ok(job);
    assert.equal(job.due, hold.notBefore);
    assert.equal(
      job.requestDue,
      job.copyUntil,
      "cleanup wake remains independent of receiver timing",
    );
    await f.reopen();
    const reopened = await inspect(f);
    assert.deepEqual(reopened.holds, before.holds);
    assert.equal(reopened.jobs[0]?.due, job.due);
    assert.deepEqual(reopened.jobs[0]?.peerIds, job.peerIds);
    assert.equal(reopened.jobs[0]?.authenticatedAt, job.authenticatedAt);
    const peer: { quota: { calls: number } } = JSON.parse(
      await (await f.raw(`/fixture/source/${agentId}`)).text(),
    );
    assert.equal(peer.quota.calls, 1);
    await f.raw(`/fixture/source/${agentId}?mode=normal`);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(500, Math.max(0, notBefore - Date.now() - 100))),
    );
    const early: { calls: number } = JSON.parse(
      await (await f.raw(`/fixture/source/${agentId}`)).text(),
    );
    assert.equal(
      early.calls,
      1,
      "a reopened admin copy must not query the receiver before its declared quota deadline",
    );
    const done = await f.observe(accepted.body.operationId, reader.token);
    assert.equal(done.state, "completed", done.reason ?? "Admin copy did not complete");
    const reference = done.artifacts[0];
    assert.ok(reference);
    const response = await f.raw(reference.endpoint, reader.token);
    assert.equal(response.status, 200);
    assert.equal(
      createHash("sha256")
        .update(new Uint8Array(await response.arrayBuffer()))
        .digest("hex"),
      createHash("sha256").update(bytes).digest("hex"),
    );
  } finally {
    await f.close();
  }
});

test("unknown receiver storage holds persist across SIGKILL and resume only on an actual new configuration CAS", {
  timeout: 35000,
}, async () => {
  const f = await adminProcess();
  try {
    const bytes = Uint8Array.from({ length: 65537 }, (_, i) => i % 233);
    const agentId = await f.source(bytes);
    const creator = await f.mint(dataScope(agentId, ["exports.create"]));
    const reader = await f.mint(
      dataScope(agentId, ["operations.read", "artifacts.read", "configuration.write"]),
    );
    await f.raw(`/fixture/source/${agentId}?mode=storage-fetch`);
    const accepted = value(
      await f.op(
        {
          operationId: "createExport",
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
    assert.equal(accepted.status, 202);
    const before = await held(f, accepted.body.operationId);
    assert.equal(before.jobs[0]?.due, null, "unknown storage must have no invented receiver reset");
    assert.equal(before.holds[0]?.notBefore, undefined);
    await f.reopen();
    const reopened = await inspect(f);
    assert.deepEqual(reopened.holds, before.holds);
    assert.equal(reopened.jobs[0]?.due, null);
    assert.deepEqual(reopened.jobs[0]?.peerIds, before.jobs[0]?.peerIds);
    const patch: D.OperationRequest<"patchConfiguration"> = {
      operationId: "patchConfiguration",
      path: {},
      query: {},
      body: { requestId: requestId(), expectedVersion: 1, configuration: configuration(2) },
    };
    const changed = value(await f.op(patch, reader.token));
    assert.equal(changed.status, 200);
    let peer: { quota: { calls: number } } = JSON.parse(
      await (await f.raw(`/fixture/source/${agentId}`)).text(),
    );
    for (let n = 0; n < 8 && peer.quota.calls < 2; n++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      peer = JSON.parse(await (await f.raw(`/fixture/source/${agentId}`)).text());
    }
    assert.equal(
      peer.quota.calls,
      2,
      "one actual CAS resumes the same retained source request once",
    );
    const heldAgain = await held(f, accepted.body.operationId);
    assert.equal(heldAgain.jobs[0]?.due, null);
    assert.equal(value(await f.op(patch, reader.token)).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 750));
    peer = JSON.parse(await (await f.raw(`/fixture/source/${agentId}`)).text());
    assert.equal(
      peer.quota.calls,
      2,
      "duplicate configuration receipts cannot release unknown storage holds",
    );
    assert.equal((await inspect(f)).jobs[0]?.due, null);
    await f.raw(`/fixture/source/${agentId}?mode=normal`);
    const next = value(
      await f.op(
        {
          ...patch,
          body: { requestId: requestId(), expectedVersion: 2, configuration: configuration(3) },
        },
        reader.token,
      ),
    );
    assert.equal(next.status, 200);
    const done = await f.observe(accepted.body.operationId, reader.token);
    assert.equal(done.state, "completed", done.reason ?? "Admin copy did not complete");
    assert.equal((await inspect(f)).holds.length, 0);
    assert.deepEqual((await inspect(f)).jobs[0]?.peerIds, before.jobs[0]?.peerIds);
  } finally {
    await f.close();
  }
});

test("held admin copy expiry releases its active slot without retrying the storage receiver", {
  timeout: 10000,
}, async () => {
  const f = await adminHarness();
  try {
    const agentId = await f.source(new Uint8Array([1, 2, 3]));
    const creator = await f.mint(dataScope(agentId, ["backups.create"]));
    await f.raw(`/fixture/source/${agentId}?mode=storage-fetch`);
    const accepted = value(
      await f.op(
        {
          operationId: "createBackup",
          path: {},
          query: {},
          body: {
            requestId: requestId(),
            resources: dataScope(agentId, []),
            maxBytes: 3,
          },
        },
        creator.token,
      ),
    );
    assert.equal(accepted.status, 202);
    await held(f, accepted.body.operationId);
    await f.raw(`/fixture/expire?id=${accepted.body.operationId}&copy=true`);
    let state = await inspect(f);
    for (let n = 0; n < 8 && state.jobs[0]?.state !== "unavailable"; n++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      state = await inspect(f);
    }
    assert.equal(
      state.jobs[0]?.state,
      "unavailable",
      "cleanup wake must retire a held copy when its retained lifetime expires",
    );
    assert.equal(state.holds.length, 0);
    const peer: { quota: { calls: number } } = JSON.parse(
      await (await f.raw(`/fixture/source/${agentId}`)).text(),
    );
    assert.equal(peer.quota.calls, 1, "expiry is cleanup, never an invented receiver retry");
    assert.equal(state.indexes, 0);
  } finally {
    await f.close();
  }
});

test("oversized peer error bytes cannot establish receiver pressure authority", {
  timeout: 10000,
}, async () => {
  const f = await adminHarness();
  try {
    const agentId = await f.source(new Uint8Array([1, 2, 3]));
    const creator = await f.mint(dataScope(agentId, ["exports.create"]));
    await f.raw(`/fixture/source/${agentId}?mode=large-error`);
    const accepted = value(
      await f.op(
        {
          operationId: "createExport",
          path: {},
          query: {},
          body: {
            requestId: requestId(),
            resources: dataScope(agentId, []),
            maxBytes: 3,
          },
        },
        creator.token,
      ),
    );
    assert.equal(accepted.status, 202);
    let state = await inspect(f);
    for (let n = 0; n < 8 && !state.holds.length && state.jobs[0]?.state !== "unavailable"; n++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      state = await inspect(f);
    }
    assert.equal(
      state.holds.length,
      0,
      "oversized admin error must not establish receiver authority or a hold",
    );
    assert.equal(state.jobs[0]?.state, "unavailable");
    assert.equal(state.indexes, 0);
    assert.equal(state.chunks.n, 0);
  } finally {
    await f.close();
  }
});
