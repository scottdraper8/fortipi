import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalJson } from "fortipi-contract";
import { createTestHarness } from "wrangler";
import type * as D from "../../src/boundary/dto.js";
import {
  type RuntimeHostContext,
  runtimeHostContextEnv,
  runtimeHostOwnershipLabel,
  type WorkspaceStorageSample,
} from "../../src/boundary/infrastructure.ts";
import { root, workspaceConfig } from "./harness.ts";
import type { FreshnessHost, WorkspaceObject } from "./sampler-freshness-worker.ts";

async function setup() {
  const config = workspaceConfig();
  config.main =
    process.env.FORTIPI_FRESHNESS_TEST_ENTRY ??
    resolve(root, "apps/worker/test/workspace/sampler-freshness-worker.ts");
  config.compatibility_flags.push("enable_request_signal", "request_signal_passthrough");
  config.durable_objects.bindings.push({ name: "LINUX_CONTAINERS", class_name: "FreshnessHost" });
  const migration = config.migrations[0];
  assert.ok(migration);
  migration.new_sqlite_classes.push("FreshnessHost");
  const server = createTestHarness({ root, workers: [{ config }] });
  const rpc = async <T>(kind: string, input: unknown): Promise<T> => {
    const reply = (await (
      await server.fetch("/rpc", { method: "POST", body: JSON.stringify({ kind, input }) })
    ).json()) as D.Outcome<T>;
    if (!reply.ok) assert.fail(JSON.stringify(reply));
    return reply.value;
  };
  await server.listen();
  try {
    const seeded = (await (await server.fetch("/seed")).json()) as D.Outcome<D.WorkspaceBinding>;
    if (!seeded.ok) assert.fail(JSON.stringify(seeded));
    const capacity = await rpc<D.CapacityReservation>("capacity", {
      operationId: "fresh-capacity",
      ownerId: "workspace",
      policyVersion: 1,
      bytes: 2000000,
      admissionSlots: 0,
    });
    const deadline = Date.now() + 30000;
    await rpc("acquire", {
      ownerKind: "job",
      operationId: "fresh-operation",
      jobId: "fresh-job",
      executionId: "fresh-execution",
      agentId: "agent",
      conversationId: "conversation",
      operationDigest: "b".repeat(64),
      workspaceId: "workspace",
      bindingVersion: 1,
      target: { kind: "executor", executorId: "executor", generation: 1 },
      actions: ["workspace.write"],
      deadline,
      expiresAt: deadline,
    });
    const allocation = await rpc<D.StoreAllocation>("allocate", {
      authorityId: "workspace",
      workspaceId: "workspace",
      role: "scratch",
      jobId: "fresh-job",
      executionId: "fresh-execution",
      baseRevision: seeded.value.revision,
      generation: 1,
      operationDigest: "b".repeat(64),
      capacityReservationId: capacity.reservationId,
      reservedBytes: capacity.bytes,
      deadline,
    });
    const native: Extract<D.BackendConfig, { kind: "linux" }> = {
      kind: "linux",
      backendId: "controlled",
      host: "fixture",
      imageDigest: `sha256:${"a".repeat(64)}`,
      runtime: { cpuMs: 1000, memoryBytes: 268435456, timeoutMs: 10000 },
    };
    const context = (await (
      await server.fetch("/storage-host-register", {
        method: "POST",
        body: JSON.stringify({ allocation, config: native }),
      })
    ).json()) as RuntimeHostContext;
    const env = await server
      .getWorker<{
        LINUX_CONTAINERS: DurableObjectNamespace<FreshnessHost>;
        WORKSPACES: DurableObjectNamespace<WorkspaceObject>;
      }>()
      .getEnv();
    const host = env.LINUX_CONTAINERS.getByName(context.hostId);
    const child = env.WORKSPACES.getByName(allocation.childId);
    const runtime = await (await host.getWorkspaceContainer()).start({
      name: "computerd",
      env: { [runtimeHostContextEnv]: JSON.stringify(context) },
      labels: {
        [runtimeHostOwnershipLabel]: createHash("sha256")
          .update(canonicalJson(context))
          .digest("hex"),
      },
      enableInternet: false,
    });
    assert.equal(
      (
        await server.fetch("/storage-host-ack", {
          method: "POST",
          body: JSON.stringify({ allocation, config: native, runtimeId: runtime.runtimeId }),
        })
      ).status,
      200,
    );
    const sample = (sampleId: string) =>
      server.fetch("/storage-sample", {
        method: "POST",
        body: JSON.stringify({ kind: "authority", sampleId, policyVersion: 1 }),
      });
    const facts = () =>
      server.fetch("/storage-facts").then(
        async (r) =>
          (await r.json()) as {
            bytes: number;
            charge: { observed: number; unspent: number };
            census: {
              version: number;
              bytes: number;
              observedAt: number;
              children: Record<string, number>;
              hosts: Record<string, number>;
            };
            report: { observedAt: number; coverage: { bytes: number } };
          },
      );
    return { server, host, child, sample, facts, allocation, context };
  } catch (error) {
    await server.close();
    throw error;
  }
}

