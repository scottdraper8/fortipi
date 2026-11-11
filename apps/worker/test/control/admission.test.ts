import assert from "node:assert/strict";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { config, harness, request, uuid, value } from "./harness.ts";

async function naturalWindow(): Promise<void> {
  const left = 60000 - (Date.now() % 60000);
  if (left < 10000) await new Promise((resolve) => setTimeout(resolve, left + 50));
}

test("one physical nested-route invocation can use the last principal slot without deduplicating distinct RPCs", async () => {
  const h = await harness();
  try {
    await naturalWindow();
    const ctx = await h.auth(); // One actual authenticate RPC admission.
    const bound = config.infrastructure.bounds.requestsPerPrincipalMinute;
    assert.equal(bound, 30);
    // Reusing a logical requestId must not hide the cost of separate actual RPCs.
    for (let n = 0; n < bound - 2; n++)
      assert.equal((await h.cp.listAgents(ctx, request("listAgents", undefined))).ok, true);
    const contenders = await Promise.all([
      h.cp.handleApi(ctx, request("listAgents", undefined)),
      h.cp.handleApi(ctx, request("listAgents", undefined)),
    ]);
    assert.equal(
      contenders.filter((result) => result.ok).length,
      1,
      "one actual handleApi invocation must use the last slot without a second internal-method charge",
    );
    const rejected = contenders.find((result) => !result.ok);
    assert.ok(rejected && !rejected.ok);
    assert.equal(rejected.code, "rate_limited");
    const after = await h.cp.listAgents(ctx, request("listAgents", undefined));
    assert.equal(
      after.ok,
      false,
      "a distinct real RPC must still be rejected after the exact bound",
    );
    if (!after.ok) assert.equal(after.code, "rate_limited");
  } finally {
    await h.close();
  }
});

async function agent(
  h: Awaited<ReturnType<typeof harness>>,
  admin: D.AuthContext,
): Promise<string> {
  const created = value(
    await h.cp.createAgent(
      admin,
      request("createAgent", {
        requestId: uuid(),
        name: "Ordinary application",
        model: { providerId: "cloudflare", modelId: "selected-model" },
      }),
    ),
  );
  assert.equal(created.status, 201);
  if (created.status !== 201) assert.fail("Agent creation failed");
  return created.body.agentId;
}
function resources(agentId: string, action: string, conversationId?: string): D.ResourceScope {
  return {
    agentIds: [agentId],
    conversationIds: conversationId ? [conversationId] : [],
    workspaceIds: [],
    executorIds: [],
    backendIds: [],
    tools: [],
    actions: [action],
  };
}
async function registered(
  h: Awaited<ReturnType<typeof harness>>,
  auth: D.AuthContext,
  scope: D.ResourceScope,
): Promise<D.AuthContext> {
  const registration = value(
    await h.cp.registerAuthorityRecipient(auth, {
      credential: {
        credentialId: auth.credentialId,
        generation: auth.generation,
        grantVersion: auth.grantVersion,
      },
      recipient: { kind: "agent", id: scope.agentIds[0] ?? "missing" },
      resources: scope,
    }),
  );
  return { ...auth, registrationId: registration.registrationId };
}
const reservationInput = (ownerId: string, admissionSlots = 0) => ({
  ownerId,
  operationId: uuid(),
  policyVersion: 1,
  bytes: 4096,
  admissionSlots,
});

