import assert from "node:assert/strict";
import test from "node:test";
import { harness, request } from "./harness.ts";

test("internal CP implementation helpers are unreachable over actual Durable Object RPC", async () => {
  const h = await harness();
  try {
    const ctx = await h.auth();
    await assert.rejects(
      async () =>
        Reflect.apply(Reflect.get(h.cp, "listAgentsValue"), h.cp, [
          ctx,
          request("listAgents", undefined),
        ]),
      /does not implement|no such method|not a function|not implemented/i,
      "internal list implementation must not create an unmetered RPC entrypoint",
    );
    await assert.rejects(
      async () => Reflect.apply(Reflect.get(h.cp, "call"), h.cp, []),
      /does not implement|no such method|not a function|not implemented/i,
      "internal admission callback helper must not be an RPC entrypoint",
    );
    const response = await h.cp.handleApi(ctx, request("listAgents", undefined));
    assert.equal(response.ok, true, "existing public typed aggregate remains usable");
  } finally {
    await h.close();
  }
});
