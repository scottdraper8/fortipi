import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { FortiPiClient, FortiPiError } from "fortipi-client/node";
import { json, protocol } from "./fixtures/wire.ts";

void test("real HTTP redirect never delivers credentials to the redirect target", async () => {
  let leaked = 0;
  let leakedAuthorization = false;
  const foreign = createServer((request, response) => {
    leaked++;
    leakedAuthorization ||= request.headers.authorization !== undefined;
    response.end("{}");
  });
  foreign.listen(0, "127.0.0.1");
  await once(foreign, "listening");
  const address = foreign.address();
  assert(address && typeof address === "object");
  let delivered = "";
  const server = createServer((request, response) => {
    if (request.url === "/v1/protocol") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(protocol));
      return;
    }
    delivered = request.headers.authorization ?? "";
    response.writeHead(307, { location: `http://127.0.0.1:${address.port}/stolen` });
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const own = server.address();
  assert(own && typeof own === "object");
  try {
    const client = new FortiPiClient({
      endpoint: `http://127.0.0.1:${own.port}`,
      allowLoopbackHttp: true,
      credentials: async () => "synthetic-client",
    });
    await assert.rejects(client.agents.list(), { code: "redirect_rejected" });
    assert.equal(delivered, "Bearer synthetic-client");
    assert.equal(leakedAuthorization, false);
    assert.equal(leaked, 0);
  } finally {
    server.closeAllConnections();
    foreign.closeAllConnections();
    await Promise.all([
      new Promise<void>((r) => server.close(() => r())),
      new Promise<void>((r) => foreign.close(() => r())),
    ]);
  }
});
void test("endpoint and descriptor rejection precedes credential acquisition", async () => {
  let acquisitions = 0;
  const credentials = async () => {
    acquisitions++;
    return "synthetic";
  };
  for (const endpoint of [
    "https://user:pass@example.test",
    "https://example.test/?token=bad",
    "http://example.test",
    "https://example.test/path",
  ])
    assert.throws(() => new FortiPiClient({ endpoint, credentials }));
  const client = new FortiPiClient({ endpoint: "https://example.test", credentials });
  await assert.rejects(
    client.artifacts.read({
      workspaceId: "ws_1",
      revision: "revision_1",
      sha256: "a".repeat(64),
      size: 1,
      endpoint: `https://other.test/v1/workspaces/ws_1/blobs/${"a".repeat(64)}?revision=revision_1`,
      owner: { kind: "cloud" },
    }),
    { code: "invalid_wire" },
  );
  assert.equal(acquisitions, 0);
});
void test("async credential cancellation and bounded 401 reacquisition preserve intent and redact errors", async () => {
  const controller = new AbortController();
  const waiting = new FortiPiClient({
    endpoint: "https://example.test",
    fetch: async () => json(protocol),
    credentials: () => new Promise(() => {}),
  });
  const result = waiting.agents.list({}, { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(result, { code: "aborted" });
  const bodies: string[] = [],
    reasons: string[] = [];
  let attempts = 0;
  const client = new FortiPiClient({
    endpoint: "https://example.test",
    credentials: async (c) => {
      reasons.push(c.reason);
      return `synthetic_${reasons.length}`;
    },
    fetch: async (url, init) => {
      if (String(url).endsWith("/v1/protocol")) return json(protocol);
      bodies.push(String(init?.body));
      return ++attempts === 1
        ? json(
            {
              error: {
                code: "unauthenticated",
                message: "must not echo synthetic token",
                requestId: "request_1",
                retryable: false,
              },
            },
            401,
          )
        : json(
            {
              operationId: "op_1",
              messageId: "m_1",
              taskId: "task_1",
              revision: "r_1",
              eventSeq: 1,
            },
            202,
          );
    },
  });
  const intent = client.messageIntent("conv_1", "hello");
  await intent.send();
  assert.deepEqual(reasons, ["initial", "unauthenticated"]);
  assert.equal(bodies[0], bodies[1]);
  const forbidden = new FortiPiClient({
    endpoint: "https://example.test",
    credentials: async () => "synthetic",
    fetch: async (url) =>
      String(url).endsWith("/v1/protocol")
        ? json(protocol)
        : json(
            {
              error: {
                code: "unauthorized",
                message: "synthetic secret",
                requestId: "request_1",
                retryable: false,
              },
            },
            403,
          ),
  });
  await assert.rejects(
    forbidden.agents.list(),
    (error) =>
      error instanceof FortiPiError &&
      error.code === "unauthorized" &&
      !JSON.stringify(error).includes("synthetic"),
  );
});
void test("strict responses, outbound validation, size bounds and opaque provider denial", async () => {
  let calls = 0;
  const client = new FortiPiClient({
    endpoint: "https://example.test",
    credentials: async () => "synthetic",
    fetch: async (url) => {
      calls++;
      return String(url).endsWith("/v1/protocol")
        ? json(protocol)
        : json({ items: [], extra: true });
    },
  });
  await assert.rejects(
    client.conversations.send("conv_1", {
      clientRequestId: "req_1",
      content: "",
      busyBehavior: "reject",
    }),
    { code: "invalid_wire" },
  );
  assert.equal(calls, 0);
  await assert.rejects(client.agents.list(), { code: "invalid_wire" });
  const opaque = new FortiPiClient({
    endpoint: "https://example.test",
    credentials: async () => "synthetic",
    fetch: async (url) =>
      String(url).endsWith("/v1/protocol")
        ? json(protocol)
        : new Response("<html>private upstream body</html>", { status: 503 }),
  });
  await assert.rejects(
    opaque.agents.list(),
    (error) =>
      error instanceof FortiPiError &&
      error.code === "transport" &&
      !JSON.stringify(error).includes("private"),
  );
  const large = new FortiPiClient({
    endpoint: "https://example.test",
    credentials: async () => "synthetic",
    fetch: async () => new Response("{}", { headers: { "content-length": "1048577" } }),
  });
  await assert.rejects(large.discovery.protocol(), { code: "payload_too_large" });
});

void test("safe credential-provider failures preserve their code; opaque provider failures redact causes and timeouts remain retryable", async () => {
  for (const opaque of [false, true]) {
    const client = new FortiPiClient({
      endpoint: "https://example.test",
      fetch: async () => json(protocol),
      credentials: async () => {
        if (opaque) throw new Error("synthetic-secret-value");
        throw new FortiPiError("invalid_application_credential");
      },
    });
    await assert.rejects(
      client.agents.list(),
      (error) =>
        error instanceof FortiPiError &&
        error.code === (opaque ? "transport" : "invalid_application_credential") &&
        !JSON.stringify(error).includes("synthetic-secret-value"),
    );
  }
  const timeout = new FortiPiClient({
    endpoint: "https://example.test",
    timeoutMs: 10,
    credentials: async () => "synthetic",
    fetch: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return json(protocol);
    },
  });
  await assert.rejects(
    timeout.negotiate(),
    (error) => error instanceof FortiPiError && error.code === "timeout" && error.retryable,
  );
});

void test("portable predicates reject UTF-8 OAuth overflow and excluded workspace paths before acquiring a bearer", async () => {
  let acquisitions = 0;
  const client = new FortiPiClient({
    endpoint: "https://example.test",
    credentials: async () => {
      acquisitions++;
      return "synthetic";
    },
  });
  await assert.rejects(
    client.operations.putProviderAuth({
      path: { providerId: "provider_1" },
      query: {},
      body: {
        requestId: "request_1",
        expectedVersion: null,
        credential: {
          type: "oauth",
          refresh: "synthetic_refresh",
          access: "😀".repeat(5000),
          expires: Date.now() + 60000,
          providerFields: {},
        },
      },
    }),
    { code: "payload_too_large" },
  );
  await assert.rejects(client.workspaces.read("ws_1", { revision: "r_1", path: ".env.local" }), {
    code: "invalid_wire",
  });
  assert.equal(acquisitions, 0);
});

void test("native fetch compressed JSON keeps wire and decoded sizes distinct without relaxing decoded caps", async () => {
  const server = createServer((request, response) => {
    const bytes = gzipSync(
      JSON.stringify(request.url === "/health" ? { oversized: "x".repeat(1048576) } : protocol),
    );
    response.writeHead(200, {
      "content-type": "application/json",
      "content-encoding": "gzip",
      "content-length": String(bytes.length),
    });
    response.end(bytes);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  try {
    const client = new FortiPiClient({
      endpoint: `http://127.0.0.1:${address.port}`,
      allowLoopbackHttp: true,
      credentials: async () => "synthetic",
    });
    assert.equal((await client.negotiate()).deploymentId, protocol.deploymentId);
    await assert.rejects(client.discovery.health(), { code: "payload_too_large" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