test("ordinary registered Agent operations reserve and complete only their retained owner and one current logical grant", async () => {
  const h = await harness();
  try {
    await naturalWindow();
    const admin = await h.auth();
    const first = await agent(h, admin);
    const second = await agent(h, admin);
    const create = resources(first, "conversations.create");
    const issued = await h.mint({
      requestId: uuid(),
      role: "client",
      grants: [
        { grantId: "create", version: 1, resources: { ...create, agentIds: [first, second] } },
      ],
    });
    const auth = await h.auth(issued.token);
    const own = await registered(h, auth, create);
    assert.equal(
      (await h.cp.describeAgent(own, request("describeAgent", undefined, { agentId: first }))).ok,
      false,
      "logical operation registration must not grant public agent configuration reads",
    );
    assert.equal(
      (await h.cp.handleApi(own, request("describeAgent", undefined, { agentId: first }))).ok,
      false,
    );
    const other = await registered(h, auth, resources(second, "conversations.create"));
    const input = reservationInput(first);
    assert.equal(
      (await h.cp.reserveCapacity(auth, input)).ok,
      false,
      "raw logical grant cannot reserve without current Agent registration",
    );
    assert.equal(
      (await h.cp.reserveCapacity(own, { ...input, ownerId: second })).ok,
      false,
      "registration cannot select another owner",
    );
    assert.equal(
      (await h.cp.reserveCapacity(own, { ...input, admissionSlots: 1 })).ok,
      false,
      "creation authority cannot acquire job slots",
    );
    const admitted = value(await h.cp.reserveCapacity(own, input));
    assert.equal(
      value(await h.cp.reserveCapacity(own, input)).reservationId,
      admitted.reservationId,
    );
    assert.equal((await h.cp.reserveCapacity(own, { ...input, bytes: 8192 })).ok, false);
    const settle = {
      reservationId: admitted.reservationId,
      disposition: "consumed" as const,
      observedBytes: 1024,
    };
    assert.equal(
      (await h.cp.settleCapacity(other, settle)).ok,
      false,
      "cross-agent registration cannot complete original reservation",
    );
    assert.equal(
      (await h.cp.settleCapacity(auth, settle)).ok,
      false,
      "unregistered caller cannot complete retained Agent reservation",
    );
    assert.equal(
      value(await h.cp.settleCapacity(own, settle)).state,
      "settled",
      "minimal conversations.create grant must complete without hidden capacity grants",
    );
    assert.equal(value(await h.cp.settleCapacity(own, settle)).state, "settled");
    assert.equal((await h.cp.settleCapacity(own, { ...settle, observedBytes: 2048 })).ok, false);

    const send = resources(first, "messages.submit", "conversation");
    const sender = await h.mint({
      requestId: uuid(),
      role: "client",
      grants: [{ grantId: "send", version: 1, resources: send }],
    });
    const sendAuth = await h.auth(sender.token);
    const sendOwn = await registered(h, sendAuth, send);
    assert.equal(
      (await h.cp.reserveCapacity(sendOwn, reservationInput(first, 1))).ok,
      false,
      "message authority requires registered conversation owner",
    );
    const message = value(await h.cp.reserveCapacity(sendOwn, reservationInput("conversation", 1)));
    assert.equal(
      value(
        await h.cp.settleCapacity(sendOwn, {
          reservationId: message.reservationId,
          disposition: "unused",
          observedBytes: 0,
        }),
      ).state,
      "settled",
      "minimal messages.submit grant must settle its existing admission",
    );
    const union = await h.mint({
      requestId: uuid(),
      role: "client",
      grants: [
        { grantId: "agent-only", version: 1, resources: { ...send, conversationIds: [] } },
        { grantId: "conversation-only", version: 1, resources: { ...send, agentIds: [] } },
      ],
    });
    const unionAuth = await h.auth(union.token);
    assert.equal(
      (
        await h.cp.registerAuthorityRecipient(unionAuth, {
          credential: union.credential,
          recipient: { kind: "agent", id: first },
          resources: send,
        })
      ).ok,
      false,
      "separate grants cannot be unioned into operation authority",
    );
    for (const action of ["conversations.fork", "conversations.steer", "tasks.resume"]) {
      const operation = resources(first, action, "conversation");
      const credential = await h.mint({
        requestId: uuid(),
        role: "client",
        grants: [{ grantId: uuid(), version: 1, resources: operation }],
      });
      const actor = await registered(h, await h.auth(credential.token), operation);
      const fork = action === "conversations.fork";
      const claim = value(
        await h.cp.reserveCapacity(
          actor,
          reservationInput(fork ? first : "conversation", fork ? 0 : 1),
        ),
      );
      assert.equal(
        value(
          await h.cp.settleCapacity(actor, {
            reservationId: claim.reservationId,
            disposition: "unused",
            observedBytes: 0,
          }),
        ).state,
        "settled",
        `${action} must complete its exact registered operation without capacity grants`,
      );
    }
  } finally {
    await h.close();
  }
});

