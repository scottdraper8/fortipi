import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { FortiPiError } from "../../packages/fortipi-client/dist/node.js";
import type { InfrastructurePressure } from "../../packages/fortipi-contract/dist/index.js";
import { assertKnownDeclarationRefusal } from "./live-allocation-refusals.ts";

test("allocation refusal classifies begin only; admitted stage never passes through a failed abort", async () => {
  const source = await readFile(new URL("./live-allocation-refusals.ts", import.meta.url), "utf8");
  const start = source.indexOf("      try {\n", source.indexOf("      const body =")),
    end = source.indexOf("      await unchanged();", start);
  assert.ok(start >= 0 && end > start);
  // Execute the actual error-classification boundary with controlled public
  // transport outcomes, without waiting request windows or claiming a service.
  const classify = new Function(
    "assert",
    "client",
    "module",
    "observations",
    "release",
    "assertKnownDeclarationRefusal",
    `return (async () => {
      const call = (operation) => operation();
      const workspace = { binding: { workspaceId: "owned-workspace" } };
      const body = {}, signal = undefined, resource = "file";
      const limits = {file: 4194304}, sizes = [4194305];
      ${stripTypeScriptTypes(source.slice(start, end))}
    })();`,
  );
  const pressure: InfrastructurePressure = {
    resource: "storage",
    scope: { kind: "object" },
    source: "policy",
    measurement: "estimated",
    reason: "Snapshot exceeds effective workspace bounds",
    action: "reclaim-storage",
  };
  const quotaError = () =>
    FortiPiError.remote(
      {
        code: "quota_exceeded",
        message: "Declared snapshot exceeds the workspace allocation",
        requestId: crypto.randomUUID(),
        retryable: false,
        details: { retryAfterMs: 0, pressure },
      },
      429,
    );
  async function run(admitted: boolean, abortError?: Error, beginError = quotaError()) {
    const observations: unknown[] = [];
    let released = 0,
      aborted = 0;
    const client = {
      uploads: {
        async begin() {
          if (!admitted) throw beginError;
          return { uploadId: "actual-admitted-stage" };
        },
        async abort(workspaceId: string, uploadId: string) {
          assert.equal(workspaceId, "owned-workspace");
          assert.equal(uploadId, "actual-admitted-stage");
          aborted++;
          if (abortError) throw abortError;
        },
      },
    };
    const done: Promise<void> = classify(
      assert,
      client,
      { FortiPiError },
      observations,
      async () => {
        released++;
      },
      assertKnownDeclarationRefusal,
    );
    return { done, observations, releases: () => released, aborts: () => aborted };
  }
  const refused = await run(false);
  await refused.done;
  assert.deepEqual(refused.observations, [
    {
      resource: "file",
      limit: 4194304,
      declared: 4194305,
      status: 429,
      code: "quota_exceeded",
      retryable: false,
      pressure,
    },
  ]);
  assert.equal(refused.releases(), 1);
  assert.equal(refused.aborts(), 0);
  for (const abortError of [
    undefined,
    quotaError(),
    new FortiPiError("workspace.conflict", { status: 409 }),
  ]) {
    const accepted = await run(true, abortError);
    await assert.rejects(accepted.done, /Above-allocation upload was admitted/);
    assert.deepEqual(accepted.observations, []);
    assert.equal(accepted.releases(), 1);
    assert.equal(accepted.aborts(), 1);
  }
  const missingPressure = await run(
    false,
    undefined,
    new FortiPiError("quota_exceeded", {
      status: 429,
      retryable: false,
      details: { retryAfterMs: 0 },
    }),
  );
  await assert.rejects(missingPressure.done, assert.AssertionError);
  assert.deepEqual(missingPressure.observations, []);
  assert.equal(missingPressure.releases(), 1);
  assert.equal(missingPressure.aborts(), 0);
});
