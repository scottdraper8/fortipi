import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyControls } from "./verify-container-egress.ts";

test("an allowed target on both sides is required to distinguish refusal from broken networking", () => {
  verifyControls(0, 1, 0);
  verifyControls(0, 124, 0);
  assert.throws(() => verifyControls(1, 1, 1));
  assert.throws(() => verifyControls(0, 124, 1));
});

test("a reachable denied target and Docker setup failures cannot count as policy refusal", () => {
  for (const status of [0, 125, 126, 127, 137]) {
    assert.throws(() => verifyControls(0, status, 0));
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
