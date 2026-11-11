import assert from "node:assert/strict";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { harness, request, uuid, value } from "./harness.ts";

async function setup() {
  const h = await harness();
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
      return {
        raw: auth,
        registered: { ...auth, registrationId: registration.registrationId },
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
    assert.deepEqual(
      JSON.parse(await h.cp.capacityUsage()),
      { reserved: 0, consumed: 4096, slots: 0 },
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
      reserved: 0,
      consumed: 4096,
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
      reserved: 8192,
      consumed: 4096,
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
      reserved: 0,
      consumed: 12288,
      slots: 0,
    });
    assert.equal(
      await h.cp.capacitySettlement(third.reservationId),
      JSON.stringify({ disposition: "consumed" }),
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
