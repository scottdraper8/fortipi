import assert from "node:assert/strict";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import type { StorageSampleInput } from "../../src/boundary/infrastructure.js";
import type { BudgetControl } from "./fixtures/storage-budget.js";
import { config, harness, request, uuid, value } from "./harness.ts";

const MiB = 1048576;
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
          name: "Budget actor",
          model: { providerId: "cloudflare", modelId: "fixture" },
        }),
      ),
    );
    assert.equal(created.status, 201);
    const agentId = created.body.agentId;
    const resources: D.ResourceScope = {
      agentIds: [agentId],
      conversationIds: [],
      workspaceIds: [],
      executorIds: [],
      backendIds: [],
      tools: [],
      actions: ["conversations.create"],
    };
    const issued = await h.mint({
      requestId: uuid(),
      role: "client",
      grants: [{ grantId: "one", version: 1, resources }],
    });
    const raw = await h.auth(issued.token);
    const registration = value(
      await h.cp.registerAuthorityRecipient(raw, {
        credential: issued.credential,
        recipient: { kind: "agent", id: agentId },
        resources,
      }),
    );
    const actor: D.ResourceAuthContext = { ...raw, registrationId: registration.registrationId };
    let sequence = 0;
    const sample = (bytes: number, ids: string[] = []): StorageSampleInput => ({
      sampleId: uuid(),
      policyVersion: 1,
      sampleSeq: ++sequence,
      observedAt: Date.now(),
      coverage: { kind: "agent", bytes },
      coveredReservationIds: ids,
    });
    const send = (input: unknown, context: D.AuthContext = actor) =>
      h.cp.fetch(
        new Request("https://control.internal/internal/storage-sample", {
          method: "POST",
          headers: { "X-Fortipi-Context": JSON.stringify(context) },
          body: typeof input === "string" ? input : JSON.stringify(input),
        }),
      );
    const reserve = (bytes: number) =>
      h.cp.reserveCapacity(actor, {
        operationId: uuid(),
        ownerId: agentId,
        policyVersion: 1,
        bytes,
        admissionSlots: 0,
      });
    const usage = async () => {
      const result = value(await h.cp.handleApi(admin, request("getUsage", undefined)));
      assert.equal(result.status, 200);
      assert.ok("reservedBytes" in result.body && "observedBytes" in result.body);
      return result.body;
    };
    return { ...h, admin, agentId, issued, actor, sample, send, reserve, usage };
  } catch (error) {
    await h.close();
    throw error;
  }
}

test("allocation floors cover actual peer SQLite growth, Workspace is charged once before RPC, and last-slot principals race atomically", async () => {
  const h = await setup();
  try {
    const before = await h.cp.peerStorage(h.agentId);
    assert.equal((await h.send(h.sample(before.bytes))).status, 200);
    const held = value(await h.reserve(12300));
    value(
      await h.cp.settleCapacity(h.actor, {
        reservationId: held.reservationId,
        disposition: "consumed",
      }),
    );
    const measured = await h.cp.peerStorage(h.agentId, "x".repeat(102400));
    assert.ok(measured.bytes > before.bytes);
    assert.equal((await h.send(h.sample(measured.bytes, [held.reservationId]))).status, 200);
    const usage = await h.usage();
    assert.ok(usage.observedBytes >= measured.bytes);
    assert.equal(
      usage.reservedBytes + usage.observedBytes,
      256 * MiB,
      "CP physical sample must be inside its floor, not added twice",
    );
    const workspace = value(
      await h.cp.handleApi(
        h.admin,
        request("createWorkspace", { requestId: uuid(), config: { kind: "computer" } }),
      ),
    );
    assert.equal(workspace.status, 201);
    const withWorkspace = await h.usage();
    assert.equal(withWorkspace.reservedBytes + withWorkspace.observedBytes, 320 * MiB);
    const retry = await h.cp.settleCapacity(h.actor, {
      reservationId: held.reservationId,
      disposition: "consumed",
      observedBytes: measured.bytes,
    });
    assert.equal(retry.ok, false, "Physical sampling must never rewrite an immutable settlement");
  } finally {
    await h.close();
  }

  const race = await harness<BudgetControl>({
    fixturePath: "apps/worker/test/control/fixtures/storage-budget.ts",
  });
  try {
    const admin = await race.auth();
    const issued = await race.mint({
      requestId: uuid(),
      role: "client",
      grants: [
        {
          grantId: "create",
          version: 1,
          resources: {
            agentIds: [],
            conversationIds: [],
            workspaceIds: [],
            executorIds: [],
            backendIds: [],
            tools: [],
            actions: ["agents.create"],
          },
        },
      ],
    });
    const actor = await race.auth(issued.token);
    const first = request("createAgent", {
      requestId: "stable_first",
      name: "First",
      model: { providerId: "cloudflare", modelId: "fixture" },
    });
    await race.cp.failBudget("storage_allocation");
    assert.equal(
      (await race.cp.createAgent(admin, first)).ok,
      false,
      "No directory receipt may escape a refused floor write",
    );
    assert.equal(
      await race.cp.rowCount("agent"),
      0,
      "A refused allocation must roll back the directory row, not just its reply",
    );
    await race.cp.failBudget(null);
    value(await race.cp.createAgent(admin, first));
    const attempts = await Promise.all(
      [admin, actor].map((ctx) =>
        race.cp.createAgent(
          ctx,
          request("createAgent", {
            requestId: uuid(),
            name: "Last",
            model: { providerId: "cloudflare", modelId: "fixture" },
          }),
        ),
      ),
    );
    assert.equal(attempts.filter((r) => r.ok).length, 1);
    assert.equal(value(await race.cp.createAgent(admin, first)).status, 201);
    assert.equal(
      (
        await race.cp.createAgent(
          admin,
          request("createAgent", {
            requestId: uuid(),
            name: "Excess",
            model: { providerId: "cloudflare", modelId: "fixture" },
          }),
        )
      ).ok,
      false,
    );
  } finally {
    await race.close();
  }
});

