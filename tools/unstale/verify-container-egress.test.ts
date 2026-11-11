import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  type ApplicationNetworkEvidence,
  observeHarnessFetch,
  verifyGatewayEgress,
} from "./verify-app-network.ts";
import {
  isStepSecuritySinkhole,
  privateBridgeDns,
  verifyControls,
} from "./verify-container-egress.ts";

test("an allowed target on both sides is required to distinguish refusal from broken networking", () => {
  verifyControls(0, 1, 0);
  verifyControls(0, 124, 0);
  assert.throws(() => verifyControls(1, 1, 1));
  assert.throws(() => verifyControls(0, 124, 1));
});

test("the existing Bash client issues only HEAD and exposes no HTTP header or body contents", async () => {
  const { healthCommand } = await import("./container-runtime-diagnostics.ts");
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    assert.equal(request.headers.authorization, undefined);
    response.writeHead(200, { "x-diagnostic-private": "hidden-header" });
    response.end("hidden-body");
  });
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const { stdout, stderr } = await promisify(execFile)(
      "/bin/bash",
      ["-c", healthCommand.replace("/8080", `/${address.port}`)],
      {
        env: { HOME: process.env.HOME, PATH: process.env.PATH },
        timeout: 1000,
        killSignal: "SIGKILL",
        maxBuffer: 1024,
        encoding: "utf8",
      },
    );
    assert.deepEqual(requests, ["HEAD /health"]);
    assert.equal(stdout, "200");
    assert.equal(stderr, "");
    assert.doesNotMatch(stdout, /hidden-|HTTP|HEAD|health/);
  } finally {
    await new Promise<void>((accept, reject) =>
      server.close((error) => (error ? reject(error) : accept())),
    );
  }
});

test("a reachable denied target and Docker setup failures cannot count as policy refusal", () => {
  for (const status of [0, 125, 126, 127, 137]) {
    assert.throws(() => verifyControls(0, status, 0));
  }
});

test("rootless bridge DNS must be the pinned private gateway, without external fallback", () => {
  assert.equal(privateBridgeDns("nameserver 10.0.2.1\n"), "10.0.2.1");
  for (const value of [
    "nameserver 8.8.8.8",
    "nameserver 127.0.0.53",
    "nameserver 10.0.2.1\nnameserver 8.8.8.8",
  ])
    assert.throws(() => privateBridgeDns(value));
});

test("a refused TCP connection alone cannot establish the provider's DNS policy action", () => {
  assert.equal(isStepSecuritySinkhole(["54.185.253.63"]), true);
  for (const addresses of [[], ["127.0.0.1"], ["8.8.8.8"], ["54.185.253.63", "8.8.8.8"]]) {
    assert.equal(isStepSecuritySinkhole(addresses), false);
  }
});

test("bounded gateway status diagnostics keep generic responses red and omit tainted receipt data", () => {
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (message: string) => logs.push(message);
  const evidence: ApplicationNetworkEvidence = {
    imageId: `sha256:${"a".repeat(64)}`,
    appPid: 42,
    authorityVerifiedBeforeAfter: true,
    allowedBefore: 200,
    deniedStatus: 502,
    deniedTransportFailure: false,
    allowedAfter: 200,
    tlsAuthorized: true,
    syntheticDns: true,
    upstreamStepSecurityBeforeAfter: true,
  };
  const receipt = (target: string, outcome: string, status: number | null) => ({
    message: `fortipi-gateway:${JSON.stringify({ target, outcome, status, forwarded: true })}`,
  });
  const registry = receipt("allowed-registry", "response", 200);
  try {
    for (const status of [200, 403, 502]) {
      logs.length = 0;
      assert.throws(() =>
        verifyGatewayEgress(
          [registry, receipt("denied-example", "response", status), registry],
          evidence,
        ),
      );
      assert.equal(logs.length, 1);
      assert.deepEqual(JSON.parse(logs[0] ?? ""), {
        probe: "computer-gateway-receipts",
        receipts: [
          { target: "allowed-registry", outcome: "response", status: 200 },
          { target: "denied-example", outcome: "response", status },
          { target: "allowed-registry", outcome: "response", status: 200 },
        ],
      });
    }
    const valid = [registry, receipt("denied-example", "upstream-error", null), registry];
    verifyGatewayEgress(valid, evidence);
    assert.throws(() =>
      verifyGatewayEgress(valid, { ...evidence, upstreamStepSecurityBeforeAfter: false }),
    );
    logs.length = 0;
    const tainted = {
      message: `fortipi-gateway:${JSON.stringify({
        target: "denied-example",
        outcome: "response",
        status: 403,
        forwarded: true,
        headers: "diagnostic-private-header",
      })}`,
    };
    assert.throws(() => verifyGatewayEgress([registry, tainted, registry], evidence));
    assert.deepEqual(logs, []);
  } finally {
    console.log = originalLog;
  }
});

