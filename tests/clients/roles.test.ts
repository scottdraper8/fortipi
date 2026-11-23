import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { RoleContext } from "./roles.ts";

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
  let issued = 0,
    status = 200,
    responseBody: unknown = complete(2),
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
      const match = /^\/v1\/admin\/credentials\/(synthetic-role-[12])\/revoke$/.exec(
        request.url ?? "",
      );
      assert.ok(match);
      const id = match[1];
      assert.ok(id);
      requests.set(id, [...(requests.get(id) ?? []), body]);
      assert.equal(body.expectedGeneration, 1);
      assert.equal(typeof body.requestId, "string");
      response.writeHead(id === "synthetic-role-1" ? 200 : status, {
        "Content-Type": "application/json",
      });
      response.end(JSON.stringify(id === "synthetic-role-1" ? complete(1) : responseBody));
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
    const incomplete = async () => {
      assert.deepEqual(await roles.cleanup(), [
        { credentialId: firstId, generation: 1, state: "complete", pendingRecipients: 0 },
        { credentialId: laterId, generation: 1, state: "unknown", pendingRecipients: null },
      ]);
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
      await incomplete();
    }
    status = 202;
    responseBody = complete(2);
    await incomplete();
    status = 503;
    await incomplete();
    status = 200;
    responseBody = complete(2);
    const finished = await roles.cleanup();
    assert.equal(requests.get(laterId)?.length, ++calls);
    assert.deepEqual(finished, [
      { credentialId: firstId, generation: 1, state: "complete", pendingRecipients: 0 },
      { credentialId: laterId, generation: 1, state: "complete", pendingRecipients: 0 },
    ]);
    const laterObservation = finished[1];
    assert.ok(laterObservation);
    laterObservation.state = "unknown";
    assert.equal((await roles.cleanup())[1]?.state, "complete");
    assert.equal(requests.get(laterId)?.length, calls);
    assert.equal(requests.get(firstId)?.length, 1);
    assert.equal(new Set(requests.get(laterId)?.map((r) => r.requestId)).size, 1);
    assert.equal(serverFailure, undefined);
  } finally {
    await new Promise<void>((accept, reject) =>
      server.close((error) => (error ? reject(error) : accept())),
    );
  }
});
