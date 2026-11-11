import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { FortiPiClient } from "fortipi-client/node";
import { routeCatalog } from "fortipi-contract";
import { json, protocol } from "./fixtures/wire.ts";

void test("all 66 canonical operations are callable typed surfaces; scoped resources retain transfer and revision identity", async () => {
  const requests: { url: URL; body: unknown }[] = [];
  const bytes = new TextEncoder().encode("independent bytes");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const client = new FortiPiClient({
    endpoint: "https://example.test",
    credentials: async () => "synthetic",
    fetch: async (url, init) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/v1/protocol") return json(protocol);
      requests.push({
        url: parsed,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
      });
      if (parsed.pathname.endsWith("/validate"))
        return json({
          uploadId: "up_1",
          manifestHash: hash,
          stageId: "opaque_stage",
          validated: true,
        });
      if (parsed.pathname.includes("/chunks/")) return new Response(null, { status: 204 });
      const ranged = parsed.searchParams.has("range[start]");
      const payload = ranged ? bytes.slice(0, 11) : bytes;
      return new Response(payload, {
        status: ranged ? 206 : 200,
        headers: {
          "content-length": String(payload.length),
          "x-content-sha256": createHash("sha256").update(payload).digest("hex"),
          ...(ranged ? { "content-range": `bytes 0-10/${bytes.length}` } : {}),
        },
      });
    },
  });
  assert.equal(Object.keys(client.operations).length, 66);
  assert.deepEqual(
    Object.keys(client.operations).sort(),
    routeCatalog.map((route) => route.operationId).sort(),
  );
  await client.uploads.chunk({
    path: { workspaceId: "ws_1", uploadId: "up_1", sha256: hash, chunkIndex: 0 },
    query: { length: bytes.length, sha256: hash },
    body: bytes,
  });
  const stage = await client.uploads.validate("ws_1", "up_1");
  assert.equal(stage.stageId, "opaque_stage");
  assert(!("childId" in stage));
  await client.workspaces.read("ws_1", {
    revision: "r_1",
    path: "src/main.ts",
    range: { start: 0, end: 10 },
  });
  assert.equal(requests.at(-1)?.url.searchParams.get("range[start]"), "0");
  assert.equal(requests.at(-1)?.url.searchParams.get("revision"), "r_1");
  await assert.rejects(
    client.uploads.chunk({
      path: { workspaceId: "ws_1", uploadId: "up_1", sha256: hash, chunkIndex: 0 },
      query: { length: bytes.length, sha256: "b".repeat(64) },
      body: bytes,
    }),
    { code: "invalid_chunk" },
  );
  const result = await client.artifacts.read({
    workspaceId: "ws_1",
    revision: "r_1",
    sha256: hash,
    size: bytes.length,
    endpoint: `/v1/workspaces/ws_1/blobs/${hash}?revision=r_1`,
    owner: { kind: "cloud" },
  });
  assert.deepEqual(result, bytes);
  await assert.rejects(
    client.artifacts.read({
      workspaceId: "ws_1",
      revision: "r_1",
      sha256: hash,
      size: bytes.length + 1,
      endpoint: `/v1/workspaces/ws_1/blobs/${hash}?revision=r_1`,
      owner: { kind: "cloud" },
    }),
    { code: "checksum_mismatch" },
  );
});

