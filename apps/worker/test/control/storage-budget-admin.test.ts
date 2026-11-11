import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { adminClient, adminConfig, dataScope, requestId, value } from "./admin-harness.ts";
import { bootstrap } from "./harness.ts";

test("actual physical overrun holds admin export growth without changing retained backup receipts or read-only bytes", {
  timeout: 30000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "fortipi-admin-budget-"));
  const configPath = join(directory, "wrangler.json");
  const configuration = adminConfig(bootstrap);
  configuration.main = resolve(
    process.env.FORTIPI_CONTROL_TEST_SOURCE ?? ".",
    "apps/worker/test/control/fixtures/storage-budget-admin.ts",
  );
  await writeFile(configPath, JSON.stringify(configuration));
  const { createTestHarness } = await import("wrangler");
  const server = createTestHarness({ root: directory, workers: [{ configPath }] });
  try {
    await server.listen();
    const worker = server.getWorker();
    const f = adminClient(
      (path, token = bootstrap, init = {}) =>
        worker.fetch(new URL(path, "http://fixture").toString(), {
          ...init,
          headers: { ...init.headers, Authorization: `Bearer ${token}` },
        }),
      bootstrap,
    );
    const bytes = Uint8Array.from({ length: 65537 }, (_, i) => i % 251);
    const agentId = await f.source(bytes);
    const reader = await f.mint(dataScope(agentId, ["operations.read", "artifacts.read"]));
    const input: D.OperationRequest<"createBackup"> = {
      operationId: "createBackup",
      path: {},
      query: {},
      body: { requestId: requestId(), resources: dataScope(agentId, []), maxBytes: bytes.length },
    };
    const accepted = value(await f.op(input));
    assert.equal(accepted.status, 202);
    const complete = await f.observe(accepted.body.operationId, reader.token);
    assert.equal(complete.state, "completed");
    const reference = complete.artifacts[0];
    assert.ok(reference);
    const url = `/v1/admin/artifacts/${reference.artifactId}`;
    const original = new Uint8Array(await (await f.raw(url, reader.token)).arrayBuffer());
    assert.deepEqual(original, bytes);
    const inspect = async (): Promise<{
      chunks: { n: number };
      holds: { kind: string; key: string }[];
    }> => JSON.parse(await (await f.raw(`/fixture/budget-state/${agentId}`)).text()).control;
    const before = await inspect();
    await f.raw(`/fixture/budget-inflate/${agentId}`);
    await f.raw(`/fixture/source/${agentId}?mode=hold-tail`);
    const copying = value(
      await f.op({ ...input, body: { ...input.body, requestId: requestId() } }),
    );
    assert.equal(copying.status, 202);
    let waiting = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      const { peer }: { peer: { waiting: number } } = JSON.parse(
        await (await f.raw(`/fixture/budget-state/${agentId}`)).text(),
      );
      if (peer.waiting === 1) {
        waiting = true;
        break;
      }
      await new Promise((done) => setTimeout(done, 100));
    }
    assert.ok(waiting, "Actual admitted copy must await peer bytes before the overrun");
    const observed: unknown = JSON.parse(
      await (await f.raw(`/fixture/storage-overrun/${agentId}`)).text(),
    );
    assert.ok(
      observed &&
        typeof observed === "object" &&
        "bytes" in observed &&
        typeof observed.bytes === "number" &&
        observed.bytes > 256 * 1048576,
      "Overrun must come from an actual peer SQLite database",
    );
    await f.raw(`/fixture/source/${agentId}?mode=normal`);
    let paused = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      const state = await inspect();
      if (
        state.holds.some(
          (hold) => hold.kind === "admin_job" && hold.key === copying.body.operationId,
        )
      ) {
        assert.equal(
          state.chunks.n,
          before.chunks.n,
          "An admitted copy must recheck the allocation ledger before writing each new chunk",
        );
        paused = true;
        break;
      }
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.ok(paused, "An overrun must durably hold the already-admitted export copy");
    const denied = await f.op({ ...input, body: { ...input.body, requestId: requestId() } });
    assert.equal(denied.ok, false, "Fresh physical overrun must deny new admin export growth");
    if (!denied.ok) assert.equal(denied.code, "quota_exceeded");
    const retry = value(await f.op(input));
    assert.equal(retry.status, 202);
    assert.equal(retry.body.operationId, complete.operationId);
    assert.deepEqual(
      retry.body,
      complete,
      "An exact retained request must not be re-admitted or rewritten under pressure",
    );
    assert.deepEqual(await f.observe(complete.operationId, reader.token), complete);
    const retained = await f.raw(url, reader.token);
    assert.equal(retained.status, 200);
    assert.deepEqual(
      new Uint8Array(await retained.arrayBuffer()),
      original,
      "Read-only retained export bytes survive quota pressure",
    );
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
