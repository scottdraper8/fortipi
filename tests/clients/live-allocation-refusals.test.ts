import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

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
    `return (async () => {
      const call = (operation) => operation();
      const workspace = { binding: { workspaceId: "owned-workspace" } };
      const body = {}, signal = undefined, resource = "file";
      const limits = {file: 4194304}, sizes = [4194305];
      ${stripTypeScriptTypes(source.slice(start, end))}
    })();`,
  );
  class FortiPiError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(status: number, code: string) {
      super(code);
      this.status = status;
      this.code = code;
    }
  }
  async function run(admitted: boolean, abortError?: Error) {
    const observations: unknown[] = [];
    let released = 0,
      aborted = 0;
    const client = {
      uploads: {
        async begin() {
          if (!admitted) throw new FortiPiError(429, "quota_exceeded");
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
    },
  ]);
  assert.equal(refused.releases(), 1);
  assert.equal(refused.aborts(), 0);
  for (const abortError of [
    undefined,
    new FortiPiError(429, "quota_exceeded"),
    new FortiPiError(409, "workspace.conflict"),
  ]) {
    const accepted = await run(true, abortError);
    await assert.rejects(accepted.done, /Above-allocation upload was admitted/);
    assert.deepEqual(accepted.observations, []);
    assert.equal(accepted.releases(), 1);
    assert.equal(accepted.aborts(), 1);
  }
});
