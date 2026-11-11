import assert from "node:assert/strict";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import type { BudgetControl } from "./fixtures/storage-budget.js";
import { harness, request, uuid, value } from "./harness.ts";

async function setup() {
  const h = await harness<BudgetControl>({
    fixturePath: "apps/worker/test/control/fixtures/storage-budget.ts",
  });
  try {
    const admin = await h.auth();
    const created = value(
      await h.cp.createAgent(
        admin,
        request("createAgent", {
          requestId: uuid(),
          name: "Conservative accounting",
          model: { providerId: "cloudflare", modelId: "selected-model" },
        }),
      ),
    );
    if (created.status !== 201) assert.fail("Missing actual Agent");
    const resources: D.ResourceScope = {
      agentIds: [created.body.agentId],
      conversationIds: [],
      workspaceIds: [],
      executorIds: [],
      backendIds: [],
      tools: [],
      actions: ["conversations.create"],
    };
    let sampleSeq = 0;
    const actor = async (expiresAt?: number) => {
      const issued = await h.mint({
        requestId: uuid(),
        role: "client",
        grants: [
          {
            grantId: "create",
            version: 1,
            resources,
            ...(expiresAt === undefined ? {} : { expiresAt }),
          },
        ],
      });
      const auth = await h.auth(issued.token);
      const registration = value(
        await h.cp.registerAuthorityRecipient(auth, {
          credential: issued.credential,
          recipient: { kind: "agent", id: created.body.agentId },
          resources,
        }),
      );
      const registered = { ...auth, registrationId: registration.registrationId };
      const measured = await h.cp.peerStorage(created.body.agentId);
      const sampling = await h.cp.fetch(
        new Request("https://control.internal/internal/storage-sample", {
          method: "POST",
          headers: { "X-Fortipi-Context": JSON.stringify(registered) },
          body: JSON.stringify({
            sampleId: uuid(),
            policyVersion: 1,
            sampleSeq: ++sampleSeq,
            observedAt: measured.observedAt,
            coverage: { kind: "agent", bytes: measured.bytes },
            coveredReservationIds: [],
          }),
        }),
      );
      assert.equal(
        sampling.status,
        200,
        "Growth starts only after a real recipient physical sample",
      );
      return {
        raw: auth,
        registered,
        issued,
      };
    };
    const input = (bytes: number) => ({
      ownerId: created.body.agentId,
      operationId: uuid(),
      policyVersion: 1,
      bytes,
      admissionSlots: 0,
    });
    return { ...h, admin, actor, input };
  } catch (error) {
    await h.close();
    throw error;
  }
}

async function publicUsage(h: Awaited<ReturnType<typeof setup>>) {
  const result = value(await h.cp.handleApi(h.admin, request("getUsage", undefined)));
  assert.ok(
    result.status === 200 && "reservedBytes" in result.body && "observedBytes" in result.body,
  );
  return { reservedBytes: result.body.reservedBytes, observedBytes: result.body.observedBytes };
}

