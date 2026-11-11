import assert from "node:assert/strict";
import { test } from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { harness } from "./harness.ts";

test("workspace metadata rechecks a persisted credential floor after authority observation", async () => {
  const failures: string[] = [];
  for (const kind of ["list", "stat", "read-metadata", "diff"] as const) {
    const server = harness();
    try {
      await server.listen();
      const seeded = (await (await server.fetch("/seed")).json()) as D.Outcome<D.WorkspaceBinding>;
      if (!seeded.ok) assert.fail(JSON.stringify(seeded));
      const query = {
        revision: seeded.value.revision,
        path: "absent",
        otherRevision: seeded.value.revision,
      };
      const result = (await (
        await server.fetch("/rpc", {
          method: "POST",
          headers: { "x-test-request-id": "revoke-during-metadata" },
          body: JSON.stringify({
            kind,
            input: {
              operationId:
                kind === "list"
                  ? "listWorkspaceFiles"
                  : kind === "stat"
                    ? "statWorkspaceFile"
                    : kind === "diff"
                      ? "diffWorkspace"
                      : "readWorkspaceFile",
              path: { workspaceId: "workspace" },
              query,
            },
          }),
        })
      ).json()) as D.Outcome<unknown>;
      if (result.ok || result.code !== "unauthorized") failures.push(kind);
    } finally {
      await server.close();
    }
  }
  assert.deepEqual(failures, [], "Metadata ignored the completed credential invalidation");
});