test("harness fetch observation preserves arguments, receiver, Promise and Response including reachable example", async () => {
  const realFetch = globalThis.fetch;
  const requests: {
    receiver: unknown;
    args: unknown[];
    promise: Promise<Response>;
    response: Response;
  }[] = [];
  const original: typeof fetch = function (this: unknown, ...args) {
    const response = new Response(null, {
      status: 200,
      headers: { "x-private": "diagnostic-private-header" },
    });
    const promise = Promise.resolve(response);
    requests.push({ receiver: this, args, promise, response });
    return promise;
  };
  globalThis.fetch = original;
  const observation = observeHarnessFetch();
  try {
    const receiver = {};
    const controller = new AbortController();
    const init = {
      method: "HEAD",
      signal: controller.signal,
      headers: { "x-private": "diagnostic-private-header" },
    };
    for (const url of [
      "https://registry.npmjs.org/pnpm/12.18.0",
      "https://example.com/",
      "https://registry.npmjs.org/pnpm/12.18.0",
    ]) {
      const promise = Reflect.apply(globalThis.fetch, receiver, [url, init]);
      const actual = requests.at(-1);
      assert.ok(actual);
      assert.equal(promise, actual.promise);
      assert.equal(await promise, actual.response);
      assert.equal(actual.receiver, receiver);
      assert.equal(actual.args[0], url);
      assert.equal(actual.args[1], init);
      assert.equal(actual.response.bodyUsed, false);
    }
    const trace = observation.stop();
    assert.equal(globalThis.fetch, original);
    assert.equal(trace.complete, true);
    assert.equal(trace.events.length, 6);
    assert.deepEqual(trace.events[3], { role: "denied-example", phase: "RESPONSE", status: 200 });
    assert.doesNotMatch(JSON.stringify(trace), /diagnostic-private|headers|https:/);
  } finally {
    observation.stop();
    globalThis.fetch = realFetch;
  }
});

test("harness observation preserves asynchronous cancellation and the original rejected error", async () => {
  const realFetch = globalThis.fetch;
  const controller = new AbortController();
  const failure = new Error("diagnostic-private-error", { cause: { code: "ECONNREFUSED" } });
  let pending: Promise<Response> | undefined;
  const original: typeof fetch = (input, init) => {
    if (input === "https://example.com/") {
      assert.equal(init?.signal, controller.signal);
      pending = new Promise((_accept, reject) =>
        controller.signal.addEventListener("abort", () => reject(failure), { once: true }),
      );
      return pending;
    }
    return Promise.resolve(new Response(null, { status: 200 }));
  };
  globalThis.fetch = original;
  const observation = observeHarnessFetch();
  try {
    await fetch("https://registry.npmjs.org/pnpm/12.18.0", { method: "HEAD" });
    const promise = fetch("https://example.com/", { method: "HEAD", signal: controller.signal });
    assert.equal(promise, pending);
    controller.abort();
    await assert.rejects(promise, (error) => error === failure);
    await fetch("https://registry.npmjs.org/pnpm/12.18.0", { method: "HEAD" });
    const trace = observation.stop();
    assert.equal(trace.complete, true);
    assert.deepEqual(trace.events[3], {
      role: "denied-example",
      phase: "FAILURE",
      causeCode: "ECONNREFUSED",
    });
    assert.doesNotMatch(JSON.stringify(trace), /diagnostic-private|error/);
  } finally {
    observation.stop();
    globalThis.fetch = realFetch;
  }
});