test("unmeasured consumed settlement durably retains the full charge, keeps absence distinct and cannot reclaim or partially acknowledge", async () => {
  const h = await setup();
  try {
    const actor = await h.actor();
    const ctx = actor.registered;
    const first = value(await h.cp.reserveCapacity(ctx, h.input(4096)));
    const absent = { reservationId: first.reservationId, disposition: "consumed" as const };
    assert.equal(
      value(await h.cp.settleCapacity(ctx, absent)).state,
      "settled",
      "consumed without measurement must settle conservatively under its original authority",
    );
    const initialUsage = await publicUsage(h);
    assert.equal(
      initialUsage.reservedBytes + initialUsage.observedBytes,
      256 * 1048576,
      "Physical allocation floors include pending work without adding the same bytes twice",
    );
    assert.ok(
      initialUsage.observedBytes > 0,
      "Only actual CP/recipient physical samples are observed usage",
    );
    assert.deepEqual(
      JSON.parse(await h.cp.capacityUsage()),
      { reserved: 4096, consumed: 0, slots: 0 },
      "unmeasured consumed storage must retain the entire original byte charge",
    );
    assert.equal(
      await h.cp.capacitySettlement(first.reservationId),
      JSON.stringify({ disposition: "consumed" }),
      "conservative settlement must not fabricate an observedBytes field",
    );
    assert.equal(
      await h.cp.rowCount("repair_resume"),
      0,
      "unknown measurement cannot announce reclaimed storage",
    );
    assert.equal(value(await h.cp.settleCapacity(ctx, absent)).reservationId, first.reservationId);
    assert.equal(
      (await h.cp.settleCapacity(ctx, { ...absent, observedBytes: 4096 })).ok,
      false,
      "later explicit measurement must not rewrite the original unmeasured settlement identity",
    );
    assert.deepEqual(JSON.parse(await h.cp.capacityUsage()), {
      reserved: 4096,
      consumed: 0,
      slots: 0,
    });
    const second = value(await h.cp.reserveCapacity(ctx, h.input(2048)));
    assert.equal(
      (
        await h.cp.settleCapacity(ctx, {
          reservationId: second.reservationId,
          disposition: "unused",
        })
      ).ok,
      false,
      "unused capacity still requires an authoritative explicit zero",
    );
    for (const observedBytes of [-1, Number.NaN, Number.POSITIVE_INFINITY, 2049])
      assert.equal(
        (
          await h.cp.settleCapacity(ctx, {
            reservationId: second.reservationId,
            disposition: "consumed",
            observedBytes,
          })
        ).ok,
        false,
      );
    assert.equal(
      value(
        await h.cp.settleCapacity(ctx, {
          reservationId: second.reservationId,
          disposition: "unused",
          observedBytes: 0,
        }),
      ).state,
      "settled",
    );
    const input = h.input(8192);
    const third = value(await h.cp.reserveCapacity(ctx, input));
    const conservative = { reservationId: third.reservationId, disposition: "consumed" as const };
    await h.cp.refuseWrites("capacity");
    assert.equal(
      (await h.cp.settleCapacity(ctx, conservative)).ok,
      false,
      "actual SQLite counter refusal cannot acknowledge partial settlement",
    );
    assert.equal(await h.cp.capacitySettlement(third.reservationId), undefined);
    assert.deepEqual(JSON.parse(await h.cp.capacityUsage()), {
      reserved: 12288,
      consumed: 0,
      slots: 0,
    });
    await h.cp.refuseWrites(null);
    assert.equal(
      value(await h.cp.reserveCapacity(ctx, input)).state,
      "reserved",
      "failed settlement must roll back the reservation state too",
    );
    value(await h.cp.settleCapacity(ctx, conservative));
    assert.deepEqual(JSON.parse(await h.cp.capacityUsage()), {
      reserved: 12288,
      consumed: 0,
      slots: 0,
    });
    assert.equal(
      await h.cp.capacitySettlement(third.reservationId),
      JSON.stringify({ disposition: "consumed" }),
    );
    const measuredBytes = new TextEncoder().encode("known retained fixture bytes").length;
    const measured = value(await h.cp.reserveCapacity(ctx, h.input(512)));
    value(
      await h.cp.settleCapacity(ctx, {
        reservationId: measured.reservationId,
        disposition: "consumed",
        observedBytes: measuredBytes,
      }),
    );
    const finalUsage = await publicUsage(h);
    assert.equal(finalUsage.reservedBytes + finalUsage.observedBytes, 256 * 1048576);
    assert.deepEqual(
      JSON.parse(await h.cp.capacityUsage()),
      { reserved: 12288, consumed: measuredBytes, slots: 0 },
      "An immutable operation measurement is distinct from cumulative physical storage",
    );
  } finally {
    await h.close();
  }
});

test("unmeasured settlement still requires its exact current retained registration, grant and credential floors", async () => {
  const h = await setup();
  try {
    const expiresAt = Date.now() + 1500;
    const short = await h.actor(expiresAt);
    const first = value(await h.cp.reserveCapacity(short.registered, h.input(4096)));
    const absent = { reservationId: first.reservationId, disposition: "consumed" as const };
    assert.equal(
      (await h.cp.settleCapacity(short.raw, absent)).ok,
      false,
      "unmeasured settlement cannot use a raw unregistered logical grant",
    );
    assert.equal(
      (await h.cp.settleCapacity({ ...short.registered, grants: [] }, absent)).ok,
      false,
      "forged canonical grant context cannot conservatively settle",
    );
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, expiresAt - Date.now() + 20)));
    assert.equal(
      (await h.cp.settleCapacity(short.registered, absent)).ok,
      false,
      "expired logical grant cannot release a retained claim by omitting measurement",
    );
    assert.equal(await h.cp.capacitySettlement(first.reservationId), undefined);
    const current = await h.actor();
    assert.equal(
      (await h.cp.settleCapacity(current.registered, absent)).ok,
      false,
      "current different principal cannot claim the original unmeasured reservation",
    );
    const second = value(await h.cp.reserveCapacity(current.registered, h.input(8192)));
    value(
      await h.cp.revokeCredential(
        h.admin,
        request(
          "revokeCredential",
          { requestId: uuid(), expectedGeneration: 1 },
          { id: current.issued.credential.credentialId },
        ),
      ),
    );
    const stale = await h.cp.settleCapacity(current.registered, {
      reservationId: second.reservationId,
      disposition: "consumed",
    });
    assert.equal(stale.ok, false, "credential revocation precedes conservative settlement");
    if (!stale.ok) assert.equal(stale.code, "unauthenticated");
    assert.equal(await h.cp.capacitySettlement(second.reservationId), undefined);
    assert.deepEqual(
      JSON.parse(await h.cp.capacityUsage()),
      { reserved: 12288, consumed: 0, slots: 0 },
      "failed authority must preserve all outstanding conservative evidence",
    );
  } finally {
    await h.close();
  }
});
