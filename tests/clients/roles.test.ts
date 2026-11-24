import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { type CleanupDiagnostic, projectCleanupDiagnostic, RoleContext } from "./roles.ts";

test("role evidence rejects JSON-escaped synthetic credentials while allowing public references", async () => {
  const admin = "synthetic-coordinator-canary-1010".repeat(2);
  const token = `${"synthetic-role-canary-1010".repeat(2)}"\\tail`;
  const credential = { credentialId: "synthetic-public-role", generation: 1, grantVersion: 1 };
  // Only the sanitizer/issuance seam is under test; no real role or service is used.
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${admin}`);
    request.resume();
    response.writeHead(201, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ state: "issued", role: "client", credential, token }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const roles = new RoleContext(`http://127.0.0.1:${address.port}`, admin);
    const issued = await roles.issue({ requestId: "synthetic-mint", role: "client", grants: [] });
    const secondContext = new RoleContext(`http://127.0.0.1:${address.port}`, admin);
    secondContext.assertSanitized({ nested: { token } });
    roles.assertSanitized({ credential: issued.credential, outcome: "redacted" });
    for (const value of [
      { nested: { token } },
      { diagnostic: `prefix:${token}:suffix` },
      { admin },
    ]) {
      assert.throws(() => roles.assertSanitized(value), /Credential appeared in evidence/);
      assert.throws(
        () => secondContext.assertSanitized(value, [token]),
        /Credential appeared in evidence/,
      );
    }
  } finally {
    await new Promise<void>((accept, reject) =>
      server.close((error) => (error ? reject(error) : accept())),
    );
  }
});