test("sample identities preserve age/receipts, only matched completed growth reconciles, and SQLite refusal cannot partially acknowledge", async () => {
  const h = await setup();
  try {
    assert.equal(
      (await h.reserve(1)).ok,
      false,
      "An unsampled allocated actor retains coverage but cannot grow",
    );
    const first = h.sample(184320);
    const response = await h.send(first);
    assert.equal(response.status, 200);
    const receipt: unknown = await response.json();
    const held = value(await h.reserve(10000));
    assert.equal(
      (await h.send(h.sample(200000, [held.reservationId]))).status,
      409,
      "A live growth claim cannot be covered before its completed settlement",
    );
    value(
      await h.cp.settleCapacity(h.actor, {
        reservationId: held.reservationId,
        disposition: "consumed",
      }),
    );
    const completed = h.sample(250000, [held.reservationId]);
    await h.cp.failBudget("storage_sample");
    assert.equal((await h.send(completed)).status, 500);
    await h.cp.failBudget(null);
    assert.equal(
      (await h.send(completed)).status,
      200,
      "Failed cache receipt must roll back sequence and growth reconciliation",
    );
    assert.deepEqual(
      await (await h.send(first)).json(),
      receipt,
      "Known old exact sample returns original immutable receipt",
    );
    assert.equal((await h.send({ ...first, observedAt: first.observedAt + 1 })).status, 409);
    assert.equal((await h.send({ ...first, sampleId: uuid() })).status, 409);
    assert.equal((await h.send({ ...h.sample(1), observedAt: Date.now() - 31000 })).status, 409);
    const overrun = h.sample(160 * MiB);
    assert.equal(
      (await h.send(overrun)).status,
      200,
      "Record truthful overrun before denying growth",
    );
    assert.equal((await h.reserve(1)).ok, false);
    const overUsage = await h.usage();
    assert.ok(overUsage.observedBytes >= 160 * MiB);
    assert.ok(overUsage.reservedBytes + overUsage.observedBytes >= 288 * MiB);
    assert.equal((await h.send({ ...h.sample(1), observedAt: Date.now() - 31000 })).status, 409);
    assert.ok(
      (await h.usage()).observedBytes >= 160 * MiB,
      "Rejected stale sample cannot erase the last overrun",
    );
    await h.cp.ageBudget(h.agentId);
    const stale = await h.usage();
    assert.ok(
      stale.reservedBytes + stale.observedBytes >= 288 * MiB,
      "Expired observation retains overrun as an estimate",
    );
    assert.ok(
      stale.observedBytes < 160 * MiB,
      "Expired observation must not be advertised as fresh measured usage",
    );
    assert.equal((await h.reserve(1)).ok, false);
    assert.deepEqual(
      await (await h.send(first)).json(),
      receipt,
      "Old exact receipt never renews observation age",
    );
    assert.equal((await h.reserve(1)).ok, false);
  } finally {
    await h.close();
  }
});

