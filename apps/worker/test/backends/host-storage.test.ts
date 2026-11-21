import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { test } from "node:test";
import { canonicalJson } from "fortipi-contract";
import { createTestHarness } from "wrangler";
import {
  type RuntimeHostStorageSample,
  type RuntimeHostStorageSampleInput,
  runtimeHostContextEnv,
  runtimeHostOwnershipLabel,
} from "../../src/boundary/infrastructure.ts";

function hostOwnershipDigest(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

import { root } from "../workspace/harness.ts";
import { fixtureHost } from "./host-fixture.ts";
import type { HostProbe } from "./host-rpc-worker.ts";

function harness() {
  const common = {
    main:
      process.env.FORTIPI_HOST_STORAGE_TEST_ENTRY ??
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
          name: "host-storage",
          services: [{ binding: "PORT", service: "host-storage-port" }],
          durable_objects: { bindings: [{ name: "HOST", class_name: "HostProbe" }] },
          migrations: [{ tag: "v1", new_sqlite_classes: ["HostProbe"] }],
        },
      },
      { config: { ...common, name: "host-storage-port" } },
    ],
  });
}
function sample(host: DurableObjectStub<HostProbe>, input: RuntimeHostStorageSampleInput) {
  return host.fetch(
    new Request("https://host.internal/__fortipi/storage-sample", {
      method: "POST",
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(10_000),
    }),
  );
}

test("Host context blocks wrong tuple/image/adoption before effect and strips the private assertion", {
  timeout: 30_000,
}, async () => {
  const server = harness();
  try {
    await server.listen();
    const env = await server.getWorker<{ HOST: DurableObjectNamespace<HostProbe> }>().getEnv();
    const host = await fixtureHost(env.HOST, "context");
    const spec = await host.launchSpec();
    const context = await host.fixtureContext();
    for (const wrong of [
      { ...spec, env: { [runtimeHostContextEnv]: "x".repeat(4097) } },
      { ...spec, env: { [runtimeHostContextEnv]: JSON.stringify({ ...context, unknown: true }) } },
      { ...spec, labels: { [runtimeHostOwnershipLabel]: "0".repeat(64) } },
      ...[
        { ...context, hostId: `fortipi:linux:other:${"f".repeat(64)}` },
        { ...context, imageDigest: `sha256:${"b".repeat(64)}` },
      ].map((value) => ({
        ...spec,
        env: { [runtimeHostContextEnv]: JSON.stringify(value) },
        labels: { [runtimeHostOwnershipLabel]: hostOwnershipDigest(value) },
      })),
    ])
      assert.equal(await host.launchAllowed(wrong), false);
    assert.equal(
      (await host.lifecycleStats()).startCalls,
      0,
      "Invalid tuple reached original SDK start",
    );
    const runtime = await (await host.getWorkspaceContainer()).start(spec);
    assert.equal((await host.lifecycleStats()).privateEnvLeaked, false);
    const changed = { ...context, ownershipNonce: "0".repeat(64) };
    assert.equal(
      await host.launchAllowed({
        ...spec,
        env: { [runtimeHostContextEnv]: JSON.stringify(changed) },
        labels: { [runtimeHostOwnershipLabel]: hostOwnershipDigest(changed) },
      }),
      false,
    );
    assert.equal(
      JSON.stringify(await host.launchSpec()),
      JSON.stringify(spec),
      "Host mutated caller's private assertion",
    );
    assert.equal(
      (await (await host.getWorkspaceContainer()).start(spec)).runtimeId,
      runtime.runtimeId,
    );
    assert.equal((await host.lifecycleStats()).starts, 1);
    for (const fault of ["replaced-label", "empty-image"]) {
      await host.setFault(fault);
      const before = (await host.lifecycleStats()).startCalls;
      assert.equal(await host.launchAllowed(spec), false);
      assert.equal(
        (await host.lifecycleStats()).startCalls,
        before,
        "Ambiguous adoption delegated before inspection",
      );
    }
  } finally {
    await server.close();
  }
});

test("Host physical samples retain exact retry/time, actual SQL growth and stopped tombstones across eviction", {
  timeout: 30_000,
}, async () => {
  const server = harness();
  try {
    await server.listen();
    const env = await server.getWorker<{ HOST: DurableObjectNamespace<HostProbe> }>().getEnv();
    let host = await fixtureHost(env.HOST, "sample");
    const context = await host.fixtureContext();
    const unknown: RuntimeHostStorageSampleInput = {
      sampleId: "unknown",
      policyVersion: 1,
      context,
      runtimeId: "not-acknowledged",
      registryVersion: 1,
    };
    assert.notEqual((await sample(host, unknown)).status, 200);
    assert.equal(
      (await host.lifecycleStats()).startCalls,
      0,
      "Sampling unknown Host started native execution",
    );
    const runtime = await (await host.getWorkspaceContainer()).start(await host.launchSpec());
    const input = {
      ...unknown,
      sampleId: "physical",
      runtimeId: runtime.runtimeId,
      registryVersion: 2,
    };
    const before = await host.physicalBytes();
    const first = (await (await sample(host, input)).json()) as RuntimeHostStorageSample;
    assert.equal(first.bytes, before, "Sample is not actual own public SQL size");
    await host.growMetadata();
    assert.deepEqual(await (await sample(host, input)).json(), first);
    assert.equal((await sample(host, { ...input, registryVersion: 3 })).status, 409);
    assert.notEqual(
      (await sample(host, { ...input, context: { ...context, ownershipNonce: "0".repeat(64) } }))
        .status,
      200,
    );
    const grown = (await (
      await sample(host, { ...input, sampleId: "growth" })
    ).json()) as RuntimeHostStorageSample;
    assert.ok(grown.bytes >= first.bytes + 262144, "Host's physical metadata growth was omitted");
    assert.equal(
      (
        await host.fetch(
          new Request("https://host.internal/__fortipi/runtime-quiesce", {
            method: "POST",
            body: JSON.stringify({
              requestId: "stop-sampled",
              runtimeId: runtime.runtimeId,
              imageDigest: context.imageDigest,
            }),
          }),
        )
      ).status,
      200,
    );
    await host.evict().catch(() => {});
    host = await fixtureHost(env.HOST, "sample");
    assert.deepEqual(await (await sample(host, input)).json(), first);
    assert.ok(
      (
        (await (
          await sample(host, { ...input, sampleId: "stopped" })
        ).json()) as RuntimeHostStorageSample
      ).bytes >= grown.bytes,
    );
    assert.equal((await host.lifecycleStats()).starts, 1);
    assert.equal((await host.lifecycleStats()).destroys, 1);
    assert.equal(await host.reacquisitionAllowed(), false);
  } finally {
    await server.close();
  }
});
