import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./harness.ts";

test("public SQLite ceiling and nested transaction reachability on actual workerd", async () => {
  const h = await harness();
  try {
    const probe = h.env.AGENT_SESSIONS.getByName("isolated-ceiling-reachability");
    const result = JSON.parse(await probe.physicalCeilingReachability()) as {
      pragma: string;
      nested: string;
      rolledBack: boolean;
      totalSqlBytes: number;
    };
    console.log(JSON.stringify(result));
    assert.ok(result.rolledBack, "A rejected outer transaction must retain no canary row");
    // Characterization only: neither outcome establishes a production all-writer ceiling.
    assert.ok(result.totalSqlBytes > 0);
  } finally {
    await h.close();
  }
});
