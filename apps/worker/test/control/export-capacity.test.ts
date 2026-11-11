import assert from "node:assert/strict";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import type { ExportControl } from "./fixtures/export-capacity.js";
import { harness, request, uuid, value } from "./harness.ts";

async function setup() {
  const h = await harness<ExportControl>({
    fixturePath: "apps/worker/test/control/fixtures/export-capacity.ts",
  });
  try {
    const admin = await h.auth();
    const result = value(
      await h.cp.createAgent(
        admin,
        request("createAgent", {
          requestId: uuid(),
          name: "Export quota",
          model: { providerId: "cloudflare", modelId: "fixture" },
        }),
      ),
    );
    assert.equal(result.status, 201);
    const agentId = result.body.agentId;
    const resources = (action = "exports.create"): D.ResourceScope => ({
      agentIds: [agentId],
      conversationIds: [],
      workspaceIds: [],
      executorIds: [],
      backendIds: [],
      tools: [],
      actions: [action],
    });
    const issue = async (
      scope: D.ResourceScope,
      role: "admin" | "client" = "admin",
      expiresAt?: number,
      grants?: D.Grant[],
    ) => {
      const minted = value(
        await h.cp.mintCredential(
          admin,
          request("mintCredential", {
            requestId: uuid(),
            role,
            grants: grants ?? [
              {
                grantId: uuid(),
                version: 1,
                resources: scope,
                ...(expiresAt === undefined ? {} : { expiresAt }),
              },
            ],
          }),
        ),
      );
      assert.equal(minted.status, 201);
      assert.equal(minted.body.state, "issued");
      if (minted.body.state !== "issued") assert.fail("Expected actual new credential");
      return { raw: await h.auth(minted.body.token), credential: minted.body.credential };
    };
    const register = async (
      scope: D.ResourceScope,
      role: "admin" | "client" = "admin",
      expiresAt?: number,
    ) => {
      const issued = await issue(scope, role, expiresAt);
      const registration = value(
        await h.cp.registerAuthorityRecipient(issued.raw, {
          credential: issued.credential,
          recipient: { kind: "agent", id: scope.agentIds[0] ?? agentId },
          resources: scope,
        }),
      );
      const auth: D.ResourceAuthContext = {
        ...issued.raw,
        registrationId: registration.registrationId,
      };
      return { ...issued, auth };
    };
    const input = () => ({
      operationId: uuid(),
      ownerId: agentId,
      bytes: 65536,
      admissionSlots: 0,
      policyVersion: 1,
    });
    const anchor = await register(resources());
    const measured = await h.cp.peerStorage(agentId);
    const sampled = await h.cp.fetch(
      new Request("https://control.internal/internal/storage-sample", {
        method: "POST",
        headers: { "X-Fortipi-Context": JSON.stringify(anchor.auth) },
        body: JSON.stringify({
          sampleId: uuid(),
          sampleSeq: 1,
          policyVersion: 1,
          observedAt: measured.observedAt,
          coverage: { kind: "agent", bytes: measured.bytes },
          coveredReservationIds: [],
        }),
      }),
    );
    assert.equal(sampled.status, 200, "A current physical observation must precede growth");
    return { ...h, admin, agentId, resources, issue, register, input, anchor };
  } catch (error) {
    await h.close();
    throw error;
  }
}

