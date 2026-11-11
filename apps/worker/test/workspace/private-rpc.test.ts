import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { harness, root } from "./harness.ts";

test("WorkspaceObject helpers are unreachable through actual Durable Object RPC", async () => {
  const path = resolve(root, "apps/worker/src/workspace/workspace-object.ts");
  const source = await readFile(path, "utf8");
  assert.doesNotMatch(
    source,
    /^ {2}private\s/m,
    "TypeScript-only private member remains on WorkspaceObject",
  );
  assert.equal([...source.matchAll(/^ {2}(?:async )?#\w+\s*(?:<|\()/gm)].length, 22);
  for (const name of ["exports", "child", "deleted"])
    assert.match(source, new RegExp(`^  (?:readonly )?#${name}\\b`, "m"));
  const server = harness();
  try {
    await server.listen();
    const seed = (await (await server.fetch("/seed")).json()) as D.Outcome<D.WorkspaceBinding>;
    assert.ok(seed.ok);
    const storage = await server
      .getWorker()
      .getDurableObjectStorage("WORKSPACES", { name: "workspace" });
    const before = await storage.exec("SELECT key,value FROM fp_ws_record ORDER BY key");
    const probes = (await (await server.fetch("/private-rpc")).json()) as {
      name: string;
      rejected: boolean;
      message: string;
    }[];
    assert.deepEqual(
      probes.map((probe) => probe.name),
      ["page", "closeUpload", "exportRegistry"],
    );
    for (const probe of probes) {
      assert.equal(
        probe.rejected,
        true,
        `Internal WorkspaceObject helper ${probe.name} was exposed over RPC`,
      );
      assert.match(
        probe.message,
        /does not implement|no such method|not a function|not implemented/i,
        `Helper ${probe.name} executed instead of rejecting at the RPC boundary`,
      );
    }
    assert.deepEqual(
      await storage.exec("SELECT key,value FROM fp_ws_record ORDER BY key"),
      before,
      "Rejected RPC helper changed authority storage",
    );
    const described = (await (
      await server.fetch("/rpc", {
        method: "POST",
        body: JSON.stringify({
          kind: "describe",
          input: {
            operationId: "describeWorkspace",
            path: { workspaceId: "workspace" },
            query: {},
          },
        }),
      })
    ).json()) as D.Outcome<D.OperationResponse<"describeWorkspace">>;
    assert.ok(described.ok, "Declared WorkspaceObjectRpc operation stopped working");
    assert.ok(described.value.status === 200);
    assert.equal(described.value.body.revision, seed.value.revision);
  } finally {
    await server.close();
  }
});
