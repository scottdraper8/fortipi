import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { assignmentDigest, canonicalJson, operationDigest, wireLimits } from "fortipi-contract";
import { createTestHarness } from "wrangler";
import type * as D from "../../src/boundary/dto.js";
import {
  type RuntimeHostContext,
  runtimeHostContextEnv,
  runtimeHostOwnershipLabel,
  type WorkspaceStorageSample,
} from "../../src/boundary/infrastructure.ts";
import type { HostProbe } from "../backends/host-rpc-worker.ts";
import { root, workspaceConfig } from "./harness.ts";

function value<T>(reply: D.Outcome<T>): T {
  if (!reply.ok) assert.fail(JSON.stringify(reply));
  return reply.value;
}

function hostBytes(hosts: Record<string, number>, hostId: string) {
  const bytes = hosts[hostId];
  assert.ok(bytes !== undefined, "Physical Host was omitted from complete census");
  return bytes;
}

test("Workspace census counts Host SQL separately, holds pending without contact and retains stopped Host after actual child GC", {
  timeout: 90_000,
}, async () => {
  const config = workspaceConfig();
  config.compatibility_flags.push("enable_request_signal", "request_signal_passthrough");
  config.durable_objects.bindings.push({ name: "LINUX_CONTAINERS", class_name: "HostProbe" });
  const migration = config.migrations[0];
  assert.ok(migration);
  migration.new_sqlite_classes.push("HostProbe");
  const server = createTestHarness({ root, workers: [{ config }] });
  const native: Extract<D.BackendConfig, { kind: "linux" }> = {
    kind: "linux",
    backendId: "controlled",
    host: "fixture",
    imageDigest: `sha256:${"a".repeat(64)}`,
    runtime: { cpuMs: 1000, memoryBytes: 268435456, timeoutMs: 10000 },
  };
  const rpc = async <T>(kind: string, input: unknown): Promise<T> =>
    value(
      (await (
        await server.fetch("/rpc", { method: "POST", body: JSON.stringify({ kind, input }) })
      ).json()) as D.Outcome<T>,
    );
  const sample = (sampleId: string, headers = {}) =>
    server.fetch("/storage-sample", {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "authority", sampleId, policyVersion: 1 }),
    });
  const facts = async () =>
    (await (await server.fetch("/storage-facts")).json()) as {
      bytes: number;
      charge: { observed: number; unspent: number };
      census: {
        version: number;
        bytes: number;
        children: Record<string, number>;
        hosts: Record<string, number>;
      };
      report: { coverage: { bytes: number } };
    };
  try {
    await server.listen();
    const binding = value(
      (await (await server.fetch("/seed")).json()) as D.Outcome<D.WorkspaceBinding>,
    );
    const capacity = await rpc<D.CapacityReservation>("capacity", {
      operationId: "host-capacity",
      ownerId: "workspace",
      policyVersion: 1,
      bytes: 2_000_000,
      admissionSlots: 0,
    });
    const lease = await rpc<D.Lease>("acquire", {
      ownerKind: "job",
      operationId: "host-operation",
      jobId: "host-job",
      executionId: "host-execution",
      agentId: "agent",
      conversationId: "conversation",
      operationDigest: "b".repeat(64),
      workspaceId: "workspace",
      bindingVersion: 1,
      target: { kind: "executor", executorId: "executor", generation: 1 },
      actions: ["workspace.write"],
      deadline: Date.now() + 30_000,
      expiresAt: Date.now() + 30_000,
    });
    const allocation = await rpc<D.StoreAllocation>("allocate", {
      authorityId: "workspace",
      workspaceId: "workspace",
      role: "scratch",
      jobId: "host-job",
      executionId: "host-execution",
      baseRevision: binding.revision,
      generation: 1,
      operationDigest: "b".repeat(64),
      capacityReservationId: capacity.reservationId,
      reservedBytes: capacity.bytes,
      deadline: Date.now() + 5000,
    });
    const register = () =>
      server.fetch("/storage-host-register", {
        method: "POST",
        body: JSON.stringify({ allocation, config: native }),
      });
    const context = (await (await register()).json()) as RuntimeHostContext;
    assert.match(context.ownershipNonce, /^[a-f0-9]{64}$/);
    assert.deepEqual(
      await (await register()).json(),
      context,
      "Known intent refreshed the authority nonce",
    );
    const env = await server
      .getWorker<{
        LINUX_CONTAINERS: DurableObjectNamespace<HostProbe>;
        WORKSPACES: DurableObjectNamespace;
      }>()
      .getEnv();
    assert.equal(
      context.hostId,
      `fortipi:linux:fixture:${env.WORKSPACES.idFromName(allocation.childId).toString()}`,
    );
    const hostStore = await server
      .getWorker()
      .getDurableObjectStorage("LINUX_CONTAINERS", { name: context.hostId });
    assert.notEqual((await sample("pending-host")).status, 200);
    assert.deepEqual(
      await hostStore.exec("SELECT name FROM sqlite_master WHERE name='controlled_host_requests'"),
      [],
      "Census contacted unacknowledged Host",
    );
    const host = env.LINUX_CONTAINERS.getByName(context.hostId);
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
    const measured = await sample("all-physical");
    assert.equal(measured.status, 200, await measured.clone().text());
    const own = (await measured.json()) as WorkspaceStorageSample;
    const first = await facts();
    assert.equal(Object.keys(first.census.hosts).length, 1);
    assert.equal(
      first.census.bytes,
      own.bytes +
        Object.values(first.census.children).reduce((a, b) => a + b, 0) +
        hostBytes(first.census.hosts, context.hostId),
    );
    assert.equal(first.report.coverage.bytes, first.census.bytes);
    assert.equal(
      first.charge.unspent,
      capacity.bytes + 3 * wireLimits.jsonBytes,
      "Active or Host prospective growth was released",
    );
    await host.growMetadata();
    assert.equal((await sample("host-growth")).status, 200);
    const grown = await facts();
    assert.ok(
      hostBytes(grown.census.hosts, context.hostId) >=
        hostBytes(first.census.hosts, context.hostId) + 262144,
    );
    assert.equal(
      grown.charge.observed,
      grown.bytes +
        Object.values(grown.census.children).reduce((a, b) => a + b, 0) +
        hostBytes(grown.census.hosts, context.hostId),
    );
    assert.notEqual((await sample("stale-context", { "x-test-unregistered": "1" })).status, 200);
    assert.equal(
      (
        await host.fetch(
          new Request("https://host.internal/__fortipi/runtime-quiesce", {
            method: "POST",
            body: JSON.stringify({
              requestId: "host-stop",
              runtimeId: runtime.runtimeId,
              imageDigest: context.imageDigest,
            }),
          }),
        )
      ).status,
      200,
    );
    // This is an unused Computer scratch, not fabricated native execution completion.
    await rpc("release", { requestId: "host-release", lease });
    await delay(Math.max(0, allocation.deadline + 60_000 - Date.now()) + 20);
    const retirement = await rpc<D.StoreRetirement>("retire", {
      allocationId: allocation.allocationId,
      childId: allocation.childId,
      authorityId: allocation.authorityId,
      workspaceId: allocation.workspaceId,
    });
    await rpc("delete", retirement);
    assert.equal((await sample("after-child-delete")).status, 200);
    const retained = await facts();
    assert.equal(Object.keys(retained.census.children).length, 0);
    assert.ok(
      hostBytes(retained.census.hosts, context.hostId) >=
        hostBytes(grown.census.hosts, context.hostId),
    );
    assert.equal((await host.lifecycleStats()).starts, 1);
    assert.equal((await host.lifecycleStats()).destroys, 1);
    assert.equal(await host.reacquisitionAllowed(), false);
    await host.setFault("sample-block");
    const waiting = sample("revoke-after-host-await");
    for (let i = 0; i < 200 && !(await host.sampleWaiting()); i++) await delay(5);
    assert.equal(await host.sampleWaiting(), true);
    await server.fetch("/storage-revoke");
    await host.releaseSample();
    assert.notEqual((await waiting).status, 200, "Host sample promoted stale context after await");
    assert.equal((await facts()).census.version, retained.census.version);
  } finally {
    await server.close();
  }
});