test("role cleanup reuses only complete receipts while rescanning owned roles", async () => {
  // Coordinator HTTP model only: no real credential, authority, provider or durable runtime.
  const admin = "synthetic-cleanup-coordinator".repeat(2);
  const complete = (n: number) => ({
    operationId: `synthetic-operation-${n}`,
    revocationId: `synthetic-revocation-${n}`,
    state: "complete",
    pendingRecipients: [],
  });
  const requests = new Map<string, { requestId: string; expectedGeneration: number }[]>();
  const requestTimes = new Map<string, number[]>();
  const replies: { status: number; body: unknown; retryAfter?: string | string[] }[] = [];
  let issued = 0,
    status = 200,
    responseBody: unknown = complete(2),
    retryAfter: string | string[] | undefined,
    responseDelayMs = 0,
    dropResponse = false,
    unreadableJson = false,
    serverFailure: unknown;
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.headers.authorization, `Bearer ${admin}`);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (request.url === "/v1/admin/credentials") {
        issued++;
        response.writeHead(201, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            state: "issued",
            role: "client",
            credential: {
              credentialId: `synthetic-role-${issued}`,
              generation: 1,
              grantVersion: 1,
            },
            token: `synthetic-role-token-${issued}`,
          }),
        );
        return;
      }
      const match = /^\/v1\/admin\/credentials\/(synthetic-role-\d+)\/revoke$/.exec(
        request.url ?? "",
      );
      assert.ok(match);
      const id = match[1];
      assert.ok(id);
      requests.set(id, [...(requests.get(id) ?? []), body]);
      requestTimes.set(id, [...(requestTimes.get(id) ?? []), performance.now()]);
      assert.equal(body.expectedGeneration, 1);
      assert.equal(typeof body.requestId, "string");
      if (dropResponse) {
        response.destroy();
        return;
      }
      const reply = replies.shift();
      const header = reply ? reply.retryAfter : retryAfter;
      response.writeHead(id === "synthetic-role-1" ? 200 : (reply?.status ?? status), {
        "Content-Type": "application/json",
        ...(header === undefined ? {} : { "Retry-After": header }),
      });
      if (responseDelayMs) {
        response.flushHeaders();
        await new Promise<void>((accept) => setTimeout(accept, responseDelayMs));
      }
      response.end(
        unreadableJson
          ? "{"
          : JSON.stringify(id === "synthetic-role-1" ? complete(1) : (reply?.body ?? responseBody)),
      );
    } catch (error) {
      serverFailure ??= error;
      response.writeHead(500);
      response.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const endpoint = `http://127.0.0.1:${address.port}`;
    const roles = new RoleContext(endpoint, admin);
    assert.deepEqual(await roles.cleanup(), []);
    const first = await roles.issue({ requestId: "synthetic-first", role: "client", grants: [] });
    const firstId = first.credential.credentialId;
    const observed = await roles.revokeAndWait(firstId);
    assert.deepEqual(observed, complete(1));
    const firstRequest = requests.get(firstId)?.[0];
    assert.ok(firstRequest);
    assert.notEqual(observed.operationId, firstRequest.requestId);
    observed.operationId = "synthetic-caller-mutation";
    observed.pendingRecipients.push({ kind: "agent", id: "synthetic-caller" });
    assert.deepEqual(await roles.cleanup(), [
      { credentialId: firstId, generation: 1, state: "complete", pendingRecipients: 0 },
    ]);
    const reused = await roles.revoke(firstId);
    assert.deepEqual(reused, complete(1));
    reused.revocationId = "synthetic-other-mutation";
    assert.deepEqual(await roles.revoke(firstId), complete(1));
    assert.deepEqual(await roles.revoke(firstId, 0), complete(1));
    assert.deepEqual(await roles.revokeAndWait(firstId, 0), complete(1));
    assert.equal(requests.get(firstId)?.length, 1);
    assert.equal(Reflect.set(roles, "endpoint", "http://localhost:1"), false);
    await assert.rejects(new RoleContext(endpoint, admin).revoke(firstId));

    const later = await roles.issue({ requestId: "synthetic-later", role: "client", grants: [] });
    const laterId = later.credential.credentialId;
    later.credential.credentialId = "synthetic-altered-role";
    later.credential.generation = 99;
    later.token = "synthetic-altered-token";
    await assert.rejects(roles.revoke(later.credential.credentialId));
    assert.throws(() => roles.assertSanitized({ token: "synthetic-role-token-2" }));
    responseBody = {
      ...complete(2),
      state: "pending",
      pendingRecipients: [{ kind: "agent", id: "synthetic-recipient" }],
    };
    status = 202;
    assert.equal((await roles.revoke(laterId)).state, "pending");
    assert.equal((await roles.revoke(laterId)).state, "pending");
    assert.equal(requests.get(laterId)?.length, 2, "Pending receipts cannot suppress a call");
    let calls = 2;
    const diagnostics: CleanupDiagnostic[] = [];
    const observe = (diagnostic: CleanupDiagnostic) => {
      diagnostics.push(diagnostic);
      throw new Error("synthetic-observer-canary");
    };
    const incomplete = async (category: CleanupDiagnostic["category"]) => {
      diagnostics.length = 0;
      assert.deepEqual(await roles.cleanup(observe), [
        { credentialId: firstId, generation: 1, state: "complete", pendingRecipients: 0 },
        { credentialId: laterId, generation: 1, state: "unknown", pendingRecipients: null },
      ]);
      assert.deepEqual(diagnostics, [{ category, status, pendingRecipients: null }]);
      assert.equal(requests.get(laterId)?.length, ++calls);
    };
    status = 200;
    for (const malformed of [
      { state: "complete", pendingRecipients: [] },
      { ...complete(2), operationId: 2 },
      { ...complete(2), extra: true },
      { ...complete(2), pendingRecipients: [{ kind: "agent", id: "synthetic-recipient" }] },
      { ...complete(2), state: "pending" },
    ]) {
      responseBody = malformed;
      await incomplete("invalid-receipt");
    }
    status = 202;
    responseBody = complete(2);
    await incomplete("invalid-receipt");
    status = 503;
    await incomplete("http-non-ok");
    status = 200;
    unreadableJson = true;
    await incomplete("json-read-failure");
    unreadableJson = false;

    // Instance-only seams inspect default/shared deadlines without advancing a global clock.
    const wait = roles.revokeAndWait;
    const revoke = roles.revoke;
    let getterInvoked = false;
    try {
      const before = Date.now();
      let publicDeadline: number | undefined;
      roles.revoke = async (id, deadline) => {
        publicDeadline = deadline;
        return revoke.call(roles, id, deadline);
      };
      assert.deepEqual(await roles.revokeAndWait(firstId), complete(1));
      assert.ok(publicDeadline && publicDeadline >= before + 15000);
      assert.ok(publicDeadline <= Date.now() + 15000);
      roles.revoke = revoke;
      await assert.rejects(roles.revoke(laterId, Date.now() - 1));
      assert.equal(requests.get(laterId)?.length, calls, "Expired budgets cannot send");
      const pending = {
        ...complete(2),
        state: "pending" as const,
        pendingRecipients: [{ kind: "agent" as const, id: "synthetic-recipient" }],
      };
      roles.revokeAndWait = async (id) => (id === laterId ? pending : wait.call(roles, id));
      diagnostics.length = 0;
      assert.deepEqual(await roles.cleanup(observe), [
        { credentialId: firstId, generation: 1, state: "complete", pendingRecipients: 0 },
        { credentialId: laterId, generation: 1, state: "pending", pendingRecipients: 1 },
      ]);
      assert.deepEqual(diagnostics, [{ category: "pending", status: null, pendingRecipients: 1 }]);
      const unknown = Object.defineProperty(new Error("synthetic-error-canary"), "category", {
        get() {
          getterInvoked = true;
          return "http-non-ok";
        },
      });
      const sharedDeadlines: (number | undefined)[] = [];
      const cleanupStarted = Date.now();
      roles.revokeAndWait = async (id, deadline) => {
        sharedDeadlines.push(deadline);
        if (id === firstId) throw unknown;
        return pending;
      };
      diagnostics.length = 0;
      assert.deepEqual(await roles.cleanup(observe), [
        { credentialId: firstId, generation: 1, state: "unknown", pendingRecipients: null },
        { credentialId: laterId, generation: 1, state: "pending", pendingRecipients: 1 },
      ]);
      assert.deepEqual(diagnostics, [
        { category: "unknown", status: null, pendingRecipients: null },
        { category: "pending", status: null, pendingRecipients: 1 },
      ]);
      assert.equal(getterInvoked, false);
      assert.equal(requests.get(laterId)?.length, calls);
      assert.equal(sharedDeadlines.length, 2);
      assert.equal(new Set(sharedDeadlines).size, 1);
      assert.ok(sharedDeadlines[0] && sharedDeadlines[0] >= cleanupStarted + 90000);
      assert.ok(sharedDeadlines[0] <= Date.now() + 90000);
    } finally {
      roles.revokeAndWait = wait;
      roles.revoke = revoke;
    }

    // Short, actual local HTTP waits model the wire contract; no real quota window is slept.
    const rateLimited = (retryAfterMs: unknown = 20) => ({
      error: {
        code: "rate_limited",
        message: `synthetic-refusal ${admin} synthetic-role-token-2`,
        requestId: "synthetic-server-request",
        retryable: true,
        details: { retryAfterMs },
      },
    });
    const newRole = async (context: RoleContext) =>
      (await context.issue({ requestId: "synthetic-wait-case", role: "client", grants: [] }))
        .credential.credentialId;
    for (const header of [undefined, "1"]) {
      const context = new RoleContext(endpoint, admin);
      const id = await newRole(context);
      replies.push(
        { status: 429, body: rateLimited(), ...(header ? { retryAfter: header } : {}) },
        { status: 200, body: complete(issued) },
      );
      const expected = complete(issued);
      assert.deepEqual(await context.revokeAndWait(id, Date.now() + 3000), expected);
      const received = requestTimes.get(id);
      assert.ok(received?.[0] !== undefined && received[1] !== undefined);
      assert.ok(received[1] - received[0] >= (header ? 1000 : 20) - 1);
      assert.equal(requests.get(id)?.length, 2);
      assert.deepEqual(requests.get(id)?.[0], requests.get(id)?.[1]);
      assert.deepEqual(await context.revokeAndWait(id, 0), expected);
      assert.equal(requests.get(id)?.length, 2, "Complete cache survives deadline expiry");
      assert.equal(replies.length, 0);
    }
    const invalidRefusals = [
      {},
      { ...rateLimited(), extra: true },
      { error: { ...rateLimited().error, requestId: undefined } },
      { error: { ...rateLimited().error, retryable: false } },
      { error: { ...rateLimited().error, retryable: "true" } },
      { error: { ...rateLimited().error, code: "unavailable" } },
      { error: { ...rateLimited().error, code: "invalid_request" } },
      { error: { ...rateLimited().error, details: undefined } },
      ...[0, -1, 0.5, "20", 86400001, null].map(rateLimited),
      {
        error: {
          ...rateLimited().error,
          details: { retryAfterMs: 20, requiredCapability: "loader" },
        },
      },
      {
        error: { ...rateLimited().error, details: { retryAfterMs: 20, setup: "synthetic-setup" } },
      },
    ];
    status = 429;
    for (const refusal of invalidRefusals) {
      const context = new RoleContext(endpoint, admin);
      const id = await newRole(context);
      const nativeWait = context.revokeAndWait;
      const deadline = Date.now() + 200;
      context.revokeAndWait = (ownedId) => nativeWait.call(context, ownedId, deadline);
      responseBody = refusal;
      diagnostics.length = 0;
      assert.deepEqual(await context.cleanup(observe), [
        { credentialId: id, generation: 1, state: "unknown", pendingRecipients: null },
      ]);
      assert.deepEqual(diagnostics, [
        { category: "http-non-ok", status: 429, pendingRecipients: null },
      ]);
      assert.equal(requests.get(id)?.length, 1, "Invalid instructions cannot authorize a retry");
      context.assertSanitized(diagnostics, ["synthetic-role-token-2"]);
    }
    responseBody = rateLimited();
    for (const header of [
      "nonsense",
      "-1",
      "0.02",
      "1, 2",
      ["1", "2"],
      "Wed, 21 Oct 2037 07:28:00 GMT",
      "86401",
      "99999999999999999999999999",
    ]) {
      const context = new RoleContext(endpoint, admin);
      const id = await newRole(context);
      retryAfter = header;
      await assert.rejects(context.revokeAndWait(id, Date.now() + 200));
      assert.equal(requests.get(id)?.length, 1, "Unsupported Retry-After cannot be ignored");
    }
    retryAfter = undefined;
    for (const otherStatus of [400, 401, 403, 408, 500, 503]) {
      const context = new RoleContext(endpoint, admin);
      const id = await newRole(context);
      status = otherStatus;
      await assert.rejects(context.revokeAndWait(id, Date.now() + 200));
      assert.equal(requests.get(id)?.length, 1, "A retryable body cannot override HTTP status");
    }
    status = 429;
    for (const [delayMs, header] of [
      [60000, undefined],
      [20, "60"],
      [86400000, undefined],
    ] as const) {
      const context = new RoleContext(endpoint, admin);
      const id = await newRole(context);
      responseBody = rateLimited(delayMs);
      retryAfter = header;
      const began = performance.now();
      await assert.rejects(context.revokeAndWait(id, Date.now() + 100));
      assert.ok(performance.now() - began < 1000, "Over-budget waits must fail without sleeping");
      assert.equal(requests.get(id)?.length, 1);
    }
    retryAfter = undefined;
    responseBody = rateLimited();
    {
      const context = new RoleContext(endpoint, admin);
      const id = await newRole(context);
      unreadableJson = true;
      await assert.rejects(context.revokeAndWait(id, Date.now() + 200));
      unreadableJson = false;
      assert.equal(requests.get(id)?.length, 1, "Malformed JSON cannot authorize a retry");
      dropResponse = true;
      await assert.rejects(context.revokeAndWait(id, Date.now() + 200));
      dropResponse = false;
      assert.equal(requests.get(id)?.length, 2, "Uncertain transport cannot authorize a retry");
      await assert.rejects(
        context.call({
          operationId: "revokeCredential",
          path: { id },
          query: {},
          body: { requestId: "synthetic-unowned-call", expectedGeneration: 1 },
        }),
      );
      assert.equal(requests.get(id)?.length, 3, "The generic call path cannot retry");
    }
    {
      const context = new RoleContext(endpoint, admin);
      const id = await newRole(context);
      const pending = {
        ...complete(issued),
        state: "pending",
        pendingRecipients: [{ kind: "agent", id: "synthetic-recipient" }],
      };
      replies.push({ status: 202, body: pending }, { status: 200, body: complete(issued) });
      assert.deepEqual(await context.revokeAndWait(id, Date.now() + 1000), complete(issued));
      const received = requestTimes.get(id);
      assert.ok(received?.[0] !== undefined && received[1] !== undefined);
      assert.ok(received[1] - received[0] >= 99, "Pending polling retains its 100 ms interval");
      assert.equal(requests.get(id)?.length, 2);
      const unresolved = new RoleContext(endpoint, admin);
      const unresolvedId = await newRole(unresolved);
      status = 202;
      responseBody = pending;
      assert.deepEqual(await unresolved.revokeAndWait(unresolvedId, Date.now() + 80), pending);
      assert.equal(requests.get(unresolvedId)?.length, 1, "No poll/sleep fits after this receipt");
      assert.deepEqual(await unresolved.revoke(unresolvedId), pending);
      assert.equal(requests.get(unresolvedId)?.length, 2, "Pending is never cached as complete");
    }
    {
      const context = new RoleContext(endpoint, admin);
      const slowId = await newRole(context);
      const untouchedId = await newRole(context);
      const cachedId = await newRole(context);
      status = 200;
      responseBody = complete(issued);
      await context.revoke(cachedId);
      const nativeWait = context.revokeAndWait;
      const sharedDeadlines: (number | undefined)[] = [];
      const shortDeadline = Date.now() + 200;
      context.revokeAndWait = (id, deadline) => {
        sharedDeadlines.push(deadline);
        // Shorten the one budget at this instance seam; retain real HTTP and timers.
        return nativeWait.call(context, id, shortDeadline);
      };
      responseDelayMs = 400;
      diagnostics.length = 0;
      const began = performance.now();
      assert.deepEqual(await context.cleanup(observe), [
        { credentialId: slowId, generation: 1, state: "unknown", pendingRecipients: null },
        { credentialId: untouchedId, generation: 1, state: "unknown", pendingRecipients: null },
        { credentialId: cachedId, generation: 1, state: "complete", pendingRecipients: 0 },
      ]);
      assert.ok(performance.now() - began < 1500, "Body reads share the remaining request budget");
      responseDelayMs = 0;
      assert.equal(sharedDeadlines.length, 3, "Cleanup accounts for every owned role after expiry");
      assert.equal(new Set(sharedDeadlines).size, 1, "Roles must not receive fresh budgets");
      assert.equal(requests.get(slowId)?.length, 1);
      assert.equal(requests.has(untouchedId), false);
      assert.equal(requests.get(cachedId)?.length, 1);
      assert.deepEqual(diagnostics, [
        { category: "json-read-failure", status: 200, pendingRecipients: null },
        { category: "unknown", status: null, pendingRecipients: null },
      ]);
    }

    status = 200;
    responseBody = complete(2);
    diagnostics.length = 0;
    const finished = await roles.cleanup(observe);
    assert.deepEqual(diagnostics, []);
    assert.equal(requests.get(laterId)?.length, ++calls);
    assert.deepEqual(finished, [
      { credentialId: firstId, generation: 1, state: "complete", pendingRecipients: 0 },
      { credentialId: laterId, generation: 1, state: "complete", pendingRecipients: 0 },
    ]);
    const laterObservation = finished[1];
    assert.ok(laterObservation);
    laterObservation.state = "unknown";
    assert.equal((await roles.cleanup(observe))[1]?.state, "complete");
    assert.deepEqual(diagnostics, []);
    assert.equal(requests.get(laterId)?.length, calls);
    assert.equal(requests.get(firstId)?.length, 1);
    assert.equal(new Set(requests.get(laterId)?.map((r) => r.requestId)).size, 1);
    assert.equal(serverFailure, undefined);
    const valid = { category: "http-non-ok", status: 503, pendingRecipients: null };
    assert.deepEqual(projectCleanupDiagnostic(valid), valid);
    assert.deepEqual(
      projectCleanupDiagnostic({ category: "pending", status: null, pendingRecipients: 100 }),
      { category: "pending", status: null, pendingRecipients: 100 },
    );
    const accessor = Object.defineProperty({ ...valid }, "status", {
      get() {
        getterInvoked = true;
        return 503;
      },
    });
    for (const unsafe of [
      null,
      "synthetic-diagnostic-canary",
      { ...valid, category: "synthetic-category-canary" },
      { ...valid, extra: "synthetic-extra-canary" },
      Object.create(valid),
      accessor,
      { ...valid, status: "503" },
      { ...valid, status: 99 },
      { ...valid, status: 600 },
      { ...valid, status: NaN },
      { ...valid, pendingRecipients: -1 },
      { ...valid, pendingRecipients: 101 },
      { ...valid, pendingRecipients: 0.5 },
      { ...valid, pendingRecipients: {} },
      { ...valid, pendingRecipients: "1" },
    ])
      assert.equal(projectCleanupDiagnostic(unsafe), null);
    assert.equal(getterInvoked, false);
  } finally {
    await new Promise<void>((accept, reject) =>
      server.close((error) => (error ? reject(error) : accept())),
    );
  }
});
