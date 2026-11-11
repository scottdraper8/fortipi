import assert from "node:assert/strict";
import test from "node:test";
import { harness, request, uuid } from "./harness.ts";

test("missing dedicated model key denies OAuth and never derives encryption from bootstrap", async () => {
  const h = await harness({ modelAuthKey: null });
  try {
    const admin = await h.auth();
    const result = await h.cp.putProviderAuth(
      admin,
      request(
        "putProviderAuth",
        {
          requestId: uuid(),
          expectedVersion: null,
          credential: {
            type: "oauth",
            access: "synthetic-access",
            refresh: "synthetic-refresh",
            expires: 0,
            providerFields: { clientId: "synthetic-client", scopes: ["chatgpt.tokens.use.direct"] },
          },
        },
        { providerId: "openai" },
      ),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "unsupported");
    assert.equal(await h.cp.encryptedRows(), "[]");
  } finally {
    await h.close();
  }
});