test("actual native preparation binds the Host before contact and current write-only SDK acknowledgment cannot change its job or runtime", {
  timeout: 30_000,
}, async () => {
  const base = workspaceConfig(true);
  const native: Extract<D.BackendConfig, { kind: "linux" }> = {
    kind: "linux",
    backendId: "backend",
    host: "fixture",
    imageDigest: `sha256:${"a".repeat(64)}`,
    runtime: { cpuMs: 1000, memoryBytes: 268435456, timeoutMs: 10000 },
  };
  base.durable_objects.bindings.push({ name: "LINUX_CONTAINERS", class_name: "HostProbe" });
  const migration = base.migrations[0];
  assert.ok(migration);
  migration.new_sqlite_classes.push("HostProbe");
  const config = {
    ...base,
    vars: {
      FORTIPI_CONFIG: {
        version: 1,
        workspace: { kind: "computer" },
        execution: native,
        routing: { kind: "cloud", targetIds: ["backend"] },
        models: [],
        infrastructure: {
          ...base.vars.FORTIPI_CONFIG.infrastructure,
          accountPlan: "paid",
          capabilities: [
            {
              capability: "containers",
              state: "available",
              accountPlan: "paid",
              deploymentId: "test-deployment",
              observedAt: Date.now(),
            },
          ],
        },
      },
    },
  };
  const server = createTestHarness({ root, workers: [{ config }] });
  const headers = { "x-test-write-only": "1" };
  const rpc = async <T>(kind: string, input: unknown): Promise<T> =>
    value(
      (await (
        await server.fetch("/rpc", {
          method: "POST",
          headers,
          body: JSON.stringify({ kind, input }),
        })
      ).json()) as D.Outcome<T>,
    );
  try {
    await server.listen();
    const binding = value(
      (await (await server.fetch("/seed")).json()) as D.Outcome<D.WorkspaceBinding>,
    );
    const deadline = Date.now() + 20000;
    const operation: D.OperationDigestInput = {
      deploymentId: "test-deployment",
      agentId: "agent",
      conversationId: "conversation",
      policyVersion: 1,
      workspaceId: "workspace",
      baseRevision: binding.revision,
      tool: "shell",
      arguments: { source: "printf metadata-only-probe" },
      target: { kind: "backend", backendId: "backend", generation: 1 },
      grantVersion: 1,
      deadline,
    };
    const target: D.TargetRequest = {
      ownerKind: "job",
      operationId: "ack-operation",
      operationDigest: await operationDigest(operation),
      workspaceId: "workspace",
      bindingVersion: 1,
      target: operation.target,
      actions: ["workspace.write"],
      jobId: "ack-job",
      executionId: "ack-execution",
      agentId: "agent",
      conversationId: "conversation",
      deadline,
      expiresAt: deadline,
    };
    const reservation = await rpc<D.TargetReservation>("reservation", target);
    assert.ok(reservation.ownerKind === "job");
    const lease = await rpc<D.Lease>("acquire", target);
    const identity: D.ExecutionIdentity = {
      jobId: "ack-job",
      executionId: "ack-execution",
      operationDigest: target.operationDigest,
      assignmentDigest: await assignmentDigest({
        operation,
        executionId: "ack-execution",
        reservationId: reservation.reservationId,
        leaseId: lease.leaseId,
        fence: lease.fence,
        executorGeneration: lease.executorGeneration,
      }),
      target: operation.target,
      lease,
      baseRevision: binding.revision,
      deadline,
    };
    const request: D.ExecutionRequest = {
      reservation,
      operationContext: {
        deploymentId: "test-deployment",
        agentId: "agent",
        conversationId: "conversation",
        policyVersion: 1,
      },
      identity,
      tool: operation.tool,
      arguments: operation.arguments,
      workspaceId: "workspace",
      bindingVersion: 1,
      capabilities: ["shell", "workspace.write"],
    };
    await rpc("prepare-execution", request);
    const db = await server
      .getWorker()
      .getDurableObjectStorage("WORKSPACES", { name: "workspace" });
    const rows = (await db.exec(
      "SELECT value FROM fp_ws_record WHERE key='execution:ack-execution'",
    )) as { value: string }[];
    assert.ok(rows[0]);
    const retained = JSON.parse(rows[0].value) as {
      allocation: D.StoreAllocation;
      nativeContext: RuntimeHostContext;
      observationKey: string;
      state: string;
    };
    const member = async () =>
      (await db.exec(
        "SELECT value FROM fp_ws_record WHERE key=?",
        `runtime-host:${retained.allocation.allocationId}`,
      )) as { value: string }[];
    assert.equal(JSON.parse((await member())[0]?.value ?? "null").version, 1);
    const env = await server
      .getWorker<{ LINUX_CONTAINERS: DurableObjectNamespace<HostProbe> }>()
      .getEnv();
    const host = env.LINUX_CONTAINERS.getByName(retained.nativeContext.hostId);
    const runtime = await (await host.getWorkspaceContainer()).start({
      name: "computerd",
      env: { [runtimeHostContextEnv]: JSON.stringify(retained.nativeContext) },
      labels: {
        [runtimeHostOwnershipLabel]: createHash("sha256")
          .update(canonicalJson(retained.nativeContext))
          .digest("hex"),
      },
      enableInternet: false,
    });
    // Only the application-owned durable attempt milestone is seeded. No tool ran and
    // this cannot stand in for native execution, terminal sync or quiescence proof.
    await db.exec(
      "UPDATE fp_ws_record SET value=? WHERE key='execution:ack-execution'",
      JSON.stringify({ ...retained, state: "attempted" }),
    );
    const observation = { identity, proof: retained.observationKey, runtimeId: runtime.runtimeId };
    const ack = (body = observation, extra = {}) =>
      server.fetch("/storage-native-ack", {
        method: "POST",
        headers: { ...headers, ...extra },
        body: JSON.stringify({ allocation: retained.allocation, observation: body }),
      });
    for (const extra of [
      { "x-test-unregistered": "1" },
      { "x-test-expired": "1" },
      { "x-test-no-grants": "1" },
      { "x-test-other-target": "1" },
    ])
      assert.notEqual((await ack(observation, extra)).status, 204);
    assert.notEqual(
      (await ack({ ...observation, identity: { ...identity, jobId: "wrong-job" } })).status,
      204,
    );
    assert.notEqual(
      (await ack({ ...observation, identity: { ...identity, baseRevision: "wrong-base" } })).status,
      204,
    );
    assert.notEqual((await ack({ ...observation, proof: "forged" })).status, 204);
    assert.equal((await ack()).status, 204);
    const accepted = (await member())[0]?.value;
    assert.ok(accepted);
    assert.equal(JSON.parse(accepted).runtimeId, runtime.runtimeId);
    assert.equal(JSON.parse(accepted).version, 2);
    assert.equal((await ack()).status, 204);
    assert.equal(
      (await member())[0]?.value,
      accepted,
      "Exact SDK acknowledgment refreshed member version",
    );
    assert.notEqual((await ack({ ...observation, runtimeId: "different-runtime" })).status, 204);
    await server.fetch("/storage-revoke");
    assert.notEqual((await ack()).status, 204);
    assert.equal((await member())[0]?.value, accepted);
  } finally {
    await server.close();
  }
});
