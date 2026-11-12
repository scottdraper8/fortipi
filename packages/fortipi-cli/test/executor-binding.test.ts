import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { help } from "../dist/argv.js";
import { runCommand } from "../dist/index.js";
import { writeProtected } from "../dist/profiles.js";
import { temp } from "./fixtures.ts";

test("executor binding forwards unchanged canonical local workspace create/rebind and names the workspace ID", async (t) => {
  const root = await temp(t);
  await writeProtected(join(root, "default.json"), {
    version: 1,
    endpoint: "https://binding.example",
    role: "admin",
    token: "synthetic-binding-admin",
  });
  const local = {
    kind: "local",
    executorId: "registered-device",
    rootBindingId: "registered-root",
  };
  const created = { requestId: "create-request", config: local };
  const rebound = {
    requestId: "rebind-request",
    expectedVersion: 4,
    newBindingVersion: 5,
    config: local,
    import: {
      revision: "revision-original",
      manifest: { version: 1, entries: [] },
      acknowledgeExternalEffects: true,
    },
  };
  let calls = 0;
  const context = {
    profileDirectory: root,
    signal: new AbortController().signal,
    transport: (async (url, init) => {
      calls++;
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer synthetic-binding-admin",
      );
      assert.equal(init?.redirect, "error");
      const expected = calls === 1 ? created : rebound;
      assert.equal(
        String(url),
        calls === 1
          ? "https://binding.example/v1/workspaces"
          : "https://binding.example/v1/workspaces/logical-workspace",
      );
      assert.equal(init?.method, calls === 1 ? "POST" : "PATCH");
      assert.deepEqual(JSON.parse(String(init?.body)), expected);
      return Response.json(
        {
          workspaceId: "logical-workspace",
          bindingVersion: calls === 1 ? 1 : 5,
          config: local,
          revision: "revision-original",
          manifestHash: "a".repeat(64),
          availability: "unknown",
        },
        { status: calls === 1 ? 201 : 200 },
      );
    }) satisfies typeof fetch,
  };
  const input = join(root, "binding.json");
  await writeFile(input, JSON.stringify(created));
  await runCommand(["executors", "bind", "--input", input], context);
  await writeFile(input, JSON.stringify(rebound));
  await runCommand(["executors", "bind", "--input", input, "--id", "logical-workspace"], context);
  assert.equal(calls, 2);
  assert.match(help("executors bind"), /--id is WORKSPACE_ID/);
  assert.match(help("executors bind"), /Register the root separately/);
});

test("executor binding rejects nonlocal and incomplete CAS/import inputs before any HTTP mutation", async (t) => {
  const root = await temp(t);
  await writeProtected(join(root, "default.json"), {
    version: 1,
    endpoint: "https://binding.example",
    role: "admin",
    token: "synthetic-binding-admin",
  });
  let requests = 0;
  const context = {
    profileDirectory: root,
    signal: new AbortController().signal,
    transport: (async () => {
      requests++;
      assert.fail("invalid binding reached HTTP");
    }) satisfies typeof fetch,
  };
  const input = join(root, "binding.json");
  await writeFile(input, JSON.stringify({ requestId: "request-A", config: { kind: "computer" } }));
  await assert.rejects(
    runCommand(["executors", "bind", "--input", input], context),
    /local_workspace_binding_required/,
  );
  const rebind = {
    requestId: "request-B",
    config: { kind: "local", executorId: "device", rootBindingId: "root" },
  };
  await writeFile(input, JSON.stringify(rebind));
  await assert.rejects(
    runCommand(["executors", "bind", "--input", input, "--id", "workspace"], context),
    /invalid_contract_input/,
  );
  await writeFile(
    input,
    JSON.stringify({
      ...rebind,
      expectedVersion: 1,
      newBindingVersion: 2,
      import: {
        revision: "original",
        manifest: { version: 1, entries: [] },
        acknowledgeExternalEffects: false,
      },
    }),
  );
  await assert.rejects(
    runCommand(["executors", "bind", "--input", input, "--id", "workspace"], context),
    /invalid_contract_input/,
  );
  assert.equal(requests, 0);
});
