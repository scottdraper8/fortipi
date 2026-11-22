import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { pause } from "../agent/harness.ts";
import { nativeService } from "./native-service.ts";

test("actual native dispatch retains its CP reservation Agent registration and exact tool grant", {
  timeout: 35000,
}, async () => {
  const n = await nativeService();
  try {
    let starts = "";
    for (let i = 0; i < 800; i++) {
      try {
        starts = await readFile(n.marker, "utf8");
      } catch {}
      if (starts) break;
      await pause(30);
    }
    assert.ok(starts);
    const input = JSON.parse(await n.probe.registrationDebugInput(n.job.jobId)) as {
      auth: D.AuthContext;
      identity: D.ExecutionIdentity;
    };
    const facts = JSON.parse(
      await n.h.env.CONTROL_PLANE.getByName("control").registrationDebug(
        input.auth,
        input.identity,
      ),
    ) as {
      isReservationAgent: boolean;
      registrationScope: D.ResourceScope;
      required: D.ResourceScope;
      oneGrant: boolean;
      credentialMatches: boolean;
    };
    console.log(JSON.stringify(facts));
    assert.equal(facts.isReservationAgent, true);
    assert.deepEqual(facts.registrationScope.tools, []);
    assert.deepEqual(facts.required.tools, ["shell"]);
    assert.equal(facts.oneGrant, true);
    assert.equal(facts.credentialMatches, true);
  } finally {
    await n.close();
  }
});