for (const kind of ["host", "child"] as const)
  for (const completed of [true, false]) {
    test(`lost ${kind} reply cannot erase a newer ${completed ? "completed" : "partial"} physical observation`, {
      timeout: 30000,
    }, async () => {
      const s = await setup();
      try {
        const peer = s[kind];
        assert.equal((await s.sample("baseline")).status, 200);
        await peer.armReply();
        const pending = s.sample("lost");
        for (let i = 0; i < 500 && !(await peer.replyWaiting()); i++) await delay(5);
        assert.equal(await peer.replyWaiting(), true);
        const old = await peer.heldSample();
        assert.ok(old);
        await peer.releaseReply(true);
        assert.notEqual((await pending).status, 200);
        await peer.growMetadata();
        const db = await s.server
          .getWorker()
          .getDurableObjectStorage("WORKSPACES", { name: "workspace" });
        if (!completed)
          await db.exec(
            "CREATE TRIGGER sample_census_failure BEFORE UPDATE ON fp_ws_record WHEN NEW.key='storage-census' BEGIN SELECT RAISE(FAIL,'SQLITE_FULL'); END",
          );
        const newerReply = await s.sample("newer");
        if (completed) assert.equal(newerReply.status, 200);
        else assert.notEqual(newerReply.status, 200);
        if (!completed) await db.exec("DROP TRIGGER sample_census_failure");
        const newer = await s.facts();
        const retry = await s.sample("lost");
        const after = await s.facts();
        console.log(
          JSON.stringify({
            kind,
            oldLeafBytes: old.bytes,
            oldLeafTime: old.observedAt,
            newerM: newer.census.bytes,
            retryStatus: retry.status,
            retryM: after.census.bytes,
            newerCharge: newer.charge.observed,
            retryCharge: after.charge.observed,
            newerTime: newer.report.observedAt,
            retryTime: after.report.observedAt,
          }),
        );
        assert.notEqual(
          retry.status,
          200,
          "Old incomplete intent promoted an older leaf over newer known physical bytes",
        );
        assert.equal(after.census.version, newer.census.version);
        assert.ok(
          after.charge.observed - after.bytes >= newer.charge.observed - newer.bytes,
          "Old cached leaf erased a known physical overrun",
        );
      } finally {
        await s.server.close();
      }
    });
  }

test("aged incomplete Host/child samples stay old while a known complete authority receipt stays immutable", {
  timeout: 30000,
}, async () => {
  const s = await setup();
  try {
    const controlDb = await s.server
      .getWorker()
      .getDurableObjectStorage("CONTROL_PLANE", { name: "control" });
    const controlCalls = async () => {
      const rows = (await controlDb.exec(
        "SELECT count(*) AS total FROM fp_sampler_report_calls",
      )) as { total: number }[];
      return rows[0]?.total ?? 0;
    };
    const beforeCalls = await controlCalls();
    const known = (await (await s.sample("known-complete")).json()) as WorkspaceStorageSample;
    await s.host.armReply();
    const quick = s.sample("quick-loss");
    for (let i = 0; i < 500 && !(await s.host.replyWaiting()); i++) await delay(5);
    assert.equal(await s.host.replyWaiting(), true);
    const quickLeaf = await s.host.heldSample();
    assert.ok(quickLeaf);
    await s.host.releaseReply(true);
    assert.notEqual((await quick).status, 200);
    const recovered = await s.sample("quick-loss");
    assert.equal(recovered.status, 200);
    const recoveredBody = await recovered.json();
    const recoveredFacts = await s.facts();
    assert.ok(
      recoveredFacts.report.observedAt <= quickLeaf.observedAt,
      "Cached leaf time was refreshed during a valid incomplete retry",
    );
    assert.equal(recoveredFacts.census.observedAt, recoveredFacts.report.observedAt);
    await s.host.growMetadata();
    assert.deepEqual(await (await s.sample("quick-loss")).json(), recoveredBody);
    assert.equal((await s.facts()).census.version, recoveredFacts.census.version);
    await s.host.armReply();
    const pending = s.sample("aged-lost");
    for (let i = 0; i < 500 && !(await s.host.replyWaiting()); i++) await delay(5);
    assert.equal(await s.host.replyWaiting(), true);
    const leaf = await s.host.heldSample();
    assert.ok(leaf);
    await s.host.releaseReply(true);
    assert.notEqual((await pending).status, 200);
    await s.host.growMetadata();
    await s.child.growMetadata();
    await delay(Math.max(0, leaf.observedAt + 10050 - Date.now()));
    await s.server.fetch("/storage-report-send");
    assert.equal(
      await controlCalls(),
      beforeCalls,
      "Sender submitted a >10s-old unknown report to CP",
    );
    const retry = await s.sample("aged-lost");
    console.log(
      JSON.stringify({
        ageMs: Date.now() - leaf.observedAt,
        retryStatus: retry.status,
        leafTime: leaf.observedAt,
        reportTime: (await s.facts()).report.observedAt,
      }),
    );
    assert.notEqual(
      retry.status,
      200,
      "Old cached leaf was relabeled as a fresh aggregate observation",
    );
    assert.equal((await s.sample("fresh-id")).status, 200);
    const current = await s.facts();
    await s.server.fetch("/storage-report-send");
    assert.equal(
      await controlCalls(),
      beforeCalls + 1,
      "Fresh genuine report did not reach CP transport",
    );
    assert.deepEqual(await (await s.sample("known-complete")).json(), known);
    assert.equal((await s.facts()).census.version, current.census.version);
  } finally {
    await s.server.close();
  }
});