void test("public commit consumes the opaque validated stage and original lease; recovery retains projected receipt fields", async () => {
  const hash = "c".repeat(64);
  const lease = {
    leaseId: "lease_1",
    operationId: "op_1",
    credential: { credentialId: "credential_1", generation: 2, grantVersion: 3 },
    registrationId: "reg_1",
    leaseVersion: 1,
    workspaceId: "ws_1",
    executorId: "exec_1",
    executorGeneration: 4,
    fence: "5",
    baseRevision: "r_1",
    expiresAt: Date.now() + 30000,
    ownerKind: "workspace-operation" as const,
  };
  const commit = {
    requestId: "request_1",
    stageId: "opaque_stage",
    commitId: "commit_1",
    uploadId: "up_1",
    operationId: "op_1",
    workspaceId: "ws_1",
    lease,
    manifestHash: hash,
    baseRevision: "r_1",
  };
  const receipt = {
    commitId: "commit_1",
    operationId: "op_1",
    workspaceId: "ws_1",
    commitDigest: hash,
    baseRevision: "r_1",
    revision: "r_2",
    manifestHash: hash,
    sourceFactId: "fact_1",
    committedAt: Date.now(),
    providerKind: "computer",
    storeRef: { stageId: "opaque_stage" },
  };
  const requests: unknown[] = [];
  const client = new FortiPiClient({
    endpoint: "https://example.test",
    credentials: async () => "synthetic",
    fetch: async (url, init) => {
      if (String(url).endsWith("/v1/protocol")) return json(protocol);
      if (init?.method === "POST") requests.push(JSON.parse(String(init.body)));
      return json(receipt);
    },
  });
  assert.deepEqual(await client.uploads.commit("ws_1", "up_1", commit), receipt);
  assert.deepEqual(requests, [commit]);
  assert.deepEqual(
    await client.uploads.receipt("ws_1", "commit_1", { commitDigest: hash }),
    receipt,
  );
  assert(!JSON.stringify(requests).includes("allocationId"));
  const bad = new FortiPiClient({
    endpoint: "https://example.test",
    credentials: async () => "synthetic",
    fetch: async (url) =>
      String(url).endsWith("/v1/protocol")
        ? json(protocol)
        : json({ ...receipt, storeRef: { stageId: "opaque_stage", childId: "private" } }),
  });
  await assert.rejects(bad.uploads.receipt("ws_1", "commit_1", { commitDigest: hash }), {
    code: "invalid_wire",
  });
});

void test("credential issuance preserves already-issued metadata without recovering a token or reminting", async () => {
  const requests: string[] = [];
  const alreadyIssued = {
    state: "already-issued",
    credential: { credentialId: "credential_1", generation: 2, grantVersion: 3 },
    role: "client",
  };
  const client = new FortiPiClient({
    endpoint: "https://example.test",
    credentials: async () => "synthetic-operator",
    fetch: async (url, init) => {
      if (String(url).endsWith("/v1/protocol")) return json(protocol);
      requests.push(String(init?.body));
      return json(alreadyIssued, 201);
    },
  });
  const input = {
    path: {},
    query: {},
    body: { requestId: "stable_issuance", role: "client" as const, grants: [] },
  };
  const receipt = await client.operations.mintCredential(input);
  assert.equal(receipt.state, "already-issued");
  assert(!("token" in receipt));
  assert.equal(requests.length, 1);
  const invalid = new FortiPiClient({
    endpoint: "https://example.test",
    credentials: async () => "synthetic-operator",
    fetch: async (url) =>
      String(url).endsWith("/v1/protocol")
        ? json(protocol)
        : json({ ...alreadyIssued, token: "forbidden_recovered_token" }, 201),
  });
  await assert.rejects(invalid.operations.mintCredential(input), { code: "invalid_wire" });
});

void test("artifact and relay reads honor their own effective bounds rather than the larger file ceiling", async () => {
  const client = new FortiPiClient({
    endpoint: "https://example.test",
    credentials: async () => "synthetic",
    fetch: async (url) =>
      String(url).endsWith("/v1/protocol")
        ? json(protocol)
        : new Response(new Uint8Array(), {
            headers: { "content-length": "2097152", "x-content-sha256": "a".repeat(64) },
          }),
  });
  await assert.rejects(client.workspaces.artifact("ws_1", "artifact_1", { revision: "r_1" }), {
    code: "payload_too_large",
  });
  await assert.rejects(
    client.operations.getExecutorTransferInputChunk({
      path: { transferId: "transfer_1", chunkIndex: 0 },
      query: { attemptId: "attempt_1" },
      body: undefined,
    }),
    { code: "payload_too_large" },
  );
});
