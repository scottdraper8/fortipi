import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import { promisify } from "node:util";
import { type ApplicationNetworkEvidence, verifyGatewayEgress } from "./verify-app-network.ts";
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
