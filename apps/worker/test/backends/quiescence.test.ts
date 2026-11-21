import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createTestHarness } from "wrangler";
import type * as D from "../../src/boundary/dto.js";
import { root } from "../workspace/harness.ts";
import { RecoveryProcess } from "../workspace/recovery-process.ts";
import { fixtureHost } from "./host-fixture.ts";
import type { HostProbe } from "./host-rpc-worker.ts";

const digest = `sha256:${"a".repeat(64)}`;
const image = `registry.invalid/controlled-abi@${digest}`;

test("host stopped receipt survives actual managed Wrangler SIGKILL before successful acknowledgment", {
  timeout: 60_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "fortipi-quiescence-"));
  const runtime = new RecoveryProcess(directory, {
    name: "fortipi-quiescence-recovery",
    main: resolve(root, "apps/worker/test/backends/host-rpc-worker.ts"),
    compatibility_date: "2026-11-10",
    compatibility_flags: ["nodejs_compat", "enable_request_signal", "request_signal_passthrough"],
    services: [{ binding: "PORT", service: "fortipi-quiescence-recovery" }],
    durable_objects: { bindings: [{ name: "HOST", class_name: "HostProbe" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["HostProbe"] }],
  });
  try {
    await runtime.start();
    const response = await fetch(`${runtime.url}/quiescence-recovery/start`, { method: "POST" });
    assert.equal(response.status, 503);
    const { intent } = (await response.json()) as { intent: D.RuntimeQuiesceRequest };
    const before = (await (await fetch(`${runtime.url}/quiescence-recovery/audit`)).json()) as {
      stop: { receipt: D.RuntimeQuiescence };
      stats: { destroys: number; starts: number; stopBeforeDestroy: boolean };
    };
    assert.equal(before.stats.stopBeforeDestroy, true);
    assert.equal(before.stats.destroys, 1);
    await runtime.kill();
    await runtime.start();
    const recovered = await fetch(`${runtime.url}/quiescence-recovery/retry`, {
      method: "POST",
      body: JSON.stringify(intent),
    });
    assert.equal(recovered.status, 200);
    assert.deepEqual(await recovered.json(), before.stop.receipt);
    const after = (await (
      await fetch(`${runtime.url}/quiescence-recovery/audit`)
    ).json()) as typeof before;
    assert.equal(after.stats.starts, 1);
    assert.equal(after.stats.destroys, 1);
  } finally {
    await runtime.kill();
    await rm(directory, { recursive: true, force: true });
  }
});
function harness() {
  const common = {
    main:
      process.env.FORTIPI_QUIESCE_TEST_ENTRY ??
      resolve(root, "apps/worker/test/backends/host-rpc-worker.ts"),
    compatibility_date: "2026-11-10",
    compatibility_flags: ["nodejs_compat", "enable_request_signal", "request_signal_passthrough"],
  };
  return createTestHarness({
    root,
    workers: [
      {
        config: {
          ...common,
          name: "fortipi-quiescence-test",
          services: [{ binding: "PORT", service: "fortipi-quiescence-port" }],
          durable_objects: { bindings: [{ name: "HOST", class_name: "HostProbe" }] },
          migrations: [{ tag: "v1", new_sqlite_classes: ["HostProbe"] }],
        },
      },
      { config: { ...common, name: "fortipi-quiescence-port" } },
    ],
  });
}
function stop(host: DurableObjectStub<HostProbe>, body: D.RuntimeQuiesceRequest) {
  return host.fetch(
    new Request("https://host.internal/__fortipi/runtime-quiesce", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

test("production private host quiescence persists before effect and recovers immutable receipts after loss and eviction", {
  timeout: 30_000,
}, async () => {
  const server = harness();
  try {
    await server.listen();
    const env = await server.getWorker<{ HOST: DurableObjectNamespace<HostProbe> }>().getEnv();
    const bounded = await fixtureHost(env.HOST, "closed-metadata");
    for (const request of [
      new Request("https://host.internal/__fortipi/runtime-quiesce", { method: "GET" }),
      new Request("https://host.internal/__fortipi/runtime-quiesce?unknown=1", {
        method: "POST",
        body: "{}",
      }),
      new Request("https://host.internal/__fortipi/runtime-quiesce", {
        method: "POST",
        body: JSON.stringify({
          requestId: "stop",
          runtimeId: "runtime",
          imageDigest: digest,
          unknown: true,
        }),
      }),
    ])
      assert.equal((await bounded.fetch(request)).status, 400);
    assert.equal(
      (
        await bounded.fetch(
          new Request("https://host.internal/__fortipi/runtime-quiesce", {
            method: "POST",
            body: "x".repeat(65_537),
          }),
        )
      ).status,
      413,
    );
    assert.equal((await bounded.lifecycleStats()).starts, 0);
    assert.equal((await bounded.lifecycleStats()).destroys, 0);
    for (const spec of [
      { name: "another-image", env: {}, enableInternet: false },
      { env: {}, enableInternet: false },
      {
        name: "computerd",
        containerSnapshot: { id: "unrelated-snapshot" },
        env: {},
        enableInternet: false,
      },
    ])
      assert.equal(await bounded.launchAllowed(spec), false);
    assert.equal(
      (await bounded.lifecycleStats()).starts,
      0,
      "Wrong prepared image reached native start before validation",
    );
    for (const fault of ["none", "lost-stop-ack", "lost-destroy-reply"]) {
      let host = await fixtureHost(env.HOST, fault);
      await host.setConfiguration(true, image);
      const api = await host.getWorkspaceContainer();
      const runtime = await api.start(await host.launchSpec());
      const intent: D.RuntimeQuiesceRequest = {
        requestId: "stop-owned",
        runtimeId: runtime.runtimeId,
        imageDigest: digest,
      };
      await host.setFault(fault);
      const first = await stop(host, intent);
      if (fault !== "none") assert.notEqual(first.status, 200);
      const receipt = (await (await stop(host, intent)).json()) as D.RuntimeQuiescence;
      assert.deepEqual({ ...receipt, observedAt: 0 }, { ...intent, stopped: true, observedAt: 0 });
      assert.ok(receipt.observedAt > 0);
      const before = await host.lifecycleStats();
      assert.equal(before.destroys, 1);
      assert.equal(before.stopBeforeDestroy, true, "Native effect preceded durable stop intent");
      assert.equal(before.labelValid, true, "Launch did not carry private ownership metadata");
      assert.equal(before.privateEnvLeaked, false, "Private assertion reached native SDK delegate");
      assert.equal(await host.reacquisitionAllowed(), false);
      assert.equal(await host.writerAllowed(runtime.runtimeId), false);
      await host.setConfiguration(false, "changed-deployment-image");
      assert.deepEqual(
        await (await stop(host, intent)).json(),
        receipt,
        "Retry inferred image/context from a new deployment",
      );
      await host.evict().catch(() => {});
      host = await fixtureHost(env.HOST, fault);
      assert.deepEqual(
        await (await stop(host, intent)).json(),
        receipt,
        "Eviction refreshed stopped observation or reopened runtime",
      );
      assert.equal((await host.lifecycleStats()).starts, 1);
      assert.equal((await host.lifecycleStats()).destroys, 1);
      assert.notEqual((await stop(host, { ...intent, requestId: "changed-intent" })).status, 200);
    }
  } finally {
    await server.close();
  }
});

test("private stop rejects replaced or ambiguous ownership and failed destruction never earns stopped evidence", {
  timeout: 30_000,
}, async () => {
  const server = harness();
  try {
    await server.listen();
    const env = await server.getWorker<{ HOST: DurableObjectNamespace<HostProbe> }>().getEnv();
    for (const fault of [
      "wrong-runtime",
      "wrong-image",
      "known-replacement",
      "replaced-label",
      "empty-image",
      "destroy-fail",
      "not-stopped",
    ]) {
      const host = await fixtureHost(env.HOST, fault);
      await host.setConfiguration(true, image);
      const api = await host.getWorkspaceContainer();
      const runtime = await api.start(await host.launchSpec());
      let intent: D.RuntimeQuiesceRequest = {
        requestId: "stop-owned",
        runtimeId: runtime.runtimeId,
        imageDigest: digest,
      };
      if (fault === "wrong-runtime") intent = { ...intent, runtimeId: "another-runtime" };
      if (fault === "wrong-image") intent = { ...intent, imageDigest: `sha256:${"b".repeat(64)}` };
      if (fault === "known-replacement") await host.markExit();
      if (fault === "known-replacement")
        await (await host.getWorkspaceContainer()).start(await host.launchSpec());
      await host.setFault(fault);
      assert.notEqual((await stop(host, intent)).status, 200, `Unsafe stopped evidence: ${fault}`);
      const failed = await host.lifecycleStats();
      assert.equal(failed.receipt, false);
      const effect = fault === "destroy-fail" || fault === "not-stopped";
      assert.equal(failed.destroys, effect ? 1 : 0, `Wrong allocation was destroyed: ${fault}`);
      assert.equal(failed.stopping, effect);
      if (effect) {
        assert.equal(await host.reacquisitionAllowed(), false);
        await host.setFault("none");
        assert.equal((await stop(host, intent)).status, 200);
        assert.equal((await host.lifecycleStats()).destroys, 2);
      }
    }
  } finally {
    await server.close();
  }
});