test("exact registered admin exports and backups reserve Agent storage with zero mutation slots and no model authority", async () => {
  const h = await setup();
  try {
    for (const scope of [
      h.resources(),
      { ...h.resources("backups.create"), conversationIds: ["selected_conversation"] },
    ]) {
      const { auth } = await h.register(scope);
      assert.equal(auth.grants.length, 1);
      assert.deepEqual(auth.grants[0]?.resources.actions, scope.actions);
      const input = h.input();
      const held = value(await h.cp.reserveCapacity(auth, input));
      assert.equal(held.ownerId, h.agentId, "Export storage always belongs to its physical Agent");
      assert.equal(held.admissionSlots, 0, "Export capacity never authorizes mutation slots");
      assert.equal(
        value(await h.cp.reserveCapacity(auth, input)).reservationId,
        held.reservationId,
      );
      assert.equal(
        (await h.cp.reserveCapacity(auth, { ...input, bytes: input.bytes + 1 })).ok,
        false,
      );
      const model = await h.cp.fetch(
        new Request(`https://control.internal/internal/agents/${h.agentId}/model`, {
          headers: { "X-Fortipi-Context": JSON.stringify(auth) },
        }),
      );
      assert.equal(model.status, 403, "Export storage authority must never resolve a model");
      value(
        await h.cp.settleCapacity(auth, {
          reservationId: held.reservationId,
          disposition: "consumed",
        }),
      );
      value(
        await h.cp.settleCapacity(auth, {
          reservationId: held.reservationId,
          disposition: "consumed",
        }),
      );
      assert.equal(
        (
          await h.cp.settleCapacity(auth, {
            reservationId: held.reservationId,
            disposition: "unused",
            observedBytes: 0,
          })
        ).ok,
        false,
      );
    }
    const allScope = { ...h.resources("backups.create"), conversationIds: ["*"] };
    const allRegistration = value(
      await h.cp.registerAuthorityRecipient(h.admin, {
        credential: {
          credentialId: h.admin.credentialId,
          generation: h.admin.generation,
          grantVersion: h.admin.grantVersion,
        },
        recipient: { kind: "agent", id: h.agentId },
        resources: allScope,
      }),
    );
    const allAuth: D.ResourceAuthContext = {
      ...h.admin,
      registrationId: allRegistration.registrationId,
    };
    const allClaim = value(await h.cp.reserveCapacity(allAuth, h.input()));
    assert.equal(
      (
        await h.cp.settleCapacity(h.admin, {
          reservationId: allClaim.reservationId,
          disposition: "consumed",
        })
      ).ok,
      false,
      "All-conversation export must retain its exact operation registration even with a broad covering administrator grant",
    );
    value(
      await h.cp.settleCapacity(allAuth, {
        reservationId: allClaim.reservationId,
        disposition: "consumed",
      }),
    );
    const selected = await h.register({
      ...h.resources("backups.create"),
      conversationIds: ["selected_conversation"],
    });
    for (const conversationIds of [["*"], ["another_conversation"]]) {
      assert.equal(
        (
          await h.cp.registerAuthorityRecipient(selected.raw, {
            credential: selected.credential,
            recipient: { kind: "agent", id: h.agentId },
            resources: { ...allScope, conversationIds },
          })
        ).ok,
        false,
        "One specific-conversation grant cannot register wider export authority",
      );
    }
    assert.equal(
      (
        await h.cp.reserveCapacity(
          { ...selected.raw, registrationId: allRegistration.registrationId },
          h.input(),
        )
      ).ok,
      false,
      "A narrower credential cannot use another credential's wildcard registration",
    );
  } finally {
    await h.close();
  }
});

test("export capacity rejects peer, wildcard Agent, mixed action, nonadmin, wrong owner/slots/policy and unknown settlement", async () => {
  const h = await setup();
  try {
    const cases: { label: string; scope: D.ResourceScope; role?: "admin" | "client" }[] = [
      { label: "workspace peer", scope: { ...h.resources(), workspaceIds: ["workspace"] } },
      { label: "executor peer", scope: { ...h.resources(), executorIds: ["executor"] } },
      { label: "backend peer", scope: { ...h.resources(), backendIds: ["backend"] } },
      { label: "tool selector", scope: { ...h.resources(), tools: ["read"] } },
      {
        label: "mixed actions",
        scope: { ...h.resources(), actions: ["exports.create", "messages.submit"] },
      },
      { label: "read action", scope: h.resources("operations.read") },
      { label: "nonadmin", scope: h.resources(), role: "client" },
    ];
    for (const example of cases) {
      const { auth } = await h.register(example.scope, example.role);
      assert.equal(
        (await h.cp.reserveCapacity(auth, h.input())).ok,
        false,
        `Export scope rejects ${example.label}`,
      );
    }
    assert.equal(
      (
        await h.cp.registerAuthorityRecipient(h.anchor.raw, {
          credential: h.anchor.credential,
          recipient: { kind: "agent", id: h.agentId },
          resources: { ...h.resources(), agentIds: [h.agentId, "*"] },
        })
      ).ok,
      false,
      "Exact Agent grant cannot register wildcard Agent scope",
    );
    const auth = h.anchor.auth;
    for (const bytes of [
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ])
      assert.equal(
        (await h.cp.reserveCapacity(auth, { ...h.input(), bytes })).ok,
        false,
        "Export bytes must remain a safe nonnegative integer",
      );
    const nonnumeric = h.input();
    Reflect.set(nonnumeric, "bytes", "65536");
    assert.equal(
      (await h.cp.reserveCapacity(auth, nonnumeric)).ok,
      false,
      "Nonnumeric wire bytes cannot use the export path",
    );
    const split = await h.issue(h.resources(), "admin", undefined, [
      { grantId: "action_only", version: 1, resources: { ...h.resources(), agentIds: [] } },
      { grantId: "agent_only", version: 1, resources: { ...h.resources(), actions: [] } },
    ]);
    assert.equal(
      (
        await h.cp.registerAuthorityRecipient(split.raw, {
          credential: split.credential,
          recipient: { kind: "agent", id: h.agentId },
          resources: h.resources(),
        })
      ).ok,
      false,
      "Split grants cannot synthesize one covering export operation",
    );
    const peerScope = { ...h.resources(), workspaceIds: ["workspace"] };
    const peer = await h.issue(peerScope);
    const peerRegistration = value(
      await h.cp.registerAuthorityRecipient(peer.raw, {
        credential: peer.credential,
        recipient: { kind: "workspace", id: "workspace" },
        resources: peerScope,
      }),
    );
    assert.equal(
      (
        await h.cp.reserveCapacity(
          { ...peer.raw, registrationId: peerRegistration.registrationId },
          h.input(),
        )
      ).ok,
      false,
      "A Workspace recipient cannot claim Agent export storage",
    );
    for (const input of [
      { ...h.input(), ownerId: "wrong_agent" },
      { ...h.input(), ownerId: "selected_conversation" },
      { ...h.input(), admissionSlots: 1 },
      { ...h.input(), policyVersion: 2 },
    ])
      assert.equal(
        (await h.cp.reserveCapacity(auth, input)).ok,
        false,
        "Owner, slots and policy remain exact",
      );
    assert.equal(
      (await h.cp.reserveCapacity(h.anchor.raw, h.input())).ok,
      false,
      "A raw grant is not a recipient registration",
    );
    assert.equal(
      (await h.cp.reserveCapacity({ ...auth, grants: [] }, h.input())).ok,
      false,
      "Forged grants cannot replace canonical authority",
    );
    assert.equal(
      (await h.cp.settleCapacity(auth, { reservationId: uuid(), disposition: "consumed" })).ok,
      false,
      "Unknown loss cannot create a completion receipt",
    );
  } finally {
    await h.close();
  }
});

