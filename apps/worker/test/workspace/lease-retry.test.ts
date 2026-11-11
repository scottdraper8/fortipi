import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type * as D from "../../src/boundary/dto.js";
import { harness } from "./harness.ts";

test("lease acknowledgments are observational retries before version and clock checks, with current floors", {
  timeout: 15_000,
}, async () => {
  const server = harness();
  const request = async <T>(body: unknown, requestId: string): Promise<D.Outcome<T>> =>
    (await (
      await server.fetch("/rpc", {
        method: "POST",
        headers: { "x-test-request-id": requestId },
        body: JSON.stringify(body),
      })
    ).json()) as D.Outcome<T>;
  const call = async <T>(body: unknown, id: string): Promise<T> => {
    const result = await request<T>(body, id);
    if (!result.ok) assert.fail(JSON.stringify(result));
    return result.value;
  };
  try {
    await server.listen();
    const denied = (await (
      await server.fetch("/seed", { headers: { "x-test-no-grants": "1" } })
    ).json()) as D.Outcome<D.WorkspaceBinding>;
    assert.equal(denied.ok, false);
    const initialized = (await (
      await server.fetch("/seed", { headers: { "x-test-bootstrap": "1" } })
    ).json()) as D.Outcome<D.WorkspaceBinding>;
    assert.equal(
      initialized.ok,
      true,
      "CP bootstrap wildcard grants could not initialize authority",
    );
    const target: D.TargetRequest = {
      ownerKind: "job",
      jobId: "lease-job",
      agentId: "agent",
      conversationId: "conversation",
      operationId: "lease-operation",
      operationDigest: "a".repeat(64),
      workspaceId: "workspace",
      bindingVersion: 1,
      target: { kind: "executor", executorId: "executor", generation: 1 },
      actions: ["workspace.write"],
      deadline: Date.now() + 5000,
      expiresAt: Date.now() + 1000,
    };
    const lease = await call<D.Lease>({ kind: "acquire", input: target }, "acquire");
    const renewal: D.LeaseRenewal = {
      lease,
      expectedLeaseVersion: lease.leaseVersion,
      expiresAt: Date.now() + 1800,
    };
    const renewed = await call<D.Lease>({ kind: "renew", input: renewal }, "renew-one");
    assert.equal(renewed.leaseVersion, lease.leaseVersion + 1);
    assert.ok(
      renewed.expiresAt > target.expiresAt,
      "Renewal was incorrectly capped by first-acquisition admission expiry",
    );
    assert.deepEqual(await call({ kind: "renew", input: renewal }, "renew-one"), renewed);
    assert.equal(
      (
        await request(
          { kind: "renew", input: { ...renewal, expiresAt: renewal.expiresAt + 1 } },
          "renew-one",
        )
      ).ok,
      false,
      "Changed retry silently extended authority",
    );
    await delay(renewed.expiresAt - Date.now() + 20);
    assert.deepEqual(
      await call({ kind: "renew", input: renewal }, "renew-one"),
      renewed,
      "Lost renewal acknowledgment changed after expiry",
    );
    const release: D.LeaseRelease = { lease: renewed, reason: "completed" };
    const released = await call<D.ReleaseReceipt>({ kind: "release", input: release }, "release");
    assert.deepEqual(await call({ kind: "release", input: release }, "release"), released);
    assert.equal(
      (await request({ kind: "renew", input: renewal }, "renew-one")).ok,
      false,
      "A stored renewal acknowledgment revived a released lease",
    );
    assert.equal(
      (await request({ kind: "release", input: { ...release, reason: "cancelled" } }, "release"))
        .ok,
      false,
    );
    assert.deepEqual(
      await call({ kind: "acquire", input: target }, "acquire"),
      lease,
      "Lost acquire acknowledgment allocated a new fence after release",
    );
    await call(
      {
        kind: "invalidate",
        input: {
          revocationId: "lease-revocation",
          subject: { kind: "executor", executorId: "executor", minimumGeneration: 2 },
        },
      },
      "invalidate",
    );
    assert.equal(
      (await request({ kind: "renew", input: renewal }, "renew-one")).ok,
      false,
      "Receipt bypassed executor floor",
    );
    assert.equal(
      (await request({ kind: "acquire", input: target }, "acquire")).ok,
      false,
      "Old reservation bypassed executor floor",
    );
  } finally {
    await server.close();
  }
});
