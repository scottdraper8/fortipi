import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type * as D from "../../src/boundary/dto.js";
import { harness } from "./harness.ts";
import { workspaceTarget } from "./target.ts";

test("lease acknowledgments are observational retries before version and clock checks, with current floors", {
  timeout: 15_000,
}, async () => {
  const server = harness();
  const request = async <T>(body: unknown, requestId: string): Promise<D.Outcome<T>> =>
    (await (
      await server.fetch("/rpc", {
        method: "POST",
        headers: { "x-test-request-id": `${requestId}-${crypto.randomUUID()}` },
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
      executionId: "lease-execution",
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
      requestId: "renew-one",
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
    const release: D.LeaseRelease = {
      requestId: "release-one",
      lease: renewed,
      reason: "completed",
    };
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

test("non-job lease binds its actual base/digest and logical Computer holder without executor-floor aliasing", async () => {
  const server = harness();
  const request = async <T>(input: unknown): Promise<D.Outcome<T>> =>
    (await (
      await server.fetch("/rpc", { method: "POST", body: JSON.stringify(input) })
    ).json()) as D.Outcome<T>;
  try {
    await server.listen();
    const seeded = (await (await server.fetch("/seed")).json()) as D.Outcome<D.WorkspaceBinding>;
    if (!seeded.ok) assert.fail(JSON.stringify(seeded));
    const stale = await request({
      kind: "acquire",
      input: await workspaceTarget("stale-base", "missing-revision"),
    });
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.details?.reason, "expected_revision");
    const wrongTarget = await workspaceTarget("wrong-holder", seeded.value.revision, {
      target: { kind: "backend", backendId: "execution-backend", generation: 1 },
    });
    assert.equal((await request({ kind: "acquire", input: wrongTarget })).ok, false);
    const wrongDigest = await workspaceTarget("wrong-digest", seeded.value.revision);
    assert.equal(
      (
        await request({
          kind: "acquire",
          input: { ...wrongDigest, operationDigest: "0".repeat(64) },
        })
      ).ok,
      false,
    );
    assert.equal(
      (
        await request({
          kind: "invalidate",
          input: {
            revocationId: "same-string-executor",
            subject: { kind: "executor", executorId: "workspace", minimumGeneration: 100 },
          },
        })
      ).ok,
      true,
    );
    const target = await workspaceTarget("logical-storage", seeded.value.revision);
    const acquired = await request<D.Lease>({ kind: "acquire", input: target });
    if (!acquired.ok) assert.fail(JSON.stringify(acquired));
    assert.equal(acquired.value.fence, "1", "Rejected acquisition consumed a fence");
    assert.equal(acquired.value.executorId, "workspace");
    assert.equal(acquired.value.executorGeneration, seeded.value.bindingVersion);
    const renewed = await request<D.Lease>({
      kind: "renew",
      input: {
        requestId: "logical-renew",
        lease: acquired.value,
        expectedLeaseVersion: 1,
        expiresAt: Date.now() + 5000,
      },
    });
    if (!renewed.ok) assert.fail(JSON.stringify(renewed));
    assert.equal(
      renewed.value.leaseVersion,
      2,
      "An unrelated executor floor revoked storage authority",
    );
  } finally {
    await server.close();
  }
});