test("registered completion survives new-admission pressure but each retry consumes the unchanged install and repair pools", async () => {
  const h = await harness();
  try {
    await naturalWindow();
    const admin = await h.auth(); // install/application 1
    const target = await agent(h, admin); // 2
    const create = resources(target, "conversations.create");
    const issued = [];
    for (let n = 0; n < 3; n++)
      issued.push(
        await h.mint({
          requestId: uuid(),
          role: "client",
          grants: [{ grantId: "create", version: 1, resources: create }],
        }),
      ); // +6 = 8
    const actors: D.AuthContext[] = [];
    for (const credential of issued)
      actors.push(await registered(h, await h.auth(credential.token), create)); // +6 = 14
    const owner = actors[0];
    assert.ok(owner);
    const reserved = value(await h.cp.reserveCapacity(owner, reservationInput(target))); // 15
    const counts = [8, 3, 2, 2];
    const all = [admin, ...actors];
    let admitted = 15;
    const appLimit = Math.floor(
      config.infrastructure.bounds.requestsPerInstallMinute *
        (1 - config.infrastructure.bounds.headroomFraction),
    );
    assert.equal(appLimit, 90);
    for (const [index, actor] of all.entries()) {
      while ((counts[index] ?? 0) < 30 && admitted < appLimit) {
        value(await h.cp.listAgents(actor, request("listAgents", undefined)));
        counts[index] = (counts[index] ?? 0) + 1;
        admitted++;
      }
    }
    assert.equal(admitted, 90);
    const unknown = await h.cp.settleCapacity(owner, {
      reservationId: uuid(),
      disposition: "unused",
      observedBytes: 0,
    });
    assert.equal(unknown.ok, false, "unknown claims cannot borrow completion headroom");
    if (!unknown.ok) assert.equal(unknown.code, "rate_limited");
    const denied = await h.cp.listAgents(owner, request("listAgents", undefined));
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.code, "rate_limited");
    const settle = {
      reservationId: reserved.reservationId,
      disposition: "consumed" as const,
      observedBytes: 4096,
    };
    const repairLimit = Math.floor(
      config.infrastructure.bounds.requestsPerInstallMinute *
        config.infrastructure.bounds.headroomFraction,
    );
    assert.equal(repairLimit, 30);
    for (let n = 0; n < repairLimit - 1; n++) {
      const result = await h.cp.settleCapacity(owner, settle);
      assert.equal(
        result.ok,
        true,
        "registered completion must use retained headroom after application exhaustion",
      );
      assert.equal(value(result).state, "settled");
    }
    const race = await Promise.all([
      h.cp.settleCapacity(owner, settle),
      h.cp.settleCapacity(owner, settle),
    ]);
    assert.equal(
      race.filter((result) => result.ok).length,
      1,
      "exactly one real completion RPC can take the final install/repair slot",
    );
    const rejected = race.find((result) => !result.ok);
    assert.ok(rejected && !rejected.ok);
    assert.equal(rejected.code, "rate_limited");
    const after = await h.cp.settleCapacity(owner, settle);
    assert.equal(
      after.ok,
      false,
      "reusing reservation and requestId must not mask physical retry cost",
    );
    assert.equal(await h.cp.rowCount("capacity_reservation"), 1);
  } finally {
    await h.close();
  }
});

test("retained Agent capacity rejects expired logical grants, credential floors and action escalation", async () => {
  const h = await harness();
  try {
    await naturalWindow();
    const admin = await h.auth();
    const target = await agent(h, admin);
    const create = resources(target, "conversations.create");
    const expiresAt = Date.now() + 2000;
    const issued = await h.mint({
      requestId: uuid(),
      role: "client",
      grants: [{ grantId: "short", version: 1, expiresAt, resources: create }],
    });
    const own = await registered(h, await h.auth(issued.token), create);
    const reserved = value(await h.cp.reserveCapacity(own, reservationInput(target)));
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, expiresAt - Date.now() + 20)));
    const settlement = {
      reservationId: reserved.reservationId,
      disposition: "unused" as const,
      observedBytes: 0,
    };
    assert.equal(
      (await h.cp.settleCapacity(own, settlement)).ok,
      false,
      "retained registration cannot outlive its current logical grant",
    );

    const current = await h.mint({
      requestId: uuid(),
      role: "client",
      grants: [{ grantId: "create", version: 1, resources: create }],
    });
    const auth = await h.auth(current.token);
    const registeredAuth = await registered(h, auth, create);
    const pending = value(await h.cp.reserveCapacity(registeredAuth, reservationInput(target)));
    assert.equal(
      (await h.cp.settleCapacity(registeredAuth, settlement)).ok,
      false,
      "another principal cannot claim an old reservation",
    );
    value(
      await h.cp.revokeCredential(
        admin,
        request(
          "revokeCredential",
          {
            requestId: uuid(),
            expectedGeneration: 1,
          },
          { id: current.credential.credentialId },
        ),
      ),
    );
    assert.equal(
      (
        await h.cp.settleCapacity(registeredAuth, {
          ...settlement,
          reservationId: pending.reservationId,
        })
      ).ok,
      false,
      "current CP credential floor precedes retained completion",
    );

    const broad = { ...create, actions: ["conversations.create", "messages.submit"] };
    const mixed = await h.mint({
      requestId: uuid(),
      role: "client",
      grants: [{ grantId: "mixed", version: 1, resources: broad }],
    });
    const mixedAuth = await registered(h, await h.auth(mixed.token), broad);
    assert.equal(
      (await h.cp.reserveCapacity(mixedAuth, reservationInput(target))).ok,
      false,
      "ambiguous registered actions cannot imply a capacity operation",
    );
    assert.equal(
      await h.cp.rowCount("capacity_reservation"),
      2,
      "denied completion must preserve outstanding evidence",
    );
  } finally {
    await h.close();
  }
});
