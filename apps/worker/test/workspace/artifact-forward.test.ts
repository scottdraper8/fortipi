import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { harness } from "./harness.ts";

test("native artifact misses use the registered reader private lane and bound streamed responses", async () => {
  const server = harness();
  const bytes = Uint8Array.from({ length: 393217 }, (_, i) => i % 251);
  const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
  const endpoint = "/v1/workspaces/workspace/artifacts/retained-native?revision=original-base";
  try {
    await server.listen();
    assert.equal((await server.fetch("/seed")).status, 200);
    const full = await server.fetch(endpoint, {
      headers: { "X-Fortipi-Context": "forged", "x-untrusted": "do-not-forward" },
    });
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("x-fortipi-context"), null);
    assert.equal(full.headers.get("Cache-Control"), "no-store");
    assert.equal(full.headers.get("X-Content-SHA256"), hash(bytes));
    assert.equal(hash(new Uint8Array(await full.arrayBuffer())), hash(bytes));
    const ranged = await server.fetch(`${endpoint}&range[start]=17&range[end]=200000`, {
      headers: { Range: "bytes=17-200000" },
    });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get("Content-Range"), "bytes 17-200000/393217");
    assert.equal(ranged.headers.get("X-Content-SHA256"), hash(bytes.slice(17, 200001)));
    assert.equal(hash(new Uint8Array(await ranged.arrayBuffer())), hash(bytes.slice(17, 200001)));
    assert.deepEqual(await (await server.fetch("/artifact-observation")).json(), {
      count: 2,
      credentialId: "credential",
      registrationId: "registration",
      method: "GET",
      search: "?revision=original-base&range%5Bstart%5D=17&range%5Bend%5D=200000",
      range: "bytes=17-200000",
      rawAuthority: false,
      untrustedHeader: false,
    });
    assert.equal(
      (await server.fetch(endpoint, { headers: { "x-test-no-grants": "1" } })).status,
      403,
    );
    assert.equal(
      ((await (await server.fetch("/artifact-observation")).json()) as { count: number }).count,
      2,
      "Missing reader grant reached the private index",
    );
    assert.equal(
      (await server.fetch("/v1/workspaces/workspace/artifacts/absent?revision=original-base"))
        .status,
      404,
    );
    const oversized = await server.fetch(
      "/v1/workspaces/workspace/artifacts/oversized?revision=original-base",
    );
    assert.equal(oversized.status, 413, "Announced artifact size escaped the reader limit");
    const truncated = await server.fetch(
      "/v1/workspaces/workspace/artifacts/truncated?revision=original-base",
    );
    // The pinned dev proxy turns the upstream stream error into a failed response.
    assert.equal(truncated.status, 500, "Truncated response completed successfully");
    await truncated.body?.cancel();
    const beforeRevocation = (await (await server.fetch("/artifact-observation")).json()) as {
      count: number;
    };
    const invalidated = (await (
      await server.fetch("/rpc", {
        method: "POST",
        body: JSON.stringify({
          kind: "invalidate",
          input: {
            revocationId: "artifact-reader-revoked",
            subject: { kind: "credential", credentialId: "credential", minimumGeneration: 2 },
          },
        }),
      })
    ).json()) as D.Outcome<unknown>;
    assert.equal(invalidated.ok, true);
    assert.equal((await server.fetch(endpoint)).status, 403);
    const observation = (await (await server.fetch("/artifact-observation")).json()) as {
      count: number;
    };
    assert.equal(
      observation.count,
      beforeRevocation.count,
      "Denied reader reached the private artifact index",
    );
  } finally {
    await server.close();
  }
});
