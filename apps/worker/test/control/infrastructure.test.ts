import assert from "node:assert/strict";
import test from "node:test";
import type { ControlPlaneRpc } from "../../src/boundary/control-plane.js";
import { harness, request, scope, uuid, value } from "./harness.ts";

test("competing reservations, stable identity, pessimistic storage and exact settlement", async () => {
  const h = await harness();
  try {
    const admin = await h.auth();
    const input = {
      operationId: uuid(),
      ownerId: "owner",
      policyVersion: 1,
      bytes: 4096,
      admissionSlots: 1,
    };
    const contenders = await Promise.all([
      h.cp.reserveCapacity(admin, input),
      h.cp.reserveCapacity(admin, { ...input, operationId: uuid() }),
    ]);
    assert.equal(contenders.filter((r) => r.ok).length, 1);
    const reservation = value(
      contenders[0] ?? {
        ok: false,
        code: "internal",
        requestId: "test",
        message: "Missing result",
        retryable: false,
      },
    );
    const api = h.cp as unknown as Pick<ControlPlaneRpc, "handleApi">;
    const health = value(await api.handleApi(admin, request("getAdminHealth", undefined)));
    if (health.status !== 200) assert.fail("No health observation");
    assert.equal(health.body.state, "degraded");
    assert.equal(
      health.body.pressure.some((p) => p.resource === "concurrency" && p.remaining === 0),
      true,
      "health must expose real outstanding claims",
    );
    assert.equal(
      value(await h.cp.reserveCapacity(admin, input)).reservationId,
      reservation.reservationId,
    );
    assert.equal((await h.cp.reserveCapacity(admin, { ...input, bytes: 8192 })).ok, false);
    assert.equal(
      (
        await h.cp.settleCapacity(admin, {
          reservationId: reservation.reservationId,
          disposition: "unused",
        })
      ).ok,
      false,
      "expiry or a caller claim without measured bytes cannot release",
    );
    const settlement = {
      reservationId: reservation.reservationId,
      disposition: "consumed" as const,
      observedBytes: 1024,
    };
    const settled = value(await h.cp.settleCapacity(admin, settlement));
    assert.equal(
      value(await h.cp.settleCapacity(admin, settlement)).reservationId,
      settled.reservationId,
    );
    assert.equal(settled.state, "settled");
    assert.equal(
      (await h.cp.settleCapacity(admin, { ...settlement, disposition: "unused", observedBytes: 0 }))
        .ok,
      false,
    );
    value(await h.cp.reserveCapacity(admin, { ...input, operationId: uuid() }));
    assert.equal(
      (
        await h.cp.reserveCapacity(admin, {
          ...input,
          operationId: uuid(),
          admissionSlots: 0,
          bytes: 512 * 1024 * 1024,
        })
      ).ok,
      false,
      "wire ceilings do not bypass repair headroom",
    );
  } finally {
    await h.close();
  }
});

test("model metadata is paged and redacted; cursor identity cannot cross principals", async () => {
  const h = await harness();
  try {
    const api = h.cp as unknown as Pick<ControlPlaneRpc, "handleApi">;
    const admin = await h.auth();
    const first = value(
      await api.handleApi(admin, {
        operationId: "listModels",
        path: {},
        query: { limit: 1 },
        body: undefined,
      }),
    );
    if (first.status !== 200) assert.fail("No catalog");
    assert.equal(first.body.items.length, 1);
    assert.equal(
      first.body.items[0]?.available,
      false,
      "missing OAuth credentials cannot appear available",
    );
    assert.ok(first.body.nextPageToken);
    const next = {
      operationId: "listModels" as const,
      path: {},
      query: { limit: 1, pageToken: first.body.nextPageToken },
      body: undefined,
    };
    const second = value(await api.handleApi(admin, next));
    if (second.status !== 200) assert.fail("No next page");
    assert.notEqual(second.body.items[0]?.providerId, first.body.items[0]?.providerId);
    const issued = await h.mint({
      requestId: uuid(),
      role: "admin",
      grants: [{ grantId: "catalog", version: 1, resources: scope(["models.list"]) }],
    });
    const crossed = await api.handleApi(await h.auth(issued.token), next);
    assert.equal(crossed.ok, false);
    if (!crossed.ok) assert.equal(crossed.code, "cursor.invalid");
    assert.equal(JSON.stringify(first.body).includes("refresh"), false);
  } finally {
    await h.close();
  }
});

test("real SQLite refusal mid-transaction cannot acknowledge or leak partial reservations", async () => {
  const h = await harness();
  try {
    const admin = await h.auth();
    const input = {
      operationId: uuid(),
      ownerId: "owner",
      policyVersion: 1,
      bytes: 4096,
      admissionSlots: 1,
    };
    await h.cp.refuseWrites("capacity");
    assert.equal((await h.cp.reserveCapacity(admin, input)).ok, false);
    assert.equal(await h.cp.rowCount("capacity_reservation"), 0);
    assert.equal(await h.cp.rowCount("capacity_request"), 0);
    await h.cp.refuseWrites(null);
    const reserved = value(await h.cp.reserveCapacity(admin, input));
    assert.equal(
      value(await h.cp.reserveCapacity(admin, input)).reservationId,
      reserved.reservationId,
    );
  } finally {
    await h.close();
  }
});
