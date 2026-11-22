import assert from "node:assert/strict";
import test from "node:test";
import Ajv from "ajv/dist/2020.js";
import { schemaRegistry } from "fortipi-contract";
import { errorResponse, failure, pressure, ServiceError, unwrap } from "../../src/api/common.ts";

const ajv = new Ajv({ strict: true, validateFormats: false });
for (const schema of Object.values(schemaRegistry)) ajv.addSchema(schema);
const protocol = ajv.compile({
  $ref: "https://fortipi.dev/schemas/1.0.0/common.schema.json#/$defs/ProtocolError",
});
const client = ajv.compile({
  $ref: "https://fortipi.dev/schemas/1.0.0/client-commands.schema.json#/$defs/ClientError",
});

test("quota failures satisfy canonical HTTP and stream unions without inventing a storage reset", async () => {
  for (const code of ["quota_paused", "quota_exceeded"] as const) {
    const actualPressure = pressure(
      "storage",
      134217728,
      "Object admission watermark reached",
    ).pressure;
    assert.ok(actualPressure);
    actualPressure.action = "reclaim-storage";
    const error = new ServiceError(code, "Object admission watermark reached", {
      pressure: actualPressure,
    });
    const response = (await errorResponse(error, "request").json()) as { error: unknown };
    assert.equal(protocol(response.error), true, JSON.stringify(protocol.errors));
    const { ok: _ok, ...body } = failure(error, "request");
    assert.equal(body.details?.retryAfterMs, 0);
    assert.deepEqual(body.details?.pressure, actualPressure);
    assert.equal(
      client({ type: "error", requestId: "request", error: body }),
      true,
      JSON.stringify(client.errors),
    );
  }
});

test("existing owner retry/reason metadata survives error normalization", () => {
  const details = { ...pressure("requests", 30, "Principal minute exhausted"), retryAfterMs: 1234 };
  const actual = failure(
    new ServiceError("quota_exceeded", "Principal minute exhausted", details),
    "request",
  );
  assert.deepEqual(actual.details, details);
  for (const code of [
    "rate_limited",
    "unavailable",
    "unavailable_executor",
    "conflict",
    "workspace.conflict",
    "interrupted",
  ] as const) {
    const { ok: _ok, ...body } = failure(
      new ServiceError(code, "Bounded test", { requiredCapability: "loader" }),
      "request",
    );
    assert.equal(protocol(body), true, JSON.stringify(protocol.errors));
  }
});

test("a typed soft rate limit retains its explicit backoff through the outer router envelope", async () => {
  const response = errorResponse(
    new ServiceError("rate_limited", "Request rate exceeded", { retryAfterMs: 60000 }),
    "request",
  );
  assert.equal(response.status, 429);
  const { error } = (await response.json()) as { error: unknown };
  assert.equal(protocol(error), true, JSON.stringify(protocol.errors));
  assert.deepEqual(error, {
    code: "rate_limited",
    message: "Request rate exceeded",
    requestId: "request",
    retryable: true,
    details: { retryAfterMs: 60000 },
  });
  for (const retryAfterMs of [undefined, 0]) {
    const error = failure(
      new ServiceError(
        "rate_limited",
        "No explicit future retry",
        retryAfterMs === undefined ? undefined : { retryAfterMs },
      ),
      "request",
    );
    assert.equal(error.retryable, false);
  }
  assert.equal(
    failure(new ServiceError("interrupted", "Unknown dispatched outcome"), "request").retryable,
    false,
  );
  for (const retryable of [true, false]) {
    try {
      unwrap({
        ok: false,
        code: "rate_limited",
        message: "Owner disposition",
        requestId: "owner-request",
        retryable,
        details: { retryAfterMs: 60000 },
      });
      assert.fail("Owner failure expected");
    } catch (error) {
      assert.equal(failure(error, "request").retryable, retryable);
    }
  }
});
