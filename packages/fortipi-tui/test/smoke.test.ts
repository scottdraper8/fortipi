import assert from "node:assert/strict";
import { test } from "node:test";
import { Controller, smoke } from "fortipi-tui";
import { FixtureService } from "./fixtures/service.ts";

void test("compiled smoke uses real native fetch/WebSocket and the interactive controller for offline replay", async () => {
  const service = new FixtureService();
  await service.start();
  const phases: string[] = [];
  try {
    const controller = new Controller(service.client());
    await smoke(controller, {
      timeoutMs: 10000,
      observe: (phase) => {
        phases.push(phase);
      },
    });
    assert.deepEqual(phases, ["discovery", "subscribed", "offline", "passed"]);
    assert.equal(service.admissions.size, 2);
    assert.equal(service.redeemed.length, 3);
    assert.equal(new Set(service.redeemed).size, 3);
    assert(service.requests.some((request) => request.endsWith("/tasks/task_2/cancel")));
    assert.deepEqual(
      controller.projection.appliedIds,
      service.events.map((event) => event.eventId),
    );
  } finally {
    await service.close();
  }
});
void test("smoke fails on rejected admission instead of reporting completion", async () => {
  const service = new FixtureService();
  await service.start();
  try {
    const controller = new Controller(service.client());
    service.busy = true;
    await assert.rejects(smoke(controller, { timeoutMs: 5000 }), { code: "conflict" });
    assert.equal(service.admissions.size, 0);
  } finally {
    await service.close();
  }
});

void test("native one-use upgrade failures are redacted and an aborted attempt does not open another socket", async () => {
  const service = new FixtureService();
  await service.start();
  try {
    const client = service.client();
    await assert.rejects(
      client.operations.getClientStream({
        path: {},
        query: { ticket: "invalid_fixture_ticket" },
        body: undefined,
      }),
      (error) =>
        error instanceof Error &&
        error.message === "FortiPi: handshake_failed" &&
        !JSON.stringify(error).includes("invalid_fixture_ticket"),
    );
    const ticket = await client.tickets.mint("conv_1");
    const connection = await client.operations.getClientStream({
      path: {},
      query: { ticket: ticket.ticket },
      body: undefined,
    });
    connection.close();
    await assert.rejects(
      client.operations.getClientStream({
        path: {},
        query: { ticket: ticket.ticket },
        body: undefined,
      }),
      { code: "handshake_failed" },
    );
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(
      client.operations.getClientStream(
        { path: {}, query: { ticket: "unattempted_ticket" }, body: undefined },
        { signal: abort.signal },
      ),
      { code: "aborted" },
    );
    assert.deepEqual(service.redeemed, [ticket.ticket]);
  } finally {
    await service.close();
  }
});
