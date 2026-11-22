import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "../agent/harness.ts";

test("actual workerd RPC cannot invoke Agent internal helpers", async () => {
  const h = await harness();
  try {
    const stub = h.env.AGENT_SESSIONS.getByName("private-probe") as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    for (const method of [
      "models",
      "selectedModel",
      "installSelectedModel",
      "selectModel",
      "arm",
      "notify",
      "drain",
      "flushHints",
      "resource",
      "reconcile",
      "guardUpgrade",
      "socketAuthority",
      "attachSocket",
      "socketContext",
      "send",
      "message",
      "deliver",
    ]) {
      await assert.rejects(
        async () => {
          const call = stub[method];
          assert.ok(call);
          return call();
        },
        (error) =>
          typeof error === "object" &&
          error !== null &&
          "message" in error &&
          /does not implement|not found|not a function|not.*callable|does not exist/.test(
            String(error.message),
          ),
        `${method} must be absent, not merely fail later inside an exposed helper`,
      );
    }
  } finally {
    await h.close();
  }
});
