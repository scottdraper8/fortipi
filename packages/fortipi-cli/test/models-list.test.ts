import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { Protocol } from "fortipi-contract";
import { runCommand } from "../dist/index.js";
import { localModels } from "../dist/models.js";
import { writeProtected } from "../dist/profiles.js";
import type { ModelListing } from "../dist/results.js";
import { config, temp } from "./fixtures.ts";

test("model listing keeps the local catalog without a profile and projects filtered deployed metadata without credentials", async (t) => {
  const root = await temp(t);
  const controller = new AbortController();
  let requests = 0;
  const transport: typeof fetch = async (url, init) => {
    requests++;
    assert.equal(String(url), "https://models.example/v1/protocol");
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.body, undefined);
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer synthetic-app-profile");
    const protocol: Protocol = {
      protocolVersion: "1.0",
      schemaVersion: "1.0.0",
      deploymentId: "not-returned",
      supportedVersions: ["1.0"],
      features: [],
      schemas: [],
      infrastructure: (await config()).runtime.infrastructure,
      limits: {
        jsonBytes: 1024,
        outputFrameBytes: 1024,
        chunkBytes: 1024,
        uploadTtlMs: 1000,
        ticketTtlMs: 1000,
        rpcDeadlineMs: 1000,
        replayPage: 10,
        socketBufferBytes: 1024,
        socketBufferFrames: 10,
      },
      retention: { kind: "conversation-lifetime", retainedFloor: 0 },
      backends: [],
      models: [
        {
          providerId: "cloudflare",
          modelId: "@cf/observed-model",
          capabilities: ["text"],
          available: true,
        },
        { providerId: "openai", modelId: "observed-openai", capabilities: [], available: false },
      ],
    };
    return Response.json(protocol);
  };
  const context = { signal: controller.signal, profileDirectory: root, transport };
  const absent = (await runCommand(
    ["models", "list", "--provider", "openai"],
    context,
  )) as ModelListing;
  assert.deepEqual(absent.items, localModels("openai"));
  assert.deepEqual(absent.deployed, { state: "not-configured" });
  assert.equal(requests, 0);
  await writeProtected(join(root, "default.json"), {
    version: 1,
    endpoint: "https://models.example",
    role: "client",
    token: "synthetic-app-profile",
  });
  const listed = (await runCommand(
    ["models", "list", "--provider", "cloudflare"],
    context,
  )) as ModelListing;
  assert.deepEqual(listed.items, []);
  assert.deepEqual(listed.deployed, {
    state: "observed",
    items: [
      {
        providerId: "cloudflare",
        modelId: "@cf/observed-model",
        capabilities: ["text"],
        available: true,
      },
    ],
  });
  const unavailableModel = (await runCommand(
    ["models", "list", "--provider", "openai"],
    context,
  )) as ModelListing;
  assert.deepEqual(unavailableModel.deployed, {
    state: "observed",
    items: [
      { providerId: "openai", modelId: "observed-openai", capabilities: [], available: false },
    ],
  });
  assert.equal(JSON.stringify(listed).includes("synthetic-app-profile"), false);
  assert.equal(JSON.stringify(listed).includes("not-returned"), false);
  await writeFile(
    join(root, "default.json"),
    JSON.stringify({ version: 1, endpoint: "https://models.example", role: "client", token: "" }),
  );
  await assert.rejects(runCommand(["models", "list"], context), /invalid_profile/);
  assert.equal(
    requests,
    2,
    "invalid existing profiles must not be treated as absent or used remotely",
  );
});

test("remote model observation failure preserves local metadata, redacts errors and obeys timeout/cancellation", async (t) => {
  const root = await temp(t);
  await writeProtected(join(root, "default.json"), {
    version: 1,
    endpoint: "https://models.example",
    role: "client",
    token: "synthetic-app-profile",
  });
  const controller = new AbortController();
  let mode = "error";
  const transport: typeof fetch = async (_url, init) => {
    if (mode === "error") throw new Error("synthetic-provider-or-server-secret");
    if (mode === "invalid") return Response.json({ token: "synthetic-provider-or-server-secret" });
    const signal = init?.signal;
    assert.ok(signal);
    await new Promise<void>((_accept, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    assert.fail("aborted observation must reject");
  };
  const context = { signal: controller.signal, profileDirectory: root, transport };
  for (mode of ["error", "invalid", "timeout"]) {
    const observed = (await runCommand(
      ["models", "list", "--provider", "openai", "--timeout-ms", "5"],
      context,
    )) as ModelListing;
    assert.deepEqual(observed.items, localModels("openai"));
    assert.deepEqual(observed.deployed, { state: "unavailable" });
    assert.equal(JSON.stringify(observed).includes("synthetic-provider-or-server-secret"), false);
  }
  const cancelled = runCommand(["models", "list", "--timeout-ms", "1000"], context);
  controller.abort();
  await assert.rejects(cancelled, /cancelled/);
});
