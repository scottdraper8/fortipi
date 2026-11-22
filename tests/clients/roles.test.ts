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
