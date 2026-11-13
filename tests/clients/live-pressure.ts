import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { Installed } from "../distribution/install.ts";
import type { ScenarioEvidence } from "./evidence.ts";
import type { RoleContext } from "./roles.ts";

/** Bounded read-only public refusal/recovery using ordinary public policy
 * discovery. No test quota or deployment configuration is installed. */
export async function publicRequestPressure(input: {
  installed: Pick<Installed, "candidate" | "resolveExport">;
  roles: RoleContext;
  agentId: string;
}): Promise<ScenarioEvidence> {
  const role = await input.roles.issue({
    requestId: randomUUID(),
    role: "client",
    expiresAt: Date.now() + 300000,
    grants: [
      {
        grantId: randomUUID(),
        version: 1,
        resources: {
          agentIds: [input.agentId],
          conversationIds: [],
          workspaceIds: [],
          executorIds: [],
          backendIds: [],
          tools: [],
          actions: ["agents.read"],
        },
      },
    ],
  });
  const module = (await import(
    pathToFileURL(
      input.installed.resolveExport(`@${input.installed.candidate.scope}/fortipi-client/node`),
    ).href
  )) as typeof import("../../packages/fortipi-client/dist/node.js");
  const client = new module.FortiPiClient({
    endpoint: input.roles.endpoint,
    credentials: async () => role.token,
    allowLoopbackHttp: new URL(input.roles.endpoint).protocol === "http:",
  });
  const signal = AbortSignal.timeout(150000);
  const protocol = await client.negotiate(signal);
  const bounds = protocol.infrastructure.bounds;
  // This probe does not generate an unbounded load against operator settings.
  // A different policy requires separate reviewed evidence, never an override.
  assert.ok(
    Number.isSafeInteger(bounds.requestsPerPrincipalMinute) &&
      bounds.requestsPerPrincipalMinute > 0 &&
      bounds.requestsPerPrincipalMinute <= 30,
    "Bounded pressure probe requires an actual principal policy at most30/minute",
  );
  const read = () => client.agents.get(input.agentId, { signal });
  const original = await read();
  let acceptedReads = 1;
  let refusal: InstanceType<typeof module.FortiPiError> | undefined;
  // A short read sequence may straddle one window edge. Bound it to two
  // declared principal allocations rather than guessing the server's epoch.
  for (let attempt = 0; attempt <= 2 * bounds.requestsPerPrincipalMinute; attempt++) {
    try {
      assert.deepEqual(await read(), original);
      acceptedReads++;
    } catch (error) {
      if (!(error instanceof module.FortiPiError)) throw error;
      assert.equal(error.status, 429);
      assert.equal(error.code, "rate_limited");
      assert.equal(error.retryable, true);
      refusal = error;
      break;
    }
  }
  assert.ok(refusal, "Real bounded public reads must encounter the configured request window");
  const retryAfterMs = Math.max(refusal.retryAfterMs ?? 0, refusal.details?.retryAfterMs ?? 0);
  assert.ok(
    Number.isSafeInteger(retryAfterMs) && retryAfterMs > 0 && retryAfterMs <= 60000,
    "Real retry-later refusal must carry a bounded public retry interval",
  );
  const waiting = performance.now();
  await delay(retryAfterMs, undefined, { signal });
  assert.ok(performance.now() - waiting >= retryAfterMs - 1);
  assert.deepEqual(await read(), original);
  const evidence: ScenarioEvidence = {
    observation: {
      configuredPrincipalPerMinute: bounds.requestsPerPrincipalMinute,
      configuredInstallPerMinute: bounds.requestsPerInstallMinute,
      acceptedReads,
      refusedStatus: refusal.status,
      refusedCode: refusal.code,
      declaredRetryAfterMs: retryAfterMs,
      actualWaitMs: Math.round(performance.now() - waiting),
      originalAgentId: original.agentId,
      sameAgentAfterWindowRecovery: true,
      readOnlyOperations: true,
      policyChanged: false,
    },
    oracle:
      "A bounded actual read-only public request sequence reaches retryable429 with a declared wait; waiting that interval restores the same scoped resource without changing policy or creating work",
    sensitivity: [
      "The actual public request window refuses work before recovery; missing429 or missing positive retry guidance fails",
    ],
    limitations: [
      "Application admission rate only; provider/account daily exhaustion, SQL/storage/CPU limits and shared headroom remain unobserved",
      "Internal authorization/repair traffic also consumes request capacity; HTTP read count is not a one-to-one counter oracle or attribution of which request scope exhausted",
      "Local execution qualifies this public scenario only; actual deployed observation requires the authenticated unchanged target",
    ],
  };
  input.roles.assertSanitized(evidence);
  return evidence;
}
