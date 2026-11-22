import assert from "node:assert/strict";
import { test } from "node:test";
import { object } from "../../../../scripts/verify-release-gates.ts";
import { observeComputerDeclaration } from "../../../../tests/clients/live-infrastructure-controls.ts";
import { RoleContext } from "../../../../tests/clients/roles.ts";
import {
  localDeclarationProbe,
  produceDefaultComputerDeclarations,
  runLocalInfrastructureDetails,
} from "./infrastructure-local.ts";
import { start } from "./runtime.ts";

test("LOCAL public Computer staging/history and CP retained cleanup preserve bounds, identities and possible effects", {
  timeout: 90000,
}, async () => {
  const observed = await runLocalInfrastructureDetails();
  // Numeric/hashes/public IDs only; never profile/token/request headers.
  console.log(JSON.stringify(observed));
});

test("actual default Computer declarations distinguish the pool, preserve same-workspace bytes and reject unrelated refusal or uncertain cleanup", {
  timeout: 90000,
}, async (t) => {
  const observed = await produceDefaultComputerDeclarations();
  const runtime = await start(),
    roles = new RoleContext(runtime.endpoint, runtime.admin);
  let changedQuota = 0,
    changedTerminal = 0,
    corruptReason = false,
    hideTerminal = false,
    deletedPath: string | undefined;
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const response = await fetch(input, init);
    if (
      corruptReason &&
      method === "POST" &&
      url.pathname.endsWith("/uploads") &&
      response.status === 429
    ) {
      const body = object(await response.clone().json());
      const pressure = object(object(object(body.error).details).pressure);
      assert.equal(
        pressure.reason,
        "Workspace physical copies and unspent growth exhaust the shared pool",
      );
      pressure.reason = "Unrelated storage refusal";
      changedQuota++;
      return Response.json(body, { status: response.status });
    }
    if (hideTerminal && method === "DELETE" && /\/uploads\/[^/]+$/.test(url.pathname))
      deletedPath = url.pathname;
    if (hideTerminal && method === "GET" && url.pathname === deletedPath && response.ok) {
      const body = object(await response.clone().json());
      assert.equal(body.state, "aborted");
      body.state = "open";
      hideTerminal = false;
      changedTerminal++;
      return Response.json(body, { status: response.status });
    }
    return response;
  };

  try {
    const snapshotProbe = await localDeclarationProbe(runtime, roles, "snapshot", 0, transport);
    corruptReason = true;
    try {
      await assert.rejects(observeComputerDeclaration(snapshotProbe), /Unrelated storage refusal/);
    } finally {
      corruptReason = false;
    }
    assert.equal(changedQuota, 1, "Intended actual HTTP refusal response changed");
    hideTerminal = true;
    await assert.rejects(
      observeComputerDeclaration(snapshotProbe),
      /Unknown or nonterminal upload cleanup/,
    );
    assert.equal(changedTerminal, 1, "Actual terminal-state GET changed after actual DELETE");
  } finally {
    try {
      const cleanup = await roles.cleanup();
      assert.ok(cleanup.every((row) => row.state === "complete" && row.pendingRecipients === 0));
    } finally {
      await runtime.dispose();
    }
  }
  t.diagnostic(JSON.stringify(observed));
});