test("export settlement retains original current grant/registration through lost replies, expiry and revocation", async () => {
  const h = await setup();
  try {
    const input = h.input();
    const before = await h.cp.rowCount("capacity_reservation");
    await assert.rejects(h.cp.loseReservation(h.anchor.auth, input));
    assert.equal(
      await h.cp.rowCount("capacity_reservation"),
      before + 1,
      "Reservation must be durably accepted before the lost reply and before retry",
    );
    const held = value(await h.cp.reserveCapacity(h.anchor.auth, input));
    assert.equal(
      await h.cp.rowCount("capacity_reservation"),
      before + 1,
      "Lost reservation reply must reuse one retained claim",
    );
    const replacement = await h.register(h.resources());
    assert.equal(
      (
        await h.cp.settleCapacity(replacement.auth, {
          reservationId: held.reservationId,
          disposition: "consumed",
        })
      ).ok,
      false,
      "A new current principal cannot settle another principal's export",
    );
    const scoped = await h.issue({
      ...h.resources(),
      conversationIds: ["selected_conversation", "different_conversation"],
    });
    const firstScope = { ...h.resources(), conversationIds: ["selected_conversation"] };
    const firstReg = value(
      await h.cp.registerAuthorityRecipient(scoped.raw, {
        credential: scoped.credential,
        recipient: { kind: "agent", id: h.agentId },
        resources: firstScope,
      }),
    );
    const firstAuth: D.ResourceAuthContext = {
      ...scoped.raw,
      registrationId: firstReg.registrationId,
    };
    const scopedClaim = value(await h.cp.reserveCapacity(firstAuth, h.input()));
    const wrongScope = { ...h.resources(), conversationIds: ["different_conversation"] };
    const secondReg = value(
      await h.cp.registerAuthorityRecipient(scoped.raw, {
        credential: scoped.credential,
        recipient: { kind: "agent", id: h.agentId },
        resources: wrongScope,
      }),
    );
    assert.equal(
      (
        await h.cp.settleCapacity(
          { ...scoped.raw, registrationId: secondReg.registrationId },
          { reservationId: scopedClaim.reservationId, disposition: "consumed" },
        )
      ).ok,
      false,
      "A retained claim cannot switch registrations or conversation scope",
    );
    value(
      await h.cp.settleCapacity(firstAuth, {
        reservationId: scopedClaim.reservationId,
        disposition: "unused",
        observedBytes: 0,
      }),
    );
    const expiresAt = Date.now() + 350;
    const expiring = await h.register(h.resources(), "admin", expiresAt);
    const expiringClaim = value(await h.cp.reserveCapacity(expiring.auth, h.input()));
    await new Promise((done) => setTimeout(done, Math.max(0, expiresAt - Date.now() + 10)));
    assert.equal(
      (await h.cp.reserveCapacity(expiring.auth, h.input())).ok,
      false,
      "Expired export grant cannot grow storage",
    );
    assert.equal(
      (
        await h.cp.settleCapacity(expiring.auth, {
          reservationId: expiringClaim.reservationId,
          disposition: "unused",
          observedBytes: 0,
        })
      ).ok,
      false,
      "Expired grant cannot refund retained growth",
    );
    value(
      await h.cp.revokeCredential(
        h.admin,
        request(
          "revokeCredential",
          { requestId: uuid(), expectedGeneration: 1 },
          { id: h.anchor.auth.credentialId },
        ),
      ),
    );
    assert.equal(
      (await h.cp.reserveCapacity(h.anchor.auth, input)).ok,
      false,
      "Revocation fences even a retained reservation retry",
    );
    assert.equal(
      (
        await h.cp.settleCapacity(h.anchor.auth, {
          reservationId: held.reservationId,
          disposition: "unused",
          observedBytes: 0,
        })
      ).ok,
      false,
    );
    const counters: { reserved: number } = JSON.parse(await h.cp.capacityUsage());
    assert.equal(
      counters.reserved,
      2 * input.bytes,
      "Uncertain or revoked export work retains its whole pending growth",
    );
  } finally {
    await h.close();
  }
});