test("harness diagnostics do not replace synchronous errors or clobber an intervening fetch hook", () => {
  const realFetch = globalThis.fetch;
  const failure = new Error("diagnostic-private-error");
  Object.defineProperty(failure, "cause", {
    get() {
      throw new Error("diagnostic-private-getter");
    },
  });
  const original: typeof fetch = () => {
    throw failure;
  };
  globalThis.fetch = original;
  const observation = observeHarnessFetch();
  try {
    assert.throws(
      () => fetch("https://registry.npmjs.org/pnpm/12.18.0", { method: "HEAD" }),
      (error) => error === failure,
    );
    const replacement: typeof fetch = () => Promise.resolve(new Response());
    globalThis.fetch = replacement;
    const trace = observation.stop();
    assert.equal(globalThis.fetch, replacement);
    assert.equal(trace.complete, false);
    assert.deepEqual(trace.events[1], {
      role: "allowed-before",
      phase: "FAILURE",
      causeCode: "UNKNOWN",
    });
    assert.doesNotMatch(JSON.stringify(trace), /diagnostic-private/);
  } finally {
    observation.stop();
    globalThis.fetch = realFetch;
  }
});

test("harness observation delegates unrelated requests and bounds overflow or misordered probes", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  const promise = Promise.resolve(new Response(null, { status: 200 }));
  globalThis.fetch = () => {
    calls++;
    return promise;
  };
  try {
    for (const urls of [
      [
        "https://registry.npmjs.org/pnpm/12.18.0",
        "https://example.com/",
        "https://registry.npmjs.org/pnpm/12.18.0",
        "https://example.com/",
      ],
      [
        "https://example.com/",
        "https://registry.npmjs.org/pnpm/12.18.0",
        "https://registry.npmjs.org/pnpm/12.18.0",
      ],
    ]) {
      const observation = observeHarnessFetch();
      try {
        const init = {
          method: "HEAD",
          get headers(): Record<string, string> {
            throw new Error("diagnostic-private-header");
          },
        };
        assert.equal(fetch("https://example.com/?diagnostic-private-query", init), promise);
        for (const url of urls) assert.equal(await fetch(url, { method: "HEAD" }), await promise);
        const trace = observation.stop();
        assert.equal(trace.complete, false);
        assert.ok(trace.events.length <= 6);
        assert.doesNotMatch(JSON.stringify(trace), /diagnostic-private|https:/);
      } finally {
        observation.stop();
      }
    }
    assert.equal(calls, 9);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("input diagnostics preserve the request/error while withholding signed URL and auth data", async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const failure = new Error("fetch failed", { cause: { code: "ECONNREFUSED" } });
  const input = "https://registry-1.docker.io/private-blob?signature=diagnostic-test-only";
  const init = { headers: { Authorization: "Bearer diagnostic-test-only" } };
  const logs: string[] = [];
  let calls = 0;
  globalThis.fetch = async (actualInput, actualInit) => {
    assert.equal(actualInput, input);
    assert.equal(actualInit, init);
    calls++;
    throw failure;
  };
  console.error = (value: unknown) => logs.push(String(value));
  try {
    const { metadataDigests } = await import("./image-network-diagnostics.ts");
    await assert.rejects(
      () => fetch(input, init),
      (error) => error === failure,
    );
    assert.equal(calls, 1);
    assert.match(logs.join("\n"), /registry-1\.docker\.io \(ECONNREFUSED\)/);
    assert.doesNotMatch(logs.join("\n"), /diagnostic-test-only|private-blob|signature|Bearer/);
    const digest = `sha256:${"a".repeat(64)}`;
    const summary = metadataDigests({
      "containerimage.digest": digest,
      "containerimage.config.digest": "credential-test-only",
      "containerimage.descriptor": { digest, annotations: { token: "credential-test-only" } },
      "buildx.build.provenance": { secret: "credential-test-only" },
    });
    assert.deepEqual(summary["containerimage.digest"], { present: true, digest });
    assert.deepEqual(summary["containerimage.config.digest"], { present: true, digest: null });
    assert.deepEqual(summary["containerimage.descriptor.digest"], { present: true, digest });
    assert.deepEqual(metadataDigests(null)["containerimage.digest"], {
      present: false,
      digest: null,
    });
    assert.doesNotMatch(
      JSON.stringify(summary),
      /credential-test-only|annotations|provenance|secret/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
});