test("private sampling rejects malformed, oversized, forged and cross-allocation input under current complete grant/floors", async () => {
  const h = await setup();
  try {
    for (const body of [
      "{",
      "x".repeat(65537),
      { ...h.sample(1), extra: true },
      { ...h.sample(1), coverage: { kind: "agent", bytes: 1, censusVersion: 1 } },
      h.sample(1, ["duplicate", "duplicate"]),
      { ...h.sample(1), sampleSeq: 0 },
      { ...h.sample(1), coverage: { kind: "agent", bytes: -1 } },
    ])
      assert.notEqual((await h.send(body)).status, 200);
    assert.equal((await h.send(h.sample(1), h.admin)).status, 403);
    assert.equal((await h.send(h.sample(1), { ...h.actor, registrationId: uuid() })).status, 403);
    assert.equal(
      (await h.send(h.sample(1), { ...h.actor, grants: [] })).status,
      401,
      "Canonical context cannot be forged to change current grants",
    );
    assert.equal((await h.send({ ...h.sample(1), policyVersion: 2 })).status, 409);
    assert.equal((await h.send({ ...h.sample(1), observedAt: Date.now() + 60000 })).status, 409);
    const resources = h.actor.grants[0]?.resources;
    assert.ok(resources);
    const expiresAt = Date.now() + 500;
    const expiring = await h.mint({
      requestId: uuid(),
      role: "client",
      grants: [{ grantId: "short", version: 1, resources, expiresAt }],
    });
    const current = await h.auth(expiring.token);
    const registration = value(
      await h.cp.registerAuthorityRecipient(current, {
        credential: expiring.credential,
        recipient: { kind: "agent", id: h.agentId },
        resources,
      }),
    );
    await new Promise((done) => setTimeout(done, Math.max(0, expiresAt - Date.now() + 10)));
    assert.equal(
      (await h.send(h.sample(1), { ...current, registrationId: registration.registrationId }))
        .status,
      403,
      "An unchanged credential cannot make its expired operation grant current",
    );
    assert.equal(
      (
        await h.send({
          ...h.sample(1),
          coverage: { kind: "workspace", bytes: 1, censusVersion: 1 },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await h.send({
          ...h.sample(1),
          coveredReservationIds: Array.from({ length: 101 }, () => uuid()),
        })
      ).status,
      400,
    );
    const revoked = value(
      await h.cp.revokeCredential(
        h.admin,
        request(
          "revokeCredential",
          { requestId: uuid(), expectedGeneration: h.issued.credential.generation },
          { id: h.issued.credential.credentialId },
        ),
      ),
    );
    assert.equal(revoked.status, 202);
    assert.equal((await h.send(h.sample(1))).status, 401);
    const usage = await h.usage();
    assert.equal(
      usage.reservedBytes + usage.observedBytes,
      256 * MiB,
      "Revocation cannot refund an unknown allocation",
    );
    // Existing configuration API can lower and restore deployment-approved bounds.
    // A restored floor must cover actors allocated under the lower policy too.
    const policy = {
      ...config.infrastructure,
      bounds: { ...config.infrastructure.bounds, objectBytes: 64 * MiB },
    };
    value(
      await h.cp.handleApi(
        h.admin,
        request("patchConfiguration", {
          requestId: uuid(),
          expectedVersion: 1,
          configuration: { ...config, version: 2, infrastructure: policy },
        }),
      ),
    );
    value(
      await h.cp.createAgent(
        h.admin,
        request("createAgent", {
          requestId: uuid(),
          name: "Lower policy allocation",
          model: { providerId: "cloudflare", modelId: "fixture" },
        }),
      ),
    );
    const lower = await h.usage();
    assert.equal(
      lower.reservedBytes + lower.observedBytes,
      320 * MiB,
      "Policy reduction cannot refund retained floors",
    );
    value(
      await h.cp.handleApi(
        h.admin,
        request("patchConfiguration", {
          requestId: uuid(),
          expectedVersion: 2,
          configuration: { ...config, version: 3 },
        }),
      ),
    );
    const restored = await h.usage();
    assert.equal(
      restored.reservedBytes + restored.observedBytes,
      384 * MiB,
      "Restoring approved bounds must cover allocations made under a lower policy",
    );
  } finally {
    await h.close();
  }
});

test("Workspace samples use the existing exact logical export grant, share one pool across rebinds, and cannot cover another actor's growth", async () => {
  const h = await setup();
  try {
    const result = value(
      await h.cp.handleApi(
        h.admin,
        request("createWorkspace", { requestId: uuid(), config: { kind: "computer" } }),
      ),
    );
    assert.equal(result.status, 201);
    assert.ok("workspaceId" in result.body);
    const workspaceId = result.body.workspaceId;
    const resources: D.ResourceScope = {
      agentIds: [],
      conversationIds: [],
      workspaceIds: [workspaceId],
      executorIds: [],
      backendIds: [],
      tools: [],
      actions: ["exports.create"],
    };
    const issued = await h.mint({
      requestId: uuid(),
      role: "admin",
      grants: [{ grantId: "export_only", version: 1, resources }],
    });
    const raw = await h.auth(issued.token);
    const registration = value(
      await h.cp.registerAuthorityRecipient(raw, {
        credential: issued.credential,
        recipient: { kind: "workspace", id: workspaceId },
        resources,
      }),
    );
    const exporter: D.ResourceAuthContext = { ...raw, registrationId: registration.registrationId };
    const sample: StorageSampleInput = {
      sampleId: uuid(),
      policyVersion: 1,
      sampleSeq: 1,
      observedAt: Date.now(),
      coverage: { kind: "workspace", bytes: 100000, censusVersion: 1 },
      coveredReservationIds: [],
    };
    assert.equal(
      (await h.send(sample, exporter)).status,
      200,
      "A sampler needs its existing operation grant, never synthetic capacity.* or read authority",
    );
    assert.equal(
      (await h.send({ ...sample, sampleId: uuid(), sampleSeq: 2 }, exporter)).status,
      409,
      "A newer sample cannot reuse a completed census version",
    );
    assert.equal((await h.send(h.sample(100000))).status, 200);
    const agentClaim = value(await h.reserve(1000));
    value(
      await h.cp.settleCapacity(h.actor, {
        reservationId: agentClaim.reservationId,
        disposition: "consumed",
      }),
    );
    assert.equal(
      (
        await h.send(
          {
            ...sample,
            sampleId: uuid(),
            sampleSeq: 2,
            observedAt: Date.now(),
            coverage: { ...sample.coverage, censusVersion: 2 },
            coveredReservationIds: [agentClaim.reservationId],
          },
          exporter,
        )
      ).status,
      409,
    );
    const operatorClaim = value(
      await h.cp.reserveCapacity(h.admin, {
        operationId: uuid(),
        ownerId: workspaceId,
        policyVersion: 1,
        bytes: 1000,
        admissionSlots: 0,
      }),
    );
    value(
      await h.cp.settleCapacity(h.admin, {
        reservationId: operatorClaim.reservationId,
        disposition: "consumed",
      }),
    );
    assert.equal(
      (
        await h.send(
          {
            ...sample,
            sampleId: uuid(),
            sampleSeq: 2,
            observedAt: Date.now(),
            coverage: { kind: "workspace", bytes: 120000, censusVersion: 2 },
            coveredReservationIds: [operatorClaim.reservationId],
          },
          exporter,
        )
      ).status,
      200,
      "Operator-owned Workspace claims belong to the same physical pool",
    );
    const rebound = await h.cp.handleApi(
      h.admin,
      request(
        "rebindWorkspace",
        {
          requestId: uuid(),
          expectedVersion: 1,
          newBindingVersion: 2,
          config: { kind: "computer" },
          import: {
            revision: "operator_import",
            manifest: { version: 1, entries: [] },
            acknowledgeExternalEffects: true,
          },
        },
        { workspaceId },
      ),
    );
    assert.equal(
      rebound.ok,
      false,
      "This controlled peer cannot attest an import; failed rebind retains the original pool",
    );
    const usage = await h.usage();
    assert.equal(
      usage.reservedBytes + usage.observedBytes,
      320 * MiB,
      "No rebind floor or child charge may be added to the Workspace pool",
    );
  } finally {
    await h.close();
  }
});

test("sample body reader accepts a delayed complete body and bounds actual abort/deadline despite a nonsettling source cancellation", async () => {
  const h = await setup();
  try {
    assert.equal(
      (await h.cp.sampleBody(h.actor, JSON.stringify(h.sample(100000)), "complete")).status,
      200,
    );
    for (const mode of ["abort", "deadline"] as const) {
      const result = await h.cp.sampleBody(h.actor, JSON.stringify(h.sample(200000)), mode);
      assert.equal(result.status, mode === "abort" ? 409 : 401);
      assert.ok(
        result.elapsed < 200,
        "Stalled sample body must finish at abort/deadline, not when its producer eventually closes",
      );
    }
    assert.equal(
      (await h.send(h.sample(100000))).status,
      200,
      "Failed body cannot publish a sample identity or sequence",
    );
  } finally {
    await h.close();
  }
});

test("freshness samples cannot spend retained completion repair headroom", async () => {
  const remainingMinute = 60000 - (Date.now() % 60000);
  if (remainingMinute < 3000) await new Promise((done) => setTimeout(done, remainingMinute + 10));
  const h = await setup();
  try {
    assert.equal((await h.send(h.sample(100000))).status, 200);
    const claim = value(await h.reserve(1000));
    const results: number[] = [];
    for (let attempt = 0; attempt < 31; attempt++)
      results.push((await h.send(h.sample(100000))).status);
    assert.ok(
      results.includes(200) && results.includes(429),
      "Existing ordinary limits bound freshness amplification",
    );
    const completion = await h.cp.settleCapacity(h.actor, {
      reservationId: claim.reservationId,
      disposition: "consumed",
    });
    assert.ok(
      completion.ok,
      "Freshness sampling cannot exhaust retained completion's repair allowance",
    );
  } finally {
    await h.close();
  }
});
